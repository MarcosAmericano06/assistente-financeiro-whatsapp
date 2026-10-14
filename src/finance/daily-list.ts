// Lista diária (19h): gastos que ENTRARAM desde a lista anterior, numerados e
// agrupados pelo dia da compra, com a categoria; o que não contou; e o "a receber".
import { sql } from 'drizzle-orm';
import { getFamilyPatterns, getOwnNames } from './family.js';
import { brl, dayLabel, displayName, shortDate, titleCase } from './format.js';
import { latestList, saveList, type ListItem } from './lists.js';
import { findReturnMatches, openReceivables } from './receivables.js';
import { normalizeText } from './rules.js';
import { getSetting } from './settings.js';
import { NECESSITY_EMOJI, type DbOrTx, type Necessity } from './types.js';
import { NECESSITY_SQL } from './spending.js';

export const DEFAULT_UNCERTAIN = ['A classificar', 'PIX enviado', 'Transferência', 'Serviços', 'Compras gerais', 'Outros lazer'];
export const EDIT_HINT = 'Quer alterar algum? Ex.: "2 para mercado", "3 não é gasto", "4 é duplicado", "1 o Pedro vai me devolver 20".';

export interface CountedRow {
  id: string;
  d: string;
  amount: string;
  type: string;
  description: string;
  merchant_raw: string | null;
  cat: string | null;
  src: string | null;
  transfer_group_id: string | null;
  nec: Necessity | null; // marca efetiva (do gasto, da subcategoria ou do pai)
}

// colunas das linhas de gasto das listas (exige joins c = categoria e p = pai)
export const TX_LINE_COLUMNS = sql`t.id::text, t.transaction_date::text as d, t.amount::text, t.type::text, t.description,
  t.merchant_raw, c.name as cat, t.category_source as src, t.transfer_group_id::text, ${NECESSITY_SQL} as nec`;

export interface LineContext {
  uncertain: string[];
  family: string[];
  ownNames: string[];
}

// Preferências que decidem o ❓ (lidas uma vez por mensagem, não por linha).
export async function lineContext(db: DbOrTx): Promise<LineContext> {
  return {
    uncertain: await getSetting<string[]>(db, 'uncertain_categories', DEFAULT_UNCERTAIN),
    family: await getFamilyPatterns(db),
    ownNames: await getOwnNames(db),
  };
}

// Uma linha de gasto: "3. R$ 89,00 · PIX Fulano · PIX enviado ❓"
export function formatTxLine(lc: LineContext, n: number, r: CountedRow): string {
  const { uncertain, family } = lc;
  const text = normalizeText(`${r.description} ${r.merchant_raw ?? ''}`);
  const isFamily = r.type === 'expense' && family.some((p) => text.includes(normalizeText(p)));
  const doubt = (r.cat && uncertain.includes(r.cat) && r.src !== 'manual' && r.src !== 'rule') || isFamily;
  const valor = r.type === 'refund' ? `−${brl(r.amount)}` : brl(r.amount);
  const cat = r.cat ?? 'sem categoria';
  // um símbolo só: ❓ quando a categoria ou a marca estão em dúvida
  const mark = doubt || !r.nec ? ' ❓' : ` ${NECESSITY_EMOJI[r.nec]}`;
  return `${n}. ${valor} · ${displayName(r.description, r.merchant_raw)} · ${cat}${r.type === 'refund' ? ' (estorno)' : ''}${mark}${isFamily ? ' (família: repasse ou gasto?)' : ''}`;
}

export function notCountedLabel(
  r: { type: string; description: string; transfer_group_id: string | null; notes?: string | null },
  ownNames: string[] = [],
): string {
  if (r.type === 'card_payment') return 'fatura';
  if (r.notes?.startsWith('a receber')) return 'a receber';
  if (r.transfer_group_id) return 'repasse família';
  if (ownNames.some((n) => normalizeText(r.description).includes(n))) return 'entre suas contas';
  return 'não é gasto';
}

