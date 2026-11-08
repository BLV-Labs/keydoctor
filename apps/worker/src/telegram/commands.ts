// Bot commands (§8.2). /check and /changes share core.ts with the MCP tools.
import { checkProposals, isKdError, type KdError, type Network } from "key-doctor";
import type { Env } from "../env.ts";
import { compare, resolve, scan, yieldCheck } from "../core.ts";
import { isComplete, topOf } from "../jobs/yield.ts";
import { checkRate } from "../mcp/rate-limit.ts";
import { addYieldWatch, countYieldWatches, getYieldTop, removeYieldWatch, saveYieldTop } from "../store/yield.ts";
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
import { langOf, renderChanges, renderCheck, renderHelp, renderYield, TEXT, type Lang } from "./render.ts";
import { takePending } from "../store/pending.ts";
import { isCode } from "../watch-link.ts";

export const MAX_SUBS_PER_CHAT = 20;
/** /yield and /yield_watch per chat per minute: each one reads two networks and scans the council. */
export const YIELD_PER_CHAT_PER_MIN = 3;

export type Command =
  | { name: "check" | "changes" | "watch" | "unwatch" | "yield" | "yield_watch" | "yield_unwatch"; target: string | null }
  | { name: "start"; code: string }
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
    case "yield":
    case "yield_watch":
    case "yield_unwatch":
      return { name: cmd, target: arg };
    case "list":
      return { name: "list" };
    case "start":
      // Deep links (UC5, P1): t.me/<bot>?start=<code> sends "/start <code>".
      return arg !== null && isCode(arg) ? { name: "start", code: arg } : { name: "help" };
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
    case "start": {
      const pending = await takePending(env.DB, cmd.code, new Date());
      if (pending === null) return TEXT.linkExpired(lang);
      const p = resolve({ target: pending.target, network: pending.network }, env);
      return watchTarget(p.id, p.network, p.rpcUrl, inc, env, typing);
    }
  }
  if (cmd.target === null) return cmd.name.startsWith("yield") ? TEXT.yieldUsage(lang, cmd.name) : TEXT.usage(lang, cmd.name);
  const t = resolve({ target: cmd.target }, env);
  if (cmd.name === "yield" || cmd.name === "yield_watch") {
    const wait = checkRate(`yield:${chatId}`, YIELD_PER_CHAT_PER_MIN);
    if (wait > 0) return TEXT.rateLimited(lang, wait);
  }

  switch (cmd.name) {
    case "check":
      typing();
      return renderCheck(lang, await scan({ target: t.id }, env), env.DASHBOARD_URL);
    case "changes":
      typing();
      return renderChanges(lang, await compare({ target: t.id, update_baseline: false }, env), env.DASHBOARD_URL);
    case "unwatch":
      return (await removeSubscription(env.DB, t.id, t.network, chatId)) ? TEXT.unwatched(lang, t.id) : TEXT.notWatched(lang, t.id);
    case "watch":
      return watchTarget(t.id, t.network, t.rpcUrl, inc, env, typing);
    case "yield": {
      // Read-only: never writes D1 (the push state belongs to /yield_watch and the job).
      typing();
      const { report, council } = await yieldCheck({ target: t.id, network: t.network }, env);
      return renderYield(lang, report, council, { ...(env.DASHBOARD_URL && { dashboardUrl: env.DASHBOARD_URL }) });
    }
    case "yield_unwatch":
      return (await removeYieldWatch(env.DB, t.id, t.network, chatId)) ? TEXT.yieldUnwatched(lang, t.id) : TEXT.yieldNotWatched(lang, t.id);
    case "yield_watch":
      return yieldWatch(t.id, t.network, inc, env, typing);
  }
}

/**
 * Opts this chat in to yield messages, in yield_watches only: key subscribers never get yield messages they did
 * not ask for. The reply is the report itself, so the chat sees the starting point the job compares against.
 */
async function yieldWatch(id: string, network: Network, inc: Incoming, env: Env, typing: () => void): Promise<Outgoing> {
  const { lang, chatId } = inc;
  if ((await countYieldWatches(env.DB, chatId)) >= MAX_SUBS_PER_CHAT) return TEXT.tooMany(lang, MAX_SUBS_PER_CHAT);
  typing();
  // Validates the DAO before anything is stored: an account or a non-DAO throws here.
  const { report, council } = await yieldCheck({ target: id, network }, env);
  if (!(await addYieldWatch(env.DB, id, network, chatId, inc.chatType))) return TEXT.yieldAlreadyWatched(lang, id);
  // First watcher of this DAO: record the current top so the job pushes only a later change. A report with a
  // read error is not a starting point; the job records the first complete one.
  if (isComplete(report) && (await getYieldTop(env.DB, id, network)) === undefined) await saveYieldTop(env.DB, id, network, topOf(report));
  const watched = TEXT.yieldWatched(lang, id);
  const shown = renderYield(lang, report, council, { watching: true, ...(env.DASHBOARD_URL && { dashboardUrl: env.DASHBOARD_URL }) });
  return { text: `${watched.text}\n\n${shown.text.split("\n").slice(1).join("\n")}`, buttons: shown.buttons ?? [] };
}

/** UC4 and the /start deep link: subscribe this chat, write the first baseline and, for a DAO, the proposal state. */
async function watchTarget(
  id: string,
  network: Network,
  rpcUrl: string[] | undefined,
  inc: Incoming,
  env: Env,
  typing: () => void,
): Promise<Outgoing> {
  const { lang, chatId } = inc;
  if ((await countSubscriptions(env.DB, chatId)) >= MAX_SUBS_PER_CHAT) return TEXT.tooMany(lang, MAX_SUBS_PER_CHAT);
  typing();
  const report = await scan({ target: id, network }, env);
  const type = report.target.type;
  const added = await addSubscription(env.DB, {
    target: id,
    network,
    target_type: type,
    chat_id: chatId,
    chat_type: inc.chatType,
    created_at: new Date().toISOString(),
  });
  if (!added) return TEXT.alreadyWatched(lang, id);
  // First subscription to a target with no baseline: this scan becomes the baseline (one of the two baseline writers).
  if ((await latestSnapshot(env.DB, id, network)) === null) await saveSnapshot(env.DB, report);
  // A DAO is watched only from now on: record the current last proposal, no alerts.
  if (type === "dao" && (await getProposalState(env.DB, id, network)) === null) {
    const { state } = await checkProposals(id, null, { network, ...(rpcUrl && { rpcUrl }) });
    await saveProposalState(env.DB, id, network, state);
  }
  return TEXT.watched(lang, id, type);
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
