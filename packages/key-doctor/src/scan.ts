import type { Flag, KdReport, KeyInfo, Member, ReportSummary, ScanOptions, Status } from "./types.ts";
import { toIsoSeconds } from "./age.ts";
import { fail, isKdError } from "./errors.ts";
import {
  AGE_LIMITATION,
  RECEIVERS_UNCHECKED_LIMITATION,
  missingMemberLimitation,
  type MemberErrorCode,
} from "./messages.ts";
import { accountKind, parsePolicy, resolveTarget, toKeyInfo, type RawKey } from "./parse.ts";
import { createRpc, DEFAULT_RPC_URL, type Rpc } from "./rpc.ts";
import { countKeys, isPqReady } from "./rules/account.ts";
import { analyzePolicy } from "./rules/dao.ts";
import { daoLevelFlags, evaluateKeys } from "./rules/index.ts";
import {
  ACCOUNT_ID_MAX_LEN,
  CONCURRENCY_DEFAULT,
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  MAX_GROUP_ENTRIES,
  MAX_KEYS,
  MAX_MEMBERS,
  MAX_ROLES,
  REQUEST_BUDGET,
  RULESET_VERSION,
  SEVERITY_RANK,
} from "./rules/thresholds.ts";

export interface MemberInput {
  account_id: string;
  account_kind: Member["account_kind"];
  roles: string[];
  keys: KeyInfo[];
  error: string | null;
  /** Set for DAO council members. */
  dao?: { daoId: string; admin: boolean };
}

const worst = (statuses: Status[]): Status =>
  statuses.reduce<Status>((acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc), "ok");

/** Every member, account or DAO council, goes through this pure function. */
export function buildMember(input: MemberInput): Member {
  const skipRules = input.error !== null || input.account_kind === "missing";
  const { flags, keys } = skipRules
    ? { flags: [] as Flag[], keys: input.keys }
    : evaluateKeys(input.account_id, input.keys, input.dao);
  const c = countKeys(keys);
  const status: Status = skipRules ? "note" : worst(flags.map((f) => f.severity));
  return {
    account_id: input.account_id,
    account_kind: input.account_kind,
    roles: input.roles,
    status,
    pq_ready: isPqReady(c),
    counts: { full_access: c.fullAccess, function_call: c.functionCall, ml_dsa: c.nMl, unused: c.unused },
    keys,
    flags,
    error: input.error,
  };
}

export function buildSummary(members: Member[], daoFlags: Flag[], councilSize: number): ReportSummary {
  const read = members.filter((m) => m.error === null);
  return {
    status: worst([...members.map((m) => m.status), ...daoFlags.map((f) => f.severity)]),
    council_size: councilSize,
    members_scanned: read.length,
    members_high: read.filter((m) => m.status === "high").length,
    members_cleanup: read.filter((m) => m.status === "cleanup").length,
    members_ok: read.filter((m) => m.status === "ok" || m.status === "note").length,
    pq_ready: read.filter((m) => m.pq_ready).length,
    keys_total: read.reduce((n, m) => n + m.keys.length, 0),
    keys_full_access: read.reduce((n, m) => n + m.counts.full_access, 0),
    keys_unused: read.reduce((n, m) => n + m.counts.unused, 0),
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function clampConcurrency(c: number | undefined): number {
  if (c === undefined || !Number.isFinite(c)) return CONCURRENCY_DEFAULT;
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.floor(c)));
}

const codeOf = (e: unknown): string => (isKdError(e) ? e.kd.code : "RPC_ERROR");

interface ReceiverResult {
  exists: Map<string, boolean | null>;
  errors: string[];
  skipped: boolean;
}

