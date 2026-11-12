// Read-only chain data for the Agent Budget page: the DAO's balance, its open proposals (raw, because Approve and
// Reject pass the displayed `proposal` back) and the Guard's recent requests. Nothing here is sample data.
import { createRpc, DCA_TESTNET, DEFAULT_RPC_URLS, type Network, type Rpc } from "key-doctor";
import { GUARD_ROLE, type RawPolicy } from "./guard-proposals.ts";
import { readGuardDao, type GuardDao, type GuardLive } from "./guard-read.ts";

export interface BudgetProposal {
  id: number;
  proposer: string;
  description: string;
  kind: Record<string, unknown>;
  status: string;
  /** When the proposal was added, nanoseconds since the epoch; null when the chain did not give it. */
  submission_time: string | null;
}

export interface BudgetRequest {
  request_id: string;
  agent: string;
  receiver_id: string;
  amount: string;
  memo: string;
  decision: string;
  reasons: string[];
  proposal_id: number | null;
  status: string;
  /** When the agent asked, nanoseconds since the epoch; null when the chain did not give it. */
  created_at: string | null;
  /** Set on a step of this plan; the Guard is then the `agent`. */
  plan_id: number | null;
  /** The explorer page of the transaction that made this request; null or absent when the indexer did not find it. */
  tx_url?: string | null;
}

export interface BudgetLive {
  dao: GuardDao;
  /** The Guard this page manages: the first ready one, preferring a Guard the DAO role lists. */
  guard: GuardLive | null;
  /** The DAO account's NEAR balance in yoctoNEAR, null when it could not be read. */
  balance: string | null;
  /** The part of `balance` not holding the DAO's storage, the most a transfer can send; null when unread. */
  withdrawable: string | null;
  /** Open (InProgress) proposals of the DAO, newest first; null when the read failed. */
  proposals: BudgetProposal[] | null;
  /** The Guard's newest requests; null when the read failed. */
  requests: BudgetRequest[] | null;
  /** The Guard's plans (§11.11.2), in `plan_id` order; null when the read failed or the Guard has none to read. */
  plans: BudgetPlan[] | null;
  /** The DAO's USDT in base units (testnet only, DCA); null when unread or on mainnet. */
  usdt?: string | null;
}

/** A Guard plan (contracts/guard `Plan`). Times are nanoseconds since the epoch; amounts yoctoNEAR. */
export interface BudgetPlan {
  plan_id: number;
  /** The receiver of a `transfer` plan; null for any other action, which this page only names. */
  receiver_id: string | null;
  action_type: string;
  strategy_id: string;
  amount_per_run: string;
  interval_sec: number;
  runs_total: number;
  runs_done: number;
  next_run_at: string | null;
  status: "active" | "paused" | "completed" | "cancelled";
  pause_reason: string | null;
}

/** How many of the newest DAO proposals are scanned for open ones. */
const PROPOSAL_WINDOW = 50;
const REQUEST_LIMIT = 10;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const nanos = (v: unknown): string | null => (typeof v === "string" && /^\d+$/.test(v) ? v : null);

