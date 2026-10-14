import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  buildTaskList,
  buildTaskReview,
  createTask,
  dueReminders,
  buildReminderMessage,
  nextReminderAt,
  onReminderChange,
  parseLocalDateTime,
  findOpenTasks,
  editTaskItems,
  resolveProject,
} from '../src/tasks/tasks.js';
import { latestList } from '../src/finance/lists.js';
import { newBatchId, undoLastBatch } from '../src/finance/audit.js';
import { executeTool } from '../src/ai/tools.js';
import { createTestDb, type TestDb } from './helpers/db.js';

const ctx = () => ({ batchId: newBatchId(), origin: 'chat' });
const task = async (t: TestDb, title: string) =>
  (await t.db.execute(sql`
    select status, due_date::text as prazo, priority as prioridade, project as projeto, remind_at is not null as lembrete
    from tasks where title=${title}`))[0] as { status: string; prazo: string | null; prioridade: string; projeto: string | null; lembrete: boolean };

describe('tarefas', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.close());

  it('projetos: resolve sem acento/maiúscula e devolve sugestões quando não conhece', async () => {
    expect((await resolveProject(t.db, 'trabalho')).projeto).toBe('Trabalho');
    expect((await resolveProject(t.db, 'CONTRATAÇÃO')).projeto).toBe('Contratação');
    const r = await resolveProject(t.db, 'astrologia');
    expect(r.projeto).toBeNull();
    expect(r.sugestoes).toContain('Pessoal');
  });

  it('lista numerada agrupada por projeto, com atrasada, prioridade e lembrete; sem projeto por último', async () => {
    const c = ctx();
    await createTask(t.db, c, { title: 'Fazer conexão com Ana', project: 'Rede' });
    await createTask(t.db, c, { title: 'Análise de custo por lead', project: 'Trabalho', priority: 'high' });
    await createTask(t.db, c, { title: 'Pedir ajuda ao contador (IR)', project: 'Trabalho', dueDate: '2026-09-15' });
    await createTask(t.db, c, { title: 'Ligar pro banco', project: 'Rede', dueDate: '2026-10-14', remindAt: '2026-10-14T15:00' });
    await createTask(t.db, c, { title: 'Mandar mensagem no LinkedIn', project: null });
    const r = await buildTaskList(t.db, { title: 'tarefas abertas', today: '2026-10-13' });
    const txt = r!.text;
    expect(txt.indexOf('*Rede*')).toBeGreaterThan(txt.indexOf('*Trabalho*'));
    expect(txt.indexOf('*Sem projeto*')).toBeGreaterThan(txt.indexOf('*Rede*'));
    expect(txt).toMatch(/1\. Pedir ajuda ao contador \(IR\) · até Ter 15\/09 ⚠️ atrasada/);
    expect(txt).toMatch(/2\. Análise de custo por lead 🔥/);
    expect(txt).toMatch(/Ligar pro banco · até Qua 14\/10 ⏰ 15:00/);
    const list = await latestList(t.db, 'tarefas');
    expect(list!.items).toHaveLength(5);
    // a lista de tarefas não vira a "última lista" dos gastos
    expect(await latestList(t.db)).toBeNull();
  });

  it('pelo número: feito, prazo, prioridade, projeto, lembrete e apagar — e desfazer', async () => {
    const r = await editTaskItems(t.db, {
      ctx: ctx(),
      changes: [
        { n: 1, acao: 'feito' },
        { n: 2, acao: 'prazo', data: '2026-10-16' },
        { n: 4, acao: 'projeto', projeto: 'contratação' },
        { n: 5, acao: 'apagar' },
      ],
    });
    expect(r.resultados.every((x) => x.ok)).toBe(true);
    expect((await task(t, 'Pedir ajuda ao contador (IR)')).status).toBe('done');
    expect((await task(t, 'Análise de custo por lead')).prazo).toBe('2026-10-16');
    expect((await task(t, 'Fazer conexão com Ana')).projeto).toBe('Contratação');
    expect((await task(t, 'Mandar mensagem no LinkedIn')).status).toBe('cancelled');
    const u = await undoLastBatch(t.db);
    expect(u.desfeitas).toBe(4);
    expect((await task(t, 'Pedir ajuda ao contador (IR)')).status).toBe('pending');
    expect((await task(t, 'Mandar mensagem no LinkedIn')).status).toBe('pending');
    const p = await editTaskItems(t.db, { ctx: ctx(), changes: [{ n: 2, acao: 'prioridade', prioridade: 'baixa' }, { n: 3, acao: 'projeto', projeto: 'astrologia' }] });
    expect((await task(t, 'Análise de custo por lead')).prioridade).toBe('low');
    expect(p.resultados[1]).toMatchObject({ ok: false });
  });

  it('lembrete: dispara uma vez na hora e vira lista de 1 item para "feito"/"adia"', async () => {
    expect(await dueReminders(t.db, '2026-10-14T14:59:00-03:00')).toHaveLength(0);
    const due = await dueReminders(t.db, '2026-10-14T15:00:30-03:00');
    expect(due.map((d) => d.title)).toEqual(['Ligar pro banco']);
    const msg = await buildReminderMessage(t.db, due);
    expect(msg).toMatch(/⏰ \*Lembrete:\* Ligar pro banco/);
    expect(await dueReminders(t.db, '2026-10-14T15:05:00-03:00')).toHaveLength(0);
    const adia = await editTaskItems(t.db, { ctx: ctx(), changes: [{ n: 1, acao: 'lembrete', quando: '2026-10-14T16:00' }] });
    expect(adia.resultados[0]!.ok).toBe(true);
    expect((await dueReminders(t.db, '2026-10-14T16:00:10-03:00')).map((d) => d.title)).toEqual(['Ligar pro banco']);
  });

  it('dois lembretes na mesma hora viram uma mensagem numerada (cada "feito" acha a tarefa certa)', async () => {
    // consome os lembretes pendentes dos testes anteriores (atrasado também dispara)
    await buildReminderMessage(t.db, await dueReminders(t.db, '2026-10-19T00:00:00-03:00'));
    const c = ctx();
    await createTask(t.db, c, { title: 'Lembrete A', project: 'Pessoal', remindAt: '2026-10-20T10:00' });
    await createTask(t.db, c, { title: 'Lembrete B', project: 'Pessoal', remindAt: '2026-10-20T10:00' });
    const due = await dueReminders(t.db, '2026-10-20T10:00:30-03:00');
    const msg = await buildReminderMessage(t.db, due);
    expect(msg).toMatch(/⏰ \*Lembretes:\*\n1\. Lembrete A\n2\. Lembrete B/);
    await editTaskItems(t.db, { ctx: ctx(), changes: [{ n: 2, acao: 'feito' }] });
    expect((await task(t, 'Lembrete B')).status).toBe('done');
    expect((await task(t, 'Lembrete A')).status).toBe('pending');
  });

  it('próximo lembrete e aviso de mudança (para o temporizador, sem consultar o banco a cada minuto)', async () => {
    let avisos = 0;
    const off = onReminderChange(() => avisos++);
    await createTask(t.db, ctx(), { title: 'Lembrete C', project: 'Pessoal', remindAt: '2030-01-01T08:00' });
    await createTask(t.db, ctx(), { title: 'Sem lembrete', project: 'Pessoal' });
    expect(avisos).toBe(1);
    const next = await nextReminderAt(t.db);
    expect(next).toBeInstanceOf(Date);
    off();
  });

  it('datas do lembrete: aceita com espaço, com T, só a data (9h) e recusa lixo', () => {
    expect(parseLocalDateTime('2026-10-14 16:00')).toBe('2026-10-14T16:00:00-03:00');
    expect(parseLocalDateTime('2026-10-14T16:00')).toBe('2026-10-14T16:00:00-03:00');
    expect(parseLocalDateTime('2026-10-15')).toBe('2026-10-15T09:00:00-03:00');
    expect(parseLocalDateTime('2026-10-14T16:00:00Z')).toBe('2026-10-14T16:00:00Z');
    expect(parseLocalDateTime('amanhã')).toBeNull();
  });

  it('busca de tarefa aberta pelo título, sem acento', async () => {
    const r = await findOpenTasks(t.db, 'CONTADOR (ir)');
    expect(r.map((x) => x.titulo)).toEqual(['Pedir ajuda ao contador (IR)']);
  });

  it('revisão semanal: sem prazo, atrasadas ou paradas há mais de 14 dias', async () => {
    await t.db.execute(sql`update tasks set created_at = now() - interval '20 days' where title='Análise de custo por lead'`);
    await createTask(t.db, ctx(), { title: 'Tarefa nova com prazo', project: 'Pessoal', dueDate: '2099-01-01' });
    const r = await buildTaskReview(t.db, '2026-10-18');
    expect(r!.text).toMatch(/🧹/);
    expect(r!.text).toMatch(/Fazer conexão com Ana/); // sem prazo
    expect(r!.text).toMatch(/Pedir ajuda ao contador/); // atrasada
    expect(r!.text).toMatch(/Análise de custo por lead/); // parada há 20 dias (mesmo com prazo)
    expect(r!.text).not.toMatch(/Tarefa nova com prazo/);
  });

  it('tools: criar com projeto e lembrete, concluir por busca sem pegar várias, listar numerado', async () => {
    const c = (await executeTool(t.db, 'create_task', { title: 'Revisar proposta do fornecedor', project: 'trabalho', remind_at: '2026-10-15T09:00' })) as Record<string, unknown>;
    expect(c.criada).toMatchObject({ titulo: 'Revisar proposta do fornecedor', projeto: 'Trabalho' });
    const sem = (await executeTool(t.db, 'create_task', { title: 'X', project: 'astrologia' })) as Record<string, unknown>;
    expect(sem.erro).toBeDefined();
    const varias = (await executeTool(t.db, 'complete_task', { title_search: 'a' })) as Record<string, unknown>;
    expect(varias.varias_encontradas).toBeDefined();
    const ok = (await executeTool(t.db, 'complete_task', { title_search: 'proposta do fornecedor' })) as Record<string, unknown>;
    expect(ok.concluida).toBe('Revisar proposta do fornecedor');
    const l = (await executeTool(t.db, 'list_tasks', { project: 'rede' })) as { texto: string; total: number };
    expect(l.total).toBe(2);
    expect(l.texto).toMatch(/1\. /);
    const e = (await executeTool(t.db, 'edit_task_items', { numeros: [1], acao: 'renomear', titulo: 'Ligar pro banco de novo' })) as Record<string, unknown>;
    expect((e.resultados as { ok: boolean }[])[0]!.ok).toBe(true);
    const p = (await executeTool(t.db, 'create_project', { name: 'Kitesurf' })) as Record<string, unknown>;
    expect(p.projetos).toContain('Kitesurf');
  });
});
