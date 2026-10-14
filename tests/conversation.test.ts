import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadHistory, saveHistory, appendProactive, trimHistory, withLeadingUser, withChatLock } from '../src/ai/conversation.js';
import { capMedia } from '../src/ai/orchestrator.js';
import type { GeminiContent } from '../src/ai/gemini.js';
import { createTestDb, type TestDb } from './helpers/db.js';

const u = (text: string): GeminiContent => ({ role: 'user', parts: [{ text }] });
const m = (text: string): GeminiContent => ({ role: 'model', parts: [{ text }] });
const call: GeminiContent = { role: 'model', parts: [{ functionCall: { name: 'query_spending', args: {} } }] };
const resp: GeminiContent = { role: 'user', parts: [{ functionResponse: { name: 'query_spending', response: {} } }] };

describe('memória da conversa', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.close());

  it('grava e carrega do banco (sobrevive a restart)', async () => {
    await saveHistory(t.db, 'c1', [u('oi'), m('olá')]);
    expect(await loadHistory(t.db, 'c1')).toEqual([u('oi'), m('olá')]);
    expect(await loadHistory(t.db, 'nao-existe')).toEqual([]);
  });

  it('mensagem automática (lista das 19h) entra no histórico, juntando com a fala anterior do bot', async () => {
    await appendProactive(t.db, '💳 Gastos novos...', 'c1');
    expect(await loadHistory(t.db, 'c1')).toEqual([u('oi'), { role: 'model', parts: [{ text: 'olá' }, { text: '💳 Gastos novos...' }] }]);
    await appendProactive(t.db, 'lista', 'vazio');
    expect(await loadHistory(t.db, 'vazio')).toEqual([m('lista')]);
  });

  it('corte nunca começa com chamada ou resposta de tool órfã', () => {
    const h = [u('a'), call, resp, m('b'), u('c'), m('d')];
    expect(trimHistory(h, 5)).toEqual([m('b'), u('c'), m('d')]);
    expect(trimHistory(h, 4)).toEqual([m('b'), u('c'), m('d')]);
    expect(trimHistory(h, 6)).toEqual(h);
  });

  it('mensagem automática durante uma conversa em andamento não se perde', async () => {
    await saveHistory(t.db, 'c2', [u('oi'), m('olá')]);
    const turno = withChatLock('c2', async () => {
      const h = await loadHistory(t.db, 'c2');
      await new Promise((r) => setTimeout(r, 50)); // Gemini pensando
      h.push(u('quanto gastei?'), m('R$ 10'));
      await saveHistory(t.db, 'c2', h);
    });
    const lista = appendProactive(t.db, '💳 lista das 19h', 'c2');
    await Promise.all([turno, lista]);
    const textos = (await loadHistory(t.db, 'c2')).flatMap((c) => c.parts.map((p) => p.text));
    expect(textos).toEqual(['oi', 'olá', 'quanto gastei?', 'R$ 10', '💳 lista das 19h']);
  });

  it('fotos demais numa leva: corta no limite do Gemini e avisa', () => {
    const foto = (mb: number) => ({ kind: 'image' as const, mimeType: 'image/jpeg', dataBase64: 'A'.repeat(Math.round((mb * 1024 * 1024 * 4) / 3)) });
    const r = capMedia([foto(8), foto(8), foto(8)], 18 * 1024 * 1024);
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toBe(1);
    expect(capMedia([foto(1)], 18 * 1024 * 1024)).toMatchObject({ dropped: 0 });
  });

  it('para o Gemini, a conversa sempre começa com o usuário', () => {
    expect(withLeadingUser([m('lista'), u('4 para mercado')])[0]!.role).toBe('user');
    expect(withLeadingUser([u('oi')])).toEqual([u('oi')]);
  });
});
