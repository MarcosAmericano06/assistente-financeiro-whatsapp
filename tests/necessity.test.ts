import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedTaxonomy } from '../src/finance/taxonomy.js';
import { netSpending, netSpendingByGroup } from '../src/finance/spending.js';
import { upsertRule } from '../src/finance/rules.js';
import { saveList } from '../src/finance/lists.js';
import { editListItems } from '../src/finance/edits.js';
import { undoLastBatch } from '../src/finance/audit.js';
import { buildDailyList } from '../src/finance/daily-list.js';
import { buildWeeklyReport } from '../src/finance/weekly-report.js';
import { syncItem } from '../src/ingestion/sync.js';
import { executeTool } from '../src/ai/tools.js';
import type { PluggyClient } from '../src/ingestion/pluggy-client.js';
import { createTestDb, insertTx, type TestDb } from './helpers/db.js';

const defaultOf = async (t: TestDb, name: string) =>
  ((await t.db.execute(sql`select default_necessity as d from categories where name=${name} and active`))[0] as { d: string | null }).d;
const necOf = async (t: TestDb, id: string) =>
  (await t.db.execute(sql`select necessity, necessity_source from transactions where id=${id}::uuid`))[0] as {
    necessity: string | null;
    necessity_source: string | null;
  };

describe('necessário, desnecessário ou doação', () => {
  let t: TestDb;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    t = await createTestDb();
    await seedTaxonomy(t.db, t.ownerId);
    const o = t.ownerId;
    const d = '2026-09-10';
    ids.mercado = await insertTx(t.db, o, { amount: 100, date: d, description: 'EMPORIO ITAIM', category: 'Mercado', account: 'card' });
    ids.bar = await insertTx(t.db, o, { amount: 50, date: d, description: 'BAR E LANCHES BARAO', category: 'Restaurantes e bares', account: 'card' });
    ids.barEstorno = await insertTx(t.db, o, { type: 'refund', amount: 10, date: d, description: 'BAR E LANCHES BARAO', category: 'Restaurantes e bares', account: 'card' });
    ids.familia = await insertTx(t.db, o, { amount: 30, date: d, description: 'Pix enviado  - Rafael', category: 'Família' });
    ids.aClassificar = await insertTx(t.db, o, { amount: 20, date: d, description: 'Pix enviado  - Fulano', category: 'PIX enviado' });
    ids.almoco = await insertTx(t.db, o, { amount: 40, date: d, description: 'BAR E LANCHES BARAO', category: 'Restaurantes e bares', account: 'card' });
    await t.db.execute(sql`update transactions set necessity='necessario', necessity_source='manual' where id=${ids.almoco}::uuid`);
  });
  afterAll(async () => t.close());

  it('a taxonomia traz a marca padrão aprovada; o pai só tem padrão quando os filhos concordam', async () => {
    expect(await defaultOf(t, 'Mercado')).toBe('necessario');
    expect(await defaultOf(t, 'Restaurantes e bares')).toBe('desnecessario');
    expect(await defaultOf(t, 'Família')).toBe('doacao');
    expect(await defaultOf(t, 'Multas')).toBe('desnecessario');
    expect(await defaultOf(t, 'A classificar')).toBeNull();
    expect(await defaultOf(t, 'PIX enviado')).toBeNull();
    expect(await defaultOf(t, 'Saúde')).toBe('necessario');
    expect(await defaultOf(t, 'Seguros')).toBe('necessario');
    expect(await defaultOf(t, 'Alimentação')).toBeNull();
  });

  it('soma por marca: a do gasto vence a da categoria, estorno abate, sem marca aparece', async () => {
    const rows = await netSpendingByGroup(t.db, { start: '2026-09-01', end: '2026-09-30', group: 'necessity' });
    expect(Object.fromEntries(rows.map((r) => [r.grupo, r.total]))).toEqual({
      necessario: '140.00',
      desnecessario: '40.00',
      doacao: '30.00',
      sem_marca: '20.00',
    });
    expect((await netSpending(t.db, { start: '2026-09-01', end: '2026-09-30', necessity: 'desnecessario' })).liquido).toBe('40.00');
  });

  it('pelo número: "2 necessário", "4 doação"; pergunta "sempre?" e desfaz', async () => {
    await saveList(t.db, 'daily', 'lista', Object.values(ids).map((id, i) => ({ n: i + 1, kind: 'tx' as const, transactionId: id })));
    const r = await editListItems(t.db, { changes: [{ n: 2, acao: 'necessario' }, { n: 5, acao: 'doacao' }] });
    expect(r.resultados.every((x) => x.ok)).toBe(true);
    expect(await necOf(t, ids.bar!)).toEqual({ necessity: 'necessario', necessity_source: 'manual' });
    expect(await necOf(t, ids.aClassificar!)).toEqual({ necessity: 'doacao', necessity_source: 'manual' });
    expect(r.resultados.find((x) => x.n === 2)!.sugerir_regra).toBe('bar e lanches barao');
    await undoLastBatch(t.db);
    expect((await necOf(t, ids.bar!)).necessity).toBeNull();
  });

  it('regra de categoria existente não impede perguntar "sempre?" para a marca', async () => {
    const outback = await insertTx(t.db, t.ownerId, { amount: 90, date: '2026-09-11', description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' });
    await insertTx(t.db, t.ownerId, { amount: 80, date: '2026-08-11', description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' });
    const rest = ((await t.db.execute(sql`select id::text from categories where name='Restaurantes e bares' and active`))[0] as { id: string }).id;
    await upsertRule(t.db, t.ownerId, { pattern: 'outback', categoryId: rest });
    await saveList(t.db, 'daily', 'outback', [{ n: 1, kind: 'tx', transactionId: outback }]);
    const r = await editListItems(t.db, { changes: [{ n: 1, acao: 'necessario' }] });
    expect(r.resultados[0]).toMatchObject({ sugerir_regra: 'outback', regra_para: 'marca' });
    const c = await editListItems(t.db, { changes: [{ n: 1, acao: 'categoria', categoria: 'delivery' }] });
    expect(c.resultados[0]!.sugerir_regra).toBeUndefined(); // categoria já tem regra para outback
  });

  it('"sempre": regra de marca vale para o que entra pelo banco', async () => {
    await upsertRule(t.db, t.ownerId, { pattern: 'bar e lanches barao', setNecessity: 'necessario' });
    const pluggy = {
      fetchAccounts: async () => [{ id: 'c1', itemId: 'i', type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'XP', marketingName: null, number: '1', balance: 0, currencyCode: 'BRL', creditData: null }],
      fetchAllTransactions: async () => [
        { id: 'n1', accountId: 'c1', date: '2026-09-20T00:00:00.000Z', description: 'BAR E LANCHES BARAO', amount: 44, currencyCode: 'BRL', category: 'Eating out', status: 'POSTED' },
      ],
    } as unknown as PluggyClient;
    await syncItem(t.db, pluggy, 'i');
    const [row] = (await t.db.execute(sql`select necessity, necessity_source from transactions where external_id='n1'`)) as unknown as {
      necessity: string;
      necessity_source: string;
    }[];
    expect(row).toEqual({ necessity: 'necessario', necessity_source: 'rule' });
  });

  it('lista diária mostra o símbolo de cada gasto e ❓ quando não tem marca', async () => {
    await t.db.execute(sql`delete from message_lists`);
    const r = await buildDailyList(t.db);
    expect(r!.text).toMatch(/EMPORIO ITAIM · Mercado 🟢/);
    expect(r!.text).toMatch(/Rafael · Família 🎁/);
    expect(r!.text).toMatch(/PIX Fulano · PIX enviado ❓/);
    expect(r!.text).toMatch(/BAR E LANCHES BARAO · Restaurantes e bares 🔴/);
  });

  it('relatório semanal traz total e % de cada marca', async () => {
    const o = t.ownerId;
    await insertTx(t.db, o, { amount: 75, date: '2026-10-05', description: 'MERCADO', category: 'Mercado', account: 'card' });
    await insertTx(t.db, o, { amount: 25, date: '2026-10-06', description: 'IFOOD', category: 'Delivery', account: 'card' });
    const r = await buildWeeklyReport(t.db, new Date('2026-10-11T12:00:00Z'));
    expect(r.text).toMatch(/🟢 Necessário R\$\s?75,00 \(75%\) · 🔴 Desnecessário R\$\s?25,00 \(25%\)/);
  });

  it('tools: agrupar e filtrar por marca; regra "sempre" de marca pela conversa', async () => {
    const g = (await executeTool(t.db, 'query_spending', { period_start: '2026-10-01', period_end: '2026-10-31', group_by: 'necessity' })) as {
      grupos: { grupo: string; total: string }[];
    };
    expect(g.grupos.map((x) => x.grupo).sort()).toEqual(['desnecessario', 'necessario']);
    const f = await executeTool(t.db, 'query_spending', { period_start: '2026-10-01', period_end: '2026-10-31', necessity: 'desnecessario' });
    expect(f.total_brl).toBe('25.00');
    const rel = (await executeTool(t.db, 'spending_report', { period_start: '2026-10-01', period_end: '2026-10-31' })) as { por_necessidade: unknown[] };
    expect(rel.por_necessidade).toHaveLength(2);
    const r = (await executeTool(t.db, 'set_category_rule', { merchant_pattern: 'ifood', set_necessity: 'necessario' })) as {
      regra_criada: { necessidade: string };
    };
    expect(r.regra_criada.necessidade).toBe('necessario');
  });
});
