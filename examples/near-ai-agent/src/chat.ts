// NEAR AI Cloud chat completions (OpenAI-compatible), with fetch only.
export const NEAR_AI_URL = "https://cloud-api.near.ai/v1";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** One model turn: the messages so far in, the assistant's next message out. */
export type Chat = (messages: Message[], tools: FunctionTool[]) => Promise<Extract<Message, { role: "assistant" }>>;

export function nearAiChat(apiKey: string, model: string, baseUrl = NEAR_AI_URL): Chat {
  return async (messages, tools) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
    });
    const body = (await res.json().catch(() => null)) as { choices?: { message?: unknown }[]; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(`NEAR AI Cloud answered ${res.status}: ${body?.error?.message ?? "no error message"}`);
    const message = body?.choices?.[0]?.message as Extract<Message, { role: "assistant" }> | undefined;
    if (message === undefined) throw new Error("NEAR AI Cloud returned no message");
    return { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
  };
}
