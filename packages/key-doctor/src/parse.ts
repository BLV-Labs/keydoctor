import type { KeyInfo, KeyPermission, Network, ScanOptions } from "./types.ts";
import { estimateAge, type HeadBlock } from "./age.ts";
import { fail } from "./errors.ts";
import { ACCOUNT_ID_MAX_LEN, ACCOUNT_ID_MIN_LEN } from "./rules/thresholds.ts";

export type AccountKind = "named" | "implicit" | "eth_implicit";

export interface RawKey {
  publicKey: string;
  nonce: string;
  permission: KeyPermission;
}

const NAMED_ID = new RegExp(
  `^(?=.{${ACCOUNT_ID_MIN_LEN},${ACCOUNT_ID_MAX_LEN}}$)(([a-z\\d]+[-_])*[a-z\\d]+\\.)*([a-z\\d]+[-_])*[a-z\\d]+$`,
);
const IMPLICIT_ID = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT_ID = /^0x[0-9a-f]{40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Strict (no trimming, no lowercasing): chain data must already be canonical. */
export function accountKind(id: string): AccountKind | null {
  if (ETH_IMPLICIT_ID.test(id)) return "eth_implicit";
  if (IMPLICIT_ID.test(id)) return "implicit";
  return NAMED_ID.test(id) ? "named" : null;
}

export function resolveTarget(
  id: string,
  opts: Pick<ScanOptions, "network" | "blockHeight"> = {},
): { id: string; network: Network; kind: AccountKind } {
  const normalized = typeof id === "string" ? id.trim().toLowerCase() : "";
  const kind = accountKind(normalized);
  if (kind === null) throw fail("INVALID_TARGET");
  if (kind === "eth_implicit") throw fail("INVALID_TARGET", { variant: "eth_implicit" });

  const suffixNetwork: Network | null = normalized.endsWith(".testnet")
    ? "testnet"
    : normalized.endsWith(".near")
      ? "mainnet"
      : null;
  if (suffixNetwork !== null && opts.network !== undefined && opts.network !== suffixNetwork) {
    throw fail("INVALID_TARGET", { variant: "network_conflict" });
  }
  const network = suffixNetwork ?? opts.network ?? "testnet";

  if (opts.blockHeight !== undefined && !(Number.isSafeInteger(opts.blockHeight) && opts.blockHeight >= 1)) {
    throw fail("INVALID_TARGET", { variant: "block_height" });
  }
  return { id: normalized, network, kind };
}

function parsePermission(raw: unknown): KeyPermission | null {
  if (raw === "FullAccess") return { type: "full_access" };
  if (!isRecord(raw) || !isRecord(raw.FunctionCall)) return null;
  const fc = raw.FunctionCall;
  const { allowance, receiver_id, method_names } = fc;
  if (typeof receiver_id !== "string") return null;
  if (!Array.isArray(method_names) || !method_names.every((m) => typeof m === "string")) return null;
  if (allowance !== null && allowance !== undefined && typeof allowance !== "string") return null;
  return {
    type: "function_call",
    receiver_id,
    method_names: method_names as string[],
    allowance_yocto: allowance ?? null,
  };
}

/** Returns null for any shape we do not understand; the caller maps that to RPC_ERROR. */
export function parseRawKey(raw: unknown): RawKey | null {
  if (!isRecord(raw) || typeof raw.public_key !== "string" || !isRecord(raw.access_key)) return null;
  const { nonce, permission } = raw.access_key;
  let nonceStr: string;
  if (typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0) nonceStr = String(nonce);
  else if (typeof nonce === "string" && /^\d+$/.test(nonce)) nonceStr = nonce;
  else return null;
  const perm = parsePermission(permission);
  return perm === null ? null : { publicKey: raw.public_key, nonce: nonceStr, permission: perm };
}

function curveOf(publicKey: string): KeyInfo["curve"] {
  if (publicKey.startsWith("ed25519:")) return "ed25519";
  // Placeholder prefix, see fixtures/README.md.
  if (publicKey.startsWith("mldsa65:")) return "ml_dsa";
  return "unknown";
}

export function toKeyInfo(raw: RawKey, network: Network, head: HeadBlock): KeyInfo {
  const age = estimateAge(raw.nonce, network, head);
  return {
    public_key: raw.publicKey,
    curve: curveOf(raw.publicKey),
    permission: raw.permission,
    nonce: raw.nonce,
    use_count: age.use_count,
    created: age.created,
    age_days: age.age_days,
    flag_ids: [],
  };
}

export type Threshold = { kind: "weight"; value: bigint } | { kind: "ratio"; n: bigint; d: bigint };

export interface VotePolicy {
  weightKind: string;
  quorum: bigint;
  /** Verbatim from get_policy, for `transfer_vote_policy`. */
  rawThreshold: unknown;
  threshold: Threshold;
}

export interface PolicyRole {
  name: string;
  kind: "everyone" | "group" | "member";
  members: string[];
  permissions: string[];
  votePolicy: Record<string, VotePolicy>;
}

export interface Policy {
  roles: PolicyRole[];
  defaultVotePolicy: VotePolicy;
  proposalBond: string;
}

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

function parseVotePolicy(raw: unknown): VotePolicy | null {
  if (!isRecord(raw) || typeof raw.weight_kind !== "string") return null;
  const q = raw.quorum;
  const quorum = isDigits(q) ? BigInt(q) : typeof q === "number" && Number.isSafeInteger(q) && q >= 0 ? BigInt(q) : null;
  if (quorum === null) return null;
  const t = raw.threshold;
  let threshold: Threshold;
  if (isDigits(t)) threshold = { kind: "weight", value: BigInt(t) };
  else if (
    Array.isArray(t) &&
    t.length === 2 &&
    t.every((x) => Number.isSafeInteger(x) && x >= 0) &&
    (t[1] as number) > 0
  ) {
    threshold = { kind: "ratio", n: BigInt(t[0] as number), d: BigInt(t[1] as number) };
  } else return null;
  return { weightKind: raw.weight_kind, quorum, rawThreshold: t, threshold };
}

function parseRole(raw: unknown): PolicyRole | null {
  if (!isRecord(raw) || typeof raw.name !== "string") return null;
  if (!Array.isArray(raw.permissions) || !raw.permissions.every((p) => typeof p === "string")) return null;
  let kind: PolicyRole["kind"];
  let members: string[] = [];
  const k = raw.kind;
  if (k === "Everyone") kind = "everyone";
  else if (isRecord(k) && Array.isArray(k.Group) && k.Group.every((m) => typeof m === "string")) {
    kind = "group";
    members = k.Group as string[];
  } else if (isRecord(k) && "Member" in k) kind = "member";
  else return null;
  const votePolicy: Record<string, VotePolicy> = {};
  if (raw.vote_policy !== undefined) {
    if (!isRecord(raw.vote_policy)) return null;
    for (const [label, v] of Object.entries(raw.vote_policy)) {
      const vp = parseVotePolicy(v);
      if (vp === null) return null;
      votePolicy[label] = vp;
    }
  }
  return { name: raw.name, kind, members, permissions: raw.permissions as string[], votePolicy };
}

/** Returns null for anything that is not a Sputnik v2 policy; the caller maps that to NOT_A_DAO. */
export function parsePolicy(raw: unknown): Policy | null {
  if (!isRecord(raw) || !Array.isArray(raw.roles) || !isDigits(raw.proposal_bond)) return null;
  const defaultVotePolicy = parseVotePolicy(raw.default_vote_policy);
  if (defaultVotePolicy === null) return null;
  const roles: PolicyRole[] = [];
  for (const r of raw.roles) {
    const role = parseRole(r);
    if (role === null) return null;
    roles.push(role);
  }
  return { roles, defaultVotePolicy, proposalBond: raw.proposal_bond };
}
