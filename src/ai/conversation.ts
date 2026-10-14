// Memória da conversa do dono com o orquestrador, gravada no banco (sobrevive a
// restart). Mensagens automáticas (lista das 19h, relatório) entram como fala do bot.
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../finance/types.js';
import type { GeminiContent, GeminiPart } from './gemini.js';

export const OWNER_CHAT_KEY = 'wa-owner';
export const HISTORY_LIMIT = 30; // conteúdos mantidos por chat

const hasCall = (c: GeminiContent) => c.parts.some((p) => (p as { functionCall?: unknown }).functionCall);
const hasResponse = (c: GeminiContent) => c.parts.some((p) => (p as { functionResponse?: unknown }).functionResponse);

// Mantém o final da conversa cortando em fronteira segura: nunca começar com
// chamada de tool ou resposta de tool órfã (o Gemini rejeita).
export function trimHistory(h: GeminiContent[], limit = HISTORY_LIMIT): GeminiContent[] {
  let t = h.slice(-limit);
  while (t.length && (hasCall(t[0]!) || hasResponse(t[0]!))) t = t.slice(1);
  return t;
}

// O Gemini exige que a conversa comece pelo usuário; mensagem automática pode vir antes.
export function withLeadingUser(h: GeminiContent[]): GeminiContent[] {
  return h[0]?.role === 'model' ? [{ role: 'user', parts: [{ text: '(início da conversa)' }] }, ...h] : h;
}

export async function loadHistory(db: DbOrTx, chatKey: string): Promise<GeminiContent[]> {
  const [row] = (await db.execute(sql`select contents from conversation_state where chat_key=${chatKey}`)) as unknown as {
    contents: GeminiContent[];
  }[];
  return row?.contents ?? [];
}

export async function saveHistory(db: DbOrTx, chatKey: string, contents: GeminiContent[]): Promise<void> {
  await db.execute(sql`
    insert into conversation_state (chat_key, contents) values (${chatKey}, ${JSON.stringify(contents)}::jsonb)
    on conflict (chat_key) do update set contents = excluded.contents, updated_at = now()`);
}

// Uma operação de histórico por chat de cada vez: o turno da conversa (carrega →
// Gemini → grava) e a mensagem automática não podem se sobrescrever.
const locks = new Map<string, Promise<unknown>>();
export function withChatLock<T>(chatKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(chatKey) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(chatKey, run);
  void run.finally(() => {
    if (locks.get(chatKey) === run) locks.delete(chatKey);
  }).catch(() => {});
  return run;
}

export function appendProactive(db: DbOrTx, text: string, chatKey = OWNER_CHAT_KEY): Promise<void> {
  return withChatLock(chatKey, () => appendProactiveNow(db, text, chatKey));
}

async function appendProactiveNow(db: DbOrTx, text: string, chatKey: string): Promise<void> {
  const h = await loadHistory(db, chatKey);
  const last = h[h.length - 1];
  const part: GeminiPart = { text };
  if (last?.role === 'model' && !hasCall(last)) last.parts.push(part);
  else if (last && hasCall(last)) h.splice(0, h.length, { role: 'model', parts: [part] }); // turno quebrado: recomeça
  else h.push({ role: 'model', parts: [part] });
  await saveHistory(db, chatKey, trimHistory(h));
}
