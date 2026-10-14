// Tarefas: projetos, lista numerada editável, lembrete no horário e revisão semanal.
// Toda escrita vai para o audit_log (entidade task), então "desfaz" vale aqui também.
import { sql, type SQL } from 'drizzle-orm';
import { newBatchId, recordChange, type AuditContext } from '../finance/audit.js';
import { dayLabel, todayIso } from '../finance/format.js';
import { latestList, saveList, type ListItem } from '../finance/lists.js';
import { normalizeText, sqlNorm } from '../finance/rules.js';
import { getSetting, setSetting } from '../finance/settings.js';
import type { DbOrTx } from '../finance/types.js';

// projetos iniciais; o setup e o dono (por mensagem) ajustam em owner_settings.task_projects
export const DEFAULT_PROJECTS = ['Trabalho', 'Pessoal', 'Estudos'];
export const TASK_HINT = 'Responda pelo número: "1 feito", "2 para sexta", "3 apaga", "4 urgente", "5 projeto pessoal", "6 me lembra amanhã 9h".';
const PRIORITY: Record<string, 'low' | 'medium' | 'high'> = { baixa: 'low', media: 'medium', alta: 'high', urgente: 'high' };

export type TaskSnapshot = {
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  due_time: string | null;
  project: string | null;
  remind_at: string | null;
  reminded_at: string | null;
  completed_at: string | null;
};
const SNAP = sql`title, status::text, priority::text, due_date::text, due_time, project, remind_at::text, reminded_at::text, completed_at::text`;

export async function getProjects(db: DbOrTx): Promise<string[]> {
  const v = await getSetting<unknown>(db, 'task_projects', DEFAULT_PROJECTS);
  return Array.isArray(v) && v.every((p) => typeof p === 'string') && v.length ? (v as string[]) : DEFAULT_PROJECTS;
}

export async function resolveProject(db: DbOrTx, name: string): Promise<{ projeto: string | null; sugestoes: string[] }> {
  const projects = await getProjects(db);
  const n = normalizeText(name);
  const exact = projects.find((p) => normalizeText(p) === n);
  if (exact) return { projeto: exact, sugestoes: [] };
  const partial = n.length >= 3 ? projects.filter((p) => normalizeText(p).includes(n)) : [];
  if (partial.length === 1) return { projeto: partial[0]!, sugestoes: [] };
  return { projeto: null, sugestoes: projects };
}

export async function addProject(db: DbOrTx, userId: string, name: string): Promise<string[]> {
  const projects = await getProjects(db);
  if (projects.some((p) => normalizeText(p) === normalizeText(name))) return projects;
  const next = [...projects, name.trim()];
  await setSetting(db, userId, 'task_projects', next);
  return next;
}

// Data/hora do lembrete dita pelo modelo → ISO com fuso. Hora de Brasília quando vem sem
// fuso; só a data = 9h. Formato desconhecido → null (a tool devolve erro, nada é gravado).
export function parseLocalDateTime(s: string): string | null {
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T09:00:00-03:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([zZ]|[+-]\d{2}:?\d{2})$/.test(v)) return v;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(v);
  return m ? `${m[1]}T${m[2]}${m[3] ?? ':00'}-03:00` : null;
}

// Avisa quem agenda os lembretes (temporizador no scheduler) que algo mudou.
const reminderListeners = new Set<() => void>();
export function onReminderChange(cb: () => void): () => void {
  reminderListeners.add(cb);
  return () => reminderListeners.delete(cb);
}
const notifyReminderChange = () => reminderListeners.forEach((cb) => cb());

export interface TaskChange {
  title?: string;
  status?: 'pending' | 'done' | 'cancelled';
  priority?: 'low' | 'medium' | 'high';
  due_date?: string | null;
  due_time?: string | null;
  project?: string | null;
  remind_at?: string | null; // ISO com fuso
}