export function parseProposal(raw: unknown): BudgetProposal | null {
  if (!isRecord(raw) || typeof raw.id !== "number" || !isRecord(raw.kind)) return null;
  return {
    id: raw.id,
    proposer: typeof raw.proposer === "string" ? raw.proposer : "",
    description: typeof raw.description === "string" ? raw.description : "",
    kind: raw.kind,
    status: typeof raw.status === "string" ? raw.status : "",
    submission_time: nanos(raw.submission_time),
  };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

export function parseRequest(raw: unknown): BudgetRequest | null {
  if (!isRecord(raw) || typeof raw.request_id !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    request_id: raw.request_id,
    agent: str(raw.agent),
    receiver_id: str(raw.receiver_id),
    amount: str(raw.amount),
    memo: str(raw.memo),
    decision: str(raw.decision),
    reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((r): r is string => typeof r === "string") : [],
    proposal_id: typeof raw.proposal_id === "number" ? raw.proposal_id : null,
    status: str(raw.status),
    created_at: nanos(raw.created_at),
    plan_id: count(raw.plan_id),
  };
}

const PLAN_STATUSES: readonly BudgetPlan["status"][] = ["active", "paused", "completed", "cancelled"];

/** One plan as `get_plans` returns it; null for anything malformed, so a plan is never shown half-read. */
export function parsePlan(raw: unknown): BudgetPlan | null {
  if (!isRecord(raw) || !isRecord(raw.action)) return null;
  const id = count(raw.plan_id);
  const interval = count(raw.interval_sec);
  const total = count(raw.runs_total);
  const done = count(raw.runs_done);
  const amount = nanos(raw.amount_per_run);
  const status = PLAN_STATUSES.find((s) => s === raw.status);
  const type = raw.action.type;
  if (id === null || interval === null || total === null || done === null || amount === null || status === undefined || typeof type !== "string") return null;
  return {
    plan_id: id,
    receiver_id: type === "transfer" && typeof raw.action.receiver_id === "string" ? raw.action.receiver_id : null,
    action_type: type,
    strategy_id: typeof raw.strategy_id === "string" ? raw.strategy_id : "",
    amount_per_run: amount,
    interval_sec: interval,
    runs_total: total,
    runs_done: done,
    next_run_at: nanos(raw.next_run_at),
    status,
    pause_reason: typeof raw.pause_reason === "string" ? raw.pause_reason : null,
  };
}

/** `get_plans` takes at most 50 a call. */
const PLAN_PAGE = 50;

const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

/** What a transfer can send: `view_account.amount` still counts the NEAR locked for the account's storage. */
export function withdrawableYocto(amount: string, storageBytes: number): string {
  const free = BigInt(amount) - BigInt(storageBytes) * STORAGE_YOCTO_PER_BYTE;
  return (free > 0n ? free : 0n).toString();
}

/**
 * Room left for the storage the Withdraw request itself adds to the DAO: signature 1 stores a new proposal, so a
 * transfer of everything `withdrawable` showed before it would fail at signature 2 for lack of storage balance.
 */
export const WITHDRAW_STORAGE_MARGIN_YOCTO = 10n ** 22n;

/**
 * The most a Withdraw may ask for: the spendable balance minus the bond every open request still holds (the DAO
 * returns it when the owner approves or rejects) and the margin above. Null when the balance is unread.
 */
export function withdrawMaxYocto(b: Pick<BudgetLive, "withdrawable" | "proposals" | "dao">): string | null {
  if (b.withdrawable === null) return null;
  const held = BigInt(b.proposals?.length ?? 0) * BigInt(b.dao.policy.proposal_bond);
  const max = BigInt(b.withdrawable) - held - WITHDRAW_STORAGE_MARGIN_YOCTO;
  return (max > 0n ? max : 0n).toString();
}

/** The account's NEAR balance at `height`; any failure is null (shown as unknown, never as zero). */
export async function readBalance(account: string, height: number, network: Network): Promise<{ balance: string; withdrawable: string } | null> {
  for (const url of DEFAULT_RPC_URLS[network]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "kd", method: "query", params: { request_type: "view_account", block_id: height, account_id: account } }),
      });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      const result = isRecord(body) && isRecord(body.result) ? body.result : null;
      const amount = result?.amount;
      const storage = result?.storage_usage;
      if (typeof amount !== "string" || !/^\d+$/.test(amount) || typeof storage !== "number") return null;
      return { balance: amount, withdrawable: withdrawableYocto(amount, storage) };
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

/** One DAO proposal, raw, at the latest final block. Throws when it cannot be read. */
export async function readProposal(rpc: Rpc, dao: string, id: number): Promise<unknown> {
  const { height } = await rpc.block();
  return rpc.callFunction(dao, height, "get_proposal", { id });
}

