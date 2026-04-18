import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";

export type TelegramReplyMarkup =
  | { kind: "none" }
  | { kind: "share_phone"; text: string }
  | { kind: "inline"; rows: { text: string; data: string }[][] }
  | { kind: "remove_keyboard" };

export interface TextMessageEvent {
  chatId: number;
  userId: number;
  username?: string;
  firstName?: string;
  text: string;
  timestamp: Date;
  hasMedia: boolean;
}

export interface ContactEvent {
  chatId: number;
  userId: number;
  username?: string;
  firstName?: string;
  phoneNumber: string;
  contactUserId?: number;
}

export interface CallbackEvent {
  chatId: number;
  userId: number;
  username?: string;
  firstName?: string;
  data: string;
  messageId?: number;
  answer: (text?: string) => Promise<void>;
}

export interface TelegramHandlers {
  onStart: (ctx: Context) => Promise<void>;
  onContact: (ev: ContactEvent) => Promise<void>;
  onText: (ev: TextMessageEvent) => Promise<void>;
  onCallback: (ev: CallbackEvent) => Promise<void>;
}

export class TelegramClient {
  private bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  wire(handlers: TelegramHandlers): void {
    this.bot.command("start", handlers.onStart);

    this.bot.on("message:contact", async (ctx) => {
      const c = ctx.message.contact;
      const from = ctx.from;
      if (!from) return;
      await handlers.onContact({
        chatId: ctx.chat.id,
        userId: from.id,
        username: from.username,
        firstName: from.first_name,
        phoneNumber: c.phone_number,
        contactUserId: c.user_id,
      });
    });

    this.bot.on("message:text", async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      if (ctx.message.text?.startsWith("/")) return;
      await handlers.onText({
        chatId: ctx.chat.id,
        userId: from.id,
        username: from.username,
        firstName: from.first_name,
        text: ctx.message.text,
        timestamp: new Date((ctx.message.date ?? Date.now() / 1000) * 1000),
        hasMedia: false,
      });
    });

    this.bot.on("message:photo", async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      const caption = ctx.message.caption ?? "";
      await handlers.onText({
        chatId: ctx.chat.id,
        userId: from.id,
        username: from.username,
        firstName: from.first_name,
        text: caption || "(foto sin texto)",
        timestamp: new Date((ctx.message.date ?? Date.now() / 1000) * 1000),
        hasMedia: true,
      });
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const from = ctx.from;
      if (!from || !ctx.chat) return;
      await handlers.onCallback({
        chatId: ctx.chat.id,
        userId: from.id,
        username: from.username,
        firstName: from.first_name,
        data: ctx.callbackQuery.data,
        messageId: ctx.callbackQuery.message?.message_id,
        answer: async (text?: string) => {
          await ctx.answerCallbackQuery(text ? { text } : undefined);
        },
      });
    });

    this.bot.catch((err) => {
      console.error("[Telegram] Middleware error:", err);
    });
  }

  async start(): Promise<void> {
    await this.bot.init();
    console.log(`[Telegram] Bot @${this.bot.botInfo.username} authenticated`);
    this.bot.start({
      drop_pending_updates: true,
      onStart: (info) => console.log(`[Telegram] Long-polling started as @${info.username}`),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendText(chatId: number, text: string, markup?: TelegramReplyMarkup): Promise<void> {
    const chunks = chunkText(text, 4000);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.bot.api.sendMessage(chatId, chunks[i], {
        reply_markup: isLast ? buildReplyMarkup(markup) : undefined,
      });
    }
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text);
    } catch (err) {
      console.error("[Telegram] editMessageText failed:", (err as Error).message);
    }
  }

  async sendAlert(chatId: number, title: string, body: string): Promise<void> {
    await this.sendText(chatId, `${title}\n\n${body}`);
  }
}

function buildReplyMarkup(m?: TelegramReplyMarkup) {
  if (!m || m.kind === "none") return undefined;
  if (m.kind === "share_phone") {
    return new Keyboard().requestContact(m.text).oneTime().resized();
  }
  if (m.kind === "remove_keyboard") {
    return { remove_keyboard: true as const };
  }
  if (m.kind === "inline") {
    const kb = new InlineKeyboard();
    m.rows.forEach((row, i) => {
      row.forEach((btn) => kb.text(btn.text, btn.data));
      if (i < m.rows.length - 1) kb.row();
    });
    return kb;
  }
  return undefined;
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = Math.min(limit, remaining.length);
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  return chunks;
}
