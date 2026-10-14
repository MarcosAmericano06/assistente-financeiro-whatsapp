// Tools do orquestrador: IA interpreta → estas funções executam no banco/integrações.
// A IA NUNCA calcula números — todo valor vem daqui. Toda escrita vai para o
// audit_log no lote da mensagem (ctx), que é a unidade do "desfazer".
import { sql, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users } from '../db/schema/core.js';
import type { ToolDeclaration } from './gemini.js';
import { loadRules, normalizeText, pickRules, sqlNorm, upsertRule } from '../finance/rules.js';
import { NECESSITY_SQL, catFilter, necFilter, netSpending, netSpendingByGroup } from '../finance/spending.js';
import {
  applyTxChange,
  cloneTxAudited,
  newBatchId,
  recordChange,
  recordTxInsert,
  undoLastBatch,
  type AuditContext,
  type TxChange,
} from '../finance/audit.js';
import { categoryScope, categoryTree, kindOfType, resolveCategory, type CategoryRef } from '../finance/taxonomy.js';
import { editListItems, type ItemChange } from '../finance/edits.js';
import { latestList, saveList, type ListItem, type ListRef } from '../finance/lists.js';
import { markReceivable, openReceivables } from '../finance/receivables.js';
import { addDays, todayIso } from '../finance/format.js';
import { NECESSITIES, TX_TYPES, type Necessity, type TxType } from '../finance/types.js';
import { createConfirmation, takeConfirmation } from '../finance/confirmations.js';
import {
  addProject,
  applyTaskAction,
  buildTaskList,
  createTask,
  editTaskItems,
  findOpenTasks,
  resolveProject,
  TASK_HINT,
  type TaskItemChange,
} from '../tasks/tasks.js';

async function ownerId(db: Db): Promise<string> {
  const owner = await db.query.users.findFirst({ where: eq(users.role, 'owner') });
  if (!owner) throw new Error('owner não encontrado');
  return owner.id;
}

const catLabel = (c: CategoryRef) => (c.parentName ? `${c.parentName} › ${c.name}` : c.name);

type TxRow = { id: string; data: string; valor: string; tipo: string; descricao: string };

// Localiza UMA transação por id ou por busca textual. Ambiguidade → devolve candidatas
// para a IA escolher o id (nunca altera mais de uma transação por engano).
async function locateTransaction(
  db: Db,
  a: Record<string, string | number | undefined>,
): Promise<{ tx?: TxRow; candidatas?: TxRow[]; erro?: string }> {
  if (a.id) {
    const rows = await db.execute(sql`
      select id::text as id, transaction_date::text as data, amount::text as valor, type as tipo, description as descricao
      from transactions where id=${a.id}::uuid and deleted_at is null limit 1`);
    if (!rows[0]) return { erro: 'transação não encontrada por esse id' };
    return { tx: rows[0] as TxRow };
  }
  if (!a.search) return { erro: 'informe id ou search para localizar a transação' };
  const search = `%${String(a.search).toLowerCase()}%`;
  const pStart = (a.period_start as string) ?? '1900-01-01';
  const pEnd = (a.period_end as string) ?? '2999-12-31';
  const rows = await db.execute(sql`
    select id::text as id, transaction_date::text as data, amount::text as valor, type as tipo, description as descricao
    from transactions
    where deleted_at is null and transaction_date between ${pStart} and ${pEnd}
      and (lower(description) like ${search} or lower(coalesce(merchant_normalized,'')) like ${search})
    order by transaction_date desc limit 6`);
  if (!rows.length) return { erro: 'nenhuma transação encontrada com essa busca' };
  if (rows.length > 1) return { candidatas: rows as unknown as TxRow[] };
  return { tx: rows[0] as TxRow };
}

async function googleAccessToken(): Promise<string> {
  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  if (!tok.access_token) throw new Error('refresh do google falhou');
  return tok.access_token;
}

const ACOES_LISTA = ['categoria', 'necessario', 'desnecessario', 'doacao', 'nao_e_gasto', 'duplicado', 'valor', 'voltar_a_contar', 'a_receber', 'sim', 'nao', 'recebi', 'nao_vai_voltar'];
const NEC_PARAM = { type: 'STRING', enum: [...NECESSITIES, 'sem_marca'], description: 'necessario | desnecessario | doacao | sem_marca' };
const asNecessity = (v: unknown): Necessity | 'sem_marca' | undefined =>
  v === 'sem_marca' || NECESSITIES.includes(v as Necessity) ? (v as Necessity | 'sem_marca') : undefined;
const LISTAS = ['ultima', 'diaria', 'semanal', 'relatorio'];
const ALL_TYPES = ['expense', 'income', 'transfer', 'card_payment', 'investment', 'refund', 'adjustment'];

