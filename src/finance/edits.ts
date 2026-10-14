// Edição pelo número das listas ("4 para alimentação", "3 não é gasto", "7 é
// duplicado"). Cada comando é um lote do audit_log, desfeito por inteiro com "desfaz".
import { sql } from 'drizzle-orm';
import { applyTxChange, newBatchId, type AuditContext } from './audit.js';
import { latestList, type ListItem, type ListRef } from './lists.js';
import { cancelReceivable, confirmReturn, markReceivable, rejectReturn, settleReceivable } from './receivables.js';
import { normalizeText, sqlNorm } from './rules.js';
import { kindOfType, resolveCategory } from './taxonomy.js';
import { NECESSITY_LABEL, type DbOrTx, type Necessity } from './types.js';

export type ItemAction =
  | 'categoria'
  | 'nao_e_gasto'
  | 'duplicado'
  | 'valor'
  | 'voltar_a_contar'
  | 'a_receber'
  | 'sim'
  | 'nao'
  | 'recebi'
  | 'nao_vai_voltar'
  | 'necessario'
  | 'desnecessario'
  | 'doacao';

export interface ItemChange {
  n: number;
  acao: ItemAction;
  categoria?: string | undefined;
  valor?: number | undefined;
  quem?: string | undefined;
}

export interface ItemResult {
  n: number;
  ok: boolean;
  erro?: string;
  sugestoes?: string[];
  descricao?: string;
  feito?: string;
  sugerir_regra?: string; // perguntar "só esse ou sempre?"
  regra_para?: 'categoria' | 'marca'; // o que a regra "sempre" deve gravar
}

// Trecho estável para regra: nome do estabelecimento/pessoa sem prefixos do banco.
export function suggestPattern(description: string, merchantRaw: string | null): string {
  const base = merchantRaw?.trim() || description;
  const s = normalizeText(base)
    .replace(/^pix (enviado|recebido)\s*(-|para|de)?\s*/, '')
    .replace(/^pagamento (para|de|efetuado)\s*-?\s*/, '')
    .replace(/^(pag|pg|mp|ifd)\s*\*\s*/, '')
    .replace(/\s+\d[\d\s./-]*$/, '')
    .trim();
  return s.length >= 3 ? s : normalizeText(base);
}

type TxInfo = { id: string; type: string; amount: string; description: string; merchant_raw: string | null; category_id: string | null };

async function loadTx(db: DbOrTx, id: string): Promise<TxInfo | undefined> {
  const [t] = (await db.execute(sql`
    select id::text, type::text, amount::text, description, merchant_raw, category_id::text
    from transactions where id=${id}::uuid and deleted_at is null`)) as unknown as TxInfo[];
  return t;
}

// Outro lançamento do mesmo estabelecimento e nenhuma regra ainda para ESSA dimensão
// (categoria ou marca): vale perguntar "sempre?".
async function ruleSuggestion(db: DbOrTx, tx: TxInfo, dim: 'categoria' | 'marca'): Promise<string | undefined> {
  const pattern = suggestPattern(tx.description, tx.merchant_raw);
  if (pattern.length < 3) return undefined;
  const has = dim === 'categoria' ? sql`category_id is not null` : sql`set_necessity is not null`;
  const [hasRule] = (await db.execute(sql`
    select 1 from category_rules where merchant_pattern=${pattern} and active and ${has}`)) as unknown[];
  if (hasRule) return undefined;
  const [other] = (await db.execute(sql`
    select 1 from transactions where id <> ${tx.id}::uuid and deleted_at is null
      and (position(${pattern} in ${sqlNorm(sql`description`)}) > 0 or position(${pattern} in ${sqlNorm(sql`merchant_raw`)}) > 0)
    limit 1`)) as unknown[];
  return other ? pattern : undefined;
}

