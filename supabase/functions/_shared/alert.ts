// Alertas para o dono do site. Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
// e/ou um webhook generico compativel com Discord (ALERT_WEBHOOK_URL).
// Sem nenhum configurado, o alerta so fica registrado em sync_status.

export async function sendAlert(text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  const webhook = Deno.env.get('ALERT_WEBHOOK_URL');
  let sent = false;

  if (token && chatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      sent = res.ok || sent;
      await res.body?.cancel();
    } catch (error) {
      console.error('Falha ao enviar alerta no Telegram:', error);
    }
  }

  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text.slice(0, 1900) }),
        signal: AbortSignal.timeout(10_000),
      });
      sent = res.ok || sent;
      await res.body?.cancel();
    } catch (error) {
      console.error('Falha ao enviar alerta no webhook:', error);
    }
  }

  return sent;
}

/** Mesma mensagem nao e repetida em menos de 12 h. */
export function shouldResend(lastKey: string | null, lastAt: string | null, key: string, now: Date): boolean {
  if (lastKey !== key) return true;
  if (!lastAt) return true;
  return now.getTime() - new Date(lastAt).getTime() > 12 * 3600 * 1000;
}
