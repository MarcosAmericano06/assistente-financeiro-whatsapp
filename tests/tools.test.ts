import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeTool } from '../src/ai/tools.js';
import { newBatchId } from '../src/finance/audit.js';
import { seedTaxonomy } from '../src/finance/taxonomy.js';
import { createTestDb, insertTx, getTx, type TestDb } from './helpers/db.js';

type R = Record<string, unknown>;
const countCategories = async (t: TestDb) => ((await t.db.execute(sql`select count(*)::int n from categories`))[0] as { n: number }).n;

describe('tools do orquestrador', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await seedTaxonomy(t.db, t.ownerId);
  });
  afterAll(async () => t.close());

  it('set_category_rule repetido não duplica a regra', async () => {
    await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'amazon', category_name: 'Eletrônicos' });
    await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'Amazon', category_name: 'eletronicos' });
    const r = (await executeTool(t.db, 'list_category_rules', {})) as { regras: unknown[] };
    expect(r.regras).toHaveLength(1);
  });

  it('categoria que não existe: nada é criado, volta com sugestões', async () => {
    const antes = await countCategories(t);
    const r = (await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'zodiaco', category_name: 'astrologia' })) as R;
    expect(r.erro).toBeDefined();
    expect((r.sugestoes as string[]).length).toBeGreaterThan(0);
    expect(await countCategories(t)).toBe(antes);
  });

  it('retroativo: a regra vale já, mas o histórico só muda com confirmação numa mensagem seguinte', async () => {
    const id = await insertTx(t.db, t.ownerId, { amount: 39.99, description: 'AMAZONMKTPLC*TOPMIXLTD', merchant: 'topmix ltda', category: 'Compras gerais' });
    const msg1 = { batchId: newBatchId(), origin: 'chat' };
    const p = (await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'amazonmktplc', category_name: 'Eletrônicos', apply_retroactive: true }, msg1)) as R;
    expect(p.historico_afetado).toBe(1);
    expect(p.confirm_token).toBeDefined();
    expect((await getTx(t.db, id)).category).toBe('Compras gerais');
    // a IA tentando confirmar sozinha na mesma mensagem é recusada
    const mesma = (await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'amazonmktplc', category_name: 'Eletrônicos', apply_retroactive: true, confirm_token: p.confirm_token }, msg1)) as R;
    expect(mesma.erro).toMatch(/confirm/);
    // no "sim" o bot pode mandar só o token: a prévia já guardou categoria e tipo
    const r = await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'amazonmktplc', confirm_token: p.confirm_token });
    expect(r.recategorizadas_no_historico).toBe(1);
    expect((await getTx(t.db, id)).category).toBe('Eletrônicos');
    expect((await t.db.execute(sql`select count(*)::int n from audit_log where entity_id=${id}`))[0]).toEqual({ n: 1 });
  });

  it('regra de tipo: "PIX pro X não é gasto"', async () => {
    const id = await insertTx(t.db, t.ownerId, { amount: 500, description: 'Pix enviado  - Fulano De Tal', category: 'PIX enviado' });
    const p = (await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'fulano de tal', set_type: 'transfer', apply_retroactive: true })) as R;
    await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'fulano de tal', set_type: 'transfer', apply_retroactive: true, confirm_token: p.confirm_token });
    expect((await getTx(t.db, id)).type).toBe('transfer');
  });

  it('query_spending: líquido de estornos e por categoria pai (soma os filhos)', async () => {
    await insertTx(t.db, t.ownerId, { amount: 100, description: 'LATAM', date: '2026-07-10', category: 'Passagens', account: 'card' });
    await insertTx(t.db, t.ownerId, { amount: 50, description: 'HOTEL', date: '2026-07-12', category: 'Hospedagem', account: 'card' });
    await insertTx(t.db, t.ownerId, { type: 'refund', amount: 40, description: 'LATAM DCP', date: '2026-07-11', category: 'Passagens', account: 'card' });
    const r = await executeTool(t.db, 'query_spending', { period_start: '2026-07-01', period_end: '2026-07-31' });
    expect(r).toMatchObject({ total_brl: '110.00', gastos_brl: '150.00', estornos_brl: '40.00' });
    const v = await executeTool(t.db, 'query_spending', { period_start: '2026-07-01', period_end: '2026-07-31', category_name: 'viagem' });
    expect(v).toMatchObject({ total_brl: '110.00', categoria: 'Viagens' });
  });

  it('create_transaction: regra vale; categoria desconhecida fica "A classificar" e pede confirmação', async () => {
    const r = (await executeTool(t.db, 'create_transaction', { amount: 80, type: 'expense', description: 'compra amazon' })) as R;
    expect(r.categoria).toBe('Eletrônicos (pela sua regra)');
    const x = (await executeTool(t.db, 'create_transaction', { amount: 20, type: 'expense', description: 'tarô', category_name: 'astrologia' })) as R;
    expect(x.categoria).toBe('A classificar');
    expect(x.categoria_nao_encontrada).toBe('astrologia');
  });

  it('list_transactions aceita filtrar estornos', async () => {
    const r = (await executeTool(t.db, 'list_transactions', { period_start: '2026-07-01', period_end: '2026-07-31', type: 'refund' })) as {
      transacoes: unknown[];
    };
    expect(r.transacoes).toHaveLength(1);
  });

  it('recategorize_transactions: com várias, só mostra a prévia; aplica nos ids confirmados', async () => {
    const a = await insertTx(t.db, t.ownerId, { amount: 70, date: '2026-09-09', description: 'Pix enviado  - Matheus Souza', category: 'PIX enviado' });
    const b = await insertTx(t.db, t.ownerId, { amount: 250, date: '2025-12-22', description: 'Pix enviado  - Matheus Lima', category: 'PIX enviado' });
    const msg1 = { batchId: newBatchId(), origin: 'chat' };
    const args = { search: 'matheus', category_name: 'festa', period_start: '2025-01-01', period_end: '2026-12-31' };
    const p = (await executeTool(t.db, 'recategorize_transactions', args, msg1)) as R;
    expect(p.previa).toHaveLength(2);
    expect((await getTx(t.db, a)).category).toBe('PIX enviado');
    const mesma = (await executeTool(t.db, 'recategorize_transactions', { ...args, confirm_token: p.confirm_token, confirm_ids: [a] }, msg1)) as R;
    expect(mesma.erro).toMatch(/confirm/);
    const intruso = (await executeTool(t.db, 'recategorize_transactions', { ...args, confirm_token: p.confirm_token, confirm_ids: [a, '00000000-0000-4000-8000-000000000000'] })) as R;
    expect(intruso.atualizadas).toBe(1); // id fora da prévia é ignorado
    const ok = (await executeTool(t.db, 'recategorize_transactions', { ...args, confirm_token: p.confirm_token, confirm_ids: [a] })) as R;
    expect(ok.erro).toMatch(/confirm/); // token é de uso único
    expect((await getTx(t.db, a)).category).toBe('Festas e eventos');
    expect((await getTx(t.db, b)).category).toBe('PIX enviado');
  });

  it('spending_report numera os itens e a edição pelo número funciona em cima dele', async () => {
    const r = (await executeTool(t.db, 'spending_report', { period_start: '2026-07-01', period_end: '2026-07-31', category_name: 'viagens' })) as R;
    expect(r).toMatchObject({ categoria: 'Viagens', total_brl: '110.00' });
    expect(r.periodo_anterior).toBeDefined();
    const itens = r.itens as { n: number; descricao: string }[];
    expect(itens.map((i) => i.n)).toEqual([1, 2, 3]);
    const hotel = itens.find((i) => i.descricao === 'HOTEL')!;
    const e = (await executeTool(t.db, 'edit_list_items', { numeros: [hotel.n], acao: 'valor', valor: 60 })) as R;
    expect((e.resultados as R[])[0]!.ok).toBe(true);
  });

  it('desfazer reverte todas as alterações da última mensagem', async () => {
    const id = await insertTx(t.db, t.ownerId, { amount: 33, description: 'PADARIA', category: 'Mercado', account: 'card' });
    const ctx = { batchId: newBatchId(), origin: 'chat' };
    await executeTool(t.db, 'update_transaction', { id, new_amount: 35 }, ctx);
    await executeTool(t.db, 'update_transaction', { id, new_category_name: 'restaurante' }, ctx);
    expect(await getTx(t.db, id)).toMatchObject({ amount: '35.00', category: 'Restaurantes e bares' });
    const u = (await executeTool(t.db, 'undo_last_change', {})) as R;
    expect(u.desfeitas).toBe(2);
    expect(await getTx(t.db, id)).toMatchObject({ amount: '33.00', category: 'Mercado' });
  });

  it('create_category exige o pai e só então a categoria passa a ser reconhecida', async () => {
    const sem = (await executeTool(t.db, 'create_category', { name: 'Kitesurf' })) as R;
    expect(sem.erro).toBeDefined();
    const ok = (await executeTool(t.db, 'create_category', { name: 'Kitesurf', parent_name: 'esportes' })) as R;
    expect(ok.criada).toMatchObject({ nome: 'Kitesurf', pai: 'Esportes' });
    const c = (await executeTool(t.db, 'list_categories', {})) as { gastos: { pai: string; filhos: string[] }[] };
    expect(c.gastos.find((p) => p.pai === 'Esportes')!.filhos).toContain('Kitesurf');
  });

  it('delete_rule acha a regra mesmo com acento e espaço extra', async () => {
    await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'Padaria São José', category_name: 'mercado' });
    const r = (await executeTool(t.db, 'delete_rule', { merchant_pattern: 'padaria  são josé' })) as R;
    expect(r.removida).toBe('padaria sao jose');
  });

  it('relatório de uma subcategoria divide pela própria subcategoria', async () => {
    const r = (await executeTool(t.db, 'spending_report', { period_start: '2026-07-01', period_end: '2026-07-31', category_name: 'passagens' })) as R;
    expect((r.divisao as { grupo: string }[]).map((g) => g.grupo)).toEqual(['Passagens']);
  });

  it('delete_rule desativa a regra', async () => {
    const r = (await executeTool(t.db, 'delete_rule', { merchant_pattern: 'amazon' })) as R;
    expect(r.removida).toBe('amazon');
    const regras = (await executeTool(t.db, 'list_category_rules', {})) as { regras: { padrao: string }[] };
    expect(regras.regras.map((x) => x.padrao)).not.toContain('amazon');
  });

  it('mark_receivable por id e list_receivables', async () => {
    const id = await insertTx(t.db, t.ownerId, { amount: 300, description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' });
    const r = (await executeTool(t.db, 'mark_receivable', { id, amount: 150, who: 'Pedro' })) as R;
    expect(r).toMatchObject({ valor: '150.00', quem: 'pedro' });
    const l = (await executeTool(t.db, 'list_receivables', {})) as { a_receber: unknown[] };
    expect(l.a_receber).toHaveLength(1);
  });
});
