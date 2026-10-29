// Worker entry (§8.1).
import { isKdError } from "key-doctor";
import type { Env, ExecutionContext, ScheduledController } from "./env.ts";
import { hasBearer } from "./auth.ts";
import { json, kdErrorBody, readJson, unauthorized } from "./http.ts";
import { runDailyJob } from "./jobs/daily.ts";
import { runProposalJob } from "./jobs/proposals.ts";
import { handleMcp } from "./mcp/server.ts";
import { handleTelegram } from "./telegram/webhook.ts";
import { createWatchLink } from "./watch-link.ts";

export const PROPOSAL_CRON = "*/15 * * * *";
export const DAILY_CRON = "0 2 * * *";

/** POST /run-check {job, target?} (§8.4): runs the same function as the cron. */
async function runCheck(request: Request, env: Env): Promise<Response> {
  if (!(await hasBearer(request, env.RUN_CHECK_TOKEN))) return unauthorized();
  const body = await readJson(request);
  const job = (body as { job?: unknown } | null)?.job;
  const target = (body as { target?: unknown } | null)?.target;
  if ((job !== "proposals" && job !== "daily") || (target !== undefined && (typeof target !== "string" || target.length > 100))) {
    return json(kdErrorBody("INVALID_TARGET", { vi: "Cần {job: \"proposals\" | \"daily\", target?}.", en: 'Expected {job: "proposals" | "daily", target?}.' }), 400);
  }
  try {
    return json(job === "proposals" ? await runProposalJob(env, target) : await runDailyJob(env, target));
  } catch (e) {
    if (isKdError(e)) return json(e.kd, 400);
    throw e;
  }
}

/** POST /api/watch-link {target, network?} (§8.4, P1): CORS only for DASHBOARD_ORIGIN; writes pending_subscriptions only. */
async function watchLink(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  const allowed = env.DASHBOARD_ORIGIN;
  if (!allowed || origin !== allowed) return json(kdErrorBody("UNAUTHORIZED"), 403);
  const cors = { "access-control-allow-origin": allowed, vary: "Origin" };
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" },
    });
  }
  const body = await readJson(request, 1024);
  const target = (body as { target?: unknown } | null)?.target;
  const network = (body as { network?: unknown } | null)?.network;
  if (typeof target !== "string" || target.length > 100 || (network !== undefined && network !== "mainnet" && network !== "testnet")) {
    return json(kdErrorBody("INVALID_TARGET", { vi: "Cần {target, network?}.", en: "Expected {target, network?}." }), 400, cors);
  }
  try {
    return json(await createWatchLink({ target, ...(network !== undefined && { network }) }, env), 200, cors);
  } catch (e) {
    if (isKdError(e)) return json(e.kd, e.kd.code === "RATE_LIMITED" ? 429 : 400, cors);
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/" && request.method === "GET") return new Response("ok", { headers: { "content-type": "text/plain" } });
    if (pathname === "/mcp") {
      if (!(await hasBearer(request, env.MCP_TOKEN))) return unauthorized();
      return handleMcp(request, env);
    }
    if (pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env, ctx);
    if (pathname === "/run-check" && request.method === "POST") return runCheck(request, env);
    if (pathname === "/api/watch-link" && (request.method === "POST" || request.method === "OPTIONS")) return watchLink(request, env);
    return json({ error: "not found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = controller.cron === DAILY_CRON ? runDailyJob(env) : runProposalJob(env);
    ctx.waitUntil(
      job.then(
        (r) => console.log("cron done", { job: r.job, targets: r.targets_checked, sent: r.alerts_sent, errors: r.errors.length }),
        (e: unknown) => console.error("cron failed", { cron: controller.cron, error: e instanceof Error ? e.name : "unknown" }),
      ),
    );
  },
};
