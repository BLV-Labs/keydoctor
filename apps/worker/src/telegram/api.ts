// Telegram Bot API client: sendMessage, sendChatAction and getChatMember only.

export class TelegramError extends Error {
  readonly status: number;
  readonly description: string;
  /** Set when a group became a supergroup: the chat now lives under this id. */
  readonly migrateTo: string | null;
  constructor(status: number, description: string, migrateTo: string | null = null) {
    super(`telegram ${status}`);
    this.name = "TelegramError";
    this.status = status;
    this.description = description;
    this.migrateTo = migrateTo;
  }
  /** 429, 5xx and network trouble may pass; any other 4xx will fail the same way next time. */
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
  /** The chat blocked the bot, removed it, or no longer exists: its subscriptions should go (§8.5). */
  get chatGone(): boolean {
    return this.status === 403 || (this.status === 400 && /chat not found/i.test(this.description));
  }
}

export interface Button {
  text: string;
  url: string;
}

export interface Outgoing {
  /** Telegram HTML: every value inside is escaped with `esc`. */
  text: string;
  buttons?: Button[];
}

const MAX_TEXT = 4096;

async function call(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return ((await res.json().catch(() => null)) as { result?: unknown } | null)?.result;
  let description = "";
  let migrateTo: string | null = null;
  try {
    const data = (await res.json()) as { description?: unknown; parameters?: { migrate_to_chat_id?: unknown } };
    if (typeof data.description === "string") description = data.description.slice(0, 200);
    const m = data.parameters?.migrate_to_chat_id;
    if (typeof m === "number" && Number.isSafeInteger(m)) migrateTo = String(m);
  } catch {
    // keep the empty description
  }
  throw new TelegramError(res.status, description, migrateTo);
}

/** Escapes text for Telegram HTML. Every chain or user value goes through it, so it can never inject markup. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The HTML message as plain text: tags dropped, entities read back. */
export function toPlain(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

const cut = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/**
 * `msg.text` is Telegram HTML (renderers escape every value with `esc`). A message too long to cut safely, or one
 * Telegram cannot parse, goes as plain text instead, so a formatting slip never loses an alert.
 * URL buttons go in an inline keyboard.
 */
export async function sendMessage(token: string, chatId: string, msg: Outgoing): Promise<void> {
  const base = {
    chat_id: chatId,
    link_preview_options: { is_disabled: true },
    ...(msg.buttons && msg.buttons.length > 0 && { reply_markup: { inline_keyboard: msg.buttons.map((b) => [b]) } }),
  };
  const plain = async () => {
    await call(token, "sendMessage", { ...base, text: cut(toPlain(msg.text)) });
  };
  if (msg.text.length > MAX_TEXT) return plain();
  try {
    await call(token, "sendMessage", { ...base, text: msg.text, parse_mode: "HTML" });
  } catch (e) {
    if (e instanceof TelegramError && e.status === 400 && /can't parse entities/i.test(e.description)) return plain();
    throw e;
  }
}

export async function sendTyping(token: string, chatId: string): Promise<void> {
  await call(token, "sendChatAction", { chat_id: chatId, action: "typing" });
}

/** True when the user is the chat's creator or an administrator. Any failure answers false (fail closed). */
export async function isChatAdmin(token: string, chatId: string, userId: string): Promise<boolean> {
  try {
    const member = (await call(token, "getChatMember", { chat_id: chatId, user_id: Number(userId) })) as { status?: unknown } | undefined;
    return member?.status === "creator" || member?.status === "administrator";
  } catch {
    return false;
  }
}
