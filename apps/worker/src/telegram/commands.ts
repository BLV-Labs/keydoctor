// Bot commands (§8.2). /check and /changes share core.ts with the MCP tools.
import { checkProposals, isKdError, type KdError } from "key-doctor";
import type { Env } from "../env.ts";
import { compare, resolve, scan } from "../core.ts";
import { getProposalState, saveProposalState } from "../store/proposal-state.ts";
import { latestSnapshot, saveSnapshot } from "../store/snapshots.ts";
import {
  addSubscription,
  countSubscriptions,
  deleteChat,
  listSubscriptions,
  removeSubscription,
} from "../store/subscriptions.ts";
import { sendMessage, sendTyping, TelegramError, type Outgoing } from "./api.ts";
import { langOf, renderChanges, renderCheck, renderHelp, TEXT, type Lang } from "./render.ts";

export const MAX_SUBS_PER_CHAT = 20;

export type Command =
  | { name: "check" | "changes" | "watch" | "unwatch"; target: string | null }
  | { name: "list" | "help" }
  | { name: "ignore" };

// *.near / *.testnet names inside free text. No LLM: a regex decides (§8.2).
const NAME_IN_TEXT = /(?:^|[^a-z0-9_.-])((?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*\.(?:near|testnet))(?![a-z0-9_-])/gi;

export function findNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(NAME_IN_TEXT)) names.add((m[1] as string).toLowerCase());
  return [...names];
}

/** Parses a message. A group chat gets no /help for chatter without exactly one name. */
export function parseCommand(text: string, isGroup: boolean): Command {
  const trimmed = text.trim();
  const m = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?/i.exec(trimmed);
  if (m === null) {
    const names = findNames(trimmed);
    if (names.length === 1) return { name: "check", target: names[0] as string };
    return isGroup ? { name: "ignore" } : { name: "help" };
  }
  const cmd = (m[1] as string).toLowerCase();
  const arg = m[2] ?? null;
  switch (cmd) {
    case "check":
    case "changes":
    case "watch":
    case "unwatch":
      return { name: cmd, target: arg };
    case "list":
      return { name: "list" };
    case "start":
    case "help":
      return { name: "help" };
    default:
      return isGroup ? { name: "ignore" } : { name: "help" };
  }
}

export interface Incoming {
  chatId: string;
  chatType: string;
  text: string;
  lang: Lang;
}

/** Extracts what the bot needs from a Telegram update; null for anything else (edits, joins, channels, bots). */
export function incomingFrom(update: unknown): Incoming | null {
  if (typeof update !== "object" || update === null) return null;
  const msg = (update as { message?: unknown }).message;
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { text?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { is_bot?: unknown; language_code?: unknown } };
  if (typeof m.text !== "string" || m.from?.is_bot === true) return null;
  const id = m.chat?.id;
  const type = m.chat?.type;
  if ((typeof id !== "number" && typeof id !== "string") || typeof type !== "string" || type === "channel") return null;
  return { chatId: String(id), chatType: type, text: m.text.slice(0, 1000), lang: langOf(m.from?.language_code) };
}

const kdOf = (e: unknown): KdError | null => (isKdError(e) ? e.kd : null);

async function run(cmd: Command, inc: Incoming, env: Env, typing: () => void): Promise<Outgoing | null> {
  const { lang, chatId } = inc;
  switch (cmd.name) {
    case "ignore":
      return null;
    case "help":
      return renderHelp(lang);
    case "list":
      return TEXT.list(lang, await listSubscriptions(env.DB, chatId));
  }
  if (cmd.target === null) return TEXT.usage(lang, cmd.name);
  const t = resolve({ target: cmd.target }, env);

  switch (cmd.name) {
    case "check":
      typing();
      return renderCheck(lang, await scan({ target: t.id }, env), env.DASHBOARD_URL);
    case "changes":
      typing();
      return renderChanges(lang, await compare({ target: t.id, update_baseline: false }, env), env.DASHBOARD_URL);
    case "unwatch":
      return (await removeSubscription(env.DB, t.id, t.network, chatId)) ? TEXT.unwatched(lang, t.id) : TEXT.notWatched(lang, t.id);
    case "watch": {
      if ((await countSubscriptions(env.DB, chatId)) >= MAX_SUBS_PER_CHAT) return TEXT.tooMany(lang, MAX_SUBS_PER_CHAT);
      typing();
      const report = await scan({ target: t.id }, env);
      const type = report.target.type;
      const added = await addSubscription(env.DB, {
        target: t.id,
        network: t.network,
        target_type: type,
        chat_id: chatId,
        chat_type: inc.chatType,
        created_at: new Date().toISOString(),
      });
      if (!added) return TEXT.alreadyWatched(lang, t.id);
      // First subscription to a target with no baseline: this scan becomes the baseline (one of the two baseline writers).
      if ((await latestSnapshot(env.DB, t.id, t.network)) === null) await saveSnapshot(env.DB, report);
      // A DAO is watched only from now on: record the current last proposal, no alerts.
      if (type === "dao" && (await getProposalState(env.DB, t.id, t.network)) === null) {
        const { state } = await checkProposals(t.id, null, { network: t.network, ...(t.rpcUrl && { rpcUrl: t.rpcUrl }) });
        await saveProposalState(env.DB, t.id, t.network, state);
      }
      return TEXT.watched(lang, t.id, type);
    }
  }
}

/** Handles one update end to end. Runs inside ctx.waitUntil, so it never throws. */
export async function handleUpdate(update: unknown, env: Env): Promise<void> {
  const inc = incomingFrom(update);
  const token = env.TELEGRAM_BOT_TOKEN;
  if (inc === null || !token) return;
  const cmd = parseCommand(inc.text, inc.chatType !== "private");
  let reply: Outgoing | null;
  try {
    reply = await run(cmd, inc, env, () => {
      sendTyping(token, inc.chatId).catch(() => {});
    });
  } catch (e) {
    const kd = kdOf(e);
    if (kd === null) console.error("bot command failed", { command: cmd.name, error: e instanceof Error ? e.name : "unknown" });
    reply = kd !== null ? TEXT.error(inc.lang, kd.message) : TEXT.internal(inc.lang);
  }
  if (reply === null) return;
  try {
    await sendMessage(token, inc.chatId, reply);
  } catch (e) {
    if (e instanceof TelegramError && e.chatGone) await deleteChat(env.DB, inc.chatId);
    else console.error("telegram send failed", { status: e instanceof TelegramError ? e.status : "network" });
  }
}
