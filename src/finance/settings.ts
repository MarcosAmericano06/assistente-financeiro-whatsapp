// Preferências do dono (owner_settings), com default quando ainda não foram definidas.
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './types.js';

export async function getSetting<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
  const [row] = (await db.execute(sql`
    select s.value from owner_settings s join users u on u.id = s.user_id
    where u.role = 'owner' and s.key = ${key} limit 1`)) as unknown as { value: T }[];
  return row ? row.value : fallback;
}

export async function setSetting(db: DbOrTx, userId: string, key: string, value: unknown): Promise<void> {
  await db.execute(sql`
    insert into owner_settings (user_id, key, value) values (${userId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`);
}
