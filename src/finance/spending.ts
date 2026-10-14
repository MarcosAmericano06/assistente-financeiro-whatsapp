// Gasto líquido: compras (expense) menos estornos (refund). Pagamento de fatura,
// transferências e investimentos nunca entram — é o que evita a dupla contagem.
import { sql } from 'drizzle-orm';
import type { DbOrTx, Necessity } from './types.js';

// Marca efetiva de um gasto (consultas precisam do join c = categoria, p = pai).
export const NECESSITY_SQL = sql`coalesce(t.necessity, c.default_necessity, p.default_necessity)`;

export interface PeriodFilter {
  start: string;
  end: string;
  categoryIds?: string[] | undefined; // categoria e filhas (ver categoryScope)
  necessity?: Necessity | 'sem_marca' | undefined;
}

export const necFilter = (n: PeriodFilter['necessity']) =>
  !n ? sql`` : n === 'sem_marca' ? sql`and ${NECESSITY_SQL} is null` : sql`and ${NECESSITY_SQL} = ${n}`;

export const catFilter = (ids: string[] | undefined) =>
  ids?.length ? sql`and t.category_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;

export async function netSpending(
  db: DbOrTx,
  f: PeriodFilter,
): Promise<{ liquido: string; gastos: string; estornos: string; n: number }> {
  const [row] = (await db.execute(sql`
    select
      coalesce(sum(t.amount) filter (where t.type='expense'), 0)::numeric(14,2)::text as gastos,
      coalesce(sum(t.amount) filter (where t.type='refund'), 0)::numeric(14,2)::text as estornos,
      (coalesce(sum(t.amount) filter (where t.type='expense'), 0)
        - coalesce(sum(t.amount) filter (where t.type='refund'), 0))::numeric(14,2)::text as liquido,
      (count(*) filter (where t.type='expense'))::int as n
    from transactions t
    left join categories c on c.id = t.category_id
    left join categories p on p.id = c.parent_id
    where t.type in ('expense','refund') and t.deleted_at is null
      and t.transaction_date between ${f.start} and ${f.end}
      ${catFilter(f.categoryIds)} ${necFilter(f.necessity)}`)) as unknown as {
    liquido: string;
    gastos: string;
    estornos: string;
    n: number;
  }[];
  return row!;
}

export async function netSpendingByGroup(
  db: DbOrTx,
  f: PeriodFilter & { group: 'category' | 'parent' | 'card' | 'necessity' },
): Promise<{ grupo: string; total: string }[]> {
  const col =
    f.group === 'category'
      ? sql`coalesce(c.name,'(sem categoria)')`
      : f.group === 'parent'
        ? sql`coalesce(p.name, c.name, '(sem categoria)')`
        : f.group === 'necessity'
          ? sql`coalesce(${NECESSITY_SQL}, 'sem_marca')`
          : sql`coalesce(cd.name,'(sem cartão)')`;
  return (await db.execute(sql`
    select ${col} as grupo,
      sum(case when t.type='refund' then -t.amount else t.amount end)::numeric(14,2)::text as total
    from transactions t
    left join categories c on c.id = t.category_id
    left join categories p on p.id = c.parent_id
    left join cards cd on cd.id = t.card_id
    where t.type in ('expense','refund') and t.deleted_at is null
      and t.transaction_date between ${f.start} and ${f.end}
      ${catFilter(f.categoryIds)} ${necFilter(f.necessity)}
    group by 1 order by sum(case when t.type='refund' then -t.amount else t.amount end) desc limit 15`)) as unknown as {
    grupo: string;
    total: string;
  }[];
}
