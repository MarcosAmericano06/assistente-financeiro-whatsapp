// Taxonomia em português aprovada em 10/10/2026 (spec 4.1): pai › filho, apelidos que
// o dono usa na conversa, categorias do Pluggy (inglês) e antigas que caem em cada uma.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { applyTxChange, newBatchId, recordChange, type AuditContext } from './audit.js';
import { normalizeText, upsertRule } from './rules.js';
import type { DbOrTx, Necessity } from './types.js';

type Kind = 'expense' | 'income';
interface ChildDef {
  name: string;
  necessity?: Necessity; // marca padrão (aprovada em 13/10/2026)
  aliases?: string[];
  pluggy?: string[]; // categorias do provedor que caem aqui
  legacy?: string[]; // categorias criadas na conversa antes da taxonomia
}
interface ParentDef extends ChildDef {
  kind: Kind;
  children: ChildDef[];
}

export const TAXONOMY: ParentDef[] = [
  { name: 'Alimentação', kind: 'expense', aliases: ['comida'], children: [
    { name: 'Restaurantes e bares', necessity: 'desnecessario', aliases: ['restaurante', 'restaurantes', 'bar', 'bares', 'almoço', 'jantar', 'lanche'], pluggy: ['Eating out', 'Food and drinks'] },
    { name: 'Delivery', necessity: 'desnecessario', aliases: ['ifood', 'rappi', 'entrega'], pluggy: ['Food delivery'] },
    { name: 'Mercado', necessity: 'necessario', aliases: ['supermercado', 'feira', 'hortifruti'], pluggy: ['Groceries'] },
  ] },
  { name: 'Transporte', kind: 'expense', aliases: ['locomoção'], children: [
    { name: 'Uber e táxi', necessity: 'necessario', aliases: ['uber', '99', 'taxi', 'táxi'], pluggy: ['Taxi and ride-hailing'] },
    { name: 'Transporte público', necessity: 'necessario', aliases: ['metrô', 'metro', 'ônibus', 'onibus', 'trem'], pluggy: ['Public transportation', 'Transportation'] },
    { name: 'Aluguel de carro', necessity: 'desnecessario', aliases: ['locadora'], pluggy: ['Car rental'] },
  ] },
  { name: 'Carro', kind: 'expense', aliases: ['veículo', 'automóvel'], children: [
    { name: 'Combustível', necessity: 'necessario', aliases: ['gasolina', 'etanol', 'posto'], pluggy: ['Gas stations'] },
    { name: 'Estacionamento', necessity: 'necessario', aliases: ['zona azul', 'valet'], pluggy: ['Parking'] },
    { name: 'Manutenção', necessity: 'necessario', aliases: ['oficina', 'mecânico', 'revisão', 'pneu', 'conserto do carro'], pluggy: ['Vehicle maintenance', 'Automotive'] },
    { name: 'Multas', necessity: 'desnecessario', aliases: ['multa', 'detran'], pluggy: ['Traffic tickets'] },
  ] },
  { name: 'Casa', kind: 'expense', aliases: ['moradia'], children: [
    { name: 'Moradia e contas', necessity: 'necessario', aliases: ['aluguel', 'condomínio', 'luz', 'água', 'gás'], pluggy: ['Housing'] },
    { name: 'Obra e reforma', necessity: 'necessario', aliases: ['obra', 'reforma', 'pedreiro'] },
    { name: 'Internet e celular', necessity: 'necessario', aliases: ['internet', 'celular', 'telefone'], pluggy: ['Internet', 'Telecommunications'] },
  ] },
  { name: 'Saúde', kind: 'expense', children: [
    { name: 'Farmácia', necessity: 'necessario', aliases: ['remédio', 'drogaria'], pluggy: ['Pharmacy'] },
    { name: 'Consultas e exames', necessity: 'necessario', aliases: ['médico', 'consulta', 'exame', 'hospital'], pluggy: ['Healthcare', 'Hospital clinics and labs'] },
    { name: 'Terapia', necessity: 'necessario', aliases: ['psicóloga', 'psicólogo', 'psicologa'] },
  ] },
  { name: 'Esportes', kind: 'expense', aliases: ['esporte'], children: [
    { name: 'Clube e academia', necessity: 'necessario', aliases: ['clube', 'academia'], pluggy: ['Gyms and fitness centers', 'Wellness and fitness'] },
    { name: 'Modalidades', necessity: 'necessario', aliases: ['natação', 'futebol', 'aula'], pluggy: ['Sports practice'] },
    { name: 'Equipamentos', necessity: 'desnecessario', aliases: ['equipamento'], pluggy: ['Sports goods'] },
  ] },
  { name: 'Lazer', kind: 'expense', children: [
    { name: 'Festas e eventos', necessity: 'desnecessario', aliases: ['festa', 'show', 'ingresso', 'cinema', 'teatro', 'balada'], pluggy: ['Tickets', 'Cinema, theater and concerts', 'Stadiums and arenas'] },
    { name: 'Outros lazer', necessity: 'desnecessario', pluggy: ['Leisure'] },
  ] },
  { name: 'Viagens', kind: 'expense', aliases: ['viagem'], children: [
    { name: 'Passagens', necessity: 'desnecessario', aliases: ['passagem', 'voo', 'aéreo'], pluggy: ['Airport and airlines'] },
    { name: 'Hospedagem', necessity: 'desnecessario', aliases: ['hotel', 'airbnb', 'pousada'], pluggy: ['Accomodation'] },
    { name: 'Gastos em viagem', necessity: 'desnecessario', pluggy: ['Travel'] },
    { name: 'Milhas e pontos', necessity: 'desnecessario', aliases: ['milhas', 'pontos', 'livelo'], pluggy: ['Mileage programs'] },
  ] },
  { name: 'Compras', kind: 'expense', children: [
    { name: 'Eletrônicos', necessity: 'desnecessario', aliases: ['eletrônico'], pluggy: ['Electronics'] },
    { name: 'Roupas', necessity: 'desnecessario', aliases: ['roupa', 'vestuário'], pluggy: ['Clothing'] },
    { name: 'Compras gerais', necessity: 'desnecessario', aliases: ['shopping'], pluggy: ['Shopping', 'Online shopping'] },
    { name: 'Livros', necessity: 'desnecessario', aliases: ['livro', 'livraria'], pluggy: ['Bookstore'] },
    { name: 'Pets', necessity: 'necessario', aliases: ['pet', 'veterinário'], pluggy: ['Pet supplies and vet'] },
    { name: 'Escritório', necessity: 'necessario', aliases: ['papelaria'], pluggy: ['Office supplies'] },
  ] },
  { name: 'Educação', kind: 'expense', children: [
    { name: 'Faculdade e cursos', necessity: 'necessario', aliases: ['faculdade', 'curso'], pluggy: ['University', 'Education', 'School'] },
  ] },
  { name: 'Assinaturas e serviços', kind: 'expense', aliases: ['assinaturas'], children: [
    { name: 'Serviços digitais', necessity: 'desnecessario', aliases: ['assinatura', 'streaming'], pluggy: ['Digital services'] },
    { name: 'Serviços', necessity: 'desnecessario', pluggy: ['Services'] },
  ] },
  { name: 'Bancos e impostos', kind: 'expense', aliases: ['banco'], children: [
    { name: 'Tarifas', necessity: 'necessario', aliases: ['tarifa', 'anuidade'], pluggy: ['Bank fees', 'Credit card fees'] },
    { name: 'Juros e encargos', necessity: 'desnecessario', aliases: ['juros'], pluggy: ['Late payment and overdraft costs', 'Interests charged', 'Proceeds interests and dividends'] },
    { name: 'IOF e impostos', necessity: 'necessario', aliases: ['iof', 'imposto'], pluggy: ['Tax on financial operations'] },
  ] },
  { name: 'Seguros', kind: 'expense', necessity: 'necessario', aliases: ['seguro'], pluggy: ['Insurance'], children: [] },
  { name: 'Família e doações', kind: 'expense', children: [
    { name: 'Família', necessity: 'doacao' },
    { name: 'Doações', necessity: 'doacao', aliases: ['doação'], pluggy: ['Donations'] },
  ] },
  { name: 'Outros', kind: 'expense', children: [
    { name: 'Prejuízos', aliases: ['prejuízo'] },
  ] },
  { name: 'A classificar', kind: 'expense', children: [
    { name: 'PIX enviado', pluggy: ['Transfer - PIX'] },
    { name: 'Transferência', pluggy: ['Transfers'] },
  ] },
  { name: 'Receitas', kind: 'income', aliases: ['receita'], children: [
    { name: 'Salário e pró-labore', aliases: ['salário', 'pró-labore'] },
    { name: 'Rendimentos', aliases: ['rendimento', 'dividendos'], pluggy: ['Proceeds interests and dividends', 'Interests charged'] },
    { name: 'Reembolsos', aliases: ['reembolso', 'devolução'] },
    { name: 'PIX recebido', pluggy: ['Transfer - PIX'] },
    { name: 'Outras receitas', pluggy: ['Transfers'] },
  ] },
];

