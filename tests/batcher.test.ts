import { describe, it, expect, vi } from 'vitest';
import { createMessageBatcher } from '../src/channels/batcher.js';

describe('mensagens em sequência', () => {
  it('junta o que chega dentro da janela e atende uma leva por vez, em ordem', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    let release!: () => void;
    const busy = new Promise<void>((r) => (release = r));
    const b = createMessageBatcher<string>(async (items) => {
      calls.push(items);
      if (calls.length === 1) await busy; // primeira leva demora (Gemini)
    }, 3000);

    b.push('foto 1');
    b.push('foto 2');
    await vi.advanceTimersByTimeAsync(1000);
    b.push('legenda');
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toEqual([['foto 1', 'foto 2', 'legenda']]);

    // chega outra mensagem enquanto a primeira leva ainda está sendo atendida
    b.push('4 para mercado');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([['foto 1', 'foto 2', 'legenda'], ['4 para mercado']]);
    vi.useRealTimers();
  });

  it('erro numa leva não trava as próximas', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const b = createMessageBatcher<string>(async (items) => {
      calls.push(items);
      if (items[0] === 'quebra') throw new Error('falhou');
    }, 100, () => {});
    b.push('quebra');
    await vi.advanceTimersByTimeAsync(200);
    b.push('depois');
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([['quebra'], ['depois']]);
    vi.useRealTimers();
  });
});
