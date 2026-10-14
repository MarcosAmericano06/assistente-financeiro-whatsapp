import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { markReceivable, findReturnMatches, confirmReturn, rejectReturn, cancelReceivable, settleReceivable } from '../src/finance/receivables.js';
import { newBatchId, undoLastBatch } from '../src/finance/audit.js';
import { netSpending } from '../src/finance/spending.js';
import { seedTaxonomy } from '../src/finance/taxonomy.js';
import { createTestDb, insertTx, type TestDb } from './helpers/db.js';

const ctx = () => ({ batchId: newBatchId(), origin: 'chat' });
const rec = async (t: TestDb, id: string) =>
  (await t.db.execute(sql`select status, amount::text, counterparty, settlement_transaction_id::text as liquidacao from receivables where id=${id}::uuid`))[0] as {
    status: string;
    amount: string;
    counterparty: string;
    liquidacao: string | null;
  };

describe('a receber', () => {
  let t: TestDb;
  let jantar: string;
  let recId: string;
  beforeAll(async () => {
    t = await createTestDb();
    await seedTaxonomy(t.db, t.ownerId);
    jantar = await insertTx(t.db, t.ownerId, { amount: 300, date: '2026-09-10', description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' });
  });
  afterAll(async () => t.close());

  it('parcial: "o Pedro vai me devolver 150" — só a parte dele sai do gasto', async () => {
    const r = await markReceivable(t.db, ctx(), jantar, { amount: 150, who: 'Pedro' });
    recId = r.receivableId;
    expect(await rec(t, recId)).toMatchObject({ status: 'open', amount: '150.00', counterparty: 'pedro' });
    expect((await netSpending(t.db, { start: '2026-09-01', end: '2026-09-30' })).liquido).toBe('150.00');
  });

  it('desfazer a marcação devolve o gasto inteiro', async () => {
    await undoLastBatch(t.db);
    expect((await netSpending(t.db, { start: '2026-09-01', end: '2026-09-30' })).liquido).toBe('300.00');
    expect(await t.db.execute(sql`select 1 from receivables where status='open'`)).toHaveLength(0);
    recId = (await markReceivable(t.db, ctx(), jantar, { amount: 150, who: 'Pedro' })).receivableId;
  });

  it('PIX recebido do Pedro com o mesmo valor é proposto como devolução; outro valor não', async () => {
    await insertTx(t.db, t.ownerId, { type: 'income', amount: 149, date: '2026-09-12', description: 'Pix recebido - Pedro Luis Silva', category: 'PIX recebido' });
    const pix = await insertTx(t.db, t.ownerId, { type: 'income', amount: 150, date: '2026-09-12', description: 'Pix recebido - Pedro Luis Silva', category: 'PIX recebido' });
    const m = await findReturnMatches(t.db);
    expect(m).toEqual([expect.objectContaining({ receivableId: recId, transactionId: pix })]);

    await rejectReturn(t.db, ctx(), recId, pix);
    expect(await findReturnMatches(t.db)).toEqual([]);
  });

  it('confirmada a devolução, a entrada não conta como receita e o a receber é baixado', async () => {
    const pix2 = await insertTx(t.db, t.ownerId, { type: 'income', amount: 150, date: '2026-09-15', description: 'Pix recebido - Pedro Luis Silva', category: 'PIX recebido' });
    expect((await findReturnMatches(t.db))[0]!.transactionId).toBe(pix2);
    await confirmReturn(t.db, ctx(), recId, pix2);
    expect(await rec(t, recId)).toMatchObject({ status: 'received', liquidacao: pix2 });
    const tipo = (await t.db.execute(sql`select type from transactions where id=${pix2}::uuid`))[0];
    expect(tipo).toEqual({ type: 'transfer' });
  });

  it('"não vai voltar": a parte volta a ser gasto; "recebi por fora": só baixa', async () => {
    const outro = await insertTx(t.db, t.ownerId, { amount: 100, date: '2026-09-20', description: 'BAR', category: 'Restaurantes e bares', account: 'card' });
    const a = (await markReceivable(t.db, ctx(), outro, { who: 'Joao' })).receivableId;
    expect((await netSpending(t.db, { start: '2026-09-20', end: '2026-09-20' })).liquido).toBe('0.00');
    await cancelReceivable(t.db, ctx(), a);
    expect((await rec(t, a)).status).toBe('cancelled');
    expect((await netSpending(t.db, { start: '2026-09-20', end: '2026-09-20' })).liquido).toBe('100.00');

    const b = (await markReceivable(t.db, ctx(), outro, { who: 'Joao' })).receivableId;
    await settleReceivable(t.db, ctx(), b);
    expect((await rec(t, b)).status).toBe('received');
  });
});
