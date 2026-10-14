import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users } from '../db/schema/core.js';
import { accounts, cards, transactions } from '../db/schema/finance.js';
import type { PluggyClient, PluggyAccount, PluggyTransaction } from './pluggy-client.js';
import { logger } from '../core/logger.js';
import { loadRules, normalizeText, pickRules } from '../finance/rules.js';
import { netSpending, netSpendingByGroup } from '../finance/spending.js';
import { kindOfType, loadProviderMap } from '../finance/taxonomy.js';
import { getOwnNames } from '../finance/family.js';
import type { TxType } from '../finance/types.js';

export interface SyncResult {
  accounts: number;
  cards: number;
  transactionsInserted: number;
  transactionsSkipped: number;
}

async function ensureOwner(db: Db): Promise<string> {
  const existing = await db.query.users.findFirst({ where: eq(users.role, 'owner') });
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({ name: process.env.OWNER_NAME ?? 'Dono', role: 'owner' })
    .returning({ id: users.id });
  return created!.id;
}

async function upsertAccount(db: Db, userId: string, pa: PluggyAccount): Promise<string> {
  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.pluggyAccountId, pa.id),
  });
  if (existing) return existing.id;
  const [created] = await db
    .insert(accounts)
    .values({
      userId,
      name: pa.name,
      type: pa.subtype === 'SAVINGS_ACCOUNT' ? 'savings' : 'checking',
      institution: pa.name.split(' ')[0] ?? null,
      currency: pa.currencyCode,
      pluggyAccountId: pa.id,
    })
    .returning({ id: accounts.id });
  return created!.id;
}

async function upsertCard(db: Db, userId: string, pa: PluggyAccount): Promise<string> {
  const existing = await db.query.cards.findFirst({ where: eq(cards.pluggyAccountId, pa.id) });
  if (existing) return existing.id;
  const cd = pa.creditData;
  const [created] = await db
    .insert(cards)
    .values({
      userId,
      name: pa.name,
      brand: cd?.brand ?? null,
      lastFourDigits: pa.number?.slice(-4) ?? null,
      creditLimit: cd?.creditLimit != null ? String(cd.creditLimit) : null,
      creditLimitTrusted: false,
      pluggyAccountId: pa.id,
    })
    .returning({ id: cards.id });
  return created!.id;
}

// Crédito no cartão: pagamento da fatura (não é gasto nem abate gasto) ou estorno
// (abate o gasto). Na dúvida fica como pagamento: confundir um pagamento grande com
// estorno derrubaria o gasto do mês; o contrário só deixa de abater um estorno.
const CARD_PAYMENT_TEXT = /pagamento|pagto|pgto|fatura|debito automatico/;
export function classifyCardCredit(description: string, category: string | null): 'card_payment' | 'refund' {
  if (category === 'Credit card payment' || CARD_PAYMENT_TEXT.test(normalizeText(description))) return 'card_payment';
  return 'refund';
}

/**
 * Mapeia transação Pluggy -> nosso modelo, evitando dupla contagem:
 * - conta BANK: category "Credit card payment" => card_payment; sinal define expense/income
 * - conta CREDIT: amount > 0 => expense no cartão; amount < 0 => card_payment ou refund
 * Valores são armazenados sempre positivos; o tipo carrega a direção.
 * Regras do usuário (set_type) podem sobrescrever o tipo depois.
 */
export function mapTransaction(t: PluggyTransaction, kind: 'BANK' | 'CREDIT', ownNames: string[] = []): { type: TxType; amount: string } {
  const cat = t.category ?? null;
  let type: TxType;
  if (kind === 'CREDIT') {
    type = t.amount < 0 ? classifyCardCredit(t.description, cat) : 'expense';
  } else if (cat === 'Credit card payment') {
    type = 'card_payment';
  } else if (cat === 'Same person transfer') {
    type = 'transfer';
  } else if (
    (cat === 'Transfer - PIX' || cat === 'Transfers') &&
    ownNames.some((n) => normalizeText(`${t.description} ${t.merchant?.name ?? ''}`).includes(n))
  ) {
    type = 'transfer'; // transferência entre contas próprias
  } else if (cat === 'Automatic investment' || cat?.startsWith('Investment')) {
    type = 'investment';
  } else {
    type = t.amount < 0 ? 'expense' : 'income';
  }
  return { type, amount: Math.abs(t.amount).toFixed(2) };
}

export async function syncItem(db: Db, pluggy: PluggyClient, itemId: string): Promise<SyncResult> {
  const userId = await ensureOwner(db);
  const pluggyAccounts = await pluggy.fetchAccounts(itemId);
  const result: SyncResult = { accounts: 0, cards: 0, transactionsInserted: 0, transactionsSkipped: 0 };

  // regras determinísticas do usuário: sempre vencem a categoria e o tipo do provedor;
  // a categoria do provedor (inglês) é traduzida pela taxonomia, nunca criada
  const rules = await loadRules(db);
  const providerCategory = await loadProviderMap(db);
  const ownNames = await getOwnNames(db);

  for (const pa of pluggyAccounts) {
    const isCredit = pa.type === 'CREDIT';
    const localAccountId = isCredit ? null : await upsertAccount(db, userId, pa);
    const localCardId = isCredit ? await upsertCard(db, userId, pa) : null;
    isCredit ? result.cards++ : result.accounts++;

    const txs = await pluggy.fetchAllTransactions(pa.id);
    for (const t of txs) {
      const mapped = mapTransaction(t, pa.type, ownNames);
      const rule = pickRules(rules, t.description, t.merchant?.name);
      const type = rule.type?.setType ?? mapped.type;
      // fatura, transferência e investimento não têm categoria
      const ruleCategoryId = kindOfType(type) ? rule.category?.categoryId ?? null : null;
      const categoryId = ruleCategoryId ?? providerCategory(t.category, type);
      const meta = t.creditCardMetadata ?? null;
      const inserted = await db
        .insert(transactions)
        .values({
          userId,
          type,
          amount: mapped.amount,
          currency: t.currencyCode,
          transactionDate: t.date.slice(0, 10),
          description: t.description,
          merchantRaw: t.merchant?.name ?? t.merchant?.businessName ?? null,
          merchantNormalized: (t.merchant?.name ?? t.description).toLowerCase().trim(),
          categoryId,
          categorySource: ruleCategoryId ? 'rule' : categoryId && t.category ? 'provider' : null,
          necessity: rule.necessity?.setNecessity ?? null,
          necessitySource: rule.necessity ? 'rule' : null,
          accountId: localAccountId,
          cardId: localCardId,
          installmentNumber: meta?.installmentNumber ?? null,
          origin: 'open_finance',
          externalId: t.id,
          status: 'confirmed',
          raw: t as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing({
          target: [transactions.origin, transactions.externalId],
        })
        .returning({ id: transactions.id });
      inserted.length ? result.transactionsInserted++ : result.transactionsSkipped++;
    }
  }

  logger.info(result, 'sync concluído');
  return result;
}

export async function spentThisMonth(db: Db): Promise<{ total: string; byCategory: unknown[] }> {
  const [row] = (await db.execute(sql`
    select date_trunc('month', current_date)::date::text as start,
      (date_trunc('month', current_date) + interval '1 month - 1 day')::date::text as end`)) as unknown as {
    start: string;
    end: string;
  }[];
  const period = { start: row!.start, end: row!.end };
  const total = await netSpending(db, period);
  const byCategory = await netSpendingByGroup(db, { ...period, group: 'category' });
  return { total: total.liquido, byCategory };
}
