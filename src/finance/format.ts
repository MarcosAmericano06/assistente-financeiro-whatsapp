// Formatação determinística das mensagens (sem LLM): valores, datas e nomes curtos.
// espaço comum no lugar do não separável que o Intl usa (copiar/colar e regex)
export const brl = (v: string | number): string =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');

export const titleCase = (s: string): string => s.replace(/(^|\s)(\p{L})/gu, (_, sp: string, c: string) => sp + c.toUpperCase());

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
// "2026-10-10" → "Sex 10/10"
export function dayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DIAS[dow]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}
export const shortDate = (isoDate: string): string => `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}`;

// "Pix enviado  - Fulano de Tal" → "PIX Fulano de Tal"; corta nomes longos.
export function displayName(description: string, merchantRaw?: string | null, max = 34): string {
  let s = (merchantRaw?.trim() || description).replace(/\s+/g, ' ').trim();
  s = s
    .replace(/^pix enviado\s*-?\s*(para)?\s*/i, 'PIX ')
    .replace(/^pix recebido\s*-?\s*(de)?\s*/i, 'PIX de ')
    .replace(/^pagamento (para|efetuado -)\s*/i, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Data de hoje no fuso do dono, YYYY-MM-DD.
export const todayIso = (now = new Date()): string => now.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
