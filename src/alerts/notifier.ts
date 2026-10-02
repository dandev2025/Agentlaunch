export interface Notifier {
  send(text: string): void;
}

export class NullNotifier implements Notifier {
  send(): void {}
}

export class ConsoleNotifier implements Notifier {
  send(text: string): void {
    console.log(`[alert]\n${text}\n`);
  }
}

export class MemoryNotifier implements Notifier {
  messages: string[] = [];
  send(text: string): void {
    this.messages.push(text);
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

/** Telegram Bot API sender. Serialised queue, ~1 msg/s, honours 429 retry_after. */
export class TelegramNotifier implements Notifier {
  private queue: string[] = [];
  private running = false;

  constructor(
    private token: string,
    private chatId: string,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private minIntervalMs = 1100,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  send(text: string): void {
    this.queue.push(text);
    if (this.queue.length > 200) this.queue.shift(); // never grow unbounded if Telegram is down
    void this.drain();
  }

  async flush(): Promise<void> {
    while (this.running || this.queue.length) await this.sleep(20);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const text = this.queue[0];
        const wait = await this.post(text);
        if (wait === 0) this.queue.shift();
        await this.sleep(wait || this.minIntervalMs);
      }
    } finally {
      this.running = false;
    }
  }

  /** @returns 0 on success, otherwise ms to wait before retrying. Permanent errors drop the message. */
  private async post(text: string): Promise<number> {
    try {
      const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (res.ok) return 0;
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) return ((body?.parameters?.retry_after as number) ?? 5) * 1000;
      console.error(`[telegram] HTTP ${res.status}: ${body?.description ?? 'error'} — message dropped`);
      this.queue.shift();
      return this.minIntervalMs;
    } catch (e) {
      console.error('[telegram] network error, retrying:', (e as Error).message);
      return 5000;
    }
  }
}

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function notifierFromEnv(env = process.env): Notifier {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) return new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
  console.warn('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alerts will print to the console only');
  return new ConsoleNotifier();
}