export const toolDeclarations: ToolDeclaration[] = [
  {
    name: 'query_spending',
    description:
      'Soma o gasto LÍQUIDO (compras menos estornos) por período, total ou agrupado. category_name aceita categoria pai (soma os filhos) ou filha, em português. Pagamento de fatura e transferências nunca entram. Datas YYYY-MM-DD.',
    parameters: {
      type: 'OBJECT',
      properties: {
        period_start: { type: 'STRING', description: 'data inicial inclusive, YYYY-MM-DD' },
        period_end: { type: 'STRING', description: 'data final inclusive, YYYY-MM-DD' },
        group_by: { type: 'STRING', enum: ['none', 'parent', 'category', 'card', 'necessity'], description: 'parent = categoria principal; category = subcategoria; necessity = necessário/desnecessário/doação. default none' },
        category_name: { type: 'STRING', description: 'filtrar por categoria (ex.: "alimentação", "uber")' },
        necessity: NEC_PARAM,
      },
      required: ['period_start', 'period_end'],
    },
  },
  {
    name: 'spending_report',
    description:
      'Relatório de gastos pedido pelo usuário ("relatório do último mês de alimentação"): total líquido, divisão por subcategoria, maiores estabelecimentos, comparação com o período anterior e lista NUMERADA de itens (o usuário pode corrigir pelo número depois com edit_list_items).',
    parameters: {
      type: 'OBJECT',
      properties: {
        period_start: { type: 'STRING' },
        period_end: { type: 'STRING' },
        category_name: { type: 'STRING', description: 'opcional: categoria pai ou filha' },
        necessity: NEC_PARAM,
        limit: { type: 'NUMBER', description: 'máximo de itens na lista, default 40' },
      },
      required: ['period_start', 'period_end'],
    },
  },
  {
    name: 'edit_list_items',
    description:
      'Altera GASTOS pelo NÚMERO da última lista de gastos (lista diária, relatório semanal ou relatório pedido). UMA ação por chamada, aplicada a todos os números em numeros; várias ações diferentes = várias chamadas. Ações: categoria (com categoria), necessario/desnecessario/doacao (a marca), nao_e_gasto, duplicado, valor (com valor), voltar_a_contar, a_receber (valor opcional = parte; quem), sim/nao (devolução a confirmar), recebi/nao_vai_voltar (a receber em aberto).',
    parameters: {
      type: 'OBJECT',
      properties: {
        numeros: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'números dos itens na lista, ex.: [1, 4]' },
        acao: { type: 'STRING', enum: ACOES_LISTA },
        categoria: { type: 'STRING' },
        valor: { type: 'NUMBER' },
        quem: { type: 'STRING', description: 'quem vai devolver (a_receber)' },
        lista: { type: 'STRING', enum: LISTAS, description: 'default ultima; use semanal se ele citar o relatório de domingo' },
      },
      required: ['numeros', 'acao'],
    },
  },
  {
    name: 'get_list_items',
    description: 'Detalhes (e ids internos) de itens de uma lista pelo número — use antes de split_transaction ou update_transaction num item de lista.',
    parameters: {
      type: 'OBJECT',
      properties: {
        lista: { type: 'STRING', enum: LISTAS },
        numbers: { type: 'ARRAY', items: { type: 'NUMBER' } },
      },
      required: ['numbers'],
    },
  },
  {
    name: 'list_transactions',
    description: 'Lista transações com filtros. Use para "quais foram", "maior despesa", detalhes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        period_start: { type: 'STRING' },
        period_end: { type: 'STRING' },
        search: { type: 'STRING', description: 'busca em descrição/estabelecimento' },
        type: { type: 'STRING', enum: ['expense', 'income', 'transfer', 'card_payment', 'investment', 'refund'] },
        order: { type: 'STRING', enum: ['date_desc', 'amount_desc'], description: 'default date_desc' },
        limit: { type: 'NUMBER', description: 'default 10, máx 30' },
      },
      required: ['period_start', 'period_end'],
    },
  },
  {
    name: 'get_committed_installments',
    description: 'Parcelas futuras já comprometidas nos cartões (quanto ainda vai cair nas próximas faturas).',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_pending_recurring',
    description: 'Pagamentos recorrentes (últimos 3 meses) que ainda NÃO ocorreram no mês atual.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'create_transaction',
    description: 'Registra transação manual dita pelo usuário ("gastei 50 no mercado"). Valores positivos.',
    parameters: {
      type: 'OBJECT',
      properties: {
        amount: { type: 'NUMBER' },
        type: { type: 'STRING', enum: ['expense', 'income'] },
        description: { type: 'STRING' },
        date: { type: 'STRING', description: 'YYYY-MM-DD; default hoje' },
        category_name: { type: 'STRING', description: 'categoria em português (pai ou filha)' },
      },
      required: ['amount', 'type', 'description'],
    },
  },
  {
    name: 'list_events',
    description: 'Lista eventos do Google Calendar no intervalo. Use para "o que tenho amanhã/hoje/semana".',
    parameters: {
      type: 'OBJECT',
      properties: {
        date_start: { type: 'STRING', description: 'YYYY-MM-DD' },
        date_end: { type: 'STRING', description: 'YYYY-MM-DD (inclusive)' },
      },
      required: ['date_start', 'date_end'],
    },
  },
  {
    name: 'set_category_rule',
    description:
      'Cria ou atualiza a regra permanente de um padrão ("Amazon é eletrônicos", "PIX pro João não é gasto", resposta "sempre"). Muda a categoria, o tipo (set_type) e/ou a marca (set_necessity) nas transações futuras. apply_retroactive=true NÃO altera o histórico na hora: devolve quantas transações antigas mudariam e um confirm_token — pergunte ao usuário e, se ele disser sim, chame de novo com o confirm_token.',
    parameters: {
      type: 'OBJECT',
      properties: {
        merchant_pattern: { type: 'STRING', description: 'trecho da descrição ou do estabelecimento, ex: "amazon", "joao da silva"' },
        category_name: { type: 'STRING', description: 'categoria em português; opcional se houver set_type' },
        set_type: {
          type: 'STRING',
          enum: ['expense', 'income', 'transfer', 'card_payment', 'investment'],
          description: 'opcional: transfer = não é gasto (repasse, conta própria); card_payment = pagamento de fatura',
        },
        set_necessity: { type: 'STRING', enum: NECESSITIES, description: 'opcional: marca necessário/desnecessário/doação para esse estabelecimento' },
        apply_retroactive: { type: 'BOOLEAN', description: 'aplicar ao histórico? default false; a 1ª chamada só devolve a prévia' },
        confirm_token: { type: 'STRING', description: 'token da prévia, só depois que o usuário confirmar numa nova mensagem' },
      },
      required: ['merchant_pattern'],
    },
  },
  {
    name: 'list_category_rules',
    description: 'Lista as regras de classificação ativas.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'delete_rule',
    description: 'Remove uma regra ("para de classificar Amazon como eletrônicos"). Não mexe no histórico.',
    parameters: { type: 'OBJECT', properties: { merchant_pattern: { type: 'STRING' } }, required: ['merchant_pattern'] },
  },
  {
    name: 'list_categories',
    description: 'Lista as categorias (pai › filhos) de gastos e de receitas.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'create_category',
    description: 'Cria categoria nova. SÓ chame quando o usuário pedir explicitamente para criar. Gasto exige a categoria pai.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        parent_name: { type: 'STRING', description: 'categoria pai (obrigatória para gasto)' },
        kind: { type: 'STRING', enum: ['expense', 'income'], description: 'default expense' },
      },
      required: ['name'],
    },
  },
  {
    name: 'recategorize_transactions',
    description:
      'Recategoriza transações que casam com uma busca. Se casar mais de uma (ou for antiga), devolve só a PRÉVIA e um confirm_token: mostre ao usuário e, se ele confirmar numa nova mensagem, chame de novo com confirm_token (e confirm_ids se ele aprovou só parte).',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: { type: 'STRING', description: 'trecho da descrição/estabelecimento' },
        period_start: { type: 'STRING', description: 'YYYY-MM-DD; default últimos 90 dias' },
        period_end: { type: 'STRING' },
        category_name: { type: 'STRING' },
        set_type: { type: 'STRING', enum: ['expense', 'transfer', 'income'], description: 'opcional: mudar o tipo' },
        confirm_token: { type: 'STRING', description: 'token da prévia, depois do OK do usuário' },
        confirm_ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'opcional: só os ids da prévia que ele aprovou' },
      },
      required: ['search', 'category_name'],
    },
  },
  {
    name: 'update_transaction',
    description:
      'Edita uma transação existente: data, valor, descrição, tipo, categoria e observações. Localize por id (de list_transactions/get_list_items) ou por search quando só houver 1 correspondência.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING' },
        search: { type: 'STRING' },
        period_start: { type: 'STRING' },
        period_end: { type: 'STRING' },
        new_date: { type: 'STRING', description: 'YYYY-MM-DD' },
        new_amount: { type: 'NUMBER' },
        new_description: { type: 'STRING' },
        new_type: { type: 'STRING', enum: ALL_TYPES },
        new_category_name: { type: 'STRING' },
        new_necessity: { type: 'STRING', enum: NECESSITIES },
        new_notes: { type: 'STRING' },
      },
    },
  },
  {
    name: 'delete_transaction',
    description: 'Exclui uma transação (some das somas). SEMPRE confirme com o usuário antes. Localize por id ou search.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING' }, search: { type: 'STRING' }, period_start: { type: 'STRING' }, period_end: { type: 'STRING' } },
    },
  },
  {
    name: 'split_transaction',
    description:
      'Divide uma transação em 2+ partes com valor, categoria e tipo próprios (a soma fecha com o original; parte que não é gasto vai como transfer).',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING' },
        search: { type: 'STRING' },
        period_start: { type: 'STRING' },
        period_end: { type: 'STRING' },
        parts: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              amount: { type: 'NUMBER' },
              category_name: { type: 'STRING' },
              type: { type: 'STRING', enum: ALL_TYPES },
              description: { type: 'STRING' },
            },
            required: ['amount'],
          },
        },
      },
      required: ['parts'],
    },
  },
  {
    name: 'mark_receivable',
    description: 'Marca um gasto (ou parte dele) como "a receber" de alguém, fora de lista: a parte sai do gasto e o bot acompanha a devolução.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING' },
        amount: { type: 'NUMBER', description: 'parte a receber; default o valor todo' },
        who: { type: 'STRING' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_receivables',
    description: 'Lista o que está "a receber" em aberto.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'undo_last_change',
    description: 'Desfaz todas as alterações da última mensagem do usuário que mudou dados ("desfaz", "volta o que você fez").',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'create_task',
    description:
      'Cria tarefa ("coloca na minha lista...", "preciso fazer X", "me lembra de X amanhã às 15h"). Projeto: sugira um dos existentes pelo assunto; na dúvida, pergunte. Sem prazo dito, crie sem prazo.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        project: { type: 'STRING', description: 'um dos projetos existentes (lista nas regras)' },
        due_date: { type: 'STRING', description: 'YYYY-MM-DD, só se ele disse' },
        due_time: { type: 'STRING', description: 'HH:MM, opcional' },
        priority: { type: 'STRING', enum: ['low', 'medium', 'high'] },
        remind_at: { type: 'STRING', description: 'lembrete no WhatsApp: YYYY-MM-DDTHH:MM (hora de Brasília)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Lista tarefas abertas NUMERADAS e agrupadas por projeto ("o que tenho pra fazer", "minhas tarefas de networking"). Mostre o texto como veio; o usuário responde pelo número.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filter: { type: 'STRING', enum: ['all_open', 'overdue', 'today', 'no_due'], description: 'default all_open' },
        project: { type: 'STRING' },
      },
    },
  },
  {
    name: 'edit_task_items',
    description:
      'Altera TAREFAS pelo NÚMERO da última lista de tarefas (resumo da manhã, revisão, lembrete ou list_tasks). UMA ação por chamada, aplicada a todos os números em numeros; várias ações diferentes = várias chamadas. Ações: feito, reabrir, apagar, prazo (data, hora opcional), sem_prazo, prioridade, projeto, lembrete (quando; "adia 1h" = agora + 1h), renomear (titulo).',
    parameters: {
      type: 'OBJECT',
      properties: {
        numeros: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'números das tarefas na lista, ex.: [18, 19, 20]' },
        acao: { type: 'STRING', enum: ['feito', 'reabrir', 'apagar', 'prazo', 'sem_prazo', 'prioridade', 'projeto', 'lembrete', 'renomear'] },
        data: { type: 'STRING', description: 'YYYY-MM-DD' },
        hora: { type: 'STRING', description: 'HH:MM' },
        prioridade: { type: 'STRING', enum: ['alta', 'media', 'baixa'] },
        projeto: { type: 'STRING' },
        quando: { type: 'STRING', description: 'YYYY-MM-DDTHH:MM (Brasília)' },
        titulo: { type: 'STRING' },
      },
      required: ['numeros', 'acao'],
    },
  },
  {
    name: 'update_task',
    description: 'Altera UMA tarefa fora de lista, achando pelo título ("remarca a do contador para segunda"). Várias encontradas → devolve candidatas para escolher.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title_search: { type: 'STRING' },
        acao: { type: 'STRING', enum: ['feito', 'reabrir', 'apagar', 'prazo', 'sem_prazo', 'prioridade', 'projeto', 'lembrete', 'renomear'] },
        data: { type: 'STRING' },
        hora: { type: 'STRING' },
        prioridade: { type: 'STRING', enum: ['alta', 'media', 'baixa'] },
        projeto: { type: 'STRING' },
        quando: { type: 'STRING' },
        titulo: { type: 'STRING' },
      },
      required: ['title_search', 'acao'],
    },
  },
  {
    name: 'complete_task',
    description: 'Marca UMA tarefa como concluída pelo título (busca parcial). Se várias casarem, devolve as candidatas — pergunte qual.',
    parameters: {
      type: 'OBJECT',
      properties: { title_search: { type: 'STRING' } },
      required: ['title_search'],
    },
  },
  {
    name: 'create_project',
    description: 'Cria um projeto novo para agrupar tarefas (só quando o usuário pedir).',
    parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
  },
];

