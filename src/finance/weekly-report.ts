// Relatório semanal (domingo 9h): domingo a sábado anteriores, total líquido,
// comparação com a média das 4 semanas anteriores, categorias e lista numerada.
import { sql } from 'drizzle-orm';
import { EDIT_HINT, TX_LINE_COLUMNS, formatTxLine, lineContext, notCountedLabel, type CountedRow } from './daily-list.js';
import { addDays, brl, dayLabel, displayName, shortDate, titleCase, todayIso } from './format.js';
import { saveList, type ListItem } from './lists.js';
import { openReceivables } from './receivables.js';
import { netSpending, netSpendingByGroup } from './spending.js';
import { NECESSITIES, NECESSITY_EMOJI, NECESSITY_LABEL, type DbOrTx } from './types.js';

export function previousWeek(now = new Date()): { start: string; end: string } {
  const today = todayIso(now);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = domingo
  const end = addDays(today, -(dow + 1));
  return { start: addDays(end, -6), end };
}

// "🟢 Necessário R$ 75,00 (75%) · 🔴 Desnecessário R$ 25,00 (25%) · ❓ Sem marca ..."
export function necessityLine(groups: { grupo: string; total: string }[], total: number): string[] {
  if (!(total > 0)) return [];
  const by = new Map(groups.map((g) => [g.grupo, Number(g.total)]));
  const parts = [...NECESSITIES, 'sem_marca' as const]
    .filter((k) => (by.get(k) ?? 0) > 0)
    .map((k) => {
      const v = by.get(k)!;
      const label = k === 'sem_marca' ? '❓ Sem marca' : `${NECESSITY_EMOJI[k]} ${NECESSITY_LABEL[k]}`;
      return `${label} ${brl(v)} (${Math.round((v / total) * 100)}%)`;
    });
  return parts.length ? [parts.join(' · ')] : [];
}

export async function buildWeeklyReport(db: DbOrTx, now = new Date()): Promise<{ text: string; listId: string }> {
  const { start, end } = previousWeek(now);
  const week = await netSpending(db, { start, end });
  const prev: number[] = [];
  for (let i = 1; i <= 4; i++) {
    prev.push(Number((await netSpending(db, { start: addDays(start, -7 * i), end: addDays(end, -7 * i) })).liquido));
  }
  const media = prev.reduce((s, v) => s + v, 0) / prev.length;

  const lines: string[] = [`📊 *Semana de ${shortDate(start)} a ${shortDate(end)}*`];
  let comp = '';
  if (media > 0) {
    const pct = Math.round(((Number(week.liquido) - media) / media) * 100);
    comp = ` (média das 4 semanas anteriores: ${brl(media)} · ${pct === 0 ? 'igual' : `${Math.abs(pct)}% ${pct < 0 ? 'abaixo' : 'acima'}`})`;
  }
  lines.push(`Gasto: *${brl(week.liquido)}*${comp}`);
  lines.push(...necessityLine(await netSpendingByGroup(db, { start, end, group: 'necessity' }), Number(week.liquido)));

  // por categoria principal, com as subcategorias mais relevantes
  const byCat = (await db.execute(sql`
    select coalesce(p.name, c.name, '(sem categoria)') as pai, case when p.id is null then null else c.name end as filho,
      sum(case when t.type='refund' then -t.amount else t.amount end)::numeric(14,2)::text as total
    from transactions t left join categories c on c.id=t.category_id left join categories p on p.id=c.parent_id
    where t.type in ('expense','refund') and t.deleted_at is null and t.transaction_date between ${start} and ${end}
    group by 1, 2`)) as unknown as { pai: string; filho: string | null; total: string }[];
  const parents = new Map<string, { total: number; filhos: { nome: string; total: number }[] }>();
  for (const r of byCat) {
    const p = parents.get(r.pai) ?? { total: 0, filhos: [] };
    p.total += Number(r.total);
    if (r.filho) p.filhos.push({ nome: r.filho, total: Number(r.total) });
    parents.set(r.pai, p);
  }
  if (parents.size) {
    lines.push('', '*Por categoria*');
    for (const [pai, p] of [...parents].sort((a, b) => b[1].total - a[1].total)) {
      const filhos = p.filhos.sort((a, b) => b.total - a.total).slice(0, 3);
      const det = filhos.length > 1 ? ` — ${filhos.map((f) => `${f.nome} ${brl(f.total)}`).join(' · ')}` : '';
      lines.push(`• ${pai} ${brl(p.total)}${det}`);
    }
  }

  const items: ListItem[] = [];
  let n = 0;
  const rows = (await db.execute(sql`
    select ${TX_LINE_COLUMNS}
    from transactions t left join categories c on c.id = t.category_id left join categories p on p.id = c.parent_id
    where t.deleted_at is null and t.type in ('expense','refund') and t.transaction_date between ${start} and ${end}
    order by t.transaction_date, t.amount desc, t.id`)) as unknown as CountedRow[];
  const lc = await lineContext(db);
  if (rows.length) {
    lines.push('', '*Todos os gastos*');
    let day = '';
    for (const r of rows) {
      if (r.d !== day) {
        day = r.d;
        lines.push(`*${dayLabel(day)}*`);
      }
      items.push({ n: ++n, kind: 'tx', transactionId: r.id });
      lines.push(formatTxLine(lc, n, r));
    }
  }

  const notCounted = (await db.execute(sql`
    select t.type::text, t.description, t.transfer_group_id::text, t.notes, t.amount::text
    from transactions t
    where t.deleted_at is null and t.card_id is null and t.type in ('card_payment','transfer')
      and t.transaction_date between ${start} and ${end}
      and (t.type = 'card_payment' or coalesce((t.raw->>'amount')::numeric, -1) < 0)`)) as unknown as {
    type: string;
    description: string;
    transfer_group_id: string | null;
    notes: string | null;
    amount: string;
  }[];
  if (notCounted.length) {
    const sums = new Map<string, number>();
    for (const r of notCounted) {
      const label = notCountedLabel(r, lc.ownNames);
      sums.set(label, (sums.get(label) ?? 0) + Number(r.amount));
    }
    lines.push('', `*Não contei:* ${[...sums].map(([k, v]) => `${k} ${brl(v)}`).join(' · ')}`);
  }

  const abertos = await openReceivables(db);
  if (abertos.length) {
    lines.push('', '*A receber em aberto*');
    for (const r of abertos) {
      items.push({ n: ++n, kind: 'receivable_open', receivableId: r.id });
      lines.push(`${n}. ${titleCase(r.counterparty)} ${brl(r.amount)} desde ${shortDate(r.data)} (${displayName(r.origem, null)}) — "${n} recebi" ou "${n} não vai voltar"`);
    }
  }
  if (items.length) lines.push('', EDIT_HINT);

  const listId = await saveList(db, 'weekly', `relatório da semana ${shortDate(start)}–${shortDate(end)}`, items);
  return { text: lines.join('\n'), listId };
}
