// Banco descartável por arquivo de teste: cria database novo no Postgres do
// docker compose, aplica as migrations reais (./drizzle) e cria o owner.
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema/core.js';
import { setSetting } from '../../src/finance/settings.js';

// configuração fictícia usada pelos testes (em produção vem do setup)
export const TEST_FAMILY = ['joana exemplo silva', 'pedro exemplo silva', 'lucas exemplo silva'];
export const TEST_OWN_NAMES = ['dono exemplo silva'];
export const TEST_PROJECTS = ['Trabalho', 'Rede', 'Contratação', 'Estudos', 'Pessoal'];

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev:dev@127.0.0.1:54329/dev';

export interface TestDb {
  db: Db;
  ownerId: string;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();

  const client = postgres(ADMIN_URL.replace(/\/[^/]+$/, `/${name}`), { max: 3, prepare: false, onnotice: () => {} });
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db, { migrationsFolder: 'drizzle' });
  const [owner] = await db.insert(users).values({ name: 'Dono', role: 'owner' }).returning({ id: users.id });
  await setSetting(db, owner!.id, 'family_patterns', TEST_FAMILY);
  await setSetting(db, owner!.id, 'own_names', TEST_OWN_NAMES);
  await setSetting(db, owner!.id, 'task_projects', TEST_PROJECTS);

  return {
    db,
    ownerId: owner!.id,
    close: async () => {
      await client.end();
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export interface TxFixture {
  type?: string;
  amount: number;
  date?: string;
  description: string;
  merchant?: string;
  category?: string | null;
  categorySource?: string | null;
  account?: 'bank' | 'card';
  rawAmount?: number;
  origin?: string;
}

// Conta e cartão únicos por banco de teste, criados sob demanda.
async function ensureAccountAndCard(db: Db, ownerId: string): Promise<{ accountId: string; cardId: string }> {
  const acc = (await db.execute(sql`select id from accounts limit 1`))[0] as { id: string } | undefined;
  const card = (await db.execute(sql`select id from cards limit 1`))[0] as { id: string } | undefined;
  const accountId =
    acc?.id ??
    ((await db.execute(sql`insert into accounts (user_id, name, type) values (${ownerId}, 'Conta XP', 'checking') returning id`))[0] as { id: string }).id;
  const cardId =
    card?.id ??
    ((await db.execute(sql`insert into cards (user_id, name) values (${ownerId}, 'Cartão XP') returning id`))[0] as { id: string }).id;
  return { accountId, cardId };
}

export async function ensureCategory(db: Db, ownerId: string, name: string): Promise<string> {
  const found = (await db.execute(sql`select id from categories where name=${name} limit 1`))[0] as { id: string } | undefined;
  if (found) return found.id;
  return ((await db.execute(sql`insert into categories (user_id, name) values (${ownerId}, ${name}) returning id`))[0] as { id: string }).id;
}

let seq = 0;
export async function insertTx(db: Db, ownerId: string, f: TxFixture): Promise<string> {
  const { accountId, cardId } = await ensureAccountAndCard(db, ownerId);
  const catId = f.category ? await ensureCategory(db, ownerId, f.category) : null;
  const onCard = f.account === 'card';
  const raw = f.rawAmount !== undefined ? { amount: f.rawAmount, category: f.category ?? null } : null;
  const rows = await db.execute(sql`
    insert into transactions (user_id, type, amount, transaction_date, description, merchant_normalized,
      category_id, category_source, account_id, card_id, origin, external_id, status, raw)
    values (${ownerId}, ${f.type ?? 'expense'}::transaction_type, ${f.amount.toFixed(2)}, ${f.date ?? '2026-09-10'},
      ${f.description}, ${(f.merchant ?? f.description).toLowerCase()}, ${catId}, ${f.categorySource ?? (catId ? 'provider' : null)},
      ${onCard ? null : accountId}, ${onCard ? cardId : null}, ${f.origin ?? 'open_finance'}::transaction_origin,
      ${'ext-' + ++seq}, 'confirmed', ${raw ? JSON.stringify(raw) : null}::jsonb)
    returning id`);
  return (rows[0] as { id: string }).id;
}

export async function getTx(db: Db, id: string) {
  return (await db.execute(sql`
    select t.type, t.amount::text as amount, t.transfer_group_id, t.deleted_at, c.name as category, t.category_source
    from transactions t left join categories c on c.id=t.category_id where t.id=${id}::uuid`))[0] as {
    type: string;
    amount: string;
    transfer_group_id: string | null;
    deleted_at: string | null;
    category: string | null;
    category_source: string | null;
  };
}
