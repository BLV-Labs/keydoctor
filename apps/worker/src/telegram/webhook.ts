import type { Env, ExecutionContext } from "../env.ts";
import { readJson } from "../http.ts";
import { handleUpdate } from "./commands.ts";

const encoder = new TextEncoder();

async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))));
  let diff = 0;
  for (let i = 0; i < (x as Uint8Array).length; i++) diff |= ((x as Uint8Array)[i] as number) ^ ((y as Uint8Array)[i] as number);
  return diff === 0;
}

/** POST /telegram: check the secret-token header, answer 200 at once, do the work in waitUntil (§8.2). */
export async function handleTelegram(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !(await same(got, secret))) return new Response("unauthorized", { status: 401 });
  const update = await readJson(request);
  if (update !== null) ctx.waitUntil(handleUpdate(update, env));
  return new Response("ok");
}
