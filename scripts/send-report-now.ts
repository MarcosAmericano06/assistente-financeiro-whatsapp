// Envia agora, pelo WhatsApp, o relatório semanal (padrão) ou a lista diária, fora
// do horário agendado. Rodar na VM com o serviço bot-wa PARADO (a sessão é única).
// Uso: npx tsx --env-file=.env scripts/send-report-now.ts [weekly|daily|tasks]
import { createDb } from '../src/db/index.js';
import { buildWeeklyReport } from '../src/finance/weekly-report.js';
import { buildDailyList } from '../src/finance/daily-list.js';
import { appendProactive } from '../src/ai/conversation.js';
import { buildTaskList, TASK_HINT } from '../src/tasks/tasks.js';
import { startWhatsApp, sendToOwnerWhatsApp } from '../src/channels/whatsapp/index.js';

const kind = ['daily', 'tasks'].includes(process.argv[2] ?? '') ? process.argv[2] : 'weekly';
const db = createDb(process.env.DATABASE_URL!);

// conecta primeiro: a lista só é gravada se der para enviar
const sock = await startWhatsApp(async () => {});
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WhatsApp não conectou em 60s')), 60_000);
  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') {
      clearTimeout(timer);
      resolve();
    }
  });
});

let text: string | undefined;
if (kind === 'weekly') {
  text = (await buildWeeklyReport(db)).text;
} else if (kind === 'tasks') {
  const r = await buildTaskList(db, { title: 'limpeza das tarefas' });
  text = r ? `🧹 Vamos limpar a lista de tarefas!\n\n${r.text}\n\n${TASK_HINT}` : undefined;
} else {
  text = (await buildDailyList(db))?.text;
}
if (!text) {
  console.log('nada novo para enviar');
  process.exit(0);
}
await sendToOwnerWhatsApp(text);
await appendProactive(db, text);
console.log(text);
await new Promise((r) => setTimeout(r, 3000)); // deixa a mensagem sair antes de fechar
process.exit(0);
