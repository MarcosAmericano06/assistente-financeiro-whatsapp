import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { findFamilyPairs, getFamilyPatterns, pairFamilyTransfers, DEFAULT_FAMILY_PATTERNS, type FamilyLeg } from '../src/finance/family.js';
import { setSetting } from '../src/finance/settings.js';
import { createTestDb, insertTx, getTx, TEST_FAMILY, type TestDb } from './helpers/db.js';

const P = TEST_FAMILY;
const leg = (id: string, direction: 'in' | 'out', amount: string, date: string, text: string): FamilyLeg => ({
  id,
  direction,
  amount,
  date,
  text,
});

describe('findFamilyPairs', () => {
  it('mesmo valor entrando e saindo com a mesma pessoa no mesmo dia é repasse', () => {
    const pairs = findFamilyPairs(
      [
        leg('a', 'in', '18000.00', '2026-03-16', 'Pix recebido - Joana Exemplo Silva'),
        leg('b', 'out', '18000.00', '2026-03-16', 'Pix enviado  - Joana Exemplo Silva'),
      ],
      P,
    );
    expect(pairs).toEqual([['b', 'a']]);
  });

  it('repasse entre pessoas diferentes da família também conta (recebe da Joana, envia ao Pedro)', () => {
    const pairs = findFamilyPairs(
      [
        leg('in', 'in', '1800.00', '2026-08-11', 'Pix recebido - Joana Exemplo Silva'),
        leg('out', 'out', '1800.00', '2026-08-11', 'Pix enviado  - Pedro Exemplo Silva'),
      ],
      P,
    );
    expect(pairs).toHaveLength(1);
  });

  it('PIX de família sem perna oposta não vira repasse', () => {
    expect(findFamilyPairs([leg('a', 'out', '300.00', '2026-08-24', 'Pix enviado  - Lucas Exemplo Silva')], P)).toEqual([]);
  });

  it('valor diferente ou mais de 3 dias de distância não pareia', () => {
    const base = leg('a', 'out', '600.00', '2026-02-13', 'Pix enviado  - Joana Exemplo Silva');
    expect(findFamilyPairs([base, leg('b', 'in', '599.00', '2026-02-13', 'Pix recebido - Joana Exemplo Silva')], P)).toEqual([]);
    expect(findFamilyPairs([base, leg('c', 'in', '600.00', '2026-02-17', 'Pix recebido - Joana Exemplo Silva')], P)).toEqual([]);
  });

  it('cada perna é usada uma vez só', () => {
    const pairs = findFamilyPairs(
      [
        leg('o1', 'out', '600.00', '2026-02-13', 'Pix enviado  - Joana Exemplo Silva'),
        leg('o2', 'out', '600.00', '2026-02-13', 'Pix enviado  - Joana Exemplo Silva'),
        leg('i1', 'in', '600.00', '2026-02-13', 'Pix recebido - Joana Exemplo Silva'),
      ],
      P,
    );
    expect(pairs).toHaveLength(1);
  });

  it('quem não é da família não pareia', () => {
    const pairs = findFamilyPairs(
      [
        leg('a', 'out', '250.00', '2026-08-15', 'Pix enviado  - Matheus Souza'),
        leg('b', 'in', '250.00', '2026-08-15', 'Pix recebido - Matheus Souza'),
      ],
      P,
    );
    expect(pairs).toEqual([]);
  });
});

describe('getFamilyPatterns', () => {
  it('ignora preferência inválida (sem família configurada, nada é repasse)', async () => {
    const t = await createTestDb();
    try {
      await setSetting(t.db, t.ownerId, 'family_patterns', 'joana');
      expect(await getFamilyPatterns(t.db)).toEqual(DEFAULT_FAMILY_PATTERNS);
      await setSetting(t.db, t.ownerId, 'family_patterns', ['Joana Exemplo', 42]);
      expect(await getFamilyPatterns(t.db)).toEqual(['Joana Exemplo']);
    } finally {
      await t.close();
    }
  });
});

