// "A receber": parte de um gasto que alguém vai devolver. Sai do gasto (vira
// transferência) e é acompanhada até a devolução ser confirmada pelo dono.
import { sql } from 'drizzle-orm';
import { applyTxChange, cloneTxAudited, recordChange, type AuditContext } from './audit.js';
import { normalizeText } from './rules.js';
import type { DbOrTx } from './types.js';

type RecSnapshot = {
  id: string;
  status: string;
  counterparty: string;
  amount: string;
  transaction_id: string;
  settlement_transaction_id: string | null;
  rejected_match_ids: string[];
  reminded_at: string | null;
  settled_at: string | null;
};
const REC = sql`id::text, status, counterparty, amount::text, transaction_id::text, settlement_transaction_id::text,
  rejected_match_ids, reminded_at::text, settled_at::text`;

async function snapshot(db: DbOrTx, id: string): Promise<RecSnapshot> {
  const [r] = (await db.execute(sql`select ${REC} from receivables where id=${id}::uuid`)) as unknown as RecSnapshot[];
  if (!r) throw new Error('a receber não encontrado');
  return r;
}

async function updateAudited(db: DbOrTx, ctx: AuditContext, action: string, id: string, set: ReturnType<typeof sql>): Promise<void> {
  const before = await snapshot(db, id);
  await db.execute(sql`update receivables set ${set} where id=${id}::uuid`);
  await recordChange(db, ctx, { action, entity: 'receivable', entityId: id, before, after: await snapshot(db, id) });
}

export async function markReceivable(
  db: DbOrTx,
  ctx: AuditContext,
  txId: string,
  opts: { amount?: number | undefined; who?: string | undefined; defaultWho?: string },
): Promise<{ receivableId: string; parteId: string; valor: string; quem: string }> {
  const [tx] = (await db.execute(sql`
    select user_id::text, type::text, amount::text, description from transactions
    where id=${txId}::uuid and deleted_at is null`)) as unknown as { user_id: string; type: string; amount: string; description: string }[];
  if (!tx) throw new Error('transação não encontrada');
  if (tx.type !== 'expense') throw new Error('só um gasto pode virar "a receber"');
  const total = Number(tx.amount);
  const valor = opts.amount ?? total;
  if (!(valor > 0) || valor > total + 0.005) throw new Error(`valor a receber deve ficar entre R$ 0,01 e ${tx.amount}`);
  const quem = normalizeText(opts.who || opts.defaultWho || 'alguém');

  let parteId = txId;
  if (valor < total - 0.005) {
    await applyTxChange(db, ctx, 'receivable_split', txId, { amount: (total - valor).toFixed(2) });
    parteId = await cloneTxAudited(db, ctx, 'receivable_split', txId, {
      amount: valor.toFixed(2),
      type: 'transfer',
      description: `${tx.description} (a receber)`,
      notes: `a receber de ${quem}`,
    });
  } else {
    await applyTxChange(db, ctx, 'receivable_mark', txId, { type: 'transfer', notes: `a receber de ${quem}` });
  }
  const [row] = (await db.execute(sql`
    insert into receivables (user_id, transaction_id, counterparty, amount)
    values (${tx.user_id}::uuid, ${parteId}::uuid, ${quem}, ${valor.toFixed(2)}::numeric) returning ${REC}`)) as unknown as RecSnapshot[];
  await recordChange(db, ctx, { action: 'receivable_create', entity: 'receivable', entityId: row!.id, before: null, after: row });
  return { receivableId: row!.id, parteId, valor: valor.toFixed(2), quem };
}

export interface ReturnMatch {
  receivableId: string;
  transactionId: string;
  amount: string;
  counterparty: string;
  date: string;
  description: string;
  origem: string; // descrição do gasto original
}

// PIX recebido com o mesmo valor e nome compatível, depois do gasto original.
export async function findReturnMatches(db: DbOrTx): Promise<ReturnMatch[]> {
  const open = (await db.execute(sql`
    select r.id::text, r.counterparty, r.amount::text, r.rejected_match_ids, t.transaction_date::text as desde, t.description as origem
    from receivables r join transactions t on t.id = r.transaction_id
    where r.status='open' order by r.created_at`)) as unknown as {
    id: string;
    counterparty: string;
    amount: string;
    rejected_match_ids: string[];
    desde: string;
    origem: string;
  }[];
  const used = new Set<string>();
  const out: ReturnMatch[] = [];
  for (const r of open) {
    const tokens = r.counterparty.split(' ').filter((w) => w.length >= 3);
    const cands = (await db.execute(sql`
      select id::text, description, amount::text, transaction_date::text as date from transactions
      where type='income' and deleted_at is null and card_id is null
        and transaction_date >= ${r.desde}::date and abs(amount - ${r.amount}::numeric) <= 0.01
        and id not in (select settlement_transaction_id from receivables where settlement_transaction_id is not null)
      order by transaction_date, created_at`)) as unknown as { id: string; description: string; amount: string; date: string }[];
    const hit = cands.find(
      (c) => !used.has(c.id) && !r.rejected_match_ids.includes(c.id) && tokens.some((tk) => normalizeText(c.description).includes(tk)),
    );
    if (!hit) continue;
    used.add(hit.id);
    out.push({ receivableId: r.id, transactionId: hit.id, amount: hit.amount, counterparty: r.counterparty, date: hit.date, description: hit.description, origem: r.origem });
  }
  return out;
}

export async function confirmReturn(db: DbOrTx, ctx: AuditContext, receivableId: string, txId: string): Promise<void> {
  const r = await snapshot(db, receivableId);
  await applyTxChange(db, ctx, 'receivable_return', txId, { type: 'transfer', notes: `devolução de ${r.counterparty}` });
  await updateAudited(db, ctx, 'receivable_received', receivableId,
    sql`status='received', settlement_transaction_id=${txId}::uuid, settled_at=now()`);
}

export async function rejectReturn(db: DbOrTx, ctx: AuditContext, receivableId: string, txId: string): Promise<void> {
  await updateAudited(db, ctx, 'receivable_reject_match', receivableId,
    sql`rejected_match_ids = rejected_match_ids || ${JSON.stringify([txId])}::jsonb`);
}

// "Recebi por fora" (dinheiro, outra conta): só baixa.
export async function settleReceivable(db: DbOrTx, ctx: AuditContext, receivableId: string): Promise<void> {
  await updateAudited(db, ctx, 'receivable_settled', receivableId, sql`status='received', settled_at=now()`);
}

// "Não vai voltar": a parte volta a contar como gasto.
export async function cancelReceivable(db: DbOrTx, ctx: AuditContext, receivableId: string): Promise<void> {
  const r = await snapshot(db, receivableId);
  await applyTxChange(db, ctx, 'receivable_cancel', r.transaction_id, { type: 'expense', notes: null });
  await updateAudited(db, ctx, 'receivable_cancelled', receivableId, sql`status='cancelled', settled_at=now()`);
}

export async function openReceivables(db: DbOrTx): Promise<
  { id: string; counterparty: string; amount: string; vencido: boolean; reminded_at: string | null; origem: string; data: string }[]
> {
  return (await db.execute(sql`
    select r.id::text, r.counterparty, r.amount::text, r.created_at < now() - interval '30 days' as vencido,
      r.reminded_at::text, t.description as origem, t.transaction_date::text as data
    from receivables r join transactions t on t.id = r.transaction_id
    where r.status='open' order by r.created_at`)) as unknown as {
    id: string;
    counterparty: string;
    amount: string;
    vencido: boolean;
    reminded_at: string | null;
    origem: string;
    data: string;
  }[];
}