// Categorias antigas que na verdade eram TIPO (não é gasto, fatura, investimento).
export const LEGACY_TYPE_CATEGORIES: Record<string, string> = {
  'Same person transfer': 'transfer',
  'Transfer - Foreign Exchange': 'transfer',
  'Credit card payment': 'card_payment',
  'Automatic investment': 'investment',
  Investments: 'investment',
};

// Regras de categoria que acompanham a taxonomia (spec 4.1).
export const SEED_CATEGORY_RULES: { pattern: string; category: string }[] = [];

// Tipos que não entram em gasto nem receita: categoria não se aplica.
const SEM_CATEGORIA = new Set(['transfer', 'card_payment', 'investment', 'adjustment']);

export const kindOfType = (type: string): Kind | null =>
  type === 'income' ? 'income' : type === 'expense' || type === 'refund' ? 'expense' : null;

export interface CategoryRef {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  kind: Kind;
}

type CatRow = { id: string; name: string; parent_id: string | null; parent_name: string | null; kind: Kind; aliases: string[] };

async function activeCategories(db: DbOrTx, kind?: Kind): Promise<CatRow[]> {
  return (await db.execute(sql`
    select c.id::text, c.name, c.parent_id::text, p.name as parent_name, c.kind, c.aliases
    from categories c left join categories p on p.id = c.parent_id
    where c.active and (${kind ?? null}::text is null or c.kind = ${kind ?? null})`)) as unknown as CatRow[];
}

