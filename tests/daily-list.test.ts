import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildDailyList } from '../src/finance/daily-list.js';
import { latestList } from '../src/finance/lists.js';
import { markReceivable } from '../src/finance/receivables.js';
import { newBatchId } from '../src/finance/audit.js';
import { seedTaxonomy } from '../src/finance/taxonomy.js';
import { createTestDb, insertTx, type TestDb } from './helpers/db.js';

describe('lista diária', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await seedTaxonomy(t.db, t.ownerId);
  });
  afterAll(async () => t.close());

  it('sem nada novo, não manda mensagem', async () => {
    expect(await buildDailyList(t.db)).toBeNull();
  });

  it('numera os gastos novos por dia da compra, com categoria, ❓ na dúvida e o que não contou', async () => {
    await insertTx(t.db, t.ownerId, { amount: 45.9, date: '2026-10-10', description: 'IFOOD', category: 'Delivery', account: 'card' });
    await insertTx(t.db, t.ownerId, { amount: 120, date: '2026-10-09', description: 'POSTO SHELL', category: 'Combustível', account: 'card' });
    await insertTx(t.db, t.ownerId, { amount: 89, date: '2026-10-10', description: 'Pix enviado  - Fulano Silva', category: 'PIX enviado' });
    await insertTx(t.db, t.ownerId, { amount: 300, date: '2026-10-10', description: 'Pix enviado  - Lucas Exemplo Silva', category: 'PIX enviado' });
    await insertTx(t.db, t.ownerId, { type: 'refund', amount: 30, date: '2026-10-10', description: 'LATAM DCP', category: 'Passagens', account: 'card' });
    await insertTx(t.db, t.ownerId, { type: 'card_payment', amount: 5763.86, date: '2026-10-10', description: 'Pagamento para BANCO XP S.A', rawAmount: -5763.86 });
    await insertTx(t.db, t.ownerId, { type: 'card_payment', amount: 5763.86, date: '2026-10-10', description: 'Pagamento recebido', account: 'card', rawAmount: -5763.86 });

    const r = await buildDailyList(t.db);
    expect(r).not.toBeNull();
    const txt = r!.text;
    expect(txt).toContain('R$ 524,90'); // 45,90 + 120 + 89 + 300 - 30
    expect(txt.indexOf('Sex 09/10')).toBeGreaterThan(-1);
    expect(txt.indexOf('Sex 09/10')).toBeLessThan(txt.indexOf('Sáb 10/10'));
    expect(txt).toMatch(/1\. R\$\s?120,00 · POSTO SHELL · Combustível/);
    expect(txt).toMatch(/PIX Fulano Silva · PIX enviado ❓/);
    expect(txt).toMatch(/Lucas Exemplo Silva · PIX enviado ❓ \(família: repasse ou gasto\?\)/);
    expect(txt).toMatch(/−R\$\s?30,00 · LATAM DCP · Passagens \(estorno\)/);
    expect(txt).toMatch(/Não contei/);
    expect(txt).toMatch(/BANCO XP S\.A · fatura/);
    expect(txt).not.toMatch(/Pagamento recebido/); // o lado do cartão do pagamento é ruído
    expect(txt).toMatch(/Quer alterar algum\?/);

    const list = await latestList(t.db, 'diaria');
    expect(list!.items).toHaveLength(6); // 5 contados + 1 fatura
    expect(list!.items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a lista seguinte só traz o que entrou depois, numerando de novo a partir de 1', async () => {
    expect(await buildDailyList(t.db)).toBeNull();
    await insertTx(t.db, t.ownerId, { amount: 33, date: '2026-10-11', description: 'PADARIA', category: 'Mercado', account: 'card' });
    const r = await buildDailyList(t.db);
    expect(r!.text).toMatch(/1\. R\$\s?33,00 · PADARIA · Mercado/);
    expect((await latestList(t.db))!.items).toHaveLength(1);
  });

  it('a receber: propõe a devolução que chegou e lembra uma vez depois de 30 dias', async () => {
    const jantar = await insertTx(t.db, t.ownerId, { amount: 300, date: '2026-09-01', description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' });
    const velho = await insertTx(t.db, t.ownerId, { amount: 80, date: '2026-08-01', description: 'BAR DO ZE', category: 'Restaurantes e bares', account: 'card' });
    const ctx = { batchId: newBatchId(), origin: 'chat' };
    await markReceivable(t.db, ctx, jantar, { amount: 150, who: 'Pedro' });
    const antigo = await markReceivable(t.db, ctx, velho, { who: 'Joao' });
    await buildDailyList(t.db); // consome os gastos inseridos acima
    await t.db.execute(sql`update receivables set created_at = now() - interval '31 days' where id=${antigo.receivableId}::uuid`);
    await insertTx(t.db, t.ownerId, { type: 'income', amount: 150, date: '2026-10-11', description: 'Pix recebido - Pedro Luis', category: 'PIX recebido' });

    const r = await buildDailyList(t.db);
    expect(r!.text).toMatch(/1\. Chegou R\$\s?150,00 \(PIX de Pedro Luis\).*Pedro.*OUTBACK.*"1 sim" ou "1 não"/s);
    expect(r!.text).toMatch(/2\. Joao te deve R\$\s?80,00.*BAR DO ZE.*"2 recebi" ou "2 não vai voltar"/s);
    const items = (await latestList(t.db))!.items;
    expect(items.map((i) => i.kind)).toEqual(['receivable_match', 'receivable_open']);

    // lembrete do João não se repete; a devolução continua proposta até ele responder
    const again = await buildDailyList(t.db);
    expect(again!.text).not.toMatch(/Joao te deve/);
    expect(again!.text).toMatch(/Chegou R\$\s?150,00/);
  });
});