async function applyOne(db: DbOrTx, ctx: AuditContext, item: ListItem, ch: ItemChange): Promise<ItemResult> {
  const r: ItemResult = { n: ch.n, ok: true };

  if (item.kind === 'receivable_match') {
    if (ch.acao === 'sim') {
      await confirmReturn(db, ctx, item.receivableId!, item.transactionId!);
      return { ...r, feito: 'devolução confirmada; não conta como receita' };
    }
    if (ch.acao === 'nao') {
      await rejectReturn(db, ctx, item.receivableId!, item.transactionId!);
      return { ...r, feito: 'ok, não é essa devolução' };
    }
    return { n: ch.n, ok: false, erro: `o ${ch.n} é uma devolução a confirmar: responda "sim" ou "não"` };
  }
  if (item.kind === 'receivable_open') {
    if (ch.acao === 'recebi') {
      await settleReceivable(db, ctx, item.receivableId!);
      return { ...r, feito: 'a receber baixado' };
    }
    if (ch.acao === 'nao_vai_voltar') {
      await cancelReceivable(db, ctx, item.receivableId!);
      return { ...r, feito: 'voltou a contar como gasto' };
    }
    return { n: ch.n, ok: false, erro: `o ${ch.n} é um "a receber": responda "recebi" ou "não vai voltar"` };
  }

  const tx = await loadTx(db, item.transactionId!);
  if (!tx) return { n: ch.n, ok: false, erro: `o ${ch.n} não existe mais (foi excluído?)` };
  r.descricao = `${tx.description} R$ ${tx.amount}`;

  switch (ch.acao) {
    case 'categoria': {
      if (!ch.categoria) return { n: ch.n, ok: false, erro: 'faltou a categoria' };
      const counted = kindOfType(tx.type);
      const kind = counted ?? 'expense';
      const res = await resolveCategory(db, ch.categoria, kind);
      if (!res.category) return { n: ch.n, ok: false, erro: `não achei a categoria "${ch.categoria}"`, sugestoes: res.sugestoes };
      await applyTxChange(db, ctx, 'list_category', tx.id, {
        ...(counted ? {} : { type: 'expense' }),
        category_id: res.category.id,
        category_source: 'manual',
      });
      const sugerir = await ruleSuggestion(db, tx, 'categoria');
      return {
        ...r,
        feito: `categoria: ${res.category.parentName ? `${res.category.parentName} › ` : ''}${res.category.name}`,
        ...(sugerir ? { sugerir_regra: sugerir, regra_para: 'categoria' as const } : {}),
      };
    }
    case 'necessario':
    case 'desnecessario':
    case 'doacao': {
      if (!kindOfType(tx.type) || tx.type === 'income') return { n: ch.n, ok: false, erro: `o ${ch.n} não conta como gasto; marca não se aplica` };
      await applyTxChange(db, ctx, 'list_necessity', tx.id, { necessity: ch.acao, necessity_source: 'manual' });
      const sugerir = await ruleSuggestion(db, tx, 'marca');
      return {
        ...r,
        feito: `marcado como ${NECESSITY_LABEL[ch.acao as Necessity].toLowerCase()}`,
        ...(sugerir ? { sugerir_regra: sugerir, regra_para: 'marca' as const } : {}),
      };
    }
    case 'nao_e_gasto':
      await applyTxChange(db, ctx, 'list_not_expense', tx.id, { type: 'transfer' });
      return { ...r, feito: 'não conta mais como gasto' };
    case 'duplicado':
      await applyTxChange(db, ctx, 'list_duplicate', tx.id, { deleted: true, notes: 'duplicado (marcado pelo dono)' });
      return { ...r, feito: 'excluído como duplicado' };
    case 'valor':
      if (!(ch.valor && ch.valor > 0)) return { n: ch.n, ok: false, erro: 'valor inválido' };
      await applyTxChange(db, ctx, 'list_amount', tx.id, { amount: ch.valor.toFixed(2) });
      return { ...r, feito: `valor: R$ ${ch.valor.toFixed(2)}` };
    case 'voltar_a_contar': {
      if (tx.type === 'refund' || tx.type === 'expense') return { ...r, feito: 'já conta (nada mudou)' };
      const [cat] = (await db.execute(sql`select kind from categories where id=${tx.category_id}::uuid`)) as unknown as { kind: string }[];
      const needsCat = !tx.category_id || cat?.kind !== 'expense';
      const aClassificar = needsCat ? (await resolveCategory(db, 'A classificar')).category?.id ?? null : null;
      await applyTxChange(db, ctx, 'list_count_again', tx.id, {
        type: 'expense',
        ...(needsCat ? { category_id: aClassificar, category_source: null } : {}),
      });
      return { ...r, feito: 'voltou a contar como gasto' };
    }
    case 'a_receber': {
      const m = await markReceivable(db, ctx, tx.id, {
        amount: ch.valor,
        who: ch.quem,
        defaultWho: suggestPattern(tx.description, tx.merchant_raw),
      });
      return { ...r, feito: `R$ ${m.valor} a receber de ${m.quem}` };
    }
    default:
      return { n: ch.n, ok: false, erro: `ação "${ch.acao}" não vale para um gasto` };
  }
}

export async function editListItems(
  db: DbOrTx,
  input: { lista?: ListRef; changes: ItemChange[]; ctx?: AuditContext },
): Promise<{ lista: string | null; batchId: string; resultados: ItemResult[] }> {
  const list = await latestList(db, input.lista ?? 'ultima');
  const ctx = input.ctx ?? { batchId: newBatchId(), origin: 'chat' };
  if (!list) return { lista: null, batchId: ctx.batchId, resultados: input.changes.map((c) => ({ n: c.n, ok: false, erro: 'nenhuma lista enviada ainda' })) };
  const resultados: ItemResult[] = [];
  for (const ch of input.changes) {
    const item = list.items.find((i) => i.n === ch.n);
    if (!item) {
      resultados.push({ n: ch.n, ok: false, erro: `não existe o item ${ch.n} na lista "${list.title}"` });
      continue;
    }
    try {
      resultados.push(await applyOne(db, ctx, item, ch));
    } catch (e) {
      resultados.push({ n: ch.n, ok: false, erro: (e as Error).message });
    }
  }
  return { lista: list.title, batchId: ctx.batchId, resultados };
}