export const budgetRpc = (network: Network): Rpc => createRpc({ url: DEFAULT_RPC_URLS[network] });

/** Throws what `readGuardDao` throws (a KdError, NOT_A_DAO, FACTORY_UNREADABLE). Failed side reads leave their field null. */
export async function readBudget(dao: string, factory: string, network: Network): Promise<BudgetLive> {
  const state = await readGuardDao(dao, factory, network);
  // A closed Guard is gone from the chain but stays in the factory's list and maybe in the role: never manage it.
  const live = state.guards.filter((g) => g.ready && !g.closed);
  const guard = live.find((g) => g.in_role) ?? live[0] ?? null;
  const rpc = budgetRpc(network);
  const { height } = await rpc.block();
  const proposalsRead = async (): Promise<BudgetProposal[] | null> => {
    try {
      const last = Number(await rpc.callFunction(dao, height, "get_last_proposal_id", {}));
      if (!Number.isSafeInteger(last) || last < 0) return null;
      const from = Math.max(0, last - PROPOSAL_WINDOW);
      const raw = await rpc.callFunction(dao, height, "get_proposals", { from_index: from, limit: last - from });
      if (!Array.isArray(raw)) return null;
      return raw
        .map(parseProposal)
        .filter((p): p is BudgetProposal => p !== null && p.status === "InProgress")
        .reverse();
    } catch {
      return null;
    }
  };
  const requestsRead = async (): Promise<BudgetRequest[] | null> => {
    if (guard === null) return null;
    try {
      const raw = await rpc.callFunction(guard.guard_id, height, "list_requests", { limit: REQUEST_LIMIT });
      return Array.isArray(raw) ? raw.map(parseRequest).filter((r): r is BudgetRequest => r !== null) : null;
    } catch {
      return null;
    }
  };
  const plansRead = async (): Promise<BudgetPlan[] | null> => {
    if (guard === null) return null;
    try {
      const plans: BudgetPlan[] = [];
      for (;;) {
        const raw = await rpc.callFunction(guard.guard_id, height, "get_plans", { from: plans.length, limit: PLAN_PAGE });
        if (!Array.isArray(raw)) return null;
        const page = raw.map(parsePlan);
        if (page.some((p) => p === null)) return null;
        plans.push(...(page as BudgetPlan[]));
        if (raw.length < PLAN_PAGE) return plans;
      }
    } catch {
      return null;
    }
  };
  const [funds, proposals, read, plans, txs] = await Promise.all([
    readBalance(dao, height, network),
    proposalsRead(),
    requestsRead(),
    plansRead(),
    guard === null ? Promise.resolve([]) : readGuardTxs(guard.guard_id, network),
  ]);
  const requests = read === null ? null : read.map((r) => ({ ...r, tx_url: txUrl(r, txs, network) }));
  const usdt = network === "testnet" ? await readUsdtBalance(rpc, height, dao) : null;
  return { dao: state, guard, balance: funds?.balance ?? null, withdrawable: funds?.withdrawable ?? null, proposals, requests, plans, usdt };
}

// The Guard cannot know the hash of the transaction that called it, and RPC keeps no account history, so the
// Activity links come from the NearBlocks indexer. A failed or slow read only drops the links.
const NEARBLOCKS_API: Record<Network, string> = { testnet: "https://api-testnet.nearblocks.io", mainnet: "https://api.nearblocks.io" };
const NEARBLOCKS_SITE: Record<Network, string> = { testnet: "https://testnet.nearblocks.io", mainnet: "https://nearblocks.io" };
/** Enough rows for REQUEST_LIMIT requests: each one also brings its `sync_request` calls. */
const TX_PAGE = 50;
const TX_TIMEOUT_MS = 5_000;
/** A request is written when its transaction's receipt runs, a block or two after the transaction lands. */
const TX_MATCH_NS = 10_000_000_000n;

export interface GuardTx {
  hash: string;
  signer: string;
  method: string;
  /** Block time of the transaction, nanoseconds since the epoch. */
  at: string;
}

