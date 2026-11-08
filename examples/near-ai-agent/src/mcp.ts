// A minimal MCP client over stdio: newline-delimited JSON-RPC 2.0, the transport apps/guard-mcp speaks.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** What the agent loop needs from an MCP server; tests pass a fake. */
export interface ToolServer {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export class StdioMcpClient implements ToolServer {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    // stderr is the server's log: pass it through so the owner sees what guard-mcp signs.
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.pipe(process.stderr);
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.on("exit", (code) => {
      for (const w of this.waiting.values()) w.reject(new Error(`MCP server exited (code ${code})`));
      this.waiting.clear();
    });
  }

  private receive(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol: guard-mcp writes logs to stderr, so this should not happen
    }
    const w = msg.id === undefined ? undefined : this.waiting.get(msg.id);
    if (w === undefined || msg.id === undefined) return;
    this.waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message ?? "MCP error"));
    else w.resolve(msg.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "near-ai-agent", version: "0.0.0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async listTools(): Promise<McpTool[]> {
    const r = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}
