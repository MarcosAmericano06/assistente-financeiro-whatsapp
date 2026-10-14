// Regras determinísticas do usuário. Casam por trecho de texto na descrição OU no
// estabelecimento, sem diferenciar acento e maiúsculas. A mais específica (padrão
// mais longo) vence; em empate, a mais recente.
import { sql, type SQL } from 'drizzle-orm';
import { recordChange, type AuditContext } from './audit.js';
import type { DbOrTx, Necessity, TxType } from './types.js';

export interface Rule {
  id: string;
  pattern: string;
  categoryId: string | null;
  setType: TxType | null;
  setNecessity: Necessity | null;
  createdAt: Date;
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Mesma normalização no SQL, sem depender da extensão unaccent
// (translate antes do lower: com locale C o lower não mexe em letras acentuadas).
const ACENTOS = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn';
export function sqlNorm(col: SQL): SQL {
  return sql`regexp_replace(lower(translate(coalesce(${col}, ''), ${ACENTOS}, ${SEM_ACENTO})), '\\s+', ' ', 'g')`;
}

export function pickRule(rules: Rule[], ...texts: (string | null | undefined)[]): Rule | null {
  const hay = texts.filter((t): t is string => !!t).map(normalizeText);
  if (!hay.length) return null;
  let best: Rule | null = null;
  let bestLen = -1;
  for (const r of rules) {
    const p = normalizeText(r.pattern);
    if (!p || !hay.some((h) => h.includes(p))) continue;
    if (p.length > bestLen || (p.length === bestLen && best && r.createdAt > best.createdAt)) {
      best = r;
      bestLen = p.length;
    }
  }
  return best;
}

// Categoria, tipo e marca são escolhidos de forma independente: uma regra só de tipo
// mais específica não pode esconder a regra de categoria (e vice-versa).
export function pickRules(
  rules: Rule[],
  ...texts: (string | null | undefined)[]
): { category: Rule | null; type: Rule | null; necessity: Rule | null } {
  return {
    category: pickRule(rules.filter((r) => r.categoryId), ...texts),
    type: pickRule(rules.filter((r) => r.setType), ...texts),
    necessity: pickRule(rules.filter((r) => r.setNecessity), ...texts),
  };
}

type RuleRow = {
  id: string;
  merchant_pattern: string;
  category_id: string | null;
  set_type: TxType | null;
  set_necessity: Necessity | null;
  created_at: Date | string;
};
const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  pattern: r.merchant_pattern,
  categoryId: r.category_id,
  setType: r.set_type,
  setNecessity: r.set_necessity,
  createdAt: new Date(r.created_at),
});

export async function loadRules(db: DbOrTx): Promise<Rule[]> {
  const rows = (await db.execute(sql`
    select id::text, merchant_pattern, category_id::text, set_type, set_necessity, created_at
    from category_rules where active`)) as unknown as RuleRow[];
  return rows.map(toRule);
}

// Cria ou atualiza a regra do padrão (um padrão por usuário). Campos não
// informados preservam o valor atual da regra existente.
export async function upsertRule(
  db: DbOrTx,
  userId: string,
  input: { pattern: string; categoryId?: string | null; setType?: TxType | null; setNecessity?: Necessity | null; origin?: string },
  audit?: AuditContext,
): Promise<{ rule: Rule; created: boolean }> {
  const pattern = normalizeText(input.pattern);
  if (pattern.length < 3) throw new Error('padrão muito curto (mínimo 3 caracteres)');
  if (!input.categoryId && !input.setType && !input.setNecessity) throw new Error('informe categoria, tipo ou marca para a regra');

  const [before] = (await db.execute(sql`
    select id::text, merchant_pattern, category_id::text, set_type, set_necessity, created_at
    from category_rules where user_id=${userId} and merchant_pattern=${pattern}`)) as unknown as RuleRow[];
  const [row] = (await db.execute(sql`
    insert into category_rules (user_id, merchant_pattern, category_id, set_type, set_necessity, origin)
    values (${userId}, ${pattern}, ${input.categoryId ?? null}::uuid, ${input.setType ?? null}::transaction_type,
      ${input.setNecessity ?? null}, ${input.origin ?? 'user_correction'})
    on conflict (user_id, merchant_pattern) do update set
      category_id = coalesce(excluded.category_id, category_rules.category_id),
      set_type = coalesce(excluded.set_type, category_rules.set_type),
      set_necessity = coalesce(excluded.set_necessity, category_rules.set_necessity),
      active = true,
      created_at = now()
    returning id::text, merchant_pattern, category_id::text, set_type, set_necessity, created_at`)) as unknown as RuleRow[];
  if (audit) {
    await recordChange(db, audit, {
      action: before ? 'rule_update' : 'rule_create',
      entity: 'category_rule',
      entityId: row!.id,
      before: before ?? null,
      after: row,
    });
  }
  return { rule: toRule(row!), created: !before };
}