/** The rows of `GET /v3/accounts/<guard>/txns`; a malformed row is dropped. */
export function parseGuardTxs(raw: unknown): GuardTx[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return [];
  return raw.data.flatMap((t): GuardTx[] => {
    if (!isRecord(t) || !Array.isArray(t.actions) || !isRecord(t.actions[0])) return [];
    const { transaction_hash: hash, signer_account_id: signer, block_timestamp: at } = t;
    const method = t.actions[0].method;
    return typeof hash === "string" && typeof signer === "string" && typeof method === "string" && nanos(at) !== null ? [{ hash, signer, method, at: at as string }] : [];
  });
}

async function readGuardTxs(guardId: string, network: Network): Promise<GuardTx[]> {
  try {
    const res = await fetch(`${NEARBLOCKS_API[network]}/v3/accounts/${encodeURIComponent(guardId)}/txns?per_page=${TX_PAGE}`, { signal: AbortSignal.timeout(TX_TIMEOUT_MS) });
    return res.ok ? parseGuardTxs(await res.json()) : [];
  } catch {
    return [];
  }
}

/**
 * The transaction that made a request: an agent's own `request_transfer`, or the `execute_plan_step` of a plan
 * step, landed at most TX_MATCH_NS before the request was written. The nearest wins, because the keeper runs
 * several steps a few seconds apart.
 */
export function txUrl(r: BudgetRequest, txs: GuardTx[], network: Network): string | null {
  if (r.created_at === null) return null;
  const created = BigInt(r.created_at);
  const method = r.plan_id === null ? "request_transfer" : "execute_plan_step";
  let best: { hash: string; gap: bigint } | null = null;
  for (const t of txs) {
    if (t.method !== method || (r.plan_id === null && t.signer !== r.agent)) continue;
    const gap = created - BigInt(t.at);
    if (gap >= 0n && gap <= TX_MATCH_NS && (best === null || gap < best.gap)) best = { hash: t.hash, gap };
  }
  return best === null ? null : `${NEARBLOCKS_SITE[network]}/txns/${best.hash}`;
}

/** `ft_balance_of(usdt, dao)` in base units; null when the read failed (shown as unknown, never as zero). */
async function readUsdtBalance(rpc: Rpc, height: number, dao: string): Promise<string | null> {
  try {
    const raw = await rpc.callFunction(DCA_TESTNET.token_out, height, "ft_balance_of", { account_id: dao });
    return typeof raw === "string" && /^\d+$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The contracts a Budget's account must be registered on before swaps can pay in USDT. */
export const DCA_TOKEN_CONTRACTS: readonly string[] = [DCA_TESTNET.wrap, DCA_TESTNET.exchange, DCA_TESTNET.token_out];

export interface DcaReadiness {
  /** `kd_guard_info.version` of the Guard; null when the Guard has no such view. */
  version: string | null;
  /** The factory's current Guard code hash (base58); null when unread. */
  latestHash: string | null;
  /** Per contract: whether the DAO is registered, and the deposit a registration needs. null = unread. */
  registrations: { contract: string; registered: boolean; min: string }[] | null;
}

/**
 * True when `version` ("1.4.0") is lower than 1.5.0, the first Guard that takes a DCA lowest price
 * (`swap_with_floor`); an unreadable version is not old.
 */
export function guardNeedsUpdate(version: string | null): boolean {
  const m = version === null ? null : /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a < 1 || (a === 1 && b < 5);
}

/** What `view_account` shows as `code_hash` for an account with no code of its own: none, or a global contract by hash. */
const NO_OWN_CODE_HASH = "11111111111111111111111111111111";

/** Room for the state `migrate` adds (1,000 bytes); the rest stays spare NEAR on the Guard. */
export const UPGRADE_STORAGE_MARGIN_YOCTO = 10n ** 22n;

/**
 * The NEAR the Guard lacks before `upgrade` can deploy `newCodeBytes` onto it, "0" when it has enough. `upgrade`
 * deploys the bytes, so the Guard pays storage for its own copy: all of it on a Guard that runs global code
 * (`ownCodeBytes` 0), only the growth on a Guard that already holds a copy. Short of that, the deploy and `migrate`
 * fail together, the old code stays and the approved request did nothing.
 */
export function upgradeShortfallYocto(freeYocto: string, newCodeBytes: number, ownCodeBytes: number): string {
  const grows = BigInt(Math.max(0, newCodeBytes - ownCodeBytes)) * STORAGE_YOCTO_PER_BYTE;
  const short = grows + UPGRADE_STORAGE_MARGIN_YOCTO - BigInt(freeYocto);
  // Rounded up to 0.01 NEAR, so the amount the page asks for is a short number and still enough.
  const cent = 10n ** 22n;
  return (short > 0n ? ((short + cent - 1n) / cent) * cent : 0n).toString();
}

/** The byte length of a base64 string, without decoding it. */
const base64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/** One raw RPC `query` at `height`, tried on each endpoint; null when every endpoint fails or the chain says no. */
async function rawQuery(network: Network, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  for (const url of DEFAULT_RPC_URLS[network]) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "kd", method: "query", params }) });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      return isRecord(body) && isRecord(body.result) ? body.result : null;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

