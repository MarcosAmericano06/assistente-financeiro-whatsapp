import { describe, it, expect } from 'vitest';
import { createConfirmation, takeConfirmation } from '../src/finance/confirmations.js';

describe('confirmação em mensagem seguinte', () => {
  it('só vale em outra mensagem, para o mesmo tipo, uma vez', () => {
    const tk = createConfirmation('msg-1', 'retro', ['a', 'b'], { pattern: 'x' });
    expect(takeConfirmation(tk, 'msg-1', 'retro')).toMatchObject({ erro: expect.stringMatching(/confirm/) });
    expect(takeConfirmation(tk, 'msg-2', 'recat')).toMatchObject({ erro: expect.any(String) });
    expect(takeConfirmation(tk, 'msg-2', 'retro')).toMatchObject({ ids: ['a', 'b'], payload: { pattern: 'x' } });
    expect(takeConfirmation(tk, 'msg-3', 'retro')).toMatchObject({ erro: expect.any(String) });
  });
  it('expira', () => {
    const tk = createConfirmation('m1', 'retro', [], {}, Date.now() - 31 * 60_000);
    expect(takeConfirmation(tk, 'm2', 'retro')).toMatchObject({ erro: expect.stringMatching(/expir/) });
  });
});
