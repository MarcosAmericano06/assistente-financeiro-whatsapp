// Processo principal do assistente na VM: canal WhatsApp + agendador.
import { startWhatsApp, type OwnerChannelInput } from './channels/whatsapp/index.js';
import { createMessageBatcher } from './channels/batcher.js';
import { startScheduler } from './scheduler/index.js';
import { handleOwnerMessage } from './ai/orchestrator.js';
import { OWNER_CHAT_KEY } from './ai/conversation.js';
import { loadConfig } from './core/config.js';
import { createDb } from './db/index.js';
import { logger } from './core/logger.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

// mensagens seguidas (fotos + legenda) viram uma leva só, atendida em fila
const batcher = createMessageBatcher<{ input: OwnerChannelInput; reply: (t: string) => Promise<void> }>(
  async (items) => {
    const text = items.map((i) => i.input.text).filter(Boolean).join('\n');
    const media = items.flatMap((i) => (i.input.media ? [i.input.media] : []));
    const reply = items[items.length - 1]!.reply;
    logger.info({ mensagens: items.length, midias: media.length }, 'leva de mensagens do owner');
    try {
      const answer = await handleOwnerMessage(OWNER_CHAT_KEY, { text: text || undefined, media }, db);
      await reply(answer);
    } catch (e) {
      logger.error(e, 'orquestrador falhou');
      await reply('⚠️ Tive um problema para processar isso. Tenta de novo em instantes.');
    }
  },
  2000,
  (e) => logger.error(e, 'erro ao atender mensagens'),
);

await startWhatsApp(async (input, reply) => {
  logger.info({ temTexto: !!input.text, temMidia: !!input.media }, 'mensagem do owner recebida');
  batcher.push({ input, reply });
});

startScheduler(db);
logger.info('assistente completo iniciado (whatsapp + cérebro + agendador)');

// teste único: com SEND_SUMMARY_ON_BOOT=1, envia o resumo matinal ao conectar
if (process.env.SEND_SUMMARY_ON_BOOT === '1') {
  setTimeout(async () => {
    const { buildMorningSummary } = await import('./jobs/morning-summary.js');
    const { sendToOwnerWhatsApp } = await import('./channels/whatsapp/index.js');
    try {
      await sendToOwnerWhatsApp(await buildMorningSummary(db));
      logger.info('resumo de teste enviado');
    } catch (e) {
      logger.error(e, 'resumo de teste falhou');
    }
  }, 15_000);
}