export async function applyTaskChange(db: DbOrTx, ctx: AuditContext, action: string, id: string, change: TaskChange): Promise<void> {
  const [before] = (await db.execute(sql`select ${SNAP} from tasks where id=${id}::uuid`)) as unknown as TaskSnapshot[];
  if (!before) throw new Error('tarefa não encontrada');
  const has = (k: keyof TaskChange) => Object.prototype.hasOwnProperty.call(change, k);
  const sets: SQL[] = [];
  if (has('title')) sets.push(sql`title = ${change.title!}`);
  if (has('status')) {
    sets.push(sql`status = ${change.status!}::task_status`);
    sets.push(change.status === 'done' ? sql`completed_at = now()` : sql`completed_at = null`);
  }
  if (has('priority')) sets.push(sql`priority = ${change.priority!}::task_priority`);
  if (has('due_date')) sets.push(sql`due_date = ${change.due_date ?? null}::date`);
  if (has('due_time')) sets.push(sql`due_time = ${change.due_time ?? null}`);
  if (has('project')) sets.push(sql`project = ${change.project ?? null}`);
  if (has('remind_at')) sets.push(sql`remind_at = ${change.remind_at ?? null}::timestamptz, reminded_at = null`);
  if (!sets.length) return;
  const [after] = (await db.execute(sql`
    update tasks set ${sql.join(sets, sql`, `)}, updated_at = now() where id=${id}::uuid returning ${SNAP}`)) as unknown as TaskSnapshot[];
  await recordChange(db, ctx, { action, entity: 'task', entityId: id, before, after });
  if (has('remind_at') || (has('status') && before.remind_at)) notifyReminderChange();
}

export async function createTask(
  db: DbOrTx,
  ctx: AuditContext,
  t: { title: string; project?: string | null; priority?: 'low' | 'medium' | 'high'; dueDate?: string | null; dueTime?: string | null; remindAt?: string | null },
): Promise<string> {
  const remindAt = t.remindAt ? parseLocalDateTime(t.remindAt) : null;
  if (t.remindAt && !remindAt) throw new Error('horário do lembrete inválido (use YYYY-MM-DDTHH:MM)');
  const [owner] = (await db.execute(sql`select id::text from users where role='owner' limit 1`)) as unknown as { id: string }[];
  const [row] = (await db.execute(sql`
    insert into tasks (user_id, title, project, priority, due_date, due_time, remind_at)
    values (${owner!.id}::uuid, ${t.title}, ${t.project ?? null}, ${t.priority ?? 'medium'}::task_priority,
      ${t.dueDate ?? null}::date, ${t.dueTime ?? null}, ${remindAt}::timestamptz)
    returning id::text, ${SNAP}`)) as unknown as (TaskSnapshot & { id: string })[];
  const { id, ...after } = row!;
  await recordChange(db, ctx, { action: 'task_create', entity: 'task', entityId: id, before: null, after });
  if (remindAt) notifyReminderChange();
  return id;
}

type OpenRow = {
  id: string;
  title: string;
  priority: string;
  due_date: string | null;
  project: string | null;
  remind_local: string | null; // 'YYYY-MM-DD HH:MI' em Brasília
};

async function openTasks(db: DbOrTx, where: SQL = sql``): Promise<OpenRow[]> {
  return (await db.execute(sql`
    select id::text, title, priority::text, due_date::text, project,
      to_char(remind_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as remind_local
    from tasks where status in ('pending','in_progress') ${where}
    order by due_date nulls last, case priority when 'high' then 0 when 'medium' then 1 else 2 end, created_at`)) as unknown as OpenRow[];
}

function taskLine(n: number, r: OpenRow, today: string): string {
  const parts = [`${n}. ${r.title}`];
  if (r.due_date) parts.push(` · até ${dayLabel(r.due_date)}${r.due_date < today ? ' ⚠️ atrasada' : ''}`);
  if (r.priority === 'high') parts.push(' 🔥');
  if (r.remind_local) {
    const [d, h] = r.remind_local.split(' ') as [string, string];
    parts.push(` ⏰ ${h}${r.due_date === d ? '' : ` (${dayLabel(d)})`}`);
  }
  return parts.join('');
}

