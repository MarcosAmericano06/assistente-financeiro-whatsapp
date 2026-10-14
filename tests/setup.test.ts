import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { applySetup } from '../src/setup/apply.js';
import { getFamilyPatterns, getOwnNames } from '../src/finance/family.js';
import { getProjects } from '../src/tasks/tasks.js';
import { createTestDb, type TestDb } from './helpers/db.js';

describe('setup do dono', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.close());

  it('grava nome, família, projetos, taxonomia e regras de fatura — e repetir não duplica', async () => {
    const cfg = {
      ownerName: 'Joana',
      ownNames: ['Joana da Silva'],
      family: ['Maria da Silva', 'Pedro da Silva', 'x'],
      projects: ['Trabalho', 'Pessoal'],
      cardPaymentPatterns: ['PAGAMENTO DE FATURA', 'Pagamento para Banco Exemplo'],
    };
    const r1 = await applySetup(t.db, cfg);
    expect(r1.categoriasCriadas).toBeGreaterThan(50);
    expect(r1.regrasDeFatura).toBe(2);
    expect(await getOwnNames(t.db)).toEqual(['joana da silva']);
    expect(await getFamilyPatterns(t.db)).toEqual(['maria da silva', 'pedro da silva']);
    expect(await getProjects(t.db)).toEqual(['Trabalho', 'Pessoal']);
    const r2 = await applySetup(t.db, cfg);
    expect(r2).toMatchObject({ categoriasCriadas: 0, regrasDeFatura: 0 });
    expect((await t.db.execute(sql`select name from users where role='owner'`))[0]).toEqual({ name: 'Joana' });
  });
});
