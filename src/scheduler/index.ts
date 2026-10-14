// Agendador in-process: sync Pluggy, resumo matinal, novidades do dia.
import cron from 'node-cron';
import type { Db } from '../db/index.js';
import { PluggyClient } from '../ingestion/pluggy-client.js';
import { syncItem } from '../ingestion/sync.js';
import { pairFamilyTransfers } from '../finance/family.js';
import { buildMorningSummary } from '../jobs/morning-summary.js';
import { buildDailyList } from '../finance/daily-list.js';
import { buildWeeklyReport } from '../finance/weekly-report.js';
import { appendProactive } from '../ai/conversation.js';
import { buildReminderMessage, buildTaskReview, dueReminders, nextReminderAt, onReminderChange } from '../tasks/tasks.js';
import { sendToOwnerWhatsApp } from '../channels/whatsapp/index.js';
import { sendTelegram } from '../notify/telegram.js';
import { logger } from '../core/logger.js';

const TZ = 'America/Sao_Paulo';

async function notifyOwner(text: string): Promise<void> {
  try {
    await sendToOwnerWhatsApp(text);
  } catch (e) {
    logger.warn(e, 'whatsapp indisponível, caindo para telegram');
    await sendTelegram(text).catch((err) => logger.error(err, 'telegram também falhou'));
  }
}

// Mensagem automática: envia e grava na memória da conversa, para o bot saber a que
// "o 4" se refere quando o dono responder.
async function sendProactive(db: Db, text: string): Promise<void> {
  await notifyOwner(text);
  await appendProactive(db, text).catch((e) => logger.error(e, 'falha ao gravar mensagem automática no histórico'));
}

let reminderTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_WAIT_MS = 6 * 3_600_000;

async function armReminders(db: Db): Promise<void> {
  try {
    if (reminderTimer) clearTimeout(reminderTimer);
    const next = await nextReminderAt(db);
    const wait = next ? Math.max(0, Math.min(next.getTime() - Date.now(), MAX_WAIT_MS)) : MAX_WAIT_MS;
    reminderTimer = setTimeout(() => void fireReminders(db), wait);
  } catch (e) {
    logger.error(e, 'agendamento de lembretes falhou');
  }
}

async function fireReminders(db: Db): Promise<void> {
  try {
    const due = await dueReminders(db);
    if (due.length) await sendProactive(db, await buildReminderMessage(db, due));
  } catch (e) {
    logger.error(e, 'lembretes de tarefas falharam');
  }
  await armReminders(db);
}

async function runSync(db: Db): Promise<number> {
  const itemIds = (process.env.PLUGGY_ITEM_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pluggy = new PluggyClient(process.env.PLUGGY_CLIENT_ID!, process.env.PLUGGY_CLIENT_SECRET!);
  let inserted = 0;
  for (const id of itemIds) {
    try {
      const r = await syncItem(db, pluggy, id);
      inserted += r.transactionsInserted;
    } catch (e) {
      logger.error(e, `sync do item ${id.slice(0, 8)} falhou`);
    }
  }
  // repasses com a família podem atravessar bancos: pareia depois de todos os itens
  try {
    // só as pernas recentes podem formar par novo; o histórico foi tratado no retroativo
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const fam = await pairFamilyTransfers(db, { origin: 'sync', since });
    if (fam.pairs) logger.info(fam, 'repasses da família marcados como transferência');
  } catch (e) {
    logger.error(e, 'pareamento de repasses da família falhou');
  }
  logger.info({ inserted }, 'sync agendado concluído');
  return inserted;
}

export function startScheduler(db: Db): void {
  // sync frequente e silencioso (idempotente e gratuito); o das 19h vem com a lista do dia
  cron.schedule('0 1,4,7,10,13,16,22 * * *', () => void runSync(db), { timezone: TZ });

  cron.schedule('30 7 * * *', async () => {
    try {
      const resumo = await buildMorningSummary(db);
      await sendProactive(db, resumo);
    } catch (e) {
      logger.error(e, 'resumo matinal falhou');
    }
  }, { timezone: TZ });

  // 19h: sync + lista numerada do que entrou desde a anterior (com "quer alterar?")
  cron.schedule('0 19 * * *', async () => {
    await runSync(db);
    try {
      const lista = await buildDailyList(db);
      if (lista) await sendProactive(db, lista.text);
    } catch (e) {
      logger.error(e, 'lista diária falhou');
    }
  }, { timezone: TZ });

  // domingo 9h: relatório da semana (domingo a sábado) e, em seguida, a revisão das tarefas
  cron.schedule('0 9 * * 0', async () => {
    try {
      const rel = await buildWeeklyReport(db);
      await sendProactive(db, rel.text);
    } catch (e) {
      logger.error(e, 'relatório semanal falhou');
    }
    try {
      const rev = await buildTaskReview(db);
      if (rev) await sendProactive(db, rev.text);
    } catch (e) {
      logger.error(e, 'revisão de tarefas falhou');
    }
  }, { timezone: TZ });

  // lembretes: temporizador para o próximo horário, sem consultar o banco a cada minuto
  // (consulta frequente manteria o Neon gratuito acordado 24h); revisa a cada 6h e a cada mudança
  onReminderChange(() => void armReminders(db));
  void armReminders(db);

  logger.info('scheduler iniciado: sync a cada 3h, resumo 07h30, lista 19h, relatório e revisão domingo 9h, lembretes no horário (America/Sao_Paulo)');
}
