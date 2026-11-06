// Read-only chain data for the Agent Budget page: the DAO's balance, its open proposals (raw, because Approve and
// Reject pass the displayed `proposal` back) and the Guard's recent requests. Nothing here is sample data.
import { createRpc, DEFAULT_RPC_URLS, type Network, type Rpc } from "key-doctor";
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
  };
}

const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

/** What a transfer can send: `view_account.amount` still counts the NEAR locked for the account's storage. */
export function withdrawableYocto(amount: string, storageBytes: number): string {
  const free = BigInt(amount) - BigInt(storageBytes) * STORAGE_YOCTO_PER_BYTE;
  return (free > 0n ? free : 0n).toString();
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
  const guard = state.guards.find((g) => g.ready && g.in_role) ?? state.guards.find((g) => g.ready) ?? null;
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
  const [funds, proposals, requests] = await Promise.all([readBalance(dao, height, network), proposalsRead(), requestsRead()]);
  return { dao: state, guard, balance: funds?.balance ?? null, withdrawable: funds?.withdrawable ?? null, proposals, requests };
}

export type TopUpBlock = "NOT_COUNCIL" | "FOREIGN_MEMBER" | "NO_GUARD_ROLE" | "FOREIGN_GUARD";

export const TOP_UP_TEXT: Record<TopUpBlock, string> = {
  NOT_COUNCIL: "The connected account is not the owner of this Budget.",
  FOREIGN_MEMBER: "Another account also controls this Budget. Top up is blocked: money sent here would not be yours alone.",
  NO_GUARD_ROLE: "This Budget's setup is not finished, so agents cannot use it. Top up is blocked.",
  FOREIGN_GUARD: "An account this Budget did not create may ask to spend from it. Top up is blocked.",
};

const isGroup = (kind: unknown): kind is { Group: string[] } => isRecord(kind) && Array.isArray(kind.Group);

/**
 * The DAO-policy check before every Top up (spec 11.10.4 item 3): the sender is a member of a DAO role, no other
 * account is, and role `agent-guard` lists this Guard and only Guards the factory registry shows for this DAO.
 * Empty means allowed.
 */
export function topUpBlocks(policy: RawPolicy, sender: string, guardId: string, registryGuards: string[]): TopUpBlock[] {
  const blocks: TopUpBlock[] = [];
  const owners = policy.roles.flatMap((r) => (r.name !== GUARD_ROLE && isGroup(r.kind) ? r.kind.Group : []));
  if (!owners.includes(sender)) blocks.push("NOT_COUNCIL");
  else if (owners.some((m) => m !== sender)) blocks.push("FOREIGN_MEMBER");
  const role = policy.roles.find((r) => r.name === GUARD_ROLE);
  const members = role !== undefined && isGroup(role.kind) ? role.kind.Group : [];
  if (!members.includes(guardId)) blocks.push("NO_GUARD_ROLE");
  if (members.some((m) => !registryGuards.includes(m))) blocks.push("FOREIGN_GUARD");
  return blocks;
}

/** Sputnik's permission label for a proposal kind, for `missingProposePermissions`. */
export function proposalLabel(kind: Record<string, unknown>): string {
  return "Transfer" in kind ? "transfer" : "FunctionCall" in kind ? "call" : "policy";
}