// Lista numerada agrupada por projeto (ordem dos projetos configurados; "Sem projeto" por último).
async function renderGrouped(db: DbOrTx, rows: OpenRow[], today: string): Promise<{ lines: string[]; items: ListItem[] }> {
  const projects = await getProjects(db);
  const groups = new Map<string, OpenRow[]>();
  for (const r of rows) {
    const g = r.project ?? 'Sem projeto';
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const order = [...projects, ...[...groups.keys()].filter((g) => !projects.includes(g) && g !== 'Sem projeto').sort(), 'Sem projeto'];
  const lines: string[] = [];
  const items: ListItem[] = [];
  let n = 0;
  for (const g of order) {
    const rs = groups.get(g);
    if (!rs?.length) continue;
    lines.push(`*${g}*`);
    for (const r of rs) {
      items.push({ n: ++n, kind: 'task', taskId: r.id });
      lines.push(taskLine(n, r, today));
    }
  }
  return { lines, items };
}

export async function buildTaskList(
  db: DbOrTx,
  opts: { title: string; header?: string; project?: string | null; filter?: 'all_open' | 'overdue' | 'today' | 'no_due'; today?: string },
): Promise<{ text: string; total: number } | null> {
  const today = opts.today ?? todayIso();
  const conds: SQL[] = [];
  if (opts.project) conds.push(sql`and project = ${opts.project}`);
  if (opts.filter === 'overdue') conds.push(sql`and due_date < ${today}::date`);
  if (opts.filter === 'today') conds.push(sql`and due_date = ${today}::date`);
  if (opts.filter === 'no_due') conds.push(sql`and due_date is null`);
  const rows = await openTasks(db, sql.join(conds, sql` `));
  if (!rows.length) return null;
  const { lines, items } = await renderGrouped(db, rows, today);
  await saveList(db, 'tasks', opts.title, items);
  return { text: [opts.header ?? `✅ *Tarefas abertas* (${rows.length})`, ...lines].join('\n'), total: rows.length };
}

// Revisão semanal: sem prazo, atrasadas ou paradas há mais de 14 dias.
export async function buildTaskReview(db: DbOrTx, today = todayIso()): Promise<{ text: string } | null> {
  const rows = await openTasks(db, sql`and (due_date is null or due_date < ${today}::date or created_at < now() - interval '14 days')`);
  if (!rows.length) return null;
  const { lines, items } = await renderGrouped(db, rows, today);
  await saveList(db, 'tasks', `revisão de tarefas ${today}`, items);
  return {
    text: [`🧹 *Revisão das tarefas* — ${rows.length} sem prazo, atrasadas ou paradas há mais de 2 semanas`, ...lines, '', TASK_HINT].join('\n'),
  };
}

export async function dueReminders(db: DbOrTx, now?: string): Promise<{ id: string; title: string }[]> {
  return (await db.execute(sql`
    select id::text, title from tasks
    where status in ('pending','in_progress') and remind_at is not null and reminded_at is null
      and remind_at <= coalesce(${now ?? null}::timestamptz, now())
    order by remind_at`)) as unknown as { id: string; title: string }[];
}

export async function nextReminderAt(db: DbOrTx): Promise<Date | null> {
  const [r] = (await db.execute(sql`
    select min(remind_at)::text as next from tasks
    where status in ('pending','in_progress') and remind_at is not null and reminded_at is null`)) as unknown as { next: string | null }[];
  return r?.next ? new Date(r.next.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : null;
}

// Todos os lembretes que vencem juntos viram UMA mensagem numerada (uma lista só),
// para "feito" / "2 feito" / "adia 1h" acharem a tarefa certa.
export async function buildReminderMessage(db: DbOrTx, ts: { id: string; title: string }[]): Promise<string> {
  for (const t of ts) await db.execute(sql`update tasks set reminded_at = now() where id=${t.id}::uuid`);
  await saveList(db, 'tasks', `lembrete: ${ts.map((t) => t.title).join(', ')}`, ts.map((t, i) => ({ n: i + 1, kind: 'task' as const, taskId: t.id })));
  if (ts.length === 1) return `⏰ *Lembrete:* ${ts[0]!.title}\nResponda "feito" ou "adia 1h" (ou "amanhã 9h").`;
  return `⏰ *Lembretes:*\n${ts.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}\nResponda pelo número: "1 feito", "2 adia 1h".`;
}

// Tarefas abertas cujo título contém o trecho (sem diferenciar acento/maiúscula).
export async function findOpenTasks(db: DbOrTx, search: string): Promise<{ id: string; titulo: string; prazo: string | null; projeto: string | null }[]> {
  return (await db.execute(sql`
    select id::text, title as titulo, due_date::text as prazo, project as projeto from tasks
    where status in ('pending','in_progress') and position(${normalizeText(search)} in ${sqlNorm(sql`title`)}) > 0
    order by created_at limit 6`)) as unknown as { id: string; titulo: string; prazo: string | null; projeto: string | null }[];
}

export type TaskAction = 'feito' | 'reabrir' | 'apagar' | 'prazo' | 'sem_prazo' | 'prioridade' | 'projeto' | 'lembrete' | 'renomear';
export interface TaskItemChange {
  n: number;
  acao: TaskAction;
  data?: string | undefined; // YYYY-MM-DD
  hora?: string | undefined; // HH:MM
  prioridade?: string | undefined;
  projeto?: string | undefined;
  quando?: string | undefined; // YYYY-MM-DDTHH:MM (Brasília)
  titulo?: string | undefined;
}

export async function applyTaskAction(
  db: DbOrTx,
  ctx: AuditContext,
  taskId: string,
  ch: Omit<TaskItemChange, 'n'>,
): Promise<{ ok: boolean; feito?: string; erro?: string; sugestoes?: string[] }> {
  switch (ch.acao) {
    case 'feito':
      await applyTaskChange(db, ctx, 'task_done', taskId, { status: 'done' });
      return { ok: true, feito: 'concluída' };
    case 'reabrir':
      await applyTaskChange(db, ctx, 'task_reopen', taskId, { status: 'pending' });
      return { ok: true, feito: 'reaberta' };
    case 'apagar':
      await applyTaskChange(db, ctx, 'task_delete', taskId, { status: 'cancelled' });
      return { ok: true, feito: 'apagada' };
    case 'prazo':
      if (!ch.data || !/^\d{4}-\d{2}-\d{2}$/.test(ch.data)) return { ok: false, erro: 'data inválida (use YYYY-MM-DD)' };
      await applyTaskChange(db, ctx, 'task_due', taskId, { due_date: ch.data, ...(ch.hora ? { due_time: ch.hora } : {}) });
      return { ok: true, feito: `prazo ${dayLabel(ch.data)}${ch.hora ? ` ${ch.hora}` : ''}` };
    case 'sem_prazo':
      await applyTaskChange(db, ctx, 'task_due', taskId, { due_date: null, due_time: null });
      return { ok: true, feito: 'sem prazo' };
    case 'prioridade': {
      const p = PRIORITY[normalizeText(ch.prioridade ?? '')] ?? PRIORITY[ch.prioridade ?? ''];
      if (!p) return { ok: false, erro: 'prioridade: alta, média ou baixa' };
      await applyTaskChange(db, ctx, 'task_priority', taskId, { priority: p });
      return { ok: true, feito: `prioridade ${ch.prioridade}` };
    }
    case 'projeto': {
      const r = await resolveProject(db, ch.projeto ?? '');
      if (!r.projeto) return { ok: false, erro: `não conheço o projeto "${ch.projeto}"`, sugestoes: r.sugestoes };
      await applyTaskChange(db, ctx, 'task_project', taskId, { project: r.projeto });
      return { ok: true, feito: `projeto ${r.projeto}` };
    }
    case 'lembrete': {
      const when = ch.quando ? parseLocalDateTime(ch.quando) : null;
      if (!when) return { ok: false, erro: 'quando inválido (use YYYY-MM-DDTHH:MM)' };
      await applyTaskChange(db, ctx, 'task_reminder', taskId, { remind_at: when });
      return { ok: true, feito: `lembrete ${ch.quando!.replace('T', ' ')}` };
    }
    case 'renomear':
      if (!ch.titulo?.trim()) return { ok: false, erro: 'faltou o novo título' };
      await applyTaskChange(db, ctx, 'task_rename', taskId, { title: ch.titulo.trim() });
      return { ok: true, feito: `renomeada` };
    default:
      return { ok: false, erro: `ação "${String(ch.acao)}" não existe para tarefa` };
  }
}

export async function editTaskItems(
  db: DbOrTx,
  input: { changes: TaskItemChange[]; ctx: AuditContext },
): Promise<{ lista: string | null; resultados: ({ n: number; titulo?: string | undefined } & Awaited<ReturnType<typeof applyTaskAction>>)[] }> {
  const list = await latestList(db, 'tarefas');
  if (!list) return { lista: null, resultados: input.changes.map((c) => ({ n: c.n, ok: false, erro: 'nenhuma lista de tarefas enviada ainda' })) };
  const resultados = [];
  for (const ch of input.changes) {
    const item = list.items.find((i) => i.n === ch.n && i.taskId);
    if (!item) {
      resultados.push({ n: ch.n, ok: false, erro: `não existe a tarefa ${ch.n} na lista "${list.title}"` });
      continue;
    }
    const [t] = (await db.execute(sql`select title from tasks where id=${item.taskId!}::uuid`)) as unknown as { title: string }[];
    try {
      resultados.push({ n: ch.n, titulo: t?.title, ...(await applyTaskAction(db, input.ctx, item.taskId!, ch)) });
    } catch (e) {
      resultados.push({ n: ch.n, ok: false, erro: (e as Error).message });
    }
  }
  return { lista: list.title, resultados };
}
