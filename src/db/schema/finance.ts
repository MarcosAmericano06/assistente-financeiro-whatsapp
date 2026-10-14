import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  numeric,
  integer,
  date,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './core.js';

export const accountType = pgEnum('account_type', [
  'checking',
  'savings',
  'investment',
  'cash',
  'other',
]);

// Tipos desenhados para evitar dupla contagem:
// - compra no cartão = expense (conta como gasto)
// - pagamento de fatura = card_payment (NÃO conta como gasto)
// - transferências têm as duas pernas ligadas por transferGroupId
export const transactionType = pgEnum('transaction_type', [
  'expense',
  'income',
  'transfer',
  'card_payment',
  'investment',
  'refund',
  'adjustment',
]);

export const transactionStatus = pgEnum('transaction_status', [
  'pending',
  'confirmed',
  'reconciled',
]);

export const transactionOrigin = pgEnum('transaction_origin', [
  'open_finance',
  'chat',
  'import_csv',
  'import_ofx',
  'system',
]);

export const invoiceStatus = pgEnum('invoice_status', [
  'open',
  'closed',
  'paid',
  'partial',
]);

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  type: accountType('type').notNull(),
  institution: text('institution'),
  currency: text('currency').notNull().default('BRL'),
  initialBalance: numeric('initial_balance', { precision: 14, scale: 2 }).notNull().default('0'),
  pluggyAccountId: text('pluggy_account_id').unique(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  brand: text('brand'),
  lastFourDigits: text('last_four_digits'),
  paymentAccountId: uuid('payment_account_id').references(() => accounts.id),
  closingDay: integer('closing_day'),
  dueDay: integer('due_day'),
  creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }),
  // limites vindos do Open Finance podem ser incorretos; só confiar após validação
  creditLimitTrusted: boolean('credit_limit_trusted').notNull().default(false),
  pluggyAccountId: text('pluggy_account_id').unique(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cardInvoices = pgTable(
  'card_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id').notNull().references(() => cards.id),
    referenceMonth: date('reference_month').notNull(), // primeiro dia da competência
    closingDate: date('closing_date'),
    dueDate: date('due_date'),
    status: invoiceStatus('status').notNull().default('open'),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('card_invoice_unique').on(t.cardId, t.referenceMonth)],
);

// Taxonomia em português com pai › filho. kind separa gastos de receitas;
// categorias antigas ficam inativas com merged_into apontando para a nova.
export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  parentId: uuid('parent_id'),
  kind: text('kind').notNull().default('expense'), // 'expense' | 'income'
  aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
  mergedInto: uuid('merged_into'),
  // marca padrão dos gastos desta categoria: 'necessario' | 'desnecessario' | 'doacao'
  defaultNecessity: text('default_necessity'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Categoria do provedor (Pluggy, em inglês) → categoria PT, por tipo de movimento.
export const providerCategoryMap = pgTable(
  'provider_category_map',
  {
    provider: text('provider').notNull(),
    providerCategory: text('provider_category').notNull(),
    kind: text('kind').notNull(), // 'expense' | 'income'
    categoryId: uuid('category_id').notNull().references(() => categories.id),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerCategory, t.kind] })],
);

// Regras determinísticas aprendidas ("Amazon é eletrônicos", "PIX pro X não é gasto").
// Sempre vencem o palpite do LLM e o mapeamento automático do Pluggy.
// Mudam a categoria, o tipo ou os dois; um padrão por usuário (upsert).
export const categoryRules = pgTable(
  'category_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    merchantPattern: text('merchant_pattern').notNull(),
    categoryId: uuid('category_id').references(() => categories.id),
    setType: transactionType('set_type'),
    setNecessity: text('set_necessity'),
    origin: text('origin').notNull().default('user_correction'),
    priority: integer('priority').notNull().default(100),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('category_rule_pattern_unique').on(t.userId, t.merchantPattern)],
);

export const installmentPlans = pgTable('installment_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => cards.id),
  description: text('description').notNull(),
  merchant: text('merchant'),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
  installmentCount: integer('installment_count').notNull(),
  installmentAmount: numeric('installment_amount', { precision: 14, scale: 2 }).notNull(),
  purchaseDate: date('purchase_date').notNull(),
  externalId: text('external_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    type: transactionType('type').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('BRL'),
    transactionDate: date('transaction_date').notNull(),
    processedDate: date('processed_date'),
    description: text('description').notNull(),
    merchantRaw: text('merchant_raw'),
    merchantNormalized: text('merchant_normalized'),
    categoryId: uuid('category_id').references(() => categories.id),
    categorySource: text('category_source'), // 'rule' | 'provider' | 'llm_suggested' | 'manual'
    // necessário/desnecessário/doação definido no próprio gasto (vence o padrão da categoria)
    necessity: text('necessity'),
    necessitySource: text('necessity_source'), // 'manual' | 'rule'
    accountId: uuid('account_id').references(() => accounts.id),
    cardId: uuid('card_id').references(() => cards.id),
    invoiceId: uuid('invoice_id').references(() => cardInvoices.id),
    installmentPlanId: uuid('installment_plan_id').references(() => installmentPlans.id),
    installmentNumber: integer('installment_number'),
    transferGroupId: uuid('transfer_group_id'),
    origin: transactionOrigin('origin').notNull(),
    externalId: text('external_id'),
    status: transactionStatus('status').notNull().default('confirmed'),
    notes: text('notes'),
    raw: jsonb('raw'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotência de ingestão/importação: nunca duplicar a mesma transação externa.
    uniqueIndex('transaction_external_unique').on(t.origin, t.externalId),
    index('transaction_date_idx').on(t.userId, t.transactionDate),
    index('transaction_invoice_idx').on(t.invoiceId),
  ],
);

// Listas numeradas enviadas ao dono (diária, semanal, relatório). O número que ele
// cita ("o 4") é resolvido aqui pelo backend, nunca adivinhado pela IA.
export const messageLists = pgTable(
  'message_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(), // 'daily' | 'weekly' | 'report'
    title: text('title').notNull(),
    items: jsonb('items').notNull(), // [{ n, kind, transactionId?, receivableId? }]
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('message_lists_sent_idx').on(t.sentAt)],
);

// Dinheiro que alguém vai devolver: a parte da transação sai do gasto (transfer)
// e fica aqui até a devolução ser confirmada.
export const receivables = pgTable('receivables', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  transactionId: uuid('transaction_id').notNull().references(() => transactions.id),
  counterparty: text('counterparty').notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  status: text('status').notNull().default('open'), // 'open' | 'received' | 'cancelled'
  settlementTransactionId: uuid('settlement_transaction_id').references(() => transactions.id),
  rejectedMatchIds: jsonb('rejected_match_ids').notNull().default(sql`'[]'::jsonb`),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