export async function buildDailyList(db: DbOrTx): Promise<{ text: string; listId: string; itens: number } | null> {
  // datas sempre calculadas no banco (o texto de timestamp do Postgres não é ISO para o JS)
  const [{ until, ontem, hoje }] = (await db.execute(sql`
    select now()::text as until, (now() - interval '24 hours')::text as ontem,
      (now() at time zone 'America/Sao_Paulo')::date::text as hoje`)) as unknown as [{ until: string; ontem: string; hoje: string }];
  const last = await latestList(db, 'diaria');
  const since = last?.sentAt ?? ontem;

  const counted = (await db.execute(sql`
    select ${TX_LINE_COLUMNS}
    from transactions t left join categories c on c.id = t.category_id left join categories p on p.id = c.parent_id
    where t.deleted_at is null and t.created_at > ${since}::timestamptz and t.created_at <= ${until}::timestamptz
      and t.type in ('expense','refund')
      and (t.origin = 'open_finance' or (t.origin = 'chat' and t.notes is null))
    order by t.transaction_date, t.amount desc, t.id`)) as unknown as CountedRow[];

  // saídas da conta corrente que não contaram (o lado do cartão do pagamento é ruído)
  const notCounted = (await db.execute(sql`
    select t.id::text, t.transaction_date::text as d, t.amount::text, t.type::text, t.description, t.merchant_raw,
      t.transfer_group_id::text, t.notes
    from transactions t
    where t.deleted_at is null and t.created_at > ${since}::timestamptz and t.created_at <= ${until}::timestamptz
      and t.card_id is null and t.origin = 'open_finance' and t.type in ('card_payment','transfer')
      and (t.type = 'card_payment' or coalesce((t.raw->>'amount')::numeric, -1) < 0)
    order by t.transaction_date, t.amount desc`)) as unknown as (CountedRow & { notes: string | null })[];

  const matches = await findReturnMatches(db);
  const reminders = (await openReceivables(db)).filter((r) => r.vencido && !r.reminded_at);
  if (!counted.length && !notCounted.length && !matches.length && !reminders.length) return null;

  const items: ListItem[] = [];
  const lines: string[] = [];
  let n = 0;

  const lc = await lineContext(db);
  if (counted.length) {
    const total = counted.reduce((s, r) => s + (r.type === 'refund' ? -1 : 1) * Number(r.amount), 0);
    lines.push(`💳 *Gastos novos* — ${brl(total)}`);
    let day = '';
    for (const r of counted) {
      if (r.d !== day) {
        day = r.d;
        lines.push(`*${dayLabel(day)}*`);
      }
      items.push({ n: ++n, kind: 'tx', transactionId: r.id });
      lines.push(formatTxLine(lc, n, r));
    }
  }
  if (notCounted.length) {
    lines.push('', '*Não contei*');
    for (const r of notCounted) {
      items.push({ n: ++n, kind: 'tx', transactionId: r.id });
      lines.push(`${n}. ${brl(r.amount)} · ${displayName(r.description, r.merchant_raw)} · ${notCountedLabel(r, lc.ownNames)}`);
    }
  }
  if (matches.length || reminders.length) {
    lines.push('', '*A receber*');
    for (const m of matches) {
      items.push({ n: ++n, kind: 'receivable_match', receivableId: m.receivableId, transactionId: m.transactionId });
      lines.push(
        `${n}. Chegou ${brl(m.amount)} (${displayName(m.description, null)}) — é a devolução de ${titleCase(m.counterparty)} (${displayName(m.origem, null)})? "${n} sim" ou "${n} não"`,
      );
    }
    for (const r of reminders) {
      items.push({ n: ++n, kind: 'receivable_open', receivableId: r.id });
      lines.push(
        `${n}. ${titleCase(r.counterparty)} te deve ${brl(r.amount)} desde ${shortDate(r.data)} (${displayName(r.origem, null)}) — "${n} recebi" ou "${n} não vai voltar"`,
      );
    }
  }
  lines.push('', EDIT_HINT);

  const listId = await saveList(db, 'daily', `lista de ${dayLabel(hoje)}`, items, until);
  for (const r of reminders) await db.execute(sql`update receivables set reminded_at = now() where id=${r.id}::uuid`);
  return { text: lines.join('\n'), listId, itens: items.length };
}
