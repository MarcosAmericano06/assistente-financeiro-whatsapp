// Listas numeradas enviadas ao dono. "O 4" é resolvido aqui, a partir do que foi
// gravado no envio — a IA nunca adivinha qual transação é.
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './types.js';

export type ListItemKind = 'tx' | 'receivable_match' | 'receivable_open' | 'task';
export interface ListItem {
  n: number;
  kind: ListItemKind;
  transactionId?: string;
  receivableId?: string;
  taskId?: string;
}
// 'tasks' tem numeração própria: "1 feito" (tarefa) não se confunde com "1 mercado" (gasto)
export type ListKind = 'daily' | 'weekly' | 'report' | 'tasks';
export type ListRef = 'ultima' | 'diaria' | 'semanal' | 'relatorio' | 'tarefas';
const KIND_OF: Record<Exclude<ListRef, 'ultima'>, ListKind> = { diaria: 'daily', semanal: 'weekly', relatorio: 'report', tarefas: 'tasks' };

export interface SavedList {
  id: string;
  kind: ListKind;
  title: string;
  sentAt: string;
  items: ListItem[];
}

export async function saveList(db: DbOrTx, kind: ListKind, title: string, items: ListItem[], sentAt?: string): Promise<string> {
  const [row] = (await db.execute(sql`
    insert into message_lists (kind, title, items, sent_at)
    values (${kind}, ${title}, ${JSON.stringify(items)}::jsonb, coalesce(${sentAt ?? null}::timestamptz, now()))
    returning id::text`)) as unknown as { id: string }[];
  return row!.id;
}

// 'ultima' = última lista de GASTOS (diária, semanal ou relatório); tarefas só por 'tarefas'.
export async function latestList(db: DbOrTx, ref: ListRef = 'ultima'): Promise<SavedList | null> {
  const kind = ref === 'ultima' ? null : KIND_OF[ref];
  const [row] = (await db.execute(sql`
    select id::text, kind, title, sent_at::text as "sentAt", items from message_lists
    where (${kind}::text is null and kind <> 'tasks') or kind = ${kind}
    order by sent_at desc, id desc limit 1`)) as unknown as SavedList[];
  return row ?? null;
}
