// kd.watch_link.v1 (§4.6): shared by POST /api/watch-link and the MCP `watch` tool. Writes pending_subscriptions only;
// the subscription itself is written when the user opens the link and Telegram sends /start <code>.
import { KdErrorException, type KdWatchLink } from "key-doctor";
import type { Env } from "./env.ts";
import { resolve, type TargetArgs } from "./core.ts";
import { kdErrorBody } from "./http.ts";
import { addPending, countLivePending } from "./store/pending.ts";

export const DEFAULT_BOT_USERNAME = "KeyDoctorOnCallBot";
/** Live codes allowed at once, so an anonymous caller cannot fill D1. */
export const MAX_LIVE_PENDING = 1000;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 16;

/** Telegram start parameters allow [A-Za-z0-9_-], up to 64 characters. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2));
  let out = "";
  for (const b of bytes) {
    if (b >= 248) continue; // 248 = 4 * 62: drop the tail so every character is equally likely.
    out += CODE_ALPHABET[b % 62];
    if (out.length === CODE_LENGTH) return out;
  }
  return out.length === CODE_LENGTH ? out : newCode();
}

export const isCode = (s: string): boolean => /^[A-Za-z0-9]{16}$/.test(s);

export async function createWatchLink(args: TargetArgs, env: Env, now = new Date()): Promise<KdWatchLink> {
  const t = resolve(args, env);
  if ((await countLivePending(env.DB, now)) >= MAX_LIVE_PENDING) throw new KdErrorException(
      kdErrorBody("RATE_LIMITED", { vi: "Đang có quá nhiều link chờ xác nhận. Hãy thử lại sau ít phút.", en: "Too many links are waiting to be opened. Try again in a few minutes." }, true),
    );
  const code = newCode();
  const ttl = Number(env.PENDING_SUB_TTL_MINUTES);
  const expires = await addPending(env.DB, code, { target: t.id, network: t.network }, now, Number.isInteger(ttl) && ttl > 0 && ttl <= 1440 ? ttl : 30);
  const bot = env.BOT_USERNAME || DEFAULT_BOT_USERNAME;
  return {
    schema_version: "kd.watch_link.v1",
    target: t.id,
    network: t.network,
    link_private: `https://t.me/${bot}?start=${code}`,
    link_group: `https://t.me/${bot}?startgroup=${code}`,
    expires_at: expires.replace(/\.\d{3}Z$/, "Z"),
    instructions: {
      vi: "Bấm link đầu để nhận cho riêng bạn, link sau để thêm vào nhóm council.",
      en: "Open the first link for yourself, the second to add the bot to your council group.",
    },
  };
}
