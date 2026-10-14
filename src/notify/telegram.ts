const API = 'https://api.telegram.org';

function base(): { token: string; chatId: string } {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN/TELEGRAM_OWNER_CHAT_ID ausentes');
  return { token, chatId };
}

export async function sendTelegram(text: string): Promise<void> {
  const { token, chatId } = base();
  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) throw new Error(`telegram sendMessage: HTTP ${res.status}`);
}

export async function sendTelegramPhoto(png: Buffer, caption: string): Promise<void> {
  const { token, chatId } = base();
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'qr.png');
  const res = await fetch(`${API}/bot${token}/sendPhoto`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`telegram sendPhoto: HTTP ${res.status}`);
}
