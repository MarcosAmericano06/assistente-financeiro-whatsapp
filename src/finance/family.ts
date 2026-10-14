// PIX com a família: repasse óbvio (o mesmo valor entra e sai com alguém da família
// em até 3 dias) vira transferência nas duas pernas. O resto continua como está e,
// a partir da etapa 3, vira pergunta ao dono.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { applyTxChange, newBatchId } from './audit.js';
import { normalizeText } from './rules.js';
import { getSetting } from './settings.js';
import type { DbOrTx } from './types.js';

// Nomes da família como aparecem nos PIX (ex.: 'maria da silva'), definidos no setup
// (owner_settings.family_patterns) e editáveis por mensagem. Sem padrão embutido.
export const DEFAULT_FAMILY_PATTERNS: string[] = [];

export interface FamilyLeg {
  id: string;
  direction: 'in' | 'out';
  amount: string;
  date: string; // YYYY-MM-DD
  text: string;
}

const DAY = 86_400_000;

// Devolve pares [idSaída, idEntrada]; cada perna entra em no máximo um par.
export function findFamilyPairs(legs: FamilyLeg[], patterns: string[], windowDays = 3): [string, string][] {
  const pats = patterns.map(normalizeText).filter(Boolean);
  const fam = legs
    .filter((l) => pats.some((p) => normalizeText(l.text).includes(p)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const used = new Set<string>();
  const pairs: [string, string][] = [];
  for (const out of fam) {
    if (out.direction !== 'out' || used.has(out.id)) continue;
    let best: FamilyLeg | null = null;
    let bestDist = Infinity;
    for (const inn of fam) {
      if (inn.direction !== 'in' || used.has(inn.id)) continue;
      if (Math.abs(Number(inn.amount) - Number(out.amount)) > 0.01) continue;
      const dist = Math.abs(Date.parse(inn.date) - Date.parse(out.date)) / DAY;
      if (dist <= windowDays && dist < bestDist) {
        best = inn;
        bestDist = dist;
      }
    }
    if (best) {
      used.add(out.id).add(best.id);
      pairs.push([out.id, best.id]);
    }
  }
  return pairs;
}

// Nomes do próprio dono como aparecem nas transferências entre as contas dele
// (owner_settings.own_names, ex.: 'joao da silva'): viram transferência, não gasto.
export async function getOwnNames(db: DbOrTx): Promise<string[]> {
  const v = await getSetting<unknown>(db, 'own_names', []);
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.trim().length >= 3).map(normalizeText) : [];
}

export async function getFamilyPatterns(db: DbOrTx): Promise<string[]> {
  const v = await getSetting<unknown>(db, 'family_patterns', DEFAULT_FAMILY_PATTERNS);
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.trim().length >= 3) : DEFAULT_FAMILY_PATTERNS;
}

type LegRow = { id: string; date: string; amount: string; type: string; description: string; merchant: string | null; raw_amount: string | null };

export async function pairFamilyTransfers(
  db: DbOrTx,
  opts: { origin: string; batchId?: string; apply?: boolean; since?: string },
): Promise<{ pairs: number }> {
  const patterns = await getFamilyPatterns(db);
  // Só conta corrente, ainda sem grupo. Gasto que o dono classificou à mão não é repasse.
  const rows = (await db.execute(sql`
    select id::text, transaction_date::text as date, amount::text, type::text, description,
      merchant_normalized as merchant, raw->>'amount' as raw_amount
    from transactions
    where deleted_at is null and card_id is null and transfer_group_id is null
      and type in ('expense','income','transfer')
      and not (type = 'expense' and category_source is not distinct from 'manual')
      and (${opts.since ?? null}::date is null or transaction_date >= ${opts.since ?? null}::date)`)) as unknown as LegRow[];

  const legs: FamilyLeg[] = [];
  for (const r of rows) {
    const direction =
      r.type === 'expense' ? 'out' : r.type === 'income' ? 'in' : r.raw_amount ? (Number(r.raw_amount) < 0 ? 'out' : 'in') : null;
    if (!direction) continue; // transferência sem sinal conhecido: não dá para saber o sentido
    legs.push({ id: r.id, direction, amount: r.amount, date: r.date, text: `${r.description} ${r.merchant ?? ''}` });
  }

  const pairs = findFamilyPairs(legs, patterns);
  if (opts.apply === false) return { pairs: pairs.length };
  const ctx = { batchId: opts.batchId ?? newBatchId(), origin: opts.origin };
  for (const [out, inn] of pairs) {
    const group = randomUUID();
    for (const id of [out, inn]) {
      await applyTxChange(db, ctx, 'family_pass_through', id, { type: 'transfer', transfer_group_id: group });
    }
  }
  return { pairs: pairs.length };
}
