// MCP over Streamable HTTP (§8.3): stateless JSON-RPC 2.0 with plain JSON replies (no SSE stream).
import { isKdError, type KdError } from "key-doctor";
import type { Env } from "../env.ts";
import { compare, diagnose } from "../core.ts";
import { json, kdErrorBody, readJson } from "../http.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "key-doctor", version: "0.1.0" };
const TARGET_MAX_LEN = 100;

const targetProps = {
  target: { type: "string", description: "NEAR account or Sputnik DAO, e.g. kd-demo.sputnik-v2.testnet" },
  network: { type: "string", enum: ["mainnet", "testnet"], description: "Optional; the .near / .testnet suffix decides when present" },
};

export const TOOLS = [
  {
    name: "diagnose",
    title: "Check the keys of a NEAR account or DAO council",
    description:
      "Scans the access keys of a NEAR account, or of every council member of a Sputnik DAO, and scores the risk with fixed rules (no AI). Returns kd.report_summary.v1 (detail=summary, default) or kd.report.v1 (detail=full). Read-only; stores nothing.",
    inputSchema: {
      type: "object",
      properties: { ...targetProps, detail: { type: "string", enum: ["summary", "full"], default: "summary" } },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "compare",
    title: "Compare keys with the last baseline",
    description:
      "Scans the target and compares it with the stored baseline, returning kd.diff.v1 (keys added or removed, members, roles, flags). Only set update_baseline=true when explicitly asked; by default the baseline does not move. The first call for a target stores the baseline and reports no changes.",
    inputSchema: {
      type: "object",
      properties: { ...targetProps, update_baseline: { type: "boolean", default: false } },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

type Id = string | number | null;
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates tool arguments; returns an error message for the agent, or null when valid. */
function badArgs(name: string, args: Record<string, unknown>): string | null {
  const allowed = new Set(["target", "network", name === "diagnose" ? "detail" : "update_baseline"]);
  for (const k of Object.keys(args)) if (!allowed.has(k)) return `Unknown argument: ${k}`;
  if (typeof args.target !== "string" || args.target.length === 0 || args.target.length > TARGET_MAX_LEN) return "target must be a NEAR account name";
  if (args.network !== undefined && args.network !== "mainnet" && args.network !== "testnet") return "network must be mainnet or testnet";
  if (args.detail !== undefined && args.detail !== "summary" && args.detail !== "full") return "detail must be summary or full";
  if (args.update_baseline !== undefined && typeof args.update_baseline !== "boolean") return "update_baseline must be a boolean";
  return null;
}

const toolResult = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError && { isError: true }),
});

async function callTool(name: string, args: Record<string, unknown>, env: Env) {
  const bad = badArgs(name, args);
  if (bad !== null) return toolResult(kdErrorBody("INVALID_TARGET", { vi: bad, en: bad }), true);
  try {
    if (name === "diagnose") return toolResult(await diagnose(args as unknown as Parameters<typeof diagnose>[0], env));
    return toolResult(await compare(args as unknown as Parameters<typeof compare>[0], env));
  } catch (e) {
    if (isKdError(e)) return toolResult(e.kd, true);
    console.error("mcp tool failed", { tool: name, error: e instanceof Error ? e.name : "unknown" });
    const kd: KdError = kdErrorBody("RPC_ERROR", { vi: "Lỗi nội bộ.", en: "Internal error." }, true);
    return toolResult(kd, true);
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json(rpcError(null, -32600, "Use POST"), 405, { allow: "POST" });
  const msg = await readJson(request);
  if (!isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return json(rpcError(null, -32600, "Invalid request"), 400);
  }
  const hasId = "id" in msg;
  const id = (typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null) as Id;
  // Notifications and client responses get 202 with no body.
  if (!hasId) return new Response(null, { status: 202 });
  const params = isObj(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return json(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Key Doctor checks NEAR access keys with fixed rules. diagnose is read-only. compare moves the baseline only with update_baseline=true. It never signs or holds keys.",
        }),
      );
    }
    case "ping":
      return json(rpcResult(id, {}));
    case "tools/list":
      return json(rpcResult(id, { tools: TOOLS }));
    case "tools/call": {
      const name = params.name;
      if (name !== "diagnose" && name !== "compare") return json(rpcError(id, -32602, "Unknown tool"));
      const args = isObj(params.arguments) ? params.arguments : {};
      return json(rpcResult(id, await callTool(name, args, env)));
    }
    default:
      return json(rpcError(id, -32601, "Method not found"));
  }
}
