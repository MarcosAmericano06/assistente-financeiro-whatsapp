// Confirmação de mudanças em lote no histórico (retroativo de regra, recategorização).
// A prévia gera um token; ele só vale numa mensagem SEGUINTE do dono (outro lote),
// uma vez, por 30 minutos — a IA não consegue pedir e confirmar sozinha no mesmo turno.
import { randomUUID } from 'node:crypto';

const TTL_MS = 30 * 60_000;
interface Pending {
  batchId: string;
  kind: string;
  ids: string[];
  payload: unknown;
  createdAt: number;
}
const pending = new Map<string, Pending>();

export function createConfirmation(batchId: string, kind: string, ids: string[], payload: unknown, createdAt = Date.now()): string {
  for (const [k, p] of pending) if (Date.now() - p.createdAt > TTL_MS) pending.delete(k);
  const token = randomUUID().slice(0, 8);
  pending.set(token, { batchId, kind, ids, payload, createdAt });
  return token;
}

export function takeConfirmation(
  token: string,
  batchId: string,
  kind: string,
): { ids: string[]; payload: unknown; erro?: undefined } | { erro: string } {
  const p = pending.get(token);
  if (!p || p.kind !== kind) return { erro: 'confirmação inválida ou já usada: gere a prévia de novo' };
  if (p.batchId === batchId) return { erro: 'a confirmação precisa vir do usuário numa nova mensagem: mostre a prévia e pergunte' };
  pending.delete(token);
  if (Date.now() - p.createdAt > TTL_MS) return { erro: 'confirmação expirada: gere a prévia de novo' };
  return { ids: p.ids, payload: p.payload };
}
