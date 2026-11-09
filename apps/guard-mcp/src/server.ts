// MCP JSON-RPC dispatch (initialize, ping, tools/list, tools/call), transport-free so tests drive it directly.
import { ToolError, TOOLS, type createGuardFromEnv } from "./tools.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "guard-mcp", version: "0.1.0" };

export type Guard = ReturnType<typeof createGuardFromEnv>;

function toolResult(data: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, ...(isError ? { isError } : {}) };
}

async function callTool(guard: Guard, name: string, args: Record<string, unknown>) {
  try {
    if (name === "guard_get_policy") return toolResult(await guard.getPolicy());
    if (name === "guard_request_transfer") return toolResult(await guard.requestTransfer(args));
    if (name === "guard_get_request_status") return toolResult(await guard.getRequestStatus(args));
    if (name === "strategies_list") return toolResult(await guard.strategiesList());
    if (name === "plans_status") return toolResult(await guard.plansStatus());
  } catch (e) {
    const err = e instanceof ToolError ? { error_code: e.code, message: e.message } : { error_code: "INTERNAL", message: (e as Error).message };
    return toolResult(err, true);
  }
  return null;
}

/** One JSON-RPC message in, one reply out (null for notifications). */
export async function handle(guard: Guard, msg: any): Promise<object | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
  if (id === undefined) return null; // notifications/initialized and friends
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const r = await callTool(guard, msg.params?.name, msg.params?.arguments ?? {});
      return r ? reply(r) : fail(-32602, `Unknown tool: ${msg.params?.name}`);
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