/**
 * What the Guard lacks before an Update can work (`upgradeShortfallYocto`), read at one block: the Guard's balance
 * and storage, the size of the code the factory hands `upgrade` (`get_guard_code`, about 370 KB, so read only when
 * Update is offered) and the size of the Guard's own code. Null when any read fails.
 */
export async function readUpgradeShortfall(guardId: string, factory: string, network: Network): Promise<string | null> {
  if (factory === "") return null;
  try {
    const { height } = await budgetRpc(network).block();
    const [account, code] = await Promise.all([
      rawQuery(network, { request_type: "view_account", block_id: height, account_id: guardId }),
      rawQuery(network, { request_type: "call_function", block_id: height, account_id: factory, method_name: "get_guard_code", args_base64: "" }),
    ]);
    const amount = account?.amount;
    const storage = account?.storage_usage;
    const newBytes = code?.result;
    if (typeof amount !== "string" || !/^\d+$/.test(amount) || typeof storage !== "number" || !Array.isArray(newBytes) || newBytes.length === 0) return null;
    let ownBytes = 0;
    if (account?.code_hash !== NO_OWN_CODE_HASH) {
      const own = await rawQuery(network, { request_type: "view_code", block_id: height, account_id: guardId });
      if (typeof own?.code_base64 !== "string") return null;
      ownBytes = base64Bytes(own.code_base64);
    }
    return upgradeShortfallYocto(withdrawableYocto(amount, storage), newBytes.length, ownBytes);
  } catch {
    return null;
  }
}

/** True from Guard 1.4.0, the first version with `close`; an unread version is false. */
export function guardCanClose(version: string | null): boolean {
  const m = version === null ? null : /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > 1 || (a === 1 && b >= 4);
}

/** Testnet DCA checklist reads at one block: the Guard version, the factory's code hash and the NEP-145 state of each contract. */
export async function readDcaReadiness(dao: string, guardId: string, factory: string, network: Network): Promise<DcaReadiness> {
  const rpc = budgetRpc(network);
  const { height } = await rpc.block();
  const view = async (account: string, method: string, args: unknown): Promise<unknown> => {
    try {
      return await rpc.callFunction(account, height, method, args);
    } catch {
      return null;
    }
  };
  const [info, hash, regs] = await Promise.all([
    view(guardId, "kd_guard_info", {}),
    factory === "" ? Promise.resolve(null) : view(factory, "get_code_hash", {}),
    Promise.all(
      DCA_TOKEN_CONTRACTS.map(async (contract) => {
        const [bal, bounds] = await Promise.all([view(contract, "storage_balance_of", { account_id: dao }), view(contract, "storage_balance_bounds", {})]);
        const min = isRecord(bounds) && typeof bounds.min === "string" && /^\d+$/.test(bounds.min) ? bounds.min : null;
        if (min === null) return null;
        return { contract, registered: bal !== null && isRecord(bal), min };
      }),
    ),
  ]);
  return {
    version: isRecord(info) && typeof info.version === "string" ? info.version : null,
    latestHash: typeof hash === "string" ? hash : null,
    registrations: regs.every((r) => r !== null) ? (regs as { contract: string; registered: boolean; min: string }[]) : null,
  };
}

