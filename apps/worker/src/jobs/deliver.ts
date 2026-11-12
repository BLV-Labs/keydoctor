// Sends one alert to every chat watching its target. Send first, record after (§8.5).
import type { KdAlert, Network } from "key-doctor";
import type { D1Database, Env } from "../env.ts";
import { sendMessage, TelegramError, type Outgoing } from "../telegram/api.ts";
import { renderAlert, type Lang } from "../telegram/render.ts";
import { alertSent, markSent, markSentMany, sentIds } from "../store/alerts.ts";
import { chatsFor, deleteChat, moveChat } from "../store/subscriptions.ts";

export type AlertLang = Lang | "both";

/** Subscriptions do not store a language, so cron messages follow ALERT_LANG (default: both). */
export function alertLang(env: Env): AlertLang {
  return env.ALERT_LANG === "vi" || env.ALERT_LANG === "en" ? env.ALERT_LANG : "both";
}

export function renderFor(lang: AlertLang, render: (l: Lang) => Outgoing): Outgoing {
  if (lang !== "both") return render(lang);
  const vi = render("vi");
  const en = render("en");
  return { text: `${vi.text}\n\n— English —\n${en.text.split("\n").slice(1).join("\n")}`, buttons: en.buttons ?? [] };
}

export interface Delivery {
  /** True when the alert reached at least one chat. */
  delivered: boolean;
  skipped: "duplicate" | "no_chats" | null;
  /** A transient failure left the alert out of alerts_sent: the caller keeps its state so the next run retries. */
  retry: boolean;
  errors: string[];
}

/** The alerts_sent id that records one chat's copy of an alert, so a retry skips the chats it already reached. */
export const chatMark = (alertId: string, chat: string): string => `${alertId}>${chat}`;

/**
 * A transient send failure (429, 5xx, network) leaves the alert out of alerts_sent, so the next run sends it again,
 * but only to the chats it missed (red-team M8): the chats that got it are recorded one by one. A chat that blocked or removed the bot loses its subscriptions;
 * a group that became a supergroup moves to its new id; any other refusal is reported and not retried.
 */
export async function deliver(env: Env, alert: { alert_id: string }, message: Outgoing, target: string, network: Network): Promise<Delivery> {
  if (await alertSent(env.DB, alert.alert_id)) return { delivered: false, skipped: "duplicate", retry: false, errors: [] };
  const all = await chatsFor(env.DB, target, network);
  const token = env.TELEGRAM_BOT_TOKEN;
  if (all.length === 0 || !token) return { delivered: false, skipped: "no_chats", retry: false, errors: [] };
  const done = await sentIds(env.DB, all.map((c) => chatMark(alert.alert_id, c)));
  const chats = all.filter((c) => !done.has(chatMark(alert.alert_id, c)));
  const { sent, retry, errors, reached } = await sendToChats(env.DB, token, alert.alert_id, message, chats);
  if (!retry) await markSent(env.DB, alert);
  else await markSentMany(env.DB, reached.map((c) => ({ alert_id: chatMark(alert.alert_id, c) })));
  return { delivered: sent > 0, skipped: null, retry, errors };
}

/** Sends to each chat and looks after the chats that moved or left. Recording the alert stays with the caller. */
export async function sendToChats(
  db: D1Database,
  token: string,
  alertId: string,
  message: Outgoing,
  chats: readonly string[],
): Promise<{ sent: number; retry: boolean; errors: string[]; reached: string[] }> {
  const errors: string[] = [];
  /** The chats (as listed in `chats`) that got the message. */
  const reached: string[] = [];
  let sent = 0;
  let retry = false;
  for (const chat of chats) {
    let to = chat;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await sendMessage(token, to, message);
        sent += 1;
        reached.push(chat);
        break;
      } catch (e) {
        if (e instanceof TelegramError && e.migrateTo !== null && attempt === 0) {
          await moveChat(db, to, e.migrateTo);
          to = e.migrateTo;
          continue;
        }
        if (e instanceof TelegramError && e.chatGone) {
          await deleteChat(db, to);
        } else if (!(e instanceof TelegramError) || e.transient) {
          retry = true;
          errors.push(`send ${alertId}: ${e instanceof TelegramError ? e.status : "network"}`);
        } else {
          // A permanent refusal for this one chat must not hold the alert back from the others.
          errors.push(`send ${alertId}: ${e.status} (not retried)`);
          console.error("telegram refused a chat", { status: e.status });
        }
        break;
      }
    }
  }
  return { sent, retry, errors, reached };
}

export const alertMessage = (env: Env, alert: KdAlert): Outgoing =>
  renderFor(alertLang(env), (l) => renderAlert(l, alert, env.DASHBOARD_URL));
