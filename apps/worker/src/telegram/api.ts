// Telegram Bot API client: sendMessage and sendChatAction only.

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
  text: string;
  buttons?: Button[];
}

const MAX_TEXT = 4096;

async function call(token: string, method: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
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

/** Plain text (no parse_mode), so chain text can never inject markup. URL buttons go in an inline keyboard. */
export function sendMessage(token: string, chatId: string, msg: Outgoing): Promise<void> {
  const text = msg.text.length > MAX_TEXT ? `${msg.text.slice(0, MAX_TEXT - 1)}…` : msg.text;
  return call(token, "sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(msg.buttons && msg.buttons.length > 0 && { reply_markup: { inline_keyboard: msg.buttons.map((b) => [b]) } }),
  });
}

export function sendTyping(token: string, chatId: string): Promise<void> {
  return call(token, "sendChatAction", { chat_id: chatId, action: "typing" });
}