/** Checks each distinct receiver once, in code-unit order, within `slots` requests. */
async function checkReceivers(
  rpc: Rpc,
  keys: KeyInfo[],
  blockId: number,
  slots: number,
  skipAll: boolean,
  concurrency: number,
  daoId?: string,
): Promise<ReceiverResult> {
  const ids = new Set<string>();
  for (const k of keys) if (k.permission.type === "function_call") ids.add(k.permission.receiver_id);
  const result: ReceiverResult = { exists: new Map(), errors: [], skipped: false };
  const toCheck: string[] = [];
  for (const id of [...ids].sort()) {
    if (id === daoId) result.exists.set(id, true);
    else if (skipAll || toCheck.length >= slots || accountKind(id) === null) {
      result.exists.set(id, null);
      result.skipped = true;
    } else toCheck.push(id);
  }
  const codes = await pool(toCheck, concurrency, async (id) => {
    try {
      await rpc.viewAccount(id, blockId);
      return null;
    } catch (e) {
      return codeOf(e);
    }
  });
  toCheck.forEach((id, i) => {
    const code = codes[i] ?? null;
    result.exists.set(id, code === null ? true : code === "NOT_FOUND" ? false : null);
    if (code !== null && code !== "NOT_FOUND") result.errors.push(`receiver ${id}: ${code}`);
  });
  return result;
}

const withReceivers = (keys: KeyInfo[], exists: Map<string, boolean | null>): KeyInfo[] =>
  keys.map((k) =>
    k.permission.type === "function_call" ? { ...k, receiver_exists: exists.get(k.permission.receiver_id) ?? null } : k,
  );

const nowIso = () => toIsoSeconds(Date.now());

export async function scanAccount(id: string, opts: ScanOptions = {}): Promise<KdReport> {
  const target = resolveTarget(id, opts);
  const rpc = createRpc({ url: opts.rpcUrl ?? DEFAULT_RPC_URL[target.network] });

  const head = await rpc.block(opts.blockHeight);
  const rawKeys = await rpc.viewAccessKeyList(target.id, head.height);
  if (rawKeys.length > MAX_KEYS) throw fail("LIMIT_EXCEEDED", { variant: "keys" });
  // A missing account can answer with an empty list, so confirm it exists.
  if (rawKeys.length === 0) await rpc.viewAccount(target.id, head.height);

  const keys = rawKeys.map((k) => toKeyInfo(k, target.network, head));
  // block, key list and the empty-list follow-up are already spent.
  const used = 2 + (rawKeys.length === 0 ? 1 : 0);
  const receivers = await checkReceivers(
    rpc,
    keys,
    head.height,
    REQUEST_BUDGET - used,
    opts.skipReceiverCheck === true,
    clampConcurrency(opts.concurrency),
  );
  const member = buildMember({
    account_id: target.id,
    account_kind: target.kind,
    roles: [],
    keys: withReceivers(keys, receivers.exists),
    error: null,
  });

  return {
    schema_version: "kd.report.v1",
    ruleset_version: RULESET_VERSION,
    generated_at: nowIso(),
    chain: { network: target.network, block_height: head.height, block_timestamp: toIsoSeconds(head.timestampMs) },
    target: { type: "account", id: target.id },
    summary: buildSummary([member], [], 0),
    members: [member],
    dao_flags: [],
    errors: receivers.errors,
    limitations: receivers.skipped ? [AGE_LIMITATION, RECEIVERS_UNCHECKED_LIMITATION] : [AGE_LIMITATION],
  };
}

type MemberRead =
  | { state: "ok"; keys: RawKey[] }
  | { state: "missing" }
  | { state: "error"; code: MemberErrorCode };

