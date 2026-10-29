// Sends one alert to every chat watching its target. Send first, record after (§8.5).
import type { KdAlert, Network } from "key-doctor";
import type { Env } from "../env.ts";
import { sendMessage, TelegramError, type Outgoing } from "../telegram/api.ts";
import { renderAlert, type Lang } from "../telegram/render.ts";
import { alertSent, markSent } from "../store/alerts.ts";
import { chatsFor, deleteChat } from "../store/subscriptions.ts";

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
  /** True when the alert reached at least one chat and is now in alerts_sent. */
  delivered: boolean;
  skipped: "duplicate" | "no_chats" | null;
  errors: string[];
}

/**
 * A transient send failure leaves the alert out of alerts_sent, so the next run sends it again:
 * a duplicate is better than a missed alert. Chats that blocked or removed the bot lose their subscriptions.
 */
export async function deliver(env: Env, alert: KdAlert, message: Outgoing, target: string, network: Network): Promise<Delivery> {
  if (await alertSent(env.DB, alert.alert_id)) return { delivered: false, skipped: "duplicate", errors: [] };
  const chats = await chatsFor(env.DB, target, network);
  const token = env.TELEGRAM_BOT_TOKEN;
  if (chats.length === 0 || !token) return { delivered: false, skipped: "no_chats", errors: [] };
  const errors: string[] = [];
  let sent = 0;
  let transient = false;
  for (const chat of chats) {
    try {
      await sendMessage(token, chat, message);
      sent += 1;
    } catch (e) {
      if (e instanceof TelegramError && e.chatGone) {
        await deleteChat(env.DB, chat);
      } else {
        transient = true;
        errors.push(`send ${alert.alert_id}: ${e instanceof TelegramError ? e.status : "network"}`);
      }
    }
  }
  if (sent > 0 && !transient) await markSent(env.DB, alert);
  return { delivered: sent > 0, skipped: null, errors };
}

export const alertMessage = (env: Env, alert: KdAlert): Outgoing =>
  renderFor(alertLang(env), (l) => renderAlert(l, alert, env.DASHBOARD_URL));