describe('pairFamilyTransfers (banco)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.close());

  it('marca as duas pernas como transferência ligadas pelo mesmo grupo, com registro no audit_log', async () => {
    const out = await insertTx(t.db, t.ownerId, { type: 'expense', amount: 18000, date: '2026-03-16', description: 'Pix enviado  - Joana Exemplo Silva', rawAmount: -18000 });
    const inn = await insertTx(t.db, t.ownerId, { type: 'income', amount: 18000, date: '2026-03-16', description: 'Pix recebido - Joana Exemplo Silva', rawAmount: 18000 });
    const sozinho = await insertTx(t.db, t.ownerId, { type: 'expense', amount: 300, date: '2026-08-24', description: 'Pix enviado  - Lucas Exemplo Silva', rawAmount: -300 });

    const r = await pairFamilyTransfers(t.db, { batchId: '00000000-0000-4000-8000-000000000001', origin: 'test' });
    expect(r.pairs).toBe(1);

    const [a, b, c] = [await getTx(t.db, out), await getTx(t.db, inn), await getTx(t.db, sozinho)];
    expect(a.type).toBe('transfer');
    expect(b.type).toBe('transfer');
    expect(a.transfer_group_id).not.toBeNull();
    expect(a.transfer_group_id).toBe(b.transfer_group_id);
    expect(c.type).toBe('expense');

    const audit = await t.db.execute(sql`select entity_id, before->>'type' as antes, after->>'type' as depois from audit_log where batch_id='00000000-0000-4000-8000-000000000001'`);
    expect(audit).toHaveLength(2);
  });

  it('perna já marcada como transferência (sinal no raw) pareia com a receita', async () => {
    const out = await insertTx(t.db, t.ownerId, { type: 'transfer', amount: 1800, date: '2026-08-11', description: 'Pix enviado  - Pedro Exemplo Silva', rawAmount: -1800, categorySource: 'manual' });
    const inn = await insertTx(t.db, t.ownerId, { type: 'income', amount: 1800, date: '2026-08-11', description: 'Pix recebido - Joana Exemplo Silva', rawAmount: 1800 });
    await pairFamilyTransfers(t.db, { origin: 'test' });
    expect((await getTx(t.db, inn)).type).toBe('transfer');
    expect((await getTx(t.db, out)).transfer_group_id).toBe((await getTx(t.db, inn)).transfer_group_id);
  });

  it('gasto da família que o dono classificou à mão não vira repasse', async () => {
    const gasto = await insertTx(t.db, t.ownerId, { type: 'expense', amount: 250, date: '2026-09-01', description: 'Pix enviado  - Lucas Exemplo Silva', category: 'Modalidades', categorySource: 'manual', rawAmount: -250 });
    await insertTx(t.db, t.ownerId, { type: 'income', amount: 250, date: '2026-09-02', description: 'Pix recebido - Lucas Exemplo Silva', rawAmount: 250 });
    await pairFamilyTransfers(t.db, { origin: 'test' });
    expect((await getTx(t.db, gasto)).type).toBe('expense');
  });

  it('com since, só considera pernas recentes', async () => {
    await insertTx(t.db, t.ownerId, { type: 'expense', amount: 77, date: '2025-01-10', description: 'Pix enviado  - Joana Exemplo Silva', rawAmount: -77 });
    await insertTx(t.db, t.ownerId, { type: 'income', amount: 77, date: '2025-01-10', description: 'Pix recebido - Joana Exemplo Silva', rawAmount: 77 });
    expect((await pairFamilyTransfers(t.db, { origin: 'test', since: '2026-01-01', apply: false })).pairs).toBe(0);
    expect((await pairFamilyTransfers(t.db, { origin: 'test', apply: false })).pairs).toBe(1);
  });

  it('é idempotente: a segunda execução não muda nada', async () => {
    await pairFamilyTransfers(t.db, { origin: 'test' });
    const r = await pairFamilyTransfers(t.db, { origin: 'test' });
    expect(r.pairs).toBe(0);
  });
});
