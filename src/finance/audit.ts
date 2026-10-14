// Registro de alterações no audit_log: antes/depois por linha, agrupado por
// batch_id (um comando do usuário = um lote, unidade do "desfazer").
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from './types.js';

export function newBatchId(): string {
  return randomUUID();
}

export interface AuditContext {
  batchId: string;
  origin: string; // 'chat' | 'sync' | 'retro_etapa1' | ...
}

export async function recordChange(
  db: DbOrTx,
  ctx: AuditContext,
  c: { action: string; entity: string; entityId: string; before: unknown; after: unknown },
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (batch_id, action, entity, entity_id, before, after, origin)
    values (${ctx.batchId}::uuid, ${c.action}, ${c.entity}, ${c.entityId},
      ${c.before === null ? null : JSON.stringify(c.before)}::jsonb,
      ${c.after === null ? null : JSON.stringify(c.after)}::jsonb, ${ctx.origin})`);
}

export interface TxChange {
  type?: string;
  category_id?: string | null;
  category_source?: string | null;
  transfer_group_id?: string | null;
  amount?: string;
  transaction_date?: string;
  description?: string;
  notes?: string | null;
  deleted?: boolean;
  necessity?: string | null;
  necessity_source?: string | null;
}

export type TxSnapshot = {
  type: string;
  category_id: string | null;
  category_source: string | null;
  transfer_group_id: string | null;
  amount: string;
  transaction_date: string;
  description: string;
  notes: string | null;
  deleted_at: string | null;
  necessity: string | null;
  necessity_source: string | null;
};

const SNAPSHOT = sql`type::text, category_id::text, category_source, transfer_group_id::text, amount::text,
  transaction_date::text, description, notes, deleted_at::text, necessity, necessity_source`;

function setClauses(change: TxChange): SQL[] {
  const has = (k: keyof TxChange) => Object.prototype.hasOwnProperty.call(change, k);
  const sets: SQL[] = [];
  if (has('type')) sets.push(sql`type = ${change.type!}::transaction_type`);
  if (has('category_id')) sets.push(sql`category_id = ${change.category_id ?? null}::uuid`);
  if (has('category_source')) sets.push(sql`category_source = ${change.category_source ?? null}`);
  if (has('transfer_group_id')) sets.push(sql`transfer_group_id = ${change.transfer_group_id ?? null}::uuid`);
  if (has('amount')) sets.push(sql`amount = ${change.amount!}::numeric`);
  if (has('transaction_date')) sets.push(sql`transaction_date = ${change.transaction_date!}::date`);
  if (has('description')) sets.push(sql`description = ${change.description!}`);
  if (has('notes')) sets.push(sql`notes = ${change.notes ?? null}`);
  if (has('deleted')) sets.push(change.deleted ? sql`deleted_at = now()` : sql`deleted_at = null`);
  if (has('necessity')) sets.push(sql`necessity = ${change.necessity ?? null}`);
  if (has('necessity_source')) sets.push(sql`necessity_source = ${change.necessity_source ?? null}`);
  return sets;
}

// Altera uma transação e registra o antes/depois.
export async function applyTxChange(
  db: DbOrTx,
  ctx: AuditContext,
  action: string,
  id: string,
  change: TxChange,
): Promise<void> {
  const [before] = (await db.execute(sql`select ${SNAPSHOT} from transactions where id=${id}::uuid`)) as unknown as TxSnapshot[];
  if (!before) throw new Error(`transação ${id} não encontrada`);
  const sets = setClauses(change);
  if (!sets.length) return;
  const [after] = (await db.execute(sql`
    update transactions set ${sql.join(sets, sql`, `)}, updated_at = now()
    where id=${id}::uuid returning ${SNAPSHOT}`)) as unknown as TxSnapshot[];
  await recordChange(db, ctx, { action, entity: 'transaction', entityId: id, before, after });
}

// Cria uma transação nova copiando conta/cartão/data da original (parte de divisão,
// parte "a receber"). Registrada com before=null: desfazer apaga a parte.
export async function cloneTxAudited(
  db: DbOrTx,
  ctx: AuditContext,
  action: string,
  sourceId: string,
  over: { amount: string; type?: string; description?: string; notes?: string | null; category_id?: string | null; category_source?: string | null },
): Promise<string> {
  const [row] = (await db.execute(sql`
    insert into transactions (user_id, type, amount, currency, transaction_date, processed_date, description,
      merchant_raw, merchant_normalized, category_id, category_source, account_id, card_id, origin, status, notes)
    select user_id, coalesce(${over.type ?? null}::transaction_type, type), ${over.amount}::numeric, currency,
      transaction_date, processed_date, coalesce(${over.description ?? null}, description), merchant_raw,
      merchant_normalized, ${over.category_id !== undefined ? sql`${over.category_id}::uuid` : sql`category_id`},
      ${over.category_source !== undefined ? sql`${over.category_source}` : sql`category_source`},
      account_id, card_id, 'chat', 'confirmed', ${over.notes ?? null}
    from transactions where id=${sourceId}::uuid
    returning id::text, ${SNAPSHOT}`)) as unknown as (TxSnapshot & { id: string })[];
  if (!row) throw new Error(`transação ${sourceId} não encontrada`);
  const { id, ...after } = row;
  await recordChange(db, ctx, { action, entity: 'transaction', entityId: id, before: null, after });
  return id;
}

// Registra uma transação recém-criada (desfazer = excluir).
export async function recordTxInsert(db: DbOrTx, ctx: AuditContext, action: string, id: string): Promise<void> {
  const [after] = (await db.execute(sql`select ${SNAPSHOT} from transactions where id=${id}::uuid`)) as unknown as TxSnapshot[];
  await recordChange(db, ctx, { action, entity: 'transaction', entityId: id, before: null, after });
}

type AuditRow = { id: string; entity: string; entity_id: string; action: string; before: Record<string, unknown> | null };

async function revertRow(db: DbOrTx, r: AuditRow): Promise<void> {
  const b = r.before;
  switch (r.entity) {
    case 'transaction':
      if (!b) {
        await db.execute(sql`update transactions set deleted_at = now(), updated_at = now() where id=${r.entity_id}::uuid`);
      } else {
        await db.execute(sql`
          update transactions set type=${b.type as string}::transaction_type, category_id=${(b.category_id as string) ?? null}::uuid,
            category_source=${(b.category_source as string) ?? null}, transfer_group_id=${(b.transfer_group_id as string) ?? null}::uuid,
            amount=${(b.amount as string) ?? null}::numeric, transaction_date=${(b.transaction_date as string) ?? null}::date,
            description=${(b.description as string) ?? null}, notes=${(b.notes as string) ?? null},
            deleted_at=${(b.deleted_at as string) ?? null}::timestamptz,
            necessity=${'necessity' in b ? sql`${(b.necessity as string) ?? null}` : sql`necessity`},
            necessity_source=${'necessity_source' in b ? sql`${(b.necessity_source as string) ?? null}` : sql`necessity_source`},
            updated_at=now()
          where id=${r.entity_id}::uuid`);
      }
      return;
    case 'category_rule':
      if (!b) {
        await db.execute(sql`delete from category_rules where id=${r.entity_id}::uuid`);
      } else {
        await db.execute(sql`
          update category_rules set
            category_id = ${'category_id' in b ? sql`${(b.category_id as string) ?? null}::uuid` : sql`category_id`},
            set_type = ${'set_type' in b ? sql`${(b.set_type as string) ?? null}::transaction_type` : sql`set_type`},
            set_necessity = ${'set_necessity' in b ? sql`${(b.set_necessity as string) ?? null}` : sql`set_necessity`},
            active = ${'active' in b ? sql`${b.active as boolean}` : sql`active`}
          where id=${r.entity_id}::uuid`);
      }
      return;
    case 'receivable':
      if (!b) {
        await db.execute(sql`delete from receivables where id=${r.entity_id}::uuid`);
      } else {
        await db.execute(sql`
          update receivables set status=${b.status as string},
            settlement_transaction_id=${(b.settlement_transaction_id as string) ?? null}::uuid,
            rejected_match_ids=${JSON.stringify(b.rejected_match_ids ?? [])}::jsonb,
            reminded_at=${(b.reminded_at as string) ?? null}::timestamptz, settled_at=${(b.settled_at as string) ?? null}::timestamptz
          where id=${r.entity_id}::uuid`);
      }
      return;
    case 'task':
      if (!b) {
        await db.execute(sql`update tasks set status='cancelled', updated_at=now() where id=${r.entity_id}::uuid`);
      } else {
        await db.execute(sql`
          update tasks set title=${b.title as string}, status=${b.status as string}::task_status,
            priority=${b.priority as string}::task_priority, due_date=${(b.due_date as string) ?? null}::date,
            due_time=${(b.due_time as string) ?? null}, project=${(b.project as string) ?? null},
            remind_at=${(b.remind_at as string) ?? null}::timestamptz, reminded_at=${(b.reminded_at as string) ?? null}::timestamptz,
            completed_at=${(b.completed_at as string) ?? null}::timestamptz, updated_at=now()
          where id=${r.entity_id}::uuid`);
      }
      return;
    case 'category':
      if (!b) {
        await db.execute(sql`update categories set active=false where id=${r.entity_id}::uuid`);
      } else {
        await db.execute(sql`
          update categories set active=${(b.active as boolean) ?? true}, merged_into=${(b.merged_into as string) ?? null}::uuid
          where id=${r.entity_id}::uuid`);
      }
      return;
    default:
      throw new Error(`não sei desfazer ${r.entity}`);
  }
}

// Desfaz o último comando do dono (lote mais recente de origem chat ainda não desfeito),
// revertendo as linhas na ordem inversa da gravação.
export async function undoLastBatch(
  db: DbOrTx,
  opts: { origin?: string } = {},
): Promise<{ desfeitas: number; acoes: string[]; batchId: string | null }> {
  // tudo ou nada: falha no meio não pode deixar o lote meio revertido
  return db.transaction((tx) => undoIn(tx, opts.origin ?? 'chat'));
}

async function undoIn(db: DbOrTx, origin: string): Promise<{ desfeitas: number; acoes: string[]; batchId: string | null }> {
  const [last] = (await db.execute(sql`
    select batch_id::text from audit_log
    where origin=${origin} and undone_at is null and batch_id is not null
    order by seq desc limit 1`)) as unknown as { batch_id: string }[];
  if (!last) return { desfeitas: 0, acoes: [], batchId: null };
  const rows = (await db.execute(sql`
    select id::text, entity, entity_id, action, before from audit_log
    where batch_id=${last.batch_id}::uuid and undone_at is null order by seq desc`)) as unknown as AuditRow[];
  for (const r of rows) await revertRow(db, r);
  await db.execute(sql`update audit_log set undone_at=now() where batch_id=${last.batch_id}::uuid`);
  return { desfeitas: rows.length, acoes: [...new Set(rows.map((r) => r.action))], batchId: last.batch_id };
}
