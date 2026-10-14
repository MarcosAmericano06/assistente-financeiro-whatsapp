// Cliente mínimo da API Gemini (REST v1beta) com function calling.
import { logger } from '../core/logger.js';

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// MALFORMED_FUNCTION_CALL acontece de forma intermitente (~1 em 4) quando o pedido tem
// várias ações; a mesma requisição costuma dar certo na tentativa seguinte.
const MAX_ATTEMPTS = 3;
// Sem um orçamento mínimo de raciocínio, o 2.5 Flash devolvia resposta vazia (STOP sem
// conteúdo) de forma reprodutível com o prompt completo do bot (teste de 13/10/2026).
const THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 512);
const RETRY_EMPTY = new Set(['MALFORMED_FUNCTION_CALL', 'STOP', 'SEM_CANDIDATO']);

export async function generate(opts: {
  apiKey: string;
  model: string;
  system: string;
  contents: GeminiContent[];
  tools: ToolDeclaration[];
}): Promise<GeminiPart[]> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE}/${opts.model}:generateContent`, {
      method: 'POST',
      // sem tempo máximo, uma resposta que nunca chega travaria a fila de mensagens
      signal: AbortSignal.timeout(90_000),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: opts.contents,
        tools: [{ functionDeclarations: opts.tools }],
        generationConfig: {
          temperature: 0.2,
          // só modelos com raciocínio (2.5+) aceitam thinkingConfig
          ...(THINKING_BUDGET > 0 && /gemini-(2\.5|[3-9])/.test(opts.model) ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET } } : {}),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`gemini HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const reason = data.candidates?.[0]?.finishReason ?? 'SEM_CANDIDATO';
    if (parts.length) return parts;
    if (!RETRY_EMPTY.has(reason)) {
      logger.warn({ reason }, 'gemini devolveu resposta vazia');
      return [];
    }
    logger.warn({ attempt, reason }, 'gemini: resposta vazia, tentando de novo');
  }
  return [];
}
