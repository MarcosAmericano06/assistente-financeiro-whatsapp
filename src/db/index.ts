import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as core from './schema/core.js';
import * as finance from './schema/finance.js';
import * as tasksSchema from './schema/tasks.js';

export const schema = { ...core, ...finance, ...tasksSchema };

export function createDb(databaseUrl: string) {
  // Neon: conexões via pooler; max baixo porque somos 1 processo pequeno.
  const client = postgres(databaseUrl, { max: 5, prepare: false });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