/** Chain ids are not echoed raw: printable ASCII only, cut to the id length cap. */
const safeId = (s: string): string => s.replace(/[^\x21-\x7e]/g, "?").slice(0, ACCOUNT_ID_MAX_LEN);

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function scanDao(id: string, opts: ScanOptions = {}): Promise<KdReport> {
  const target = resolveTarget(id, opts);
  const rpc = createRpc({ url: opts.rpcUrl ?? DEFAULT_RPC_URL[target.network] });
  const concurrency = clampConcurrency(opts.concurrency);

  const head = await rpc.block(opts.blockHeight);
  const policy = parsePolicy(await rpc.callFunction(target.id, head.height, "get_policy", {}));
  if (policy === null) throw fail("NOT_A_DAO");
  let used = 2;

  if (policy.roles.length > MAX_ROLES) throw fail("LIMIT_EXCEEDED", { variant: "roles" });
  const groupEntries = policy.roles.reduce((n, r) => n + (r.kind === "group" ? r.members.length : 0), 0);
  if (groupEntries > MAX_GROUP_ENTRIES) throw fail("LIMIT_EXCEEDED", { variant: "roles" });
  const analysis = analyzePolicy(policy);
  if (analysis.council.length > MAX_MEMBERS) throw fail("LIMIT_EXCEEDED", { variant: "members" });

  const reads = await pool(analysis.council, concurrency, async (memberId): Promise<MemberRead> => {
    if (accountKind(memberId) === null) return { state: "error", code: "INVALID_ACCOUNT_ID" };
    try {
      used += 1;
      const keys = await rpc.viewAccessKeyList(memberId, head.height);
      if (keys.length > MAX_KEYS) return { state: "error", code: "LIMIT_EXCEEDED" };
      if (keys.length === 0) {
        used += 1;
        await rpc.viewAccount(memberId, head.height);
      }
      return { state: "ok", keys };
    } catch (e) {
      const code = codeOf(e);
      if (code === "NOT_FOUND") return { state: "missing" };
      return { state: "error", code: code === "RATE_LIMITED" ? "RATE_LIMITED" : "RPC_ERROR" };
    }
  });

  const drafts = analysis.council.map((memberId, i) => {
    const read = reads[i] as MemberRead;
    const keys = read.state === "ok" ? read.keys.map((k) => toKeyInfo(k, target.network, head)) : [];
    return { memberId, read, keys };
  });

  const receivers = await checkReceivers(
    rpc,
    drafts.flatMap((d) => d.keys),
    head.height,
    REQUEST_BUDGET - used,
    opts.skipReceiverCheck === true,
    concurrency,
    target.id,
  );

  const members: Member[] = drafts.map(({ memberId, read, keys }) =>
    buildMember({
      account_id: read.state === "error" && read.code === "INVALID_ACCOUNT_ID" ? safeId(memberId) : memberId,
      account_kind:
        read.state === "missing" ? "missing" : (accountKind(memberId) ?? "named"),
      roles: analysis.memberRoles.get(memberId) ?? [],
      keys: withReceivers(keys, receivers.exists),
      error: read.state === "error" ? read.code : null,
      dao: { daoId: target.id, admin: analysis.adminMembers.has(memberId) },
    }),
  );

  members.sort((a, b) => {
    const ea = a.error !== null;
    const eb = b.error !== null;
    if (ea !== eb) return ea ? 1 : -1;
    return SEVERITY_RANK[b.status] - SEVERITY_RANK[a.status] || byCodeUnit(a.account_id, b.account_id);
  });

  const daoFlags = daoLevelFlags(analysis.council.length);
  const memberErrors = members.filter((m) => m.error !== null).map((m) => `member ${m.account_id}: ${m.error}`);
  const missing = members.filter((m) => m.account_kind === "missing").map((m) => missingMemberLimitation(m.account_id));

  return {
    schema_version: "kd.report.v1",
    ruleset_version: RULESET_VERSION,
    generated_at: nowIso(),
    chain: { network: target.network, block_height: head.height, block_timestamp: toIsoSeconds(head.timestampMs) },
    target: { type: "dao", id: target.id },
    dao: {
      roles: analysis.roles,
      transfer_vote_policy: analysis.transferVotePolicy,
      proposal_bond_yocto: analysis.proposalBond,
    },
    summary: buildSummary(members, daoFlags, analysis.council.length),
    members,
    dao_flags: daoFlags,
    errors: [...memberErrors, ...receivers.errors],
    limitations: [
      AGE_LIMITATION,
      ...analysis.limitations,
      ...missing,
      ...(receivers.skipped ? [RECEIVERS_UNCHECKED_LIMITATION] : []),
    ],
  };
}
