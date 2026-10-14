import { describe, it, expect, vi, afterEach } from 'vitest';
import { generate } from '../src/ai/gemini.js';

const resp = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const malformed = { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: {} }] };
const ok = { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'edit_task_items', args: {} } }] } }] };
const opts = { apiKey: 'k', model: 'm', system: 's', contents: [{ role: 'user' as const, parts: [{ text: 'oi' }] }], tools: [] };

describe('generate (Gemini)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('chamada de tool malformada: tenta de novo e devolve a resposta boa', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(malformed)).mockResolvedValueOnce(resp(ok));
    vi.stubGlobal('fetch', fetchMock);
    const parts = await generate(opts);
    expect(parts[0]!.functionCall!.name).toBe('edit_task_items');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resposta vazia com STOP também tenta de novo; motivo de segurança não', async () => {
    const empty = { candidates: [{ finishReason: 'STOP', content: {} }] };
    const f1 = vi.fn().mockResolvedValueOnce(resp(empty)).mockResolvedValueOnce(resp(ok));
    vi.stubGlobal('fetch', f1);
    expect((await generate(opts)).length).toBe(1);
    const f2 = vi.fn().mockResolvedValue(resp({ candidates: [{ finishReason: 'SAFETY', content: {} }] }));
    vi.stubGlobal('fetch', f2);
    expect(await generate(opts)).toEqual([]);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('pede um orçamento mínimo de raciocínio', async () => {
    const f = vi.fn().mockResolvedValue(resp(ok));
    vi.stubGlobal('fetch', f);
    await generate({ ...opts, model: 'gemini-2.5-flash' });
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
  });

  it('modelo sem raciocínio (2.0) não recebe thinkingConfig', async () => {
    const f = vi.fn().mockResolvedValue(resp(ok));
    vi.stubGlobal('fetch', f);
    await generate({ ...opts, model: 'gemini-2.0-flash' });
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('desiste depois de 3 tentativas malformadas', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => resp(malformed));
    vi.stubGlobal('fetch', fetchMock);
    expect(await generate(opts)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('chave vai no cabeçalho, não na URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(ok));
    vi.stubGlobal('fetch', fetchMock);
    await generate(opts);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
  });
});
