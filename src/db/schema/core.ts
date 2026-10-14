import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
  bigserial,
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['owner', 'contact']);
export const channelKind = pgEnum('channel_kind', ['telegram', 'whatsapp']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  role: userRole('role').notNull().default('contact'),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Identidade por canal: telegram chat id hoje, wa_id amanhã.
// A autorização SEMPRE parte do identificador externo real do canal.
export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    channel: channelKind('channel').notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('channel_identity_unique').on(t.channel, t.externalId)],
);

// Tokens/credenciais de integrações, sempre criptografados na aplicação.
export const integrationTokens = pgTable('integration_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(), // 'pluggy' | 'google' | ...
  encryptedPayload: text('encrypted_payload').notNull(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Append-only: toda escrita financeira e operação sensível passa por aqui.
// batch_id agrupa as linhas de um mesmo comando (unidade do "desfazer").
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    batchId: uuid('batch_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    origin: text('origin').notNull(), // 'system' | 'chat' | 'ingestion' | ...
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    // ordem real de gravação (created_at empata dentro de uma transação do banco)
    seq: bigserial('seq', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_batch_idx').on(t.batchId)],
);

// Preferências do dono, editáveis por mensagem (família, avisos, ...).
export const ownerSettings = pgTable(
  'owner_settings',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// Memória da conversa com o orquestrador, por chat (sobrevive a restart).
export const conversationState = pgTable('conversation_state', {
  chatKey: text('chat_key').primaryKey(),
  contents: jsonb('contents').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
