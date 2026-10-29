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
  MCP_TOKEN?: string;
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
  RPC_URL_TESTNET?: string;
  RPC_URL_MAINNET?: string;
}
