import type { Flag, KdReport, KeyInfo, Member, ReportSummary, ScanOptions, Status } from "./types.ts";
import { toIsoSeconds } from "./age.ts";
import { fail } from "./errors.ts";
import { AGE_LIMITATION } from "./messages.ts";
import { resolveTarget, toKeyInfo } from "./parse.ts";
import { createRpc, DEFAULT_RPC_URL } from "./rpc.ts";
import { countKeys } from "./rules/account.ts";
import { evaluateKeys } from "./rules/index.ts";
import { MAX_KEYS, RULESET_VERSION, SEVERITY_RANK } from "./rules/thresholds.ts";

export interface MemberInput {
  account_id: string;
  account_kind: Member["account_kind"];
  roles: string[];
  keys: KeyInfo[];
  error: string | null;
}

const worst = (statuses: Status[]): Status =>
  statuses.reduce<Status>((acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc), "ok");

/** Every member, account or DAO council, goes through this pure function. */
export function buildMember(input: MemberInput): Member {
  const skipRules = input.error !== null || input.account_kind === "missing";
  const { flags, keys } = skipRules ? { flags: [] as Flag[], keys: input.keys } : evaluateKeys(input.account_id, input.keys);
  const c = countKeys(keys);
  let status: Status = worst(flags.map((f) => f.severity));
  if (skipRules) status = "note";
  return {
    account_id: input.account_id,
    account_kind: input.account_kind,
    roles: input.roles,
    status,
    pq_ready: c.nMl >= 1 && c.nEd === 0,
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

export async function scanAccount(id: string, opts: ScanOptions = {}): Promise<KdReport> {
  const target = resolveTarget(id, opts);
  const rpc = createRpc({ url: opts.rpcUrl ?? DEFAULT_RPC_URL[target.network] });

  const head = await rpc.block(opts.blockHeight);
  const rawKeys = await rpc.viewAccessKeyList(target.id, head.height);
  if (rawKeys.length > MAX_KEYS) throw fail("LIMIT_EXCEEDED", { variant: "keys" });
  // A missing account can answer with an empty list, so confirm it exists.
  if (rawKeys.length === 0) await rpc.viewAccount(target.id, head.height);

  const member = buildMember({
    account_id: target.id,
    account_kind: target.kind,
    roles: [],
    keys: rawKeys.map((k) => toKeyInfo(k, target.network, head)),
    error: null,
  });

  return {
    schema_version: "kd.report.v1",
    ruleset_version: RULESET_VERSION,
    generated_at: toIsoSeconds(Date.now()),
    chain: { network: target.network, block_height: head.height, block_timestamp: toIsoSeconds(head.timestampMs) },
    target: { type: "account", id: target.id },
    summary: buildSummary([member], [], 0),
    members: [member],
    dao_flags: [],
    errors: [],
    limitations: [AGE_LIMITATION],
  };
}
