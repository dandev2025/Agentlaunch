import type { FetchLike } from './notifier.js';

export type CommandHandler = () => string | Promise<string>;

/**
 * Minimal Telegram command listener (long-polling getUpdates). It only answers messages from
 * the configured chat id — anyone else messaging the bot is ignored. Read-only commands only.
 */
export class TelegramCommandListener {
  private offset = 0;
  private stopped = true;

  constructor(
    private token: string,
    private chatId: string,
    private commands: Record<string, CommandHandler>,
    private reply: (text: string) => void,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private pollSeconds = 25,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        console.error('[telegram-bot] poll error:', (e as Error).message);
        await this.sleep(5000);
      }
    }
  }

  /** One getUpdates round trip; exposed for tests. */
  async pollOnce(): Promise<void> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset: this.offset, timeout: this.pollSeconds, allowed_updates: ['message'] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 409 = another getUpdates consumer (or a webhook) is using this bot.
      throw new Error(`HTTP ${res.status}: ${body?.description ?? 'error'}`);
    }
    for (const u of (body.result ?? []) as any[]) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      await this.handle(u.message);
    }
  }

  private async handle(msg: any): Promise<void> {
    if (!msg?.text || String(msg.chat?.id) !== String(this.chatId)) return;
    // "/status", "/status@MyBot", "/status extra args"
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(msg.text.trim())?.[1]?.toLowerCase();
    if (!cmd) return;
    const h = this.commands[cmd];
    if (!h) return;
    try {
      this.reply(await h());
    } catch (e) {
      this.reply(`Command /${cmd} failed: ${(e as Error).message}`);
    }
  }
}
