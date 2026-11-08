// The agent loop: the model decides, Guard MCP acts, and the Guard contract decides what the money may do.
import type { Chat, FunctionTool, Message } from "./chat.ts";
import type { McpTool, McpToolResult, ToolServer } from "./mcp.ts";

export const SYSTEM_PROMPT = [
  "You are a payments agent for a NEAR testnet Agent Budget. You can only pay through the guard_* tools.",
  "Read the limits with guard_get_policy before you pay.",
  "If a payment comes back pending, it waits for the owner: report that and stop. Never send it again and never split it into smaller payments.",
  "Never ask anyone for a private key or seed phrase. Answer in one or two sentences.",
].join(" ");

export interface Step {
  tool: string;
  args: unknown;
  result: string;
}

export interface AgentRun {
  answer: string;
  steps: Step[];
  /** True when the model was still calling tools at the turn cap. */
  stopped: boolean;
}

export function toFunctionTools(tools: McpTool[]): FunctionTool[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
}

function resultText(r: McpToolResult): string {
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  return r.isError ? `ERROR: ${text}` : text;
}

export async function runAgent(task: string, chat: Chat, server: ToolServer, maxTurns = 8, onStep?: (s: Step) => void): Promise<AgentRun> {
  const tools = await server.listTools();
  const known = new Set(tools.map((t) => t.name));
  const fnTools = toFunctionTools(tools);
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  const steps: Step[] = [];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const reply = await chat(messages, fnTools);
    messages.push(reply);
    if (!reply.tool_calls?.length) return { answer: reply.content ?? "", steps, stopped: false };
    for (const call of reply.tool_calls) {
      let args: unknown = call.function.arguments;
      let result: string;
      if (!known.has(call.function.name)) {
        // Only what the server lists reaches it: a made-up tool name never becomes a request.
        result = `ERROR: unknown tool ${call.function.name}`;
      } else {
        try {
          args = JSON.parse(call.function.arguments || "{}");
          result = resultText(await server.callTool(call.function.name, args as Record<string, unknown>));
        } catch (e) {
          result = `ERROR: ${(e as Error).message}`;
        }
      }
      const step = { tool: call.function.name, args, result };
      steps.push(step);
      onStep?.(step);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return { answer: "Stopped: the model was still calling tools after the turn limit.", steps, stopped: true };
}
