import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeText, pickRule, pickRules, upsertRule, loadRules, type Rule } from '../src/finance/rules.js';
import { createTestDb, ensureCategory, type TestDb } from './helpers/db.js';

const rule = (pattern: string, extra: Partial<Rule> = {}): Rule => ({
  id: pattern,
  pattern,
  categoryId: 'cat-' + pattern,
  setType: null,
  setNecessity: null,
  createdAt: new Date('2026-09-07T10:00:00Z'),
  ...extra,
});

describe('normalizeText', () => {
  it('minúsculas, sem acento e com espaços colapsados', () => {
    expect(normalizeText('  PAGAMENTO   De Fatúra ')).toBe('pagamento de fatura');
    expect(normalizeText('Itaú Unibanco São Paulo')).toBe('itau unibanco sao paulo');
  });
});

describe('pickRule', () => {
  it('o padrão mais específico (mais longo) vence', () => {
    const r = pickRule([rule('amazon'), rule('amazon prime')], 'AMAZON PRIME VIDEO');
    expect(r?.pattern).toBe('amazon prime');
  });

  it('em empate de tamanho, a regra mais recente vence', () => {
    const velha = rule('uber', { id: 'velha', categoryId: 'A', createdAt: new Date('2026-09-01') });
    const nova = rule('uber', { id: 'nova', categoryId: 'B', createdAt: new Date('2026-10-01') });
    expect(pickRule([velha, nova], 'UBER *TRIP')?.id).toBe('nova');
    expect(pickRule([nova, velha], 'UBER *TRIP')?.id).toBe('nova');
  });

  it('casa com a descrição OU com o estabelecimento', () => {
    const r = rule('mktplc');
    expect(pickRule([r], 'AMAZONMKTPLC*TOPMIXLTD', 'amazon servicos')?.id).toBe('mktplc');
    expect(pickRule([r], 'compra qualquer', 'AMAZONMKTPLC')?.id).toBe('mktplc');
  });

  it('ignora acentos e maiúsculas dos dois lados', () => {
    expect(pickRule([rule('itaú unibanco')], 'Pix enviado - ITAU UNIBANCO HOLDING S A')).not.toBeNull();
  });

  it('devolve null quando nada casa ou o texto é vazio', () => {
    expect(pickRule([rule('amazon')], 'MERCADO LIVRE')).toBeNull();
    expect(pickRule([rule('amazon')], null, undefined)).toBeNull();
  });
});

describe('pickRules (categoria e tipo independentes)', () => {
  it('regra só de tipo mais específica não esconde a regra de categoria', () => {
    const tipo = rule('itau unibanco holding', { categoryId: null, setType: 'card_payment' });
    const cat = rule('itau', { categoryId: 'Bancos' });
    const r = pickRules([tipo, cat], 'Pix enviado - Itau Unibanco Holding S A');
    expect(r.category?.categoryId).toBe('Bancos');
    expect(r.type?.setType).toBe('card_payment');
  });
});

describe('upsertRule (banco)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.close());

  it('o mesmo padrão não duplica: a segunda chamada atualiza a regra', async () => {
    const a = await ensureCategory(t.db, t.ownerId, 'Eletrônicos');
    const b = await ensureCategory(t.db, t.ownerId, 'Compras gerais');
    const first = await upsertRule(t.db, t.ownerId, { pattern: ' Amazon ', categoryId: a });
    const second = await upsertRule(t.db, t.ownerId, { pattern: 'amazon', categoryId: b });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const rules = await loadRules(t.db);
    expect(rules.filter((r) => r.pattern === 'amazon')).toHaveLength(1);
    expect(rules.find((r) => r.pattern === 'amazon')?.categoryId).toBe(b);
  });

  it('aceita regra só de tipo, sem categoria', async () => {
    await upsertRule(t.db, t.ownerId, { pattern: 'pagamento de fatura', setType: 'card_payment' });
    const r = (await loadRules(t.db)).find((x) => x.pattern === 'pagamento de fatura');
    expect(r?.setType).toBe('card_payment');
    expect(r?.categoryId).toBeNull();
  });

  it('recusa padrão curto demais', async () => {
    await expect(upsertRule(t.db, t.ownerId, { pattern: 'ab', setType: 'transfer' })).rejects.toThrow(/curto/);
  });

  it('recusa regra sem categoria, sem tipo e sem marca', async () => {
    await expect(upsertRule(t.db, t.ownerId, { pattern: 'qualquer' })).rejects.toThrow(/categoria, tipo ou marca/);
  });
});
