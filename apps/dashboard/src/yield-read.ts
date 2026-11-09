// Read-only chain data for the Yield agent page: the library's kd.yield.v1 scan, plus what the scan does not read
// yet: the DAO's policy, its registration and position on Rhea Lend, and its yield proposals. Every extra read is
// pinned to the scan's block. A failed extra read leaves its field null (shown as unknown, never as zero).
import { createRpc, DEFAULT_RPC_URLS, parseRheaPool, scanVault, type KdYieldReport, type Network, type RheaPool, type Rpc } from "key-doctor";
import { GUARD_ROLE, type RawPolicy } from "./guard-proposals.ts";
import { YIELD_ALLOWLIST, YIELD_PREFIX } from "./yield-proposals.ts";

export interface YieldPosition {
  token_id: string;
  /** Supplied balance in the token's own raw units (Rhea's extra decimals removed), interest included. */
  supplied: string;
}

export interface YieldProposal {
  id: number;
  proposer: string;
  description: string;
  status: string;
  kind: Record<string, unknown>;
  approvals: number;
  /** Nanoseconds since the epoch; null when the chain did not give it. */
  submission_time: string | null;
}

export interface YieldLive {
  report: KdYieldReport;
  policy: RawPolicy | null;
  /** True when the DAO has a Rhea Lend storage deposit; null when unread or the builder is off on this network. */
  registered: boolean | null;
  /** Supplied balances of allowlisted tokens; null when unread. */
  positions: YieldPosition[] | null;
  /** Rhea Lend's pool state per allowlisted token, for the rate-after previews; null when unread. */
  pools: RheaPool[] | null;
  /** The DAO's yield proposals among the newest it has, newest first; null when unread. */
  proposals: YieldProposal[] | null;
}

/** How many of the newest DAO proposals are scanned for yield ones. */
const PROPOSAL_WINDOW = 40;
const SHOWN = 8;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

export function parsePolicy(raw: unknown): RawPolicy | null {
  if (!isRecord(raw) || !Array.isArray(raw.roles) || !digits(raw.proposal_bond)) return null;
  return raw as unknown as RawPolicy;
}

/** A proposal is a yield one when its description carries the prefix or its call goes to an allowlisted receiver. */
export function isYieldProposal(network: Network, description: string, kind: Record<string, unknown>): boolean {
  if (description.startsWith(YIELD_PREFIX)) return true;
  const list = YIELD_ALLOWLIST[network];
  const fc = kind.FunctionCall;
  if (list === null || !isRecord(fc) || typeof fc.receiver_id !== "string") return false;
  return fc.receiver_id === list.lend || list.tokens.some((t) => t.token_id === fc.receiver_id);
}

export function parseYieldProposal(raw: unknown): YieldProposal | null {
  if (!isRecord(raw) || typeof raw.id !== "number" || !isRecord(raw.kind)) return null;
  const votes = isRecord(raw.votes) ? Object.values(raw.votes) : [];
  return {
    id: raw.id,
    proposer: typeof raw.proposer === "string" ? raw.proposer : "",
    description: typeof raw.description === "string" ? raw.description : "",
    status: typeof raw.status === "string" ? raw.status : "",
    kind: raw.kind,
    approvals: votes.filter((v) => v === "Approve").length,
    submission_time: digits(raw.submission_time) ? raw.submission_time : null,
  };
}

/**
 * Rhea Lend `get_account` to supplied balances of allowlisted tokens. Rhea keeps balances with `extra` more
 * decimals than the token, so they are divided down. A null account means nothing supplied.
 */
export function parsePositions(raw: unknown, tokens: readonly string[], extra: ReadonlyMap<string, number>): YieldPosition[] | null {
  if (raw === null) return [];
  if (!isRecord(raw) || !Array.isArray(raw.supplied)) return null;
  const out: YieldPosition[] = [];
  for (const s of raw.supplied) {
    if (!isRecord(s) || typeof s.token_id !== "string" || !tokens.includes(s.token_id)) continue;
    const ex = extra.get(s.token_id);
    if (!digits(s.balance) || ex === undefined) return null;
    const supplied = (BigInt(s.balance) / 10n ** BigInt(ex)).toString();
    if (supplied !== "0") out.push({ token_id: s.token_id, supplied });
  }
  return out;
}

const read = async <T>(f: () => Promise<T>): Promise<T | null> => {
  try {
    return await f();
  } catch {
    return null;
  }
};

