import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgent } from "../src/agent.ts";
import type { Chat, Message } from "../src/chat.ts";
import type { McpTool, ToolServer } from "../src/mcp.ts";

const TOOLS: McpTool[] = [
  { name: "guard_get_policy", description: "limits", inputSchema: { type: "object", properties: {} } },
  { name: "guard_request_transfer", description: "pay", inputSchema: { type: "object", properties: {} } },
];

type Assistant = Extract<Message, { role: "assistant" }>;
const call = (id: string, name: string, args: string): Assistant => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] });
const say = (text: string): Assistant => ({ role: "assistant", content: text });

/** A model that plays back fixed replies and keeps what it was shown. */
function scripted(replies: Assistant[]) {
  const seen: Message[][] = [];
  const chat: Chat = async (messages) => {
    seen.push([...messages]);
    const next = replies.shift();
    if (next === undefined) throw new Error("model asked for more turns than scripted");
    return next;
  };
  return { chat, seen };
}

function server(answer = (name: string) => `{"tool":"${name}"}`) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const s: ToolServer = {
    listTools: async () => TOOLS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: answer(name) }] };
    },
  };
  return { s, calls };
}

describe("runAgent", () => {
  it("passes the model's tool calls to Guard MCP and hands each result back under its call id", async () => {
    const { chat, seen } = scripted([call("c1", "guard_request_transfer", '{"receiver_id":"bob.testnet","amount_near":"0.1"}'), say("Paid 0.1 NEAR.")]);
    const { s, calls } = server(() => '{"status":"auto_approved"}');
    const run = await runAgent("Pay bob 0.1", chat, s);
    assert.deepEqual(calls, [{ name: "guard_request_transfer", args: { receiver_id: "bob.testnet", amount_near: "0.1" } }]);
    assert.equal(run.answer, "Paid 0.1 NEAR.");
    assert.equal(run.stopped, false);
    // The model must see the Guard's own answer, or it would guess whether the money moved.
    assert.deepEqual(seen[1]?.at(-1), { role: "tool", tool_call_id: "c1", content: '{"status":"auto_approved"}' });
  });

  it("offers the model exactly the tools the server lists", async () => {
    let offered: string[] = [];
    const chat: Chat = async (_m, tools) => {
      offered = tools.map((t) => t.function.name);
      return say("ok");
    };
    await runAgent("hi", chat, server().s);
    assert.deepEqual(offered, ["guard_get_policy", "guard_request_transfer"]);
  });

  it("never forwards a tool name the server did not list", async () => {
    // A model can invent a tool; only guard-mcp's own tools may reach the process that holds the key.
    const { chat } = scripted([call("c1", "send_near_directly", "{}"), say("I cannot do that.")]);
    const { s, calls } = server();
    const run = await runAgent("pay", chat, s);
    assert.equal(calls.length, 0);
    assert.match(run.steps[0]?.result ?? "", /unknown tool send_near_directly/);
  });

  it("reports arguments that are not JSON back to the model instead of crashing", async () => {
    const { chat } = scripted([call("c1", "guard_get_policy", "{not json"), say("Retrying failed.")]);
    const { s, calls } = server();
    const run = await runAgent("limits?", chat, s);
    assert.equal(calls.length, 0);
    assert.match(run.steps[0]?.result ?? "", /^ERROR:/);
    assert.equal(run.answer, "Retrying failed.");
  });

  it("marks a server-side tool error so the model reads it as a failure", async () => {
    const { chat, seen } = scripted([call("c1", "guard_request_transfer", "{}"), say("It failed.")]);
    const s: ToolServer = { listTools: async () => TOOLS, callTool: async () => ({ isError: true, content: [{ type: "text", text: "LIMIT" }] }) };
    await runAgent("pay", chat, s);
    assert.equal((seen[1]?.at(-1) as { content: string }).content, "ERROR: LIMIT");
  });

  it("stops at the turn cap, so a model that keeps calling tools cannot keep asking for payments", async () => {
    const replies = Array.from({ length: 5 }, (_, i) => call(`c${i}`, "guard_request_transfer", '{"receiver_id":"bob.testnet","amount_near":"0.1"}'));
    const { chat } = scripted(replies);
    const { s, calls } = server();
    const run = await runAgent("pay", chat, s, 3);
    assert.equal(calls.length, 3);
    assert.equal(run.stopped, true);
  });
});
