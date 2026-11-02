import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handle, type Guard } from "../src/server.ts";
import { ToolError } from "../src/tools.ts";

const guard = {
  getPolicy: async () => ({ max_per_tx: "5" }),
  requestTransfer: async () => {
    throw new ToolError("INVALID_AMOUNT", "amount_near must be a decimal like 2.5");
  },
  getRequestStatus: async () => {
    throw new Error("boom");
  },
} as unknown as Guard;

const call = (method: string, params?: unknown) => handle(guard, { jsonrpc: "2.0", id: 1, method, params });

describe("MCP dispatch", () => {
  it("negotiates the protocol version", async () => {
    const r: any = await call("initialize", { protocolVersion: "2025-03-26" });
    assert.equal(r.result.protocolVersion, "2025-03-26");
    assert.deepEqual(r.result.serverInfo, { name: "guard-mcp", version: "0.1.0" });
    const old: any = await call("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(old.result.protocolVersion, "2025-06-18");
  });

  it("lists exactly the three Guard tools", async () => {
    const r: any = await call("tools/list");
    assert.deepEqual(
      r.result.tools.map((t: { name: string }) => t.name),
      ["guard_get_policy", "guard_request_transfer", "guard_get_request_status"],
    );
  });

  it("returns tool data as text and structuredContent", async () => {
    const r: any = await call("tools/call", { name: "guard_get_policy", arguments: {} });
    assert.deepEqual(r.result.structuredContent, { max_per_tx: "5" });
    assert.deepEqual(JSON.parse(r.result.content[0].text), { max_per_tx: "5" });
    assert.equal(r.result.isError, undefined);
  });

  it("turns tool failures into isError results the agent can read", async () => {
    const bad: any = await call("tools/call", { name: "guard_request_transfer", arguments: {} });
    assert.equal(bad.result.isError, true);
    assert.deepEqual(bad.result.structuredContent, { error_code: "INVALID_AMOUNT", message: "amount_near must be a decimal like 2.5" });
    const internal: any = await call("tools/call", { name: "guard_get_request_status", arguments: {} });
    assert.equal(internal.result.structuredContent.error_code, "INTERNAL");
  });

  it("answers JSON-RPC errors and ignores notifications", async () => {
    assert.equal(((await call("tools/call", { name: "guard_drain" })) as any).error.code, -32602);
    assert.equal(((await call("resources/list")) as any).error.code, -32601);
    assert.equal(((await handle(guard, { id: 1, method: "ping" })) as any).error.code, -32600);
    assert.equal(await handle(guard, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  });
});
