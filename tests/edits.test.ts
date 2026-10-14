import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { saveList } from '../src/finance/lists.js';
import { editListItems, suggestPattern } from '../src/finance/edits.js';
import { undoLastBatch } from '../src/finance/audit.js';
import { seedTaxonomy } from '../src/finance/taxonomy.js';
import { createTestDb, insertTx, type TestDb } from './helpers/db.js';

const tx = async (t: TestDb, id: string) =>
  (await t.db.execute(sql`
    select t.type, t.amount::text, t.deleted_at is not null as apagada, c.name as categoria, t.category_source as fonte
    from transactions t left join categories c on c.id=t.category_id where t.id=${id}::uuid`))[0] as {
    type: string;
    amount: string;
    apagada: boolean;
    categoria: string | null;
    fonte: string | null;
  };

describe('suggestPattern', () => {
  it('tira prefixos de PIX/pagamento e fica com o nome', () => {
    expect(suggestPattern('Pix enviado  - Matheus Souza', null)).toBe('matheus souza');
    expect(suggestPattern('OUTBACK MORUMBI', 'Outback')).toBe('outback');
    expect(suggestPattern('Pagamento para ITAU UNIBANCO HOLDING S.A.', null)).toBe('itau unibanco holding s.a.');
  });
});

describe('edição pelo número da lista', () => {
  let t: TestDb;
  const ids: string[] = [];
  beforeAll(async () => {
    t = await createTestDb();
    await seedTaxonomy(t.db, t.ownerId);
    ids.push(await insertTx(t.db, t.ownerId, { amount: 57.5, description: 'CINEMARK', category: 'Festas e eventos', account: 'card' }));
    ids.push(await insertTx(t.db, t.ownerId, { amount: 300, description: 'Pix enviado  - Lucas Exemplo Silva', category: 'PIX enviado' }));
    ids.push(await insertTx(t.db, t.ownerId, { amount: 89, description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' }));
    ids.push(await insertTx(t.db, t.ownerId, { amount: 45, description: 'IFOOD', category: 'Delivery', account: 'card' }));
    ids.push(await insertTx(t.db, t.ownerId, { type: 'card_payment', amount: 5763.86, description: 'Pagamento para BANCO XP S.A' }));
    await insertTx(t.db, t.ownerId, { amount: 120, date: '2026-08-01', description: 'OUTBACK', category: 'Restaurantes e bares', account: 'card' });
    await saveList(t.db, 'weekly', 'semana antiga', [{ n: 1, kind: 'tx', transactionId: ids[0]! }]);
    await saveList(
      t.db,
      'daily',
      'gastos de hoje',
      ids.map((id, i) => ({ n: i + 1, kind: 'tx' as const, transactionId: id })),
    );
  });
  afterAll(async () => t.close());

  it('"1 para alimentação": nome de pai fica no pai, marcado como escolha do dono', async () => {
    const r = await editListItems(t.db, { changes: [{ n: 1, acao: 'categoria', categoria: 'alimentação' }] });
    expect(r.resultados[0]).toMatchObject({ n: 1, ok: true });
    expect(await tx(t, ids[0]!)).toMatchObject({ categoria: 'Alimentação', fonte: 'manual' });
  });

  it('categoria desconhecida não altera nada e devolve sugestões', async () => {
    const r = await editListItems(t.db, { changes: [{ n: 4, acao: 'categoria', categoria: 'astrologia' }] });
    expect(r.resultados[0]).toMatchObject({ n: 4, ok: false });
    expect(r.resultados[0]!.sugestoes!.length).toBeGreaterThan(0);
    expect((await tx(t, ids[3]!)).categoria).toBe('Delivery');
  });

  it('várias alterações num comando: não é gasto, valor e categoria com sugestão de regra', async () => {
    const r = await editListItems(t.db, {
      changes: [
        { n: 2, acao: 'nao_e_gasto' },
        { n: 4, acao: 'valor', valor: 80 },
        { n: 3, acao: 'categoria', categoria: 'delivery' },
      ],
    });
    expect(r.resultados.every((x) => x.ok)).toBe(true);
    expect((await tx(t, ids[1]!)).type).toBe('transfer');
    expect((await tx(t, ids[3]!)).amount).toBe('80.00');
    expect((await tx(t, ids[2]!)).categoria).toBe('Delivery');
    // Outback já apareceu antes: o bot deve perguntar "só esse ou sempre?"
    expect(r.resultados.find((x) => x.n === 3)!.sugerir_regra).toBe('outback');
  });

  it('"desfaz" reverte o último comando inteiro', async () => {
    const r = await undoLastBatch(t.db);
    expect(r.desfeitas).toBe(3);
    expect((await tx(t, ids[1]!)).type).toBe('expense');
    expect((await tx(t, ids[3]!)).amount).toBe('45.00');
    expect((await tx(t, ids[2]!)).categoria).toBe('Restaurantes e bares');
    expect((await tx(t, ids[0]!)).categoria).toBe('Alimentação'); // comando anterior continua
  });

  it('duplicado sai das contas; voltar a contar traz a fatura para o gasto como "A classificar"', async () => {
    await editListItems(t.db, { changes: [{ n: 4, acao: 'duplicado' }, { n: 5, acao: 'voltar_a_contar' }] });
    expect((await tx(t, ids[3]!)).apagada).toBe(true);
    expect(await tx(t, ids[4]!)).toMatchObject({ type: 'expense', categoria: 'A classificar' });
  });

  it('"voltar a contar" num estorno não vira gasto (não inverte o sinal)', async () => {
    const est = await insertTx(t.db, t.ownerId, { type: 'refund', amount: 30, description: 'LATAM DCP', category: 'Passagens', account: 'card' });
    await saveList(t.db, 'daily', 'com estorno', [{ n: 1, kind: 'tx', transactionId: est }]);
    const r = await editListItems(t.db, { changes: [{ n: 1, acao: 'voltar_a_contar' }] });
    expect(r.resultados[0]!.ok).toBe(true);
    expect((await tx(t, est)).type).toBe('refund');
    await saveList(t.db, 'daily', 'gastos de hoje', ids.map((id, i) => ({ n: i + 1, kind: 'tx' as const, transactionId: id })));
  });

  it('desfazer é atômico: se uma linha falha, nada do lote é revertido', async () => {
    await editListItems(t.db, { changes: [{ n: 1, acao: 'valor', valor: 11 }, { n: 3, acao: 'valor', valor: 12 }] });
    // corrompe a PRIMEIRA linha do lote (revertida por último): a outra já teria sido revertida
    const [{ batch }] = (await t.db.execute(sql`
      select batch_id::text as batch from audit_log where origin='chat' and undone_at is null order by seq desc limit 1`)) as unknown as [{ batch: string }];
    await t.db.execute(sql`
      update audit_log set before = before - 'amount' - 'type'
      where seq = (select min(seq) from audit_log where batch_id=${batch}::uuid)`);
    await expect(undoLastBatch(t.db)).rejects.toThrow();
    expect((await tx(t, ids[0]!)).amount).toBe('11.00');
    expect((await tx(t, ids[2]!)).amount).toBe('12.00');
    await t.db.execute(sql`update audit_log set undone_at = now() where batch_id=${batch}::uuid`);
  });

  it('número inexistente vira erro claro; outra lista pode ser citada', async () => {
    const r = await editListItems(t.db, { changes: [{ n: 9, acao: 'nao_e_gasto' }] });
    expect(r.resultados[0]).toMatchObject({ n: 9, ok: false });
    expect(r.resultados[0]!.erro).toMatch(/9/);
    const sem = await editListItems(t.db, { lista: 'semanal', changes: [{ n: 1, acao: 'valor', valor: 46 }] });
    expect(sem.resultados[0]!.ok).toBe(true);
    expect((await tx(t, ids[0]!)).amount).toBe('46.00');
  });
});
