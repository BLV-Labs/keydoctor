// The three Guard MCP tools (docs/final-idea.md §11.6.2) and the kd.guard_result.v1 mapping (§4.8).
// The agent never picks the request_id or the raw yocto amount; descriptions and messages teach it not to
// resend a Pending request and not to split a payment.
import { randomUUID } from "node:crypto";
import { nearToYocto, yoctoToNear } from "./amount.ts";
import { panicCode, readAgentKey, Rpc, RpcError, signTx, type AgentKey } from "./near.ts";

const TGAS = 10n ** 12n;
const GAS_REQUEST_TRANSFER = 200n * TGAS; // README "Agent Guard": 145 Tgas is the lowest that works
const GAS_SYNC_REQUEST = 50n * TGAS; // 10 + 15 Tgas reserved for the DAO view and callback
const MEMO_MAX = 200; // the contract trims to this anyway
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const FINAL = new Set(["Executed", "Rejected", "Expired", "Failed"]);
const DEFAULT_RPC = { mainnet: "https://rpc.mainnet.fastnear.com", testnet: "https://rpc.testnet.fastnear.com" };

export interface Config {
  network: "mainnet" | "testnet";
  rpcUrl: string;
  guardId: string;
  agentId: string;
  keyPath: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const network = env.NEAR_NETWORK ?? "testnet";
  if (network !== "mainnet" && network !== "testnet") throw new Error("NEAR_NETWORK must be mainnet or testnet");
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    network,
    rpcUrl: env.NEAR_RPC_URL || DEFAULT_RPC[network],
    guardId: need("GUARD_CONTRACT_ID"),
    agentId: need("AGENT_ACCOUNT_ID"),
    keyPath: need("AGENT_KEY_PATH"),
  };
}

