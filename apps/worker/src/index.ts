// Worker entry (§8.1). The bot (/telegram), /run-check and the crons arrive in GĐ4, GĐ6 and GĐ9.
import type { Env, ExecutionContext } from "./env.ts";
import { hasBearer } from "./auth.ts";
import { json, unauthorized } from "./http.ts";
import { handleMcp } from "./mcp/server.ts";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/" && request.method === "GET") return new Response("ok", { headers: { "content-type": "text/plain" } });
    if (pathname === "/mcp") {
      if (!(await hasBearer(request, env.MCP_TOKEN))) return unauthorized();
      return handleMcp(request, env);
    }
    return json({ error: "not found" }, 404);
  },
};