// Resolve categoria pelo nome dito, no tipo certo (gasto ou receita); nunca cria.
async function categoryFor(db: Db, name: string, type: string): Promise<{ category: CategoryRef | null; sugestoes: string[] }> {
  return resolveCategory(db, name, kindOfType(type) ?? 'expense');
}

const notFound = (name: unknown, sugestoes: string[]) => ({ erro: `não achei a categoria "${String(name)}"`, sugestoes });

export async function executeTool(
  db: Db,
  name: string,
  args: Record<string, unknown>,
  ctx: AuditContext = { batchId: newBatchId(), origin: 'chat' },
): Promise<Record<string, unknown>> {
  const a = args as Record<string, string | number | undefined>;
  switch (name) {
    case 'query_spending': {
      const group =
        a.group_by === 'category' || a.group_by === 'parent' || a.group_by === 'card' || a.group_by === 'necessity' ? a.group_by : 'none';
      let categoryIds: string[] | undefined;
      let categoria: string | undefined;
      if (a.category_name) {
        const r = await resolveCategory(db, String(a.category_name));
        if (!r.category) return notFound(a.category_name, r.sugestoes);
        categoryIds = await categoryScope(db, r.category.id);
        categoria = r.category.name;
      }
      const period = { start: String(a.period_start), end: String(a.period_end), categoryIds, necessity: asNecessity(a.necessity) };
      if (group === 'none') {
        const r = await netSpending(db, period);
        return { total_brl: r.liquido, gastos_brl: r.gastos, estornos_brl: r.estornos, transacoes: r.n, ...(categoria ? { categoria } : {}) };
      }
      return { grupos: await netSpendingByGroup(db, { ...period, group }), ...(categoria ? { categoria } : {}) };
    }

    case 'spending_report': {
      const start = String(a.period_start);
      const end = String(a.period_end);
      let cat: CategoryRef | null = null;
      let categoryIds: string[] | undefined;
      if (a.category_name) {
        const r = await resolveCategory(db, String(a.category_name));
        if (!r.category) return notFound(a.category_name, r.sugestoes);
        cat = r.category;
        categoryIds = await categoryScope(db, cat.id);
      }
      const necessity = asNecessity(a.necessity);
      const total = await netSpending(db, { start, end, categoryIds, necessity });
      const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
      const prevEnd = addDays(start, -1);
      const anterior = await netSpending(db, { start: addDays(prevEnd, -(days - 1)), end: prevEnd, categoryIds, necessity });
      // com categoria: pelas subcategorias (ou ela mesma); sem categoria: pelas principais
      const divisao = await netSpendingByGroup(db, { start, end, categoryIds, necessity, group: cat ? 'category' : 'parent' });
      const porNecessidade = await netSpendingByGroup(db, { start, end, categoryIds, necessity, group: 'necessity' });
      const estabelecimentos = await db.execute(sql`
        select coalesce(nullif(t.merchant_raw,''), t.description) as nome,
          sum(case when t.type='refund' then -t.amount else t.amount end)::numeric(14,2)::text as total, count(*)::int as vezes
        from transactions t left join categories c on c.id=t.category_id left join categories p on p.id=c.parent_id
        where t.deleted_at is null and t.type in ('expense','refund')
          and t.transaction_date between ${start} and ${end} ${catFilter(categoryIds)} ${necFilter(necessity)}
        group by 1 order by sum(case when t.type='refund' then -t.amount else t.amount end) desc limit 8`);
      const limit = Math.min(Number(a.limit ?? 40), 80);
      const rows = (await db.execute(sql`
        select t.id::text, t.transaction_date::text as data, t.amount::text as valor, t.type::text as tipo,
          t.description as descricao, coalesce(c.name,'') as categoria, ${NECESSITY_SQL} as necessidade
        from transactions t left join categories c on c.id=t.category_id left join categories p on p.id=c.parent_id
        where t.deleted_at is null and t.type in ('expense','refund') and t.transaction_date between ${start} and ${end} ${catFilter(categoryIds)} ${necFilter(necessity)}
        order by t.transaction_date, t.amount desc, t.id limit ${limit}`)) as unknown as {
        id: string;
        data: string;
        valor: string;
        tipo: string;
        descricao: string;
        categoria: string;
        necessidade: string | null;
      }[];
      const items: ListItem[] = rows.map((r, i) => ({ n: i + 1, kind: 'tx', transactionId: r.id }));
      await saveList(db, 'report', `relatório ${cat ? `de ${cat.name} ` : ''}${start} a ${end}`, items);
      return {
        ...(cat ? { categoria: cat.name } : {}),
        total_brl: total.liquido,
        estornos_brl: total.estornos,
        periodo_anterior: { total_brl: anterior.liquido },
        divisao,
        por_necessidade: porNecessidade,
        maiores_estabelecimentos: estabelecimentos,
        itens: rows.map((r, i) => ({
          n: i + 1,
          data: r.data,
          valor: r.valor,
          descricao: r.descricao,
          categoria: r.categoria,
          necessidade: r.necessidade ?? 'sem_marca',
          estorno: r.tipo === 'refund',
        })),
        ...(rows.length === limit ? { aviso: `lista cortada em ${limit} itens` } : {}),
      };
    }

    case 'edit_list_items': {
      const { numeros, acao, categoria, valor, quem } = args as { numeros?: number[]; acao?: string; categoria?: string; valor?: number; quem?: string };
      const changes: ItemChange[] = (numeros ?? []).map((n) => ({ n: Number(n), acao: acao as ItemChange['acao'], categoria, valor, quem }));
      if (!changes.length || !acao) return { erro: 'informe numeros e acao' };
      const lista = LISTAS.includes(String(a.lista)) ? (a.lista as ListRef) : 'ultima';
      return { ...(await editListItems(db, { lista, changes, ctx })) };
    }

    case 'get_list_items': {
      const lista = LISTAS.includes(String(a.lista)) ? (a.lista as ListRef) : 'ultima';
      const list = await latestList(db, lista);
      if (!list) return { erro: 'nenhuma lista enviada ainda' };
      const out = [];
      for (const n of ((args.numbers as number[]) ?? []).map(Number)) {
        const item = list.items.find((i) => i.n === n);
        if (!item?.transactionId) {
          out.push({ n, erro: 'não é um gasto desta lista' });
          continue;
        }
        const [tx] = await db.execute(sql`
          select t.id::text as id, t.transaction_date::text as data, t.amount::text as valor, t.type as tipo,
            t.description as descricao, coalesce(c.name,'') as categoria, t.deleted_at is not null as excluida
          from transactions t left join categories c on c.id=t.category_id where t.id=${item.transactionId}::uuid`);
        out.push({ n, ...(tx as Record<string, unknown>) });
      }
      return { lista: list.title, itens: out };
    }

    case 'list_transactions': {
      const limit = Math.min(Number(a.limit ?? 10), 30);
      const search = a.search ? `%${String(a.search).toLowerCase()}%` : null;
      const type = a.type ?? null;
      const order = a.order === 'amount_desc' ? sql`t.amount desc` : sql`t.transaction_date desc`;
      const rows = await db.execute(sql`
        select t.id::text as id, t.transaction_date::text as data, t.amount::numeric(14,2) as valor, t.type as tipo,
               t.description as descricao, coalesce(c.name,'') as categoria,
               coalesce(cd.name,'') as cartao
        from transactions t
        left join categories c on c.id = t.category_id
        left join cards cd on cd.id = t.card_id
        where t.deleted_at is null
          and t.transaction_date between ${a.period_start} and ${a.period_end}
          and (${type}::text is null or t.type = ${type}::transaction_type)
          and (${search}::text is null or lower(t.description) like ${search} or lower(coalesce(t.merchant_normalized,'')) like ${search})
        order by ${order} limit ${limit}`);
      return { transacoes: rows };
    }

    case 'get_committed_installments': {
      const rows = await db.execute(sql`
        select t.description as descricao,
               (t.raw->'creditCardMetadata'->>'installmentNumber')::int as parcela_atual,
               (t.raw->'creditCardMetadata'->>'totalInstallments')::int as total_parcelas,
               t.amount::numeric(14,2) as valor_parcela,
               ((t.raw->'creditCardMetadata'->>'totalInstallments')::int - (t.raw->'creditCardMetadata'->>'installmentNumber')::int) as parcelas_restantes
        from transactions t
        where t.type='expense' and t.card_id is not null and t.deleted_at is null
          and t.raw->'creditCardMetadata'->>'totalInstallments' is not null
          and (t.raw->'creditCardMetadata'->>'installmentNumber')::int < (t.raw->'creditCardMetadata'->>'totalInstallments')::int
          and t.transaction_date >= current_date - interval '45 days'
        order by 5 desc limit 20`);
      const total = rows.reduce(
        (s, r) => s + Number((r as Record<string, unknown>).valor_parcela) * Number((r as Record<string, unknown>).parcelas_restantes),
        0,
      );
      return { parcelas: rows, total_comprometido_brl: total.toFixed(2) };
    }

    case 'get_pending_recurring': {
      const rows = await db.execute(sql`
        with historico as (
          select merchant_normalized, date_trunc('month', transaction_date) as mes, avg(amount) as v
          from transactions
          where type in ('expense','card_payment') and deleted_at is null
            and transaction_date >= date_trunc('month', current_date) - interval '3 months'
            and transaction_date < date_trunc('month', current_date)
          group by 1,2
        ), freq as (
          select merchant_normalized, count(distinct mes) as meses, avg(v)::numeric(14,2) as valor_tipico
          from historico group by 1 having count(distinct mes) >= 2
        )
        select f.* from freq f
        where not exists (
          select 1 from transactions t where t.merchant_normalized = f.merchant_normalized
            and t.deleted_at is null
            and date_trunc('month', t.transaction_date) = date_trunc('month', current_date))
        order by valor_tipico desc limit 12`);
      return { pendentes_no_mes: rows };
    }

    case 'create_transaction': {
      const uid = await ownerId(db);
      const date = (a.date as string) || todayIso();
      const type = a.type === 'income' ? 'income' : 'expense';
      const kind = type === 'income' ? 'income' : 'expense';
      // precedência: regra do usuário > categoria informada > "A classificar"
      const rule = type === 'expense' ? pickRules(await loadRules(db), String(a.description)).category : null;
      let catId: string | null = null;
      let catName: string | null = null;
      let source: string | null = null;
      let naoEncontrada: string | undefined;
      let sugestoes: string[] | undefined;
      if (rule?.categoryId) {
        const [c] = (await db.execute(sql`select name from categories where id=${rule.categoryId}::uuid`)) as unknown as { name: string }[];
        catId = rule.categoryId;
        catName = c?.name ?? null;
        source = 'rule';
      } else if (a.category_name) {
        const r = await resolveCategory(db, String(a.category_name), kind);
        if (r.category) {
          catId = r.category.id;
          catName = r.category.name;
          source = 'manual';
        } else {
          naoEncontrada = String(a.category_name);
          sugestoes = r.sugestoes;
        }
      }
      if (!catId) {
        const fallback = (await resolveCategory(db, kind === 'income' ? 'Outras receitas' : 'A classificar', kind)).category;
        catId = fallback?.id ?? null;
        catName = fallback?.name ?? null;
      }
      const [row] = (await db.execute(sql`
        insert into transactions (user_id, type, amount, transaction_date, description, origin, status, merchant_normalized, category_id, category_source)
        values (${uid}, ${type}::transaction_type, ${Number(a.amount).toFixed(2)}, ${date}, ${a.description}, 'chat', 'confirmed',
          ${String(a.description).toLowerCase()}, ${catId}::uuid, ${source})
        returning id::text, amount::text, transaction_date::text`)) as unknown as { id: string; amount: string; transaction_date: string }[];
      await recordTxInsert(db, ctx, 'create_transaction', row!.id);
      return {
        criada: { valor: row!.amount, data: row!.transaction_date },
        categoria: source === 'rule' ? `${catName} (pela sua regra)` : catName ?? '(sem categoria)',
        ...(naoEncontrada ? { categoria_nao_encontrada: naoEncontrada, sugestoes } : {}),
      };
    }

    case 'list_events': {
      const at = await googleAccessToken();
      const tmin = `${a.date_start}T00:00:00-03:00`;
      const tmax = `${a.date_end}T23:59:59-03:00`;
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(tmin)}&timeMax=${encodeURIComponent(tmax)}&singleEvents=true&orderBy=startTime&maxResults=25`;
      const data = (await fetch(url, { headers: { authorization: `Bearer ${at}` } }).then((r) => r.json())) as {
        items?: { summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string } }[];
      };
      return {
        eventos: (data.items ?? []).map((e) => ({
          inicio: e.start?.dateTime ?? e.start?.date,
          fim: e.end?.dateTime,
          titulo: e.summary ?? '(sem título)',
          local: e.location,
        })),
      };
    }

    case 'set_category_rule': {
      // confirmação do retroativo (prévia feita numa mensagem anterior)
      if (a.confirm_token) {
        const c = takeConfirmation(String(a.confirm_token), ctx.batchId, 'rule_retro');
        if (c.erro !== undefined) return { erro: c.erro };
        const { catId: cId, setType: sType, setNec } = c.payload as { catId: string | null; setType: TxType | null; setNec: Necessity | null };
        await db.transaction(async (tx) => {
          for (const id of c.ids) {
            await applyTxChange(tx, ctx, 'rule_retroactive', id, {
              ...(cId ? { category_id: cId, category_source: 'rule' } : {}),
              ...(sType ? { type: sType } : {}),
              ...(setNec ? { necessity: setNec, necessity_source: 'rule' } : {}),
            });
          }
        });
        return { recategorizadas_no_historico: c.ids.length };
      }
      const uid = await ownerId(db);
      const setType = a.set_type && TX_TYPES.includes(a.set_type as TxType) ? (a.set_type as TxType) : null;
      let catId: string | null = null;
      let catName: string | undefined;
      if (a.category_name) {
        const r = await categoryFor(db, String(a.category_name), setType ?? 'expense');
        if (!r.category) return notFound(a.category_name, r.sugestoes);
        catId = r.category.id;
        catName = catLabel(r.category);
      }
      const setNec = NECESSITIES.includes(a.set_necessity as Necessity) ? (a.set_necessity as Necessity) : null;
      if (!catId && !setType && !setNec) return { erro: 'diga a categoria, a marca ou se o tipo muda (ex.: não é gasto)' };
      let rule;
      try {
        ({ rule } = await upsertRule(db, uid, { pattern: String(a.merchant_pattern ?? ''), categoryId: catId, setType, setNecessity: setNec }, ctx));
      } catch (e) {
        return { erro: (e as Error).message };
      }
      const criada = { padrao: rule.pattern, categoria: catName, tipo: setType ?? undefined, necessidade: setNec ?? undefined };
      if (args.apply_retroactive !== true) return { regra_criada: criada };
      // casa pela descrição OU pelo estabelecimento, como a regra faz na ingestão
      const rows = (await db.execute(sql`
        select id::text, transaction_date::text as data, amount::text as valor, description as descricao from transactions
        where user_id=${uid} and deleted_at is null
          and (position(${rule.pattern} in ${sqlNorm(sql`description`)}) > 0
            or position(${rule.pattern} in ${sqlNorm(sql`merchant_normalized`)}) > 0)
        order by transaction_date desc`)) as unknown as { id: string; data: string; valor: string; descricao: string }[];
      if (!rows.length) return { regra_criada: criada, historico_afetado: 0 };
      return {
        regra_criada: criada,
        historico_afetado: rows.length,
        exemplos: rows.slice(0, 5).map(({ id: _id, ...r }) => r),
        confirm_token: createConfirmation(ctx.batchId, 'rule_retro', rows.map((r) => r.id), { catId, setType, setNec }),
        instrucao: 'a regra já vale para as próximas; pergunte se ele quer aplicar também nessas transações antigas',
      };
    }

    case 'list_category_rules': {
      const rows = await db.execute(sql`
        select r.merchant_pattern as padrao, c.name as categoria, r.set_type as tipo, r.set_necessity as necessidade
        from category_rules r left join categories c on c.id = r.category_id
        where r.active order by r.created_at desc limit 40`);
      return { regras: rows };
    }

    case 'delete_rule': {
      const [rule] = (await db.execute(sql`
        select id::text, merchant_pattern from category_rules
        where merchant_pattern = ${normalizeText(String(a.merchant_pattern ?? ''))} and active`)) as unknown as {
        id: string;
        merchant_pattern: string;
      }[];
      if (!rule) return { erro: 'regra não encontrada — use list_category_rules para ver os padrões' };
      await db.execute(sql`update category_rules set active=false where id=${rule.id}::uuid`);
      await recordChange(db, ctx, { action: 'rule_delete', entity: 'category_rule', entityId: rule.id, before: { active: true }, after: { active: false } });
      return { removida: rule.merchant_pattern };
    }

    case 'list_categories':
      return { gastos: await categoryTree(db, 'expense'), receitas: await categoryTree(db, 'income') };

    case 'create_category': {
      const uid = await ownerId(db);
      const kind = a.kind === 'income' ? 'income' : 'expense';
      const nome = String(a.name ?? '').trim();
      if (nome.length < 2) return { erro: 'nome inválido' };
      const existente = (await resolveCategory(db, nome, kind)).category;
      if (existente && existente.name.toLowerCase() === nome.toLowerCase()) return { erro: `já existe a categoria ${catLabel(existente)}` };
      let parent: CategoryRef | null = null;
      const principais = async () => (await categoryTree(db, kind)).map((p) => p.pai);
      if (a.parent_name) {
        parent = (await resolveCategory(db, String(a.parent_name), kind)).category;
        if (!parent || parent.parentId) return { erro: `"${a.parent_name}" não é uma categoria principal`, sugestoes: await principais() };
      } else if (kind === 'expense') {
        return { erro: 'diga em qual categoria principal ela fica', sugestoes: await principais() };
      }
      const [row] = (await db.execute(sql`
        insert into categories (user_id, name, parent_id, kind) values (${uid}, ${nome}, ${parent?.id ?? null}::uuid, ${kind})
        returning id::text`)) as unknown as { id: string }[];
      await recordChange(db, ctx, { action: 'category_create', entity: 'category', entityId: row!.id, before: null, after: { name: nome, parent: parent?.name ?? null } });
      return { criada: { nome, pai: parent?.name ?? null } };
    }

    case 'recategorize_transactions': {
      const uid = await ownerId(db);
      const setType = (a.set_type as string) ?? null;
      const r = await categoryFor(db, String(a.category_name), setType ?? 'expense');
      if (!r.category) return notFound(a.category_name, r.sugestoes);
      const pStart = (a.period_start as string) ?? addDays(todayIso(), -90);
      const pEnd = (a.period_end as string) ?? '2999-12-31';
      const search = `%${String(a.search).toLowerCase()}%`;
      const matches = (await db.execute(sql`
        select id::text as id, transaction_date::text as data, amount::text as valor, description as descricao,
          transaction_date >= current_date - 60 as recente
        from transactions
        where user_id=${uid} and deleted_at is null and transaction_date between ${pStart} and ${pEnd}
          and (lower(description) like ${search} or lower(coalesce(merchant_normalized,'')) like ${search})
        order by transaction_date desc limit 50`)) as unknown as { id: string; data: string; valor: string; descricao: string; recente: boolean }[];
      if (!matches.length) return { erro: 'nenhuma transação encontrada com essa busca nesse período' };
      let alvo: typeof matches | null = null;
      if (a.confirm_token) {
        // só ids da prévia (gerada numa mensagem anterior) — nunca amplia o conjunto
        const c = takeConfirmation(String(a.confirm_token), ctx.batchId, 'recategorize');
        if (c.erro !== undefined) return { erro: c.erro };
        const pedidos = (args.confirm_ids as string[] | undefined) ?? c.ids;
        alvo = matches.filter((m) => c.ids.includes(m.id) && pedidos.includes(m.id));
      } else if (matches.length === 1 && matches[0]!.recente) {
        alvo = matches; // uma única transação recente: aplica direto
      }
      if (!alvo) {
        return {
          previa: matches.map((m) => ({ id: m.id, data: m.data, valor: m.valor, descricao: m.descricao })),
          total: matches.length,
          confirm_token: createConfirmation(ctx.batchId, 'recategorize', matches.map((m) => m.id), null),
          instrucao: 'mostre a lista ao usuário; se ele confirmar, chame de novo com confirm_token (e confirm_ids se ele aprovou só parte)',
        };
      }
      for (const m of alvo) {
        await applyTxChange(db, ctx, 'recategorize', m.id, {
          category_id: r.category.id,
          category_source: 'manual',
          ...(setType ? { type: setType } : {}),
        });
      }
      return { atualizadas: alvo.length, transacoes: alvo.map((m) => ({ data: m.data, valor: m.valor, descricao: m.descricao })), categoria: catLabel(r.category) };
    }

    case 'update_transaction': {
      const loc = await locateTransaction(db, a);
      if (!loc.tx) return loc.candidatas ? { varias_encontradas_escolha_um_id: loc.candidatas } : { erro: loc.erro };
      const change: TxChange = {};
      const newType = (a.new_type as string) ?? loc.tx.tipo;
      if (a.new_category_name) {
        const r = await categoryFor(db, String(a.new_category_name), newType);
        if (!r.category) return notFound(a.new_category_name, r.sugestoes);
        change.category_id = r.category.id;
        change.category_source = 'manual';
      }
      if (a.new_type) change.type = String(a.new_type);
      if (a.new_date) change.transaction_date = String(a.new_date);
      if (a.new_amount !== undefined) change.amount = Number(a.new_amount).toFixed(2);
      if (a.new_description) change.description = String(a.new_description);
      if (a.new_notes !== undefined) change.notes = String(a.new_notes);
      if (NECESSITIES.includes(a.new_necessity as Necessity)) {
        change.necessity = String(a.new_necessity);
        change.necessity_source = 'manual';
      }
      await applyTxChange(db, ctx, 'update_transaction', loc.tx.id, change);
      const [row] = await db.execute(sql`
        select t.transaction_date::text as data, t.amount::text as valor, t.type as tipo, t.description as descricao,
          coalesce(c.name,'') as categoria, t.notes as observacao
        from transactions t left join categories c on c.id=t.category_id where t.id=${loc.tx.id}::uuid`);
      return { atualizada: row ?? null };
    }

    case 'delete_transaction': {
      const loc = await locateTransaction(db, a);
      if (!loc.tx) return loc.candidatas ? { varias_encontradas_escolha_um_id: loc.candidatas } : { erro: loc.erro };
      await applyTxChange(db, ctx, 'delete_transaction', loc.tx.id, { deleted: true });
      return { excluida: { data: loc.tx.data, valor: loc.tx.valor, descricao: loc.tx.descricao } };
    }

    case 'split_transaction': {
      const loc = await locateTransaction(db, a);
      if (!loc.tx) return loc.candidatas ? { varias_encontradas_escolha_um_id: loc.candidatas } : { erro: loc.erro };
      const parts = (args.parts as { amount: number; category_name?: string; type?: string; description?: string }[]) ?? [];
      if (!Array.isArray(parts) || parts.length < 2) return { erro: 'informe pelo menos 2 partes' };
      const soma = parts.reduce((s, p) => s + Number(p.amount), 0);
      const original = Number(loc.tx.valor);
      if (Math.abs(soma - original) > 0.01)
        return { erro: `a soma das partes (R$ ${soma.toFixed(2)}) difere do valor original (R$ ${original.toFixed(2)}) — ajuste as partes` };
      // valida todas as categorias antes de gravar qualquer parte
      const cats: (CategoryRef | null)[] = [];
      for (const p of parts) {
        if (!p.category_name) {
          cats.push(null);
          continue;
        }
        const r = await categoryFor(db, p.category_name, p.type ?? loc.tx.tipo);
        if (!r.category) return notFound(p.category_name, r.sugestoes);
        cats.push(r.category);
      }
      const criadas = [];
      for (const [i, p] of parts.entries()) {
        const type = p.type ?? loc.tx.tipo;
        const cat = cats[i];
        await cloneTxAudited(db, ctx, 'split_part', loc.tx.id, {
          amount: Number(p.amount).toFixed(2),
          type,
          description: p.description ?? `${loc.tx.descricao} (parte)`,
          notes: `parte da transação dividida ${loc.tx.id}`,
          ...(cat ? { category_id: cat.id, category_source: 'manual' } : kindOfType(type) ? {} : { category_id: null }),
        });
        criadas.push({ valor: Number(p.amount).toFixed(2), tipo: type, categoria: cat?.name });
      }
      await applyTxChange(db, ctx, 'split_original', loc.tx.id, { deleted: true, notes: `dividida em ${parts.length} partes` });
      return { original_substituida: { data: loc.tx.data, valor: loc.tx.valor, descricao: loc.tx.descricao }, partes_criadas: criadas };
    }

    case 'mark_receivable': {
      try {
        const r = await markReceivable(db, ctx, String(a.id), {
          amount: a.amount !== undefined ? Number(a.amount) : undefined,
          who: a.who as string | undefined,
        });
        return { valor: r.valor, quem: r.quem };
      } catch (e) {
        return { erro: (e as Error).message };
      }
    }

    case 'list_receivables': {
      const rows = await openReceivables(db);
      return { a_receber: rows.map((r) => ({ quem: r.counterparty, valor: r.amount, desde: r.data, origem: r.origem })) };
    }

    case 'undo_last_change': {
      const r = await undoLastBatch(db);
      return r.desfeitas ? { desfeitas: r.desfeitas, acoes: r.acoes } : { erro: 'não há alteração recente para desfazer' };
    }

    case 'create_task': {
      let project: string | null = null;
      if (a.project) {
        const r = await resolveProject(db, String(a.project));
        if (!r.projeto) return { erro: `não conheço o projeto "${a.project}"`, projetos: r.sugestoes };
        project = r.projeto;
      }
      let id: string;
      try {
        id = await createTask(db, ctx, {
        title: String(a.title),
        project,
        priority: (['low', 'medium', 'high'].includes(String(a.priority)) ? a.priority : 'medium') as 'low' | 'medium' | 'high',
        dueDate: (a.due_date as string) || null,
        dueTime: (a.due_time as string) || null,
        remindAt: (a.remind_at as string) || null,
        });
      } catch (e) {
        return { erro: (e as Error).message };
      }
      const [t] = await db.execute(sql`
        select title as titulo, project as projeto, due_date::text as prazo,
          to_char(remind_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as lembrete
        from tasks where id=${id}::uuid`);
      return { criada: t ?? null };
    }

    case 'list_tasks': {
      let project: string | null = null;
      if (a.project) {
        const r = await resolveProject(db, String(a.project));
        if (!r.projeto) return { erro: `não conheço o projeto "${a.project}"`, projetos: r.sugestoes };
        project = r.projeto;
      }
      const filter = ['overdue', 'today', 'no_due'].includes(String(a.filter)) ? (a.filter as 'overdue' | 'today' | 'no_due') : 'all_open';
      const r = await buildTaskList(db, { title: `tarefas${project ? ` de ${project}` : ''}`, project, filter });
      return r ? { texto: `${r.text}\n\n${TASK_HINT}`, total: r.total } : { texto: 'Nenhuma tarefa aberta nesse filtro. 🎉', total: 0 };
    }

    case 'edit_task_items': {
      const { numeros, ...rest } = args as { numeros?: number[] } & Omit<TaskItemChange, 'n'>;
      const changes: TaskItemChange[] = (numeros ?? []).map((n) => ({ ...rest, n: Number(n) }));
      if (!changes.length || !rest.acao) return { erro: 'informe numeros e acao' };
      return { ...(await editTaskItems(db, { changes, ctx })) };
    }

    case 'update_task': {
      const rows = await findOpenTasks(db, String(a.title_search ?? ''));
      if (!rows.length) return { erro: 'nenhuma tarefa aberta com esse título' };
      if (rows.length > 1) return { varias_encontradas: rows.map(({ id: _id, ...r }) => r), instrucao: 'pergunte qual (ou use list_tasks e o número)' };
      const { title_search: _s, ...change } = args as Record<string, string | undefined>;
      return { titulo: rows[0]!.titulo, ...(await applyTaskAction(db, ctx, rows[0]!.id, change as Omit<TaskItemChange, 'n'>)) };
    }

    case 'complete_task': {
      const rows = await findOpenTasks(db, String(a.title_search ?? ''));
      if (!rows.length) return { erro: 'nenhuma tarefa aberta encontrada com esse título' };
      if (rows.length > 1) return { varias_encontradas: rows.map((r) => r.titulo), instrucao: 'pergunte qual delas' };
      await applyTaskAction(db, ctx, rows[0]!.id, { acao: 'feito' });
      return { concluida: rows[0]!.titulo };
    }

    case 'create_project': {
      const uid = await ownerId(db);
      const nome = String(a.name ?? '').trim();
      if (nome.length < 2) return { erro: 'nome inválido' };
      return { projetos: await addProject(db, uid, nome) };
    }

    default:
      return { erro: `tool desconhecida: ${name}` };
  }
}
