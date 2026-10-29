// Worker entry (§8.1). /run-check and the crons arrive in GĐ6 and GĐ9.
import type { Env, ExecutionContext } from "./env.ts";
import { hasBearer } from "./auth.ts";
import { json, unauthorized } from "./http.ts";
import { handleMcp } from "./mcp/server.ts";
import { handleTelegram } from "./telegram/webhook.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/" && request.method === "GET") return new Response("ok", { headers: { "content-type": "text/plain" } });
    if (pathname === "/mcp") {
      if (!(await hasBearer(request, env.MCP_TOKEN))) return unauthorized();
      return handleMcp(request, env);
    }
    if (pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env, ctx);
    return json({ error: "not found" }, 404);
  },
};