export const TOOLS = [
  {
    name: "guard_get_policy",
    title: "Read the Agent Guard spending limits",
    description:
      "The limits the Guard enforces on this agent: max NEAR per payment, max NEAR per 24 hours, what is already spent and what is left in the current window, when it resets, the whitelisted receivers, and whether the Guard is paused. Read-only. Payments over these limits are not refused: they wait for the DAO council.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "guard_request_transfer",
    title: "Ask the Agent Guard to pay NEAR from the DAO treasury",
    description:
      "Asks the Guard to pay amount_near NEAR to receiver_id from the DAO treasury. Within the limits and to a whitelisted receiver the Guard approves and the money moves at once (status auto_approved). Otherwise the payment becomes a proposal that waits for the DAO council (status pending): that is the council's decision, so never send the same payment again, and never split it into smaller payments to get under a limit. Each call is a new payment with a new request_id; to follow up on one, use guard_get_request_status. Returns kd.guard_result.v1.",
    inputSchema: {
      type: "object",
      properties: {
        receiver_id: { type: "string", description: "NEAR account to pay, e.g. vendor.testnet" },
        amount_near: { type: "string", description: 'Amount in NEAR as a decimal string, e.g. "2.5"' },
        memo: { type: "string", description: "What the payment is for, e.g. the invoice number (max 200 characters)" },
      },
      required: ["receiver_id", "amount_near"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "guard_get_request_status",
    title: "Check a payment request",
    description:
      "The current status of a payment request by its request_id (from guard_request_transfer): pending (waiting for the council), auto_approved, executed (paid), rejected, expired or failed. Refreshes the status from the DAO when the request is not final yet. Use this instead of sending a payment again.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string", description: "request_id returned by guard_request_transfer" } },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
] as const;

export interface GuardResult {
  schema_version: "kd.guard_result.v1";
  request_id: string;
  status: "auto_approved" | "pending" | "rejected" | "failed";
  proposal_id: number | null;
  tx_hash: string | null;
  reasons: string[];
  error_code: string | null;
  limits: { max_per_tx: string; max_per_day: string; remaining_today: string };
  message: string;
}

interface RequestRecord {
  request_id: string;
  receiver_id: string;
  amount: string;
  memo: string;
  decision: "Auto" | "Pending";
  reasons: string[];
  proposal_id: number | null;
  status: string;
}

interface Policy {
  max_per_tx: string;
  max_per_day: string;
  max_pending_per_agent: number;
  min_reserve: string;
}

interface Window {
  resets_at: string;
  spent_in_window: string;
  remaining: string;
}

/** A tool failure the agent can read; becomes an isError tool result. */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const NO_RETRY = "Do not send this payment again in another form (other amount, split, other receiver).";

const REJECT_MESSAGES: Record<string, string> = {
  PAUSED: "The DAO has paused the Guard, so no payment can go out. Tell the owner.",
  UNKNOWN_AGENT: "This agent account is not registered with the Guard. Tell the owner.",
  AGENT_DISABLED: "The DAO has disabled this agent. Tell the owner.",
  INVALID_AMOUNT: "The amount must be more than 0.",
  TOO_MANY_PENDING:
    "Too many of this agent's payments are already waiting for the council. Wait until the council decides on them; do not send more.",
  INSUFFICIENT_GUARD_BALANCE: "The Guard cannot pay the proposal bond right now. Tell the owner.",
};

function pendingMessage(r: RequestRecord): string {
  const why = r.reasons.length ? ` (${r.reasons.join(", ")})` : "";
  return (
    `This payment is over the agent's limits${why}, so it waits for the DAO council (proposal ${r.proposal_id}). ` +
    "Do NOT send it again and do NOT split it into smaller payments: an over-limit payment is the council's decision. " +
    `Check later with guard_get_request_status and request_id ${r.request_id}.`
  );
}

const STATUS_MESSAGES: Record<string, (r: RequestRecord) => string> = {
  Submitted: () => "The Guard is still creating the proposal. Check again in a few seconds; do not send the payment again.",
  AutoApproved: (r) =>
    `Approved within the limits; the DAO pays ${yoctoToNear(r.amount)} NEAR to ${r.receiver_id}. Do not send it again.`,
  Pending: pendingMessage,
  Executed: (r) => `Paid: ${yoctoToNear(r.amount)} NEAR to ${r.receiver_id}. Done.`,
  Rejected: () => `The council rejected or removed this payment. ${NO_RETRY} Tell the owner.`,
  Expired: () => `The council did not decide in time and the proposal expired. ${NO_RETRY} Tell the owner.`,
  Failed: (r) =>
    `This request failed${r.proposal_id === null ? "" : `; proposal ${r.proposal_id} may still be open for the council`}. ${NO_RETRY} Tell the owner.`,
};

export interface GuardDeps {
  config: Config;
  rpc: Rpc;
  key: AgentKey;
  newRequestId?: () => string;
}

export function createGuard({ config, rpc, key, newRequestId = randomUUID }: GuardDeps) {
  const guard = config.guardId;
  let queue: Promise<unknown> = Promise.resolve();

  /** Signs and sends one FunctionCall to the Guard. Calls run one at a time so nonces never collide. */
  function callGuard(methodName: string, args: unknown, gas: bigint): Promise<{ hash: string; outcome: Promise<any> }> {
    const run = queue.then(async () => {
      const ak = await rpc.accessKey(key.accountId, key.publicKey);
      if (ak.permission === "FullAccess") {
        throw new ToolError("FULL_ACCESS_KEY", "AGENT_KEY_PATH holds a full-access key. Give the agent only the function-call key limited to the Guard.");
      }
      const tx = {
        signerId: key.accountId,
        pub: key.pub,
        nonce: ak.nonce + 1n,
        receiverId: guard,
        blockHash: ak.blockHash,
        methodName,
        args: Buffer.from(JSON.stringify(args)),
        gas,
        deposit: 0n,
      };
      const { signed, hash } = signTx(tx, key.seed);
      // The hash is known before the send, so even an unknown outcome names the transaction.
      return { hash, outcome: rpc.sendTx(signed) };
    });
    queue = run.then(
      (r) => r.outcome.catch(() => {}),
      () => {},
    );
    return run;
  }

  async function limits(): Promise<GuardResult["limits"]> {
    try {
      const [p, w] = await Promise.all([rpc.view<Policy>(guard, "get_policy"), rpc.view<Window>(guard, "get_window")]);
      return { max_per_tx: yoctoToNear(p.max_per_tx), max_per_day: yoctoToNear(p.max_per_day), remaining_today: yoctoToNear(w.remaining) };
    } catch {
      return { max_per_tx: "unknown", max_per_day: "unknown", remaining_today: "unknown" };
    }
  }

  async function getPolicy() {
    const [cfg, p, w, wl, agents] = await Promise.all([
      rpc.view<{ dao_id: string; paused: boolean }>(guard, "get_config"),
      rpc.view<Policy>(guard, "get_policy"),
      rpc.view<Window>(guard, "get_window"),
      rpc.view<{ account_id: string; label: string; max_per_tx: string | null }[]>(guard, "get_whitelist"),
      rpc.view<{ account_id: string; enabled: boolean; pending: number }[]>(guard, "get_agents"),
    ]);
    const me = agents.find((a) => a.account_id === key.accountId);
    return {
      guard_id: guard,
      dao_id: cfg.dao_id,
      paused: cfg.paused,
      max_per_tx: yoctoToNear(p.max_per_tx),
      max_per_day: yoctoToNear(p.max_per_day),
      spent_today: yoctoToNear(w.spent_in_window),
      remaining_today: yoctoToNear(w.remaining),
      resets_at: new Date(Number(BigInt(w.resets_at) / 1_000_000n)).toISOString(),
      max_pending_per_agent: p.max_pending_per_agent,
      agent: me ? { account_id: me.account_id, enabled: me.enabled, pending: me.pending } : null,
      whitelist: wl.map((e) => ({ account_id: e.account_id, label: e.label, max_per_tx: e.max_per_tx === null ? null : yoctoToNear(e.max_per_tx) })),
      note: "Amounts are NEAR. A payment over max_per_tx or remaining_today, or to a receiver not on the whitelist, is not refused: it waits for the DAO council. Never split a payment to fit the limits.",
    };
  }

  async function requestTransfer(input: { receiver_id?: unknown; amount_near?: unknown; memo?: unknown }): Promise<GuardResult> {
    const receiver = typeof input.receiver_id === "string" ? input.receiver_id.trim() : "";
    if (!ACCOUNT_ID.test(receiver)) throw new ToolError("INVALID_RECEIVER", "receiver_id must be a NEAR account like vendor.testnet");
    let amount: string;
    try {
      amount = nearToYocto(typeof input.amount_near === "string" ? input.amount_near.trim() : "");
    } catch (e) {
      throw new ToolError("INVALID_AMOUNT", (e as Error).message);
    }
    if (amount === "0") throw new ToolError("INVALID_AMOUNT", "amount_near must be more than 0");
    if (input.memo !== undefined && typeof input.memo !== "string") throw new ToolError("INVALID_MEMO", "memo must be a string");
    const memo = (input.memo ?? "").slice(0, MEMO_MAX);

    const request_id = newRequestId();
    const base = { schema_version: "kd.guard_result.v1" as const, request_id, proposal_id: null, reasons: [], error_code: null };
    const sent = await callGuard("request_transfer", { request_id, receiver_id: receiver, amount, memo: memo || null }, GAS_REQUEST_TRANSFER);

    let outcome: any;
    try {
      outcome = await sent.outcome;
    } catch (e) {
      // INVALID_TRANSACTION means NEAR refused it before running anything; any other error leaves it unknown.
      const body = e instanceof RpcError ? JSON.stringify(e.body) : "";
      if (body.includes("NotEnoughAllowance")) {
        const message = "The agent key has run out of gas allowance, so nothing was sent. Tell the owner to top it up.";
        return { ...base, status: "failed", tx_hash: null, error_code: "NOT_ENOUGH_ALLOWANCE", limits: await limits(), message };
      }
      if (body.includes("INVALID_TRANSACTION")) {
        const message = "NEAR refused the transaction before running it, so nothing was paid. Tell the owner.";
        return { ...base, status: "failed", tx_hash: null, error_code: "TX_INVALID", limits: await limits(), message };
      }
      return {
        ...base,
        status: "failed",
        tx_hash: sent.hash,
        error_code: "UNKNOWN_OUTCOME",
        limits: await limits(),
        message: `No answer from NEAR, so the payment may or may not have gone through. Do NOT send a new request: check with guard_get_request_status and request_id ${request_id}.`,
      };
    }

    const status = outcome?.status ?? {};
    if (status.Failure !== undefined) {
      const code = panicCode(status.Failure);
      return {
        ...base,
        status: code ? "rejected" : "failed",
        tx_hash: sent.hash,
        error_code: code ?? "TX_FAILED",
        limits: await limits(),
        message: code ? `${REJECT_MESSAGES[code] ?? `The Guard refused this request (${code}).`} ${NO_RETRY}` : `The transaction failed. ${NO_RETRY} Tell the owner.`,
      };
    }

    const r = JSON.parse(Buffer.from(status.SuccessValue ?? "", "base64").toString()) as RequestRecord;
    const msg = (STATUS_MESSAGES[r.status] ?? STATUS_MESSAGES.Failed!)(r);
    const common = { ...base, tx_hash: sent.hash, proposal_id: r.proposal_id, limits: await limits(), message: msg };
    if (r.status === "AutoApproved" || r.status === "Executed") return { ...common, status: "auto_approved" };
    if (r.status === "Pending") return { ...common, status: "pending", reasons: r.reasons };
    return { ...common, status: "failed", reasons: r.reasons, error_code: "REQUEST_FAILED" };
  }

  async function getRequestStatus(input: { request_id?: unknown }) {
    const id = typeof input.request_id === "string" ? input.request_id.trim() : "";
    if (!REQUEST_ID.test(id)) throw new ToolError("INVALID_REQUEST_ID", "request_id must be the id returned by guard_request_transfer");
    let r = await rpc.view<RequestRecord | null>(guard, "get_request", { request_id: id });
    if (!r) throw new ToolError("NOT_FOUND", `The Guard has no request ${id}.`);
    let note: string | null = null;
    if (!FINAL.has(r.status) && r.proposal_id !== null) {
      try {
        const sent = await callGuard("sync_request", { request_id: id }, GAS_SYNC_REQUEST);
        const v = (await sent.outcome)?.status?.SuccessValue;
        if (v) r = JSON.parse(Buffer.from(v, "base64").toString()) as RequestRecord;
      } catch {
        note = "Could not refresh from the DAO; this is the Guard's last known status.";
      }
    }
    return {
      request_id: r.request_id,
      status: r.status.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
      decision: r.decision.toLowerCase(),
      proposal_id: r.proposal_id,
      receiver_id: r.receiver_id,
      amount_near: yoctoToNear(r.amount),
      reasons: r.reasons,
      memo: r.memo,
      message: (STATUS_MESSAGES[r.status] ?? STATUS_MESSAGES.Failed!)(r) + (note ? ` ${note}` : ""),
    };
  }

  return { getPolicy, requestTransfer, getRequestStatus };
}

export function createGuardFromEnv(env: NodeJS.ProcessEnv) {
  const config = configFromEnv(env);
  return createGuard({ config, rpc: new Rpc(config.rpcUrl), key: readAgentKey(config.keyPath, config.agentId) });
}