const toRef = (c: CatRow): CategoryRef => ({ id: c.id, name: c.name, parentId: c.parent_id, parentName: c.parent_name, kind: c.kind });

// Pai só tem marca padrão quando todos os filhos concordam (ou quando ele mesmo define).
export function parentNecessity(p: ParentDef): Necessity | null {
  if (p.necessity) return p.necessity;
  const marks = new Set(p.children.map((c) => c.necessity ?? null));
  return marks.size === 1 ? [...marks][0]! : null;
}

async function findOrAdopt(
  db: DbOrTx,
  userId: string,
  def: ChildDef,
  kind: Kind,
  parentId: string | null,
  necessity: Necessity | null,
): Promise<{ id: string; created: boolean }> {
  const target = normalizeText(def.name);
  const existing = (await activeCategories(db, kind)).find((c) => normalizeText(c.name) === target);
  // array como JSON: o driver expandiria um array JS em parâmetros soltos
  const aliases = sql`array(select jsonb_array_elements_text(${JSON.stringify(def.aliases ?? [])}::jsonb))`;
  if (existing) {
    await db.execute(sql`
      update categories set parent_id=${parentId}::uuid, kind=${kind}, aliases=${aliases}, default_necessity=${necessity}
      where id=${existing.id}::uuid`);
    return { id: existing.id, created: false };
  }
  const [row] = (await db.execute(sql`
    insert into categories (user_id, name, parent_id, kind, aliases, default_necessity)
    values (${userId}, ${def.name}, ${parentId}::uuid, ${kind}, ${aliases}, ${necessity}) returning id::text`)) as unknown as { id: string }[];
  return { id: row!.id, created: true };
}

// Cria (ou adota, se já existir com o mesmo nome) a árvore e o mapa do provedor. Idempotente.
export async function seedTaxonomy(db: DbOrTx, userId: string): Promise<{ criadas: number }> {
  let criadas = 0;
  const providerMap: { pluggy: string; kind: Kind; id: string }[] = [];
  for (const parent of TAXONOMY) {
    const p = await findOrAdopt(db, userId, parent, parent.kind, null, parent.kind === 'expense' ? parentNecessity(parent) : null);
    if (p.created) criadas++;
    for (const pl of parent.pluggy ?? []) providerMap.push({ pluggy: pl, kind: parent.kind, id: p.id });
    for (const child of parent.children) {
      const c = await findOrAdopt(db, userId, child, parent.kind, p.id, child.necessity ?? null);
      if (c.created) criadas++;
      for (const pl of child.pluggy ?? []) providerMap.push({ pluggy: pl, kind: parent.kind, id: c.id });
    }
  }
  for (const m of providerMap) {
    await db.execute(sql`
      insert into provider_category_map (provider, provider_category, kind, category_id)
      values ('pluggy', ${m.pluggy}, ${m.kind}, ${m.id}::uuid)
      on conflict (provider, provider_category, kind) do update set category_id = excluded.category_id`);
  }
  return { criadas };
}

