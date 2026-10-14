import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedTaxonomy, resolveCategory, categoryScope, migrateLegacyCategories } from '../src/finance/taxonomy.js';
import { upsertRule } from '../src/finance/rules.js';
import { createTestDb, ensureCategory, insertTx, type TestDb } from './helpers/db.js';

const catOf = async (t: TestDb, id: string) =>
  (await t.db.execute(sql`
    select t.type, c.name as categoria, p.name as pai from transactions t
    left join categories c on c.id=t.category_id left join categories p on p.id=c.parent_id where t.id=${id}::uuid`))[0] as {
    type: string;
    categoria: string | null;
    pai: string | null;
  };

describe('taxonomia', () => {
  let t: TestDb;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb();
    const db = t.db;
    const o = t.ownerId;
    // categorias antigas como estão hoje em produção
    const eletronicos = await ensureCategory(db, o, 'Eletrônicos');
    await upsertRule(db, o, { pattern: 'amazon', categoryId: eletronicos });
    ids.restaurante = await insertTx(db, o, { amount: 50, description: 'OUTBACK', category: 'Eating out', account: 'card' });
    ids.amazon = await insertTx(db, o, { amount: 28, description: 'AMAZON MARKETPLACE', category: 'Eletrônicos', categorySource: 'rule', account: 'card' });
    ids.pix = await insertTx(db, o, { amount: 70, description: 'Pix enviado  - Fulano', category: 'Transfer - PIX' });
    ids.mensalidade = await insertTx(db, o, { amount: 35, description: 'Mensalidade - Plano do cartão', category: null });
    ids.semCategoria = await insertTx(db, o, { amount: 12, description: 'XPTO LTDA', category: null });
    ids.pixRecebido = await insertTx(db, o, { type: 'income', amount: 70, description: 'Pix recebido - Fulano', category: 'Transfer - PIX' });
    ids.reembolsoUber = await insertTx(db, o, { type: 'income', amount: 12, description: 'UBER REEMBOLSO', category: 'Taxi and ride-hailing' });
    ids.juros = await insertTx(db, o, { type: 'income', amount: 0.09, description: 'REMUNER BASICA', category: 'Interests charged' });
    ids.estorno = await insertTx(db, o, { type: 'refund', amount: 5863.63, description: 'LATAM DCP', category: 'Airport and airlines', account: 'card' });
    ids.fatura = await insertTx(db, o, { type: 'card_payment', amount: 1000, description: 'Pagamento de fatura', category: 'Credit card payment', account: 'card' });
    ids.undef = await insertTx(db, o, { type: 'transfer', amount: 10, description: 'x', category: 'undefined' });
  });
  afterAll(async () => t.close());

  it('cria a árvore em português e reaproveita categoria de mesmo nome (sem duplicar)', async () => {
    const r1 = await seedTaxonomy(t.db, t.ownerId);
    expect(r1.criadas).toBeGreaterThan(50);
    const r2 = await seedTaxonomy(t.db, t.ownerId);
    expect(r2.criadas).toBe(0);
    const eletronicos = await t.db.execute(sql`
      select c.name, p.name as pai from categories c join categories p on p.id=c.parent_id
      where c.name='Eletrônicos' and c.active`);
    expect(eletronicos).toEqual([{ name: 'Eletrônicos', pai: 'Compras' }]);
  });

  it('resolve nome, apelido, pai e ignora acento/maiúsculas', async () => {
    expect((await resolveCategory(t.db, 'restaurante')).category?.name).toBe('Restaurantes e bares');
    expect((await resolveCategory(t.db, 'ifood')).category?.name).toBe('Delivery');
    expect((await resolveCategory(t.db, 'ALIMENTACAO')).category?.name).toBe('Alimentação');
    expect((await resolveCategory(t.db, 'uber')).category?.name).toBe('Uber e táxi');
    expect((await resolveCategory(t.db, 'psicóloga')).category?.name).toBe('Terapia');
    expect((await resolveCategory(t.db, 'reembolso', 'income')).category?.name).toBe('Reembolsos');
  });

  it('nome desconhecido não cria nada e devolve sugestões', async () => {
    const r = await resolveCategory(t.db, 'astrologia');
    expect(r.category).toBeNull();
    expect(r.sugestoes.length).toBeGreaterThan(0);
  });

  it('o escopo de um pai inclui os filhos', async () => {
    const carro = (await resolveCategory(t.db, 'carro')).category!;
    const scope = await categoryScope(t.db, carro.id);
    expect(scope.length).toBe(5); // Carro + Combustível, Estacionamento, Manutenção, Multas
  });

  it('migra transações antigas para a taxonomia nova, com mudança de tipo onde a categoria era tipo', async () => {
    const r = await migrateLegacyCategories(t.db, { apply: true, origin: 'test' });
    expect(r.transacoes).toBeGreaterThan(0);
    expect(await catOf(t, ids.restaurante!)).toEqual({ type: 'expense', categoria: 'Restaurantes e bares', pai: 'Alimentação' });
    expect((await catOf(t, ids.amazon!)).categoria).toBe('Eletrônicos');
    expect((await catOf(t, ids.pix!)).categoria).toBe('PIX enviado');
    expect((await catOf(t, ids.semCategoria!)).categoria).toBe('A classificar');
    expect(await catOf(t, ids.mensalidade!)).toEqual({ type: 'expense', categoria: 'A classificar', pai: null });
    expect((await catOf(t, ids.pixRecebido!)).categoria).toBe('PIX recebido');
    expect((await catOf(t, ids.reembolsoUber!)).categoria).toBe('Reembolsos');
    expect((await catOf(t, ids.juros!)).categoria).toBe('Rendimentos');
    expect(await catOf(t, ids.estorno!)).toEqual({ type: 'refund', categoria: 'Passagens', pai: 'Viagens' });
    expect(await catOf(t, ids.fatura!)).toEqual({ type: 'card_payment', categoria: null, pai: null });
    expect(await catOf(t, ids.undef!)).toEqual({ type: 'transfer', categoria: null, pai: null });
  });

  it('desativa as categorias antigas apontando para a nova e repontua as regras', async () => {
    const velha = (await t.db.execute(sql`
      select c.active, n.name as nova from categories c left join categories n on n.id=c.merged_into where c.name='Eating out'`))[0];
    expect(velha).toEqual({ active: false, nova: 'Restaurantes e bares' });
    const regra = (await t.db.execute(sql`
      select c.name from category_rules r join categories c on c.id=r.category_id where r.merchant_pattern='amazon'`))[0];
    expect(regra).toEqual({ name: 'Eletrônicos' });
    const ativasEmIngles = await t.db.execute(sql`select name from categories where active and name in ('Eating out','Transfer - PIX','Groceries','undefined')`);
    expect(ativasEmIngles).toHaveLength(0);
  });

  it('é idempotente e grava tudo no audit_log', async () => {
    const r = await migrateLegacyCategories(t.db, { apply: true, origin: 'test' });
    expect(r.transacoes).toBe(0);
    const audit = (await t.db.execute(sql`select count(distinct batch_id)::int lotes from audit_log where origin='test'`))[0];
    expect(audit).toEqual({ lotes: 1 });
  });
});
