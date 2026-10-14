// Resumo matinal: agenda de hoje + tarefas + gastos de ontem + recorrentes pendentes.
// Formatação determinística (sem LLM) — números direto do banco.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { netSpending } from '../finance/spending.js';
import { buildTaskList, TASK_HINT } from '../tasks/tasks.js';

const TZ = 'America/Sao_Paulo';

function isoDate(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}

function brl(v: unknown): string {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
  if (!tok.access_token) throw new Error('refresh google falhou');
  return tok.access_token;
}

export async function buildMorningSummary(db: Db): Promise<string> {
  const hoje = isoDate(new Date());
  const ontem = isoDate(new Date(Date.now() - 86_400_000));
  const linhas: string[] = [];

  const dataFmt = new Date().toLocaleDateString('pt-BR', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit' });
  linhas.push(`☀️ Bom dia! ${dataFmt.charAt(0).toUpperCase()}${dataFmt.slice(1)}`);

  // agenda de hoje
  try {
    const at = await googleAccessToken();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(`${hoje}T00:00:00-03:00`)}&timeMax=${encodeURIComponent(`${hoje}T23:59:59-03:00`)}&singleEvents=true&orderBy=startTime&maxResults=15`;
    const data = (await fetch(url, { headers: { authorization: `Bearer ${at}` } }).then((r) => r.json())) as {
      items?: { summary?: string; start?: { dateTime?: string; date?: string } }[];
    };
    const eventos = data.items ?? [];
    if (eventos.length) {
      linhas.push('\n📅 *Agenda de hoje:*');
      for (const e of eventos) {
        const hora = e.start?.dateTime ? e.start.dateTime.slice(11, 16) : 'dia todo';
        linhas.push(`• ${hora} — ${e.summary ?? '(sem título)'}`);
      }
    } else {
      linhas.push('\n📅 Agenda livre hoje.');
    }
  } catch {
    linhas.push('\n📅 (agenda indisponível agora)');
  }

  // todas as tarefas abertas, numeradas e agrupadas por projeto (decisão de 13/10/2026)
  const tarefas = await buildTaskList(db, { title: `tarefas da manhã ${hoje}`, today: hoje });
  if (tarefas) linhas.push('', tarefas.text, TASK_HINT);

  // gastos de ontem (líquidos de estornos)
  const g = await netSpending(db, { start: ontem, end: ontem });
  if (g.n > 0) {
    const top = await db.execute(sql`
      select description, amount::numeric(14,2) as v from transactions
      where type='expense' and deleted_at is null and transaction_date = ${ontem}
      order by amount desc limit 3`);
    const desconto = Number(g.estornos) > 0 ? ` (já descontados ${brl(g.estornos)} de estornos)` : '';
    linhas.push(`\n💸 *Ontem:* ${brl(g.liquido)} em ${g.n} transações${desconto}`);
    for (const t of top as unknown as { description: string; v: string }[]) {
      linhas.push(`• ${brl(t.v)} — ${t.description.slice(0, 40)}`);
    }
  } else {
    linhas.push('\n💸 Ontem: nenhum gasto registrado.');
  }

  return linhas.join('\n');
}
