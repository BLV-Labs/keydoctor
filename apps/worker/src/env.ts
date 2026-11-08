// Minimal Workers runtime types: only what this Worker uses, so no @cloudflare/workers-types dependency.

export interface D1Result<T> {
  results: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface Env {
  DB: D1Database;
  RUN_CHECK_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  NEW_KEY_WINDOW_HOURS?: string;
  MAX_DAOS_PER_RUN?: string;
  PENDING_SUB_TTL_MINUTES?: string;
  DASHBOARD_URL?: string;
  DASHBOARD_ORIGIN?: string;
  PROPOSAL_UI_URL_TEMPLATE?: string;
  /** Language of cron messages: vi, en or both (default). */
  ALERT_LANG?: string;
  /** Telegram bot username for deep links (default KeyDoctorOnCallBot). */
  BOT_USERNAME?: string;
  /** `tools/call` limit per client IP per minute on /mcp (default 30). */
  MCP_RATE_LIMIT_PER_MIN?: string;
  /** One RPC URL or a comma-separated list, tried in order on rate limits and transport failures. */
  RPC_URL_TESTNET?: string;
  RPC_URL_MAINNET?: string;
  /** Keeper (ADR 0005). The job stays off until the account, the key and the factory are all set. */
  KEEPER_ACCOUNT_ID?: string;
  /** Secret. The only key the Worker holds; it may sign only `execute_plan_step` and `sync_request` (K3). */
  KEEPER_PRIVATE_KEY?: string;
  /** Guard factory the keeper lists Guards from. */
  KEEPER_FACTORY_ID?: string;
  /** In NEAR. Below the minimum or above the maximum the team is told once a day (K4; default 1 and 5). */
  KEEPER_MIN_BALANCE?: string;
  KEEPER_MAX_BALANCE?: string;
  /** Telegram chat of the team, for balance warnings. */
  KEEPER_ALERT_CHAT_ID?: string;
  /** Limits per cycle, to stay inside the 50 subrequests of the free plan (default 3 and 3). */
  KEEPER_MAX_GUARDS_PER_RUN?: string;
  KEEPER_MAX_STEPS_PER_RUN?: string;
}
