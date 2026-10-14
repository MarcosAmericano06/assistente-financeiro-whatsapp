import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { sendTelegram, sendTelegramPhoto } from '../../notify/telegram.js';
import { logger } from '../../core/logger.js';

const SESSION_DIR = process.env.WA_SESSION_DIR ?? './wa-session';

/**
 * Identidade do OWNER: pelo LID (ID privado estável do WhatsApp) e/ou
 * pelo número real (tolerante ao nono dígito BR: país+DDD + últimos 8 dígitos).
 */
export function isOwnerJid(jid: string, altJid?: string): boolean {
  const ownerLid = process.env.WHATSAPP_OWNER_LID ?? '';
  if (ownerLid && jid === ownerLid) return true;

  const owner = (process.env.WHATSAPP_OWNER_NUMBER ?? '').replace(/\D/g, '');
  if (!owner) return false;
  for (const candidate of [jid, altJid ?? '']) {
    if (!candidate.endsWith('@s.whatsapp.net')) continue;
    const sender = (candidate.split('@')[0] ?? '').replace(/\D/g, '');
    if (!sender.startsWith('55') || !owner.startsWith('55')) {
      if (sender === owner) return true;
      continue;
    }
    if (sender.slice(2, 4) === owner.slice(2, 4) && sender.slice(-8) === owner.slice(-8)) return true;
  }
  return false;
}

export interface OwnerChannelInput {
  text?: string | undefined;
  media?: { kind: 'audio' | 'image'; mimeType: string; dataBase64: string } | undefined;
}

export type OwnerMessageHandler = (input: OwnerChannelInput, reply: (t: string) => Promise<void>) => Promise<void>;

const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

let qrSent = 0;
let currentSock: WASocket | null = null;

/** Envio proativo para o OWNER (resumo matinal, alertas). */
export async function sendToOwnerWhatsApp(text: string): Promise<void> {
  const target = process.env.WHATSAPP_OWNER_LID || `${(process.env.WHATSAPP_OWNER_NUMBER ?? '').replace(/\D/g, '')}@s.whatsapp.net`;
  if (!currentSock) throw new Error('whatsapp não conectado');
  await currentSock.sendMessage(target, { text });
}

export async function startWhatsApp(onOwnerMessage: OwnerMessageHandler): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'warn' }) as never,
    // aparência de cliente comum; sem marcar online para não sinalizar automação
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  currentSock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && qrSent < 5) {
      qrSent++;
      const png = await QRCode.toBuffer(qr, { width: 400 });
      await sendTelegramPhoto(
        png,
        `📲 QR de pareamento do WhatsApp (${qrSent}/5 — expira em ~60s).\nNo celular do número do bot: WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho → escaneie.`,
      ).catch((e) => logger.error(e, 'falha ao enviar QR no telegram'));
    }

    if (connection === 'open') {
      qrSent = 0;
      logger.info('whatsapp conectado');
      await sendTelegram('✅ *WhatsApp conectado!* O assistente agora responde no seu número profissional (somente para você).').catch(() => {});
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        logger.warn('sessão deslogada — pareamento necessário de novo');
        await sendTelegram('⚠️ Sessão do WhatsApp deslogada. Me peça para reconectar quando quiser parear de novo.').catch(() => {});
        return; // não reconecta sozinho após logout explícito
      }
      logger.warn({ code }, 'conexão caiu, reconectando em 5s');
      setTimeout(() => startWhatsApp(onOwnerMessage), 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid ?? '';
      if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // nunca em grupos/status
      const altJid = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
      if (!isOwnerJid(jid, altJid)) {
        logger.info({ jid, altJid }, 'mensagem de não-owner ignorada');
        continue; // silêncio total para terceiros
      }
      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        '';
      const audio = msg.message.audioMessage;
      const image = msg.message.imageMessage;

      const input: OwnerChannelInput = { text: text || image?.caption || undefined };
      if (audio || image) {
        try {
          const buffer = (await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }) as never, reuploadRequest: sock.updateMediaMessage },
          )) as Buffer;
          if (buffer.length > MAX_MEDIA_BYTES) {
            await sock.sendMessage(jid, { text: '⚠️ Arquivo muito grande — consigo processar até ~15 MB.' });
            continue;
          }
          const rawMime = (audio?.mimetype ?? image?.mimetype ?? '').split(';')[0]!.trim();
          input.media = {
            kind: audio ? 'audio' : 'image',
            mimeType: rawMime || (audio ? 'audio/ogg' : 'image/jpeg'),
            dataBase64: buffer.toString('base64'),
          };
        } catch (e) {
          logger.error(e, 'falha ao baixar mídia');
          await sock.sendMessage(jid, { text: '⚠️ Não consegui baixar essa mídia. Tenta mandar de novo?' });
          continue;
        }
      }
      if (!input.text && !input.media) continue;

      const reply = async (t: string) => {
        await sock.sendMessage(jid, { text: t });
      };
      await onOwnerMessage(input, reply).catch((e) => logger.error(e, 'erro no handler de mensagem'));
    }
  });

  return sock;
}
