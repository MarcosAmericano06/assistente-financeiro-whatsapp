import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { netSpending, netSpendingByGroup } from '../src/finance/spending.js';
import { seedTaxonomy, resolveCategory, categoryScope } from '../src/finance/taxonomy.js';
import { createTestDb, insertTx, type TestDb } from './helpers/db.js';

describe('gasto líquido', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    const db = t.db;
    const o = t.ownerId;
    await seedTaxonomy(db, o);
    await insertTx(db, o, { type: 'expense', amount: 100, description: 'LATAM AIR', category: 'Passagens', account: 'card' });
    await insertTx(db, o, { type: 'expense', amount: 40, description: 'HOTEL', category: 'Hospedagem', account: 'card' });
    await insertTx(db, o, { type: 'expense', amount: 50, description: 'IFOOD', category: 'Delivery', account: 'card' });
    await insertTx(db, o, { type: 'refund', amount: 30, description: 'LATAM DCP', category: 'Passagens', account: 'card' });
    await insertTx(db, o, { type: 'card_payment', amount: 1000, description: 'PAGAMENTO DE FATURA' });
    await insertTx(db, o, { type: 'transfer', amount: 500, description: 'Pix enviado para Dono Exemplo Silva' });
    await insertTx(db, o, { type: 'expense', amount: 999, description: 'fora do período', date: '2026-08-01', category: 'Delivery' });
    const del = await insertTx(db, o, { type: 'expense', amount: 777, description: 'apagada', category: 'Delivery' });
    await db.execute(sql`update transactions set deleted_at=now() where id=${del}::uuid`);
  });
  afterAll(async () => t.close());

  it('estornos abatem; fatura, transferência, fora do período e apagadas não entram', async () => {
    const r = await netSpending(t.db, { start: '2026-09-01', end: '2026-09-30' });
    expect(r).toMatchObject({ liquido: '160.00', gastos: '190.00', estornos: '30.00' });
  });

  it('filtrar por um pai soma os filhos e abate o estorno', async () => {
    const viagens = (await resolveCategory(t.db, 'viagem')).category!;
    const r = await netSpending(t.db, { start: '2026-09-01', end: '2026-09-30', categoryIds: await categoryScope(t.db, viagens.id) });
    expect(r.liquido).toBe('110.00'); // 100 + 40 - 30
  });

  it('agrupado por subcategoria, o estorno abate dentro da própria categoria', async () => {
    const rows = await netSpendingByGroup(t.db, { start: '2026-09-01', end: '2026-09-30', group: 'category' });
    expect(Object.fromEntries(rows.map((r) => [r.grupo, r.total]))).toEqual({ Passagens: '70.00', Delivery: '50.00', Hospedagem: '40.00' });
  });

  it('agrupado por categoria principal soma os filhos', async () => {
    const rows = await netSpendingByGroup(t.db, { start: '2026-09-01', end: '2026-09-30', group: 'parent' });
    expect(Object.fromEntries(rows.map((r) => [r.grupo, r.total]))).toEqual({ Viagens: '110.00', Alimentação: '50.00' });
  });
});