/**
 * The given accounts that sit in a Group role of the DAO, the Guard's own role left out: the council whose votes
 * move yield funds, and whose DAOs My Agents lists. Order follows `accounts`.
 */
export function councilAccounts(policy: RawPolicy, accounts: readonly string[]): string[] {
  const members = new Set<string>();
  for (const r of policy.roles) {
    if (r.name === GUARD_ROLE || !isRecord(r.kind) || !Array.isArray(r.kind.Group)) continue;
    for (const m of r.kind.Group) if (typeof m === "string") members.add(m);
  }
  return accounts.filter((a) => members.has(a));
}

interface LendRead {
  positions: YieldPosition[] | null;
  pools: RheaPool[];
}

async function readPositions(rpc: Rpc, lend: string, dao: string, height: number, tokens: readonly string[]): Promise<LendRead | null> {
  const extra = new Map<string, number>();
  const pools: RheaPool[] = [];
  for (const t of tokens) {
    const asset = await rpc.callFunction(lend, height, "get_asset", { token_id: t });
    const ex = isRecord(asset) && isRecord(asset.config) ? asset.config.extra_decimals : undefined;
    if (typeof ex !== "number" || !Number.isSafeInteger(ex) || ex < 0) return null;
    extra.set(t, ex);
    const pool = parseRheaPool(asset);
    if (pool !== null) pools.push(pool);
  }
  return { positions: parsePositions(await rpc.callFunction(lend, height, "get_account", { account_id: dao }), tokens, extra), pools };
}

async function readProposals(rpc: Rpc, dao: string, height: number, network: Network): Promise<YieldProposal[] | null> {
  const last = Number(await rpc.callFunction(dao, height, "get_last_proposal_id", {}));
  if (!Number.isSafeInteger(last) || last < 0) return null;
  if (last === 0) return [];
  const from = Math.max(0, last - PROPOSAL_WINDOW);
  const raw = await rpc.callFunction(dao, height, "get_proposals", { from_index: from, limit: last - from });
  if (!Array.isArray(raw)) return null;
  return raw
    .map(parseYieldProposal)
    .filter((p): p is YieldProposal => p !== null && isYieldProposal(network, p.description, p.kind))
    .reverse()
    .slice(0, SHOWN);
}

/** Supplied balances of a DAO on Rhea Lend at the final block, for My Agents' Farming / Idle. Null when unread or off. */
export async function readYieldPositions(dao: string, network: Network): Promise<YieldPosition[] | null> {
  const list = YIELD_ALLOWLIST[network];
  if (list === null) return null;
  const rpc = createRpc({ url: DEFAULT_RPC_URLS[network] });
  const got = await read(async () => readPositions(rpc, list.lend, dao, (await rpc.block()).height, list.tokens.map((t) => t.token_id)));
  return got?.positions ?? null;
}

/** Throws what scanVault throws (a KdError: not a DAO, RPC down). The extra reads never fail the page. */
export async function readYield(dao: string, network: Network): Promise<YieldLive> {
  const report = await scanVault(dao, { network });
  const rpc = createRpc({ url: DEFAULT_RPC_URLS[network] });
  const height = report.chain.block_height;
  const list = YIELD_ALLOWLIST[network];
  const tokens = list?.tokens.map((t) => t.token_id) ?? [];
  const [policy, registered, lend, proposals] = await Promise.all([
    read(async () => parsePolicy(await rpc.callFunction(dao, height, "get_policy", {}))),
    list === null ? null : read(async () => (await rpc.callFunction(list.lend, height, "storage_balance_of", { account_id: dao })) !== null),
    list === null ? null : read(() => readPositions(rpc, list.lend, dao, height, tokens)),
    read(() => readProposals(rpc, dao, height, network)),
  ]);
  return { report, policy, registered, positions: lend?.positions ?? null, pools: lend?.pools ?? null, proposals };
}

/** Yield DAOs this browser opened, newest first. Storage can be blocked: then the list is empty. */
const SEEN_KEY = "kd.yield.daos";
const SEEN_MAX = 10;

export function seenYieldDaos(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string").slice(0, SEEN_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberYieldDao(dao: string): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([dao, ...seenYieldDaos().filter((d) => d !== dao)].slice(0, SEEN_MAX)));
  } catch {
    // storage blocked: My Agents just will not list it
  }
}
