// Runs one task: a NEAR AI Cloud model as the agent's brain, apps/guard-mcp as its only hands.
// The agent key stays on this machine (AGENT_KEY_PATH, read by guard-mcp); NEAR AI sees only the conversation.
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.ts";
import { nearAiChat } from "./chat.ts";
import { StdioMcpClient } from "./mcp.ts";

const DEFAULT_MODEL = "Qwen/Qwen3.8-27B"; // a private (TEE) model on NEAR AI Cloud with tool calls

const task = process.argv.slice(2).join(" ").trim();
const apiKey = process.env.NEAR_AI_API_KEY;
if (!task || !apiKey) {
  console.error('usage: NEAR_AI_API_KEY=... GUARD_CONTRACT_ID=... AGENT_ACCOUNT_ID=... AGENT_KEY_PATH=... pnpm --silent --filter near-ai-agent start "Pay 0.1 NEAR to bob.testnet for invoice 7"');
  process.exit(2);
}
const model = process.env.NEAR_AI_MODEL || DEFAULT_MODEL;
const guardMcp = fileURLToPath(new URL("../../../apps/guard-mcp/src/index.ts", import.meta.url));
// guard-mcp gets only what it needs: never the NEAR AI key.
const { NEAR_AI_API_KEY: _drop, ...guardEnv } = process.env;
const server = new StdioMcpClient(process.execPath, ["--no-warnings=ExperimentalWarning", guardMcp], guardEnv);
try {
  await server.initialize();
  console.error(`near-ai-agent: model ${model}`);
  const run = await runAgent(task, nearAiChat(apiKey, model), server, 8, (s) => console.error(`→ ${s.tool} ${JSON.stringify(s.args)}\n← ${s.result}`));
  console.log(run.answer);
  process.exitCode = run.stopped ? 1 : 0;
} catch (e) {
  console.error(`near-ai-agent: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  server.close();
}
