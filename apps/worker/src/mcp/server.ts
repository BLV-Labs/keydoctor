// MCP over Streamable HTTP (§8.3): stateless JSON-RPC 2.0 with plain JSON replies (no SSE stream).
import { isKdError, type KdError } from "key-doctor";
import type { Env } from "../env.ts";
import { compare, diagnose, listKeys, listProposals } from "../core.ts";
import { json, kdErrorBody, readJson } from "../http.ts";
import { createWatchLink } from "../watch-link.ts";
import { checkRate } from "./rate-limit.ts";

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
  {
    name: "list_keys",
    title: "List the access keys of an account or DAO council",
    description:
      "One row per access key, like the dashboard key table: member account, roles, full access or function call (approved contract, methods, allowance), age, use count, and the flags raised on it with their vi/en explanation. Filter by account_id, permission or flagged_only. Read-only; stores nothing.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetProps,
        account_id: { type: "string", description: "Only the keys of this council member" },
        permission: { type: "string", enum: ["full_access", "function_call"] },
        flagged_only: { type: "boolean", default: false },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_proposals",
    title: "List the proposals of a Sputnik DAO",
    description:
      "The DAO's proposals, newest first: id, kind, status, proposer, transfer details, votes cast, approvals needed and who still has to vote. Page with limit (default 10, max 50) and offset. Only for a DAO target. Read-only; stores nothing.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetProps,
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        offset: { type: "integer", minimum: 0, default: 0, description: "Newest proposals to skip" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "watch",
    title: "Get Telegram alert links for a target",
    description:
      "Returns kd.watch_link.v1: two one-time Telegram links (private chat, or add the bot to a council group) that subscribe to alerts for the target. Nothing is subscribed until the user opens a link; links expire after 30 minutes. Give both links to the user.",
    inputSchema: { type: "object", properties: { ...targetProps }, required: ["target"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

type Id = string | number | null;
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates tool arguments; returns an error message for the agent, or null when valid. */
function badArgs(name: string, args: Record<string, unknown>): string | null {
  const extra: Record<string, string[]> = {
    diagnose: ["detail"],
    compare: ["update_baseline"],
    list_keys: ["account_id", "permission", "flagged_only"],
    list_proposals: ["limit", "offset"],
  };
  const allowed = new Set(["target", "network", ...(extra[name] ?? [])]);
  for (const k of Object.keys(args)) if (!allowed.has(k)) return `Unknown argument: ${k}`;
  if (typeof args.target !== "string" || args.target.length === 0 || args.target.length > TARGET_MAX_LEN) return "target must be a NEAR account name";
  if (args.network !== undefined && args.network !== "mainnet" && args.network !== "testnet") return "network must be mainnet or testnet";
  if (args.detail !== undefined && args.detail !== "summary" && args.detail !== "full") return "detail must be summary or full";
  if (args.update_baseline !== undefined && typeof args.update_baseline !== "boolean") return "update_baseline must be a boolean";
  if (args.account_id !== undefined && (typeof args.account_id !== "string" || args.account_id.length > TARGET_MAX_LEN)) return "account_id must be a NEAR account name";
  if (args.permission !== undefined && args.permission !== "full_access" && args.permission !== "function_call") return "permission must be full_access or function_call";
  if (args.flagged_only !== undefined && typeof args.flagged_only !== "boolean") return "flagged_only must be a boolean";
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 50)) return "limit must be an integer from 1 to 50";
  if (args.offset !== undefined && (!Number.isInteger(args.offset) || (args.offset as number) < 0)) return "offset must be an integer of 0 or more";
  return null;
}

const toolResult = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError && { isError: true }),
});

const TOOL_NAMES = ["diagnose", "compare", "list_keys", "list_proposals", "watch"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

async function callTool(name: ToolName, args: Record<string, unknown>, env: Env) {
  const bad = badArgs(name, args);
  if (bad !== null) return toolResult(kdErrorBody("INVALID_TARGET", { vi: bad, en: bad }), true);
  try {
    if (name === "diagnose") return toolResult(await diagnose(args as unknown as Parameters<typeof diagnose>[0], env));
    if (name === "list_keys") return toolResult(await listKeys(args as unknown as Parameters<typeof listKeys>[0], env));
    if (name === "list_proposals") return toolResult(await listProposals(args as unknown as Parameters<typeof listProposals>[0], env));
    if (name === "watch") return toolResult(await createWatchLink(args as unknown as Parameters<typeof createWatchLink>[0], env));
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

  // Cloudflare always sets cf-connecting-ip; without it (local dev, tests) there is nothing to key on.
  const ip = request.headers.get("cf-connecting-ip");
  if (msg.method === "tools/call" && ip) {
    const wait = checkRate(ip, Number(env.MCP_RATE_LIMIT_PER_MIN) || 30);
    if (wait > 0) {
      return json(
        kdErrorBody("RATE_LIMITED", { vi: "Quá nhiều lệnh gọi MCP. Hãy thử lại sau ít phút.", en: "Too many MCP calls. Try again in a minute." }, true),
        429,
        { "retry-after": String(wait) },
      );
    }
  }

  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return json(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Key Doctor checks NEAR access keys and DAO proposals with fixed rules. diagnose, list_keys and list_proposals are read-only. compare moves the baseline only with update_baseline=true. It never signs or holds keys.",
        }),
      );
    }
    case "ping":
      return json(rpcResult(id, {}));
    case "tools/list":
      return json(rpcResult(id, { tools: TOOLS }));
    case "tools/call": {
      const name = params.name;
      if (!TOOL_NAMES.some((n) => n === name)) return json(rpcError(id, -32602, "Unknown tool"));
      const args = isObj(params.arguments) ? params.arguments : {};
      return json(rpcResult(id, await callTool(name as ToolName, args, env)));
    }
    default:
      return json(rpcError(id, -32601, "Method not found"));
  }
}
