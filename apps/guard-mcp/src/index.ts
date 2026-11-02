// MCP over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr only, stdout is the protocol.
import { createInterface } from "node:readline";
import { handle, type Guard } from "./server.ts";
import { createGuardFromEnv } from "./tools.ts";

let guard: Guard;
try {
  guard = createGuardFromEnv(process.env);
} catch (e) {
  console.error(`guard-mcp: ${(e as Error).message}`);
  process.exit(1);
}
console.error(`guard-mcp: Guard ${process.env.GUARD_CONTRACT_ID}, agent ${process.env.AGENT_ACCOUNT_ID}`);
const out = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    continue;
  }
  // Requests run concurrently; signing inside the Guard tools is serialized.
  handle(guard, msg).then((r) => r && out(r), (e) => console.error(`guard-mcp: ${(e as Error).message}`));
}
