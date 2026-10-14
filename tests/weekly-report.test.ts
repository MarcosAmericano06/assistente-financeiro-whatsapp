import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { previousWeek, buildWeeklyReport } from '../src/finance/weekly-report.js';
import { latestList } from '../src/finance/lists.js';
import { seedTaxonomy } from '../src/finance/taxonomy.js';
import { createTestDb, insertTx, type TestDb } from './helpers/db.js';

describe('semana anterior (domingo a sábado)', () => {
  it('no domingo de manhã, é a semana que terminou ontem', () => {
    expect(previousWeek(new Date('2026-10-11T12:00:00Z'))).toEqual({ start: '2026-10-04', end: '2026-10-10' });
  });
  it('no meio da semana, continua sendo a última semana fechada', () => {
    expect(previousWeek(new Date('2026-10-14T15:00:00Z'))).toEqual({ start: '2026-10-04', end: '2026-10-10' });
  });
});

describe('relatório semanal', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await seedTaxonomy(t.db, t.ownerId);
    const o = t.ownerId;
    // semana do relatório (04 a 10/10)
    await insertTx(t.db, o, { amount: 600, date: '2026-10-04', description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' });
    await insertTx(t.db, o, { amount: 200, date: '2026-10-06', description: 'IFOOD', category: 'Delivery', account: 'card' });
    await insertTx(t.db, o, { amount: 150, date: '2026-10-10', description: 'POSTO', category: 'Combustível', account: 'card' });
    await insertTx(t.db, o, { type: 'refund', amount: 50, date: '2026-10-07', description: 'IFOOD ESTORNO', category: 'Delivery', account: 'card' });
    await insertTx(t.db, o, { type: 'card_payment', amount: 5000, date: '2026-10-05', description: 'PAGAMENTO DE FATURA', rawAmount: -5000 });
    await insertTx(t.db, o, { amount: 999, date: '2026-10-11', description: 'fora (domingo seguinte)', category: 'Mercado', account: 'card' });
    // 4 semanas anteriores: 1000 cada → média 1000
    for (const d of ['2026-09-29', '2026-09-22', '2026-09-15', '2026-09-08']) {
      await insertTx(t.db, o, { amount: 1000, date: d, description: 'MERCADO', category: 'Mercado', account: 'card' });
    }
  });
  afterAll(async () => t.close());

  it('traz total, comparação, categorias, lista numerada e o que não contou', async () => {
    const r = await buildWeeklyReport(t.db, new Date('2026-10-11T12:00:00Z'));
    const txt = r.text;
    expect(txt).toMatch(/Semana de 04\/10 a 10\/10/);
    expect(txt).toMatch(/R\$\s?900,00/); // 600 + 200 + 150 - 50
    expect(txt).toMatch(/média das 4 semanas anteriores: R\$\s?1\.000,00 · 10% abaixo/);
    expect(txt).toMatch(/Alimentação R\$\s?750,00 — Restaurantes e bares R\$\s?600,00 · Delivery R\$\s?150,00/);
    expect(txt).toMatch(/Carro R\$\s?150,00/);
    expect(txt).toMatch(/1\. R\$\s?600,00 · OUTBACK · Restaurantes e bares/);
    expect(txt).toMatch(/fatura R\$\s?5\.000,00/);
    expect(txt).not.toMatch(/fora \(domingo seguinte\)/);
    expect((await latestList(t.db, 'semanal'))!.items).toHaveLength(4);
  });
});