// Resolve o nome dito pelo dono (nome, apelido, sem acento) para uma categoria ativa.
// Nunca cria: sem correspondência única, devolve sugestões para o bot perguntar.
export async function resolveCategory(
  db: DbOrTx,
  name: string,
  kind: Kind = 'expense',
): Promise<{ category: CategoryRef | null; sugestoes: string[] }> {
  const n = normalizeText(name);
  const cats = await activeCategories(db, kind);
  const exact = cats.find((c) => normalizeText(c.name) === n);
  if (exact) return { category: toRef(exact), sugestoes: [] };
  const byAlias = cats.filter((c) => c.aliases.some((a) => normalizeText(a) === n));
  if (byAlias.length === 1) return { category: toRef(byAlias[0]!), sugestoes: [] };
  const partial = n.length >= 3
    ? cats.filter((c) => normalizeText(c.name).includes(n) || c.aliases.some((a) => normalizeText(a).includes(n)))
    : [];
  if (partial.length === 1) return { category: toRef(partial[0]!), sugestoes: [] };
  const sugestoes = (partial.length ? partial : byAlias.length ? byAlias : cats.filter((c) => !c.parent_id)).map((c) =>
    c.parent_name ? `${c.parent_name} › ${c.name}` : c.name,
  );
  return { category: null, sugestoes };
}

