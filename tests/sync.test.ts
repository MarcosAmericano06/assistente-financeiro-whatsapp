import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { syncItem } from '../src/ingestion/sync.js';
import { upsertRule } from '../src/finance/rules.js';
import { seedTaxonomy, resolveCategory } from '../src/finance/taxonomy.js';
import type { PluggyAccount, PluggyClient, PluggyTransaction } from '../src/ingestion/pluggy-client.js';
import { createTestDb, type TestDb } from './helpers/db.js';

const acc = (id: string, type: 'BANK' | 'CREDIT'): PluggyAccount => ({
  id,
  itemId: 'item',
  type,
  subtype: type === 'BANK' ? 'CHECKING_ACCOUNT' : 'CREDIT_CARD',
  name: type === 'BANK' ? 'XP Conta' : 'XP Visa Infinite',
  marketingName: null,
  number: '1234',
  balance: 0,
  currencyCode: 'BRL',
  creditData: null,
});
const ptx = (id: string, description: string, amount: number, category: string | null, merchant?: string): PluggyTransaction => ({
  id,
  accountId: 'x',
  date: '2026-09-10T00:00:00.000Z',
  description,
  amount,
  currencyCode: 'BRL',
  category,
  status: 'POSTED',
  merchant: merchant ? { name: merchant } : null,
});

const fakePluggy = (byAccount: Record<string, PluggyTransaction[]>, accounts: PluggyAccount[]) =>
  ({
    fetchAccounts: async () => accounts,
    fetchAllTransactions: async (accountId: string) => byAccount[accountId] ?? [],
  }) as unknown as PluggyClient;

describe('syncItem com regras de tipo e estornos', () => {
  let t: TestDb;
  const row = async (externalId: string) =>
    (await t.db.execute(sql`
      select t.type, c.name as category, t.category_source from transactions t
      left join categories c on c.id=t.category_id where t.external_id=${externalId}`))[0] as {
      type: string;
      category: string | null;
      category_source: string | null;
    };

  beforeAll(async () => {
    t = await createTestDb();
    await seedTaxonomy(t.db, t.ownerId);
    await upsertRule(t.db, t.ownerId, { pattern: 'pagamento de fatura', setType: 'card_payment' });
    const eletronicos = (await resolveCategory(t.db, 'Eletrônicos')).category!.id;
    await upsertRule(t.db, t.ownerId, { pattern: 'sanfevari', categoryId: eletronicos });

    const pluggy = fakePluggy(
      {
        bank1: [ptx('b1', 'PAGAMENTO DE FATURA', -10753.1, 'Transfers'), ptx('b2', 'Pix enviado  - Fulano', -70, 'Transfer - PIX')],
        card1: [
          ptx('c1', 'LATAM DCP ND*DJLW', -5863.63, 'Airport and airlines'),
          ptx('c2', 'Pagamento de fatura', -10753.1, null),
          ptx('c3', 'AMAZONMKTPLC*SANFEVARI', 28, 'Online shopping', 'Amazon'),
          ptx('c4', 'OUTBACK', 120, 'Eating out'),
          ptx('c5', 'LOJA NOVA', 30, 'Categoria Que Nao Existe'),
        ],
      },
      [acc('bank1', 'BANK'), acc('card1', 'CREDIT')],
    );
    const r = await syncItem(t.db, pluggy, 'item');
    expect(r.transactionsInserted).toBe(7);
  });
  afterAll(async () => t.close());

  it('regra de tipo transforma o pagamento de fatura da conta em card_payment, sem categoria', async () => {
    expect(await row('b1')).toEqual({ type: 'card_payment', category: null, category_source: null });
  });

  it('PIX comum para terceiros continua gasto, em "PIX enviado" (a classificar)', async () => {
    expect(await row('b2')).toEqual({ type: 'expense', category: 'PIX enviado', category_source: 'provider' });
  });

  it('crédito no cartão que não é pagamento vira estorno, na categoria em português', async () => {
    expect(await row('c1')).toEqual({ type: 'refund', category: 'Passagens', category_source: 'provider' });
    expect((await row('c2')).type).toBe('card_payment');
  });

  it('categoria do Pluggy vira a categoria em português; desconhecida cai em "A classificar"', async () => {
    expect((await row('c4')).category).toBe('Restaurantes e bares');
    expect((await row('c5')).category).toBe('A classificar');
    const ingles = await t.db.execute(sql`select name from categories where name in ('Eating out','Categoria Que Nao Existe')`);
    expect(ingles).toHaveLength(0);
  });

  it('regra de categoria casa pela descrição mesmo quando o estabelecimento tem outro nome', async () => {
    expect(await row('c3')).toEqual({ type: 'expense', category: 'Eletrônicos', category_source: 'rule' });
  });
});