/** A Rhea quote for selling `amountIn` yoctoNEAR; null when the read failed. */
export async function readDcaQuote(amountIn: string, network: Network): Promise<string | null> {
  if (network !== "testnet" || !/^\d+$/.test(amountIn) || BigInt(amountIn) === 0n) return null;
  try {
    const rpc = budgetRpc(network);
    const { height } = await rpc.block();
    const out = await rpc.callFunction(DCA_TESTNET.exchange, height, "get_return", {
      pool_id: DCA_TESTNET.pool_id,
      token_in: DCA_TESTNET.wrap,
      amount_in: amountIn,
      token_out: DCA_TESTNET.token_out,
    });
    return typeof out === "string" && /^\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export type TopUpBlock = "NOT_COUNCIL" | "FOREIGN_MEMBER" | "NO_GUARD_ROLE" | "FOREIGN_GUARD";

export const TOP_UP_TEXT: Record<TopUpBlock, string> = {
  NOT_COUNCIL: "The connected account is not the owner of this Budget.",
  FOREIGN_MEMBER: "Other accounts can also act on this Budget. Top up is blocked: money sent here would not be yours alone.",
  NO_GUARD_ROLE: "This Budget's setup is not finished, so agents cannot use it. Top up is blocked.",
  FOREIGN_GUARD: "An account this Budget did not create may ask to spend from it. Top up is blocked.",
};

const isGroup = (kind: unknown): kind is { Group: string[] } => isRecord(kind) && Array.isArray(kind.Group);

/**
 * The DAO-policy check before every Top up (spec 11.10.4 item 3): the sender is a member of a DAO role, no other
 * account is, and role `agent-guard` lists this Guard and only Guards the factory registry shows for this DAO.
 * `Everyone` and `Member` roles name no account, so they count as other accounts: `budgetPolicy` has neither, and
 * one may hold a vote. Every role named `agent-guard` counts, because a policy can repeat a name. Empty means allowed.
 */
export function topUpBlocks(policy: RawPolicy, sender: string, guardId: string, registryGuards: string[]): TopUpBlock[] {
  const blocks: TopUpBlock[] = [];
  const ownerRoles = policy.roles.filter((r) => r.name !== GUARD_ROLE);
  const owners = ownerRoles.flatMap((r) => (isGroup(r.kind) ? r.kind.Group : []));
  if (!owners.includes(sender)) blocks.push("NOT_COUNCIL");
  else if (owners.some((m) => m !== sender) || ownerRoles.some((r) => !isGroup(r.kind))) blocks.push("FOREIGN_MEMBER");
  const guardRoles = policy.roles.filter((r) => r.name === GUARD_ROLE);
  const members = guardRoles.flatMap((r) => (isGroup(r.kind) ? r.kind.Group : []));
  if (!members.includes(guardId)) blocks.push("NO_GUARD_ROLE");
  if (members.some((m) => !registryGuards.includes(m)) || guardRoles.some((r) => !isGroup(r.kind))) blocks.push("FOREIGN_GUARD");
  return blocks;
}

/** Sputnik's permission label for a proposal kind, for `missingProposePermissions`. */
export function proposalLabel(kind: Record<string, unknown>): string {
  return "Transfer" in kind ? "transfer" : "FunctionCall" in kind ? "call" : "policy";
}