// A categoria e suas filhas (consultar um pai soma os filhos).
export async function categoryScope(db: DbOrTx, id: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    select id::text from categories where id=${id}::uuid or parent_id=${id}::uuid`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export async function categoryTree(db: DbOrTx, kind: Kind = 'expense'): Promise<{ pai: string; filhos: string[] }[]> {
  const cats = await activeCategories(db, kind);
  return cats
    .filter((c) => !c.parent_id)
    .map((p) => ({ pai: p.name, filhos: cats.filter((c) => c.parent_id === p.id).map((c) => c.name) }));
}

// Categoria do provedor → id PT. Receita com categoria de gasto é reembolso.
export async function loadProviderMap(db: DbOrTx): Promise<(providerCategory: string | null, type: string) => string | null> {
  const rows = (await db.execute(sql`
    select provider_category, kind, category_id::text from provider_category_map where provider='pluggy'`)) as unknown as {
    provider_category: string;
    kind: Kind;
    category_id: string;
  }[];
  const byKey = new Map(rows.map((r) => [`${r.kind}|${r.provider_category}`, r.category_id]));
  const cats = await activeCategories(db);
  const named = (name: string, kind: Kind) => cats.find((c) => c.name === name && c.kind === kind)?.id ?? null;
  const fallbackExpense = named('A classificar', 'expense');
  const reembolsos = named('Reembolsos', 'income');
  const outrasReceitas = named('Outras receitas', 'income');
  return (providerCategory, type) => {
    const kind = kindOfType(type);
    if (!kind) return null;
    const direct = providerCategory ? byKey.get(`${kind}|${providerCategory}`) : undefined;
    if (direct) return direct;
    if (kind === 'expense') return fallbackExpense;
    return providerCategory && byKey.has(`expense|${providerCategory}`) ? reembolsos : outrasReceitas;
  };
}

// Migração única das categorias antigas para a taxonomia (spec 4.2). Idempotente.
export async function migrateLegacyCategories(
  db: Db | DbOrTx,
  opts: { apply: boolean; origin: string; batchId?: string },
): Promise<{ batchId: string; transacoes: number; categoriasDesativadas: number; regras: number }> {
  const ctx: AuditContext = { batchId: opts.batchId ?? newBatchId(), origin: opts.origin };
  const run = async (tx: DbOrTx) => {
    const [owner] = (await tx.execute(sql`select id::text from users where role='owner' limit 1`)) as unknown as { id: string }[];
    if (!owner) throw new Error('owner não encontrado');
    if (opts.apply) {
      await seedTaxonomy(tx, owner.id);
      for (const r of SEED_CATEGORY_RULES) {
        const cat = (await resolveCategory(tx, r.category)).category;
        const exists = (await tx.execute(sql`
          select 1 from category_rules where merchant_pattern=${r.pattern} and category_id=${cat!.id}::uuid and active`)).length;
        if (!exists) await upsertRule(tx, owner.id, { pattern: r.pattern, categoryId: cat!.id, origin: 'system' }, ctx);
      }
    }
    // nome antigo → nome novo, por tipo de movimento
    const legacy = { expense: new Map<string, string>(), income: new Map<string, string>() };
    const taxonomyNames = { expense: new Set<string>(), income: new Set<string>() };
    for (const parent of TAXONOMY) {
      taxonomyNames[parent.kind].add(parent.name);
      for (const pl of parent.pluggy ?? []) legacy[parent.kind].set(pl, parent.name);
      for (const child of parent.children) {
        taxonomyNames[parent.kind].add(child.name);
        for (const old of [...(child.pluggy ?? []), ...(child.legacy ?? [])]) legacy[parent.kind].set(old, child.name);
      }
    }
    const ids = { expense: new Map<string, string>(), income: new Map<string, string>() };
    for (const c of await activeCategories(tx)) {
      if (taxonomyNames[c.kind].has(c.name)) ids[c.kind].set(c.name, c.id);
    }
    const rows = (await tx.execute(sql`
      select t.id::text, t.type::text, t.category_id::text, c.name as cat, c.active as cat_active,
        t.description, t.merchant_normalized as merchant
      from transactions t left join categories c on c.id=t.category_id
      where t.deleted_at is null`)) as unknown as {
      id: string;
      type: string;
      category_id: string | null;
      cat: string | null;
      cat_active: boolean | null;
      description: string;
      merchant: string | null;
    }[];

    let transacoes = 0;
    for (const r of rows) {
      let type = r.type;
      if (r.cat && LEGACY_TYPE_CATEGORIES[r.cat] && (type === 'expense' || type === 'income')) type = LEGACY_TYPE_CATEGORIES[r.cat]!;
      let target: string | null = null;
      const kind = SEM_CATEGORIA.has(type) ? null : kindOfType(type);
      if (kind) {
        const seedRule = SEED_CATEGORY_RULES.find((s) => normalizeText(`${r.description} ${r.merchant ?? ''}`).includes(s.pattern));
        if (seedRule && kind === 'expense') target = seedRule.category;
        else if (r.cat && r.cat_active && taxonomyNames[kind].has(r.cat)) target = r.cat;
        else if (r.cat && legacy[kind].has(r.cat)) target = legacy[kind].get(r.cat)!;
        else if (kind === 'income') target = r.cat && legacy.expense.has(r.cat) ? 'Reembolsos' : 'Outras receitas';
        else target = 'A classificar';
      }
      const targetId = target && kind ? ids[kind].get(target) ?? null : null;
      const willChange = type !== r.type || (opts.apply ? targetId !== r.category_id : target !== r.cat);
      if (!willChange) continue;
      transacoes++;
      if (opts.apply) {
        await applyTxChange(tx, ctx, 'taxonomy_migration', r.id, {
          ...(type !== r.type ? { type } : {}),
          category_id: targetId,
          ...(seedRuleApplies(r, kind) ? { category_source: 'rule' } : {}),
        });
      }
    }

    // categorias fora da taxonomia: desativa apontando para a nova
    let categoriasDesativadas = 0;
    let regras = 0;
    if (opts.apply) {
      const taxonomyIds = new Set([...ids.expense.values(), ...ids.income.values()]);
      const old = (await tx.execute(sql`select id::text, name, kind from categories where active`)) as unknown as {
        id: string;
        name: string;
        kind: Kind;
      }[];
      for (const c of old) {
        if (taxonomyIds.has(c.id)) continue;
        const destName = legacy.expense.get(c.name) ?? legacy.income.get(c.name) ?? null;
        const destId = destName ? ids.expense.get(destName) ?? ids.income.get(destName) ?? null : null;
        await tx.execute(sql`update categories set active=false, merged_into=${destId}::uuid where id=${c.id}::uuid`);
        await recordChange(tx, ctx, {
          action: 'category_merge',
          entity: 'category',
          entityId: c.id,
          before: { active: true, merged_into: null },
          after: { active: false, merged_into: destId },
        });
        categoriasDesativadas++;
        const moved = (await tx.execute(sql`
          update category_rules set category_id=${destId}::uuid where category_id=${c.id}::uuid
          returning id::text`)) as unknown as { id: string }[];
        for (const m of moved) {
          await recordChange(tx, ctx, {
            action: 'rule_repoint',
            entity: 'category_rule',
            entityId: m.id,
            before: { category_id: c.id },
            after: { category_id: destId },
          });
        }
        regras += moved.length;
      }
    }
    return { batchId: ctx.batchId, transacoes, categoriasDesativadas, regras };
  };
  if (opts.apply && 'transaction' in db) return (db as Db).transaction((tx) => run(tx));
  return run(db);
}

function seedRuleApplies(r: { description: string; merchant: string | null }, kind: Kind | null): boolean {
  return kind === 'expense' && SEED_CATEGORY_RULES.some((s) => normalizeText(`${r.description} ${r.merchant ?? ''}`).includes(s.pattern));
}
