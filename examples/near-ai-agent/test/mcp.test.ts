import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StdioMcpClient } from "../src/mcp.ts";

// A tiny stdio server with guard-mcp's framing: one JSON-RPC message per line on stdout.
const FAKE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }) + "\\n");
  if (m.method === "initialize") out({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  else if (m.method === "tools/list") out({ result: { tools: [{ name: "guard_get_policy", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call") out({ result: { content: [{ type: "text", text: JSON.stringify(m.params) }] } });
  else if (m.method === "die") process.exit(3);
  else out({ error: { code: -32601, message: "Method not found: " + m.method } });
});
`;

const start = () => new StdioMcpClient(process.execPath, ["-e", FAKE_SERVER], {});

describe("StdioMcpClient", () => {
  it("lists tools and calls one over stdio", async () => {
    const c = start();
    try {
      await c.initialize();
      assert.deepEqual((await c.listTools()).map((t) => t.name), ["guard_get_policy"]);
      const r = await c.callTool("guard_get_policy", { a: 1 });
      assert.deepEqual(JSON.parse(r.content?.[0]?.text ?? ""), { name: "guard_get_policy", arguments: { a: 1 } });
    } finally {
      c.close();
    }
  });

  it("rejects instead of hanging when the server exits mid-request", async () => {
    // guard-mcp exits at start when its env is wrong: the agent must fail loud, not wait forever.
    const c = start();
    try {
      await assert.rejects((c as unknown as { request(m: string, p: unknown): Promise<unknown> }).request("die", {}), /exited/);
    } finally {
      c.close();
    }
  });
});
