// checkProposals (§4.5, §5.2, UC6). Reads RPC only: it never stores or sends anything.
import type {
  AlertKind,
  CheckProposalsOptions,
  CheckProposalsResult,
  KdAlert,
  ListProposalsOptions,
  ListProposalsResult,
  Network,
  ProposalInfo,
  ProposalWatchState,
  Vote,
} from "./types.ts";
import type { HeadBlock } from "./age.ts";
import { toIsoSeconds } from "./age.ts";
import { fail, isKdError } from "./errors.ts";
import { ACTION_TEXT, formatNear, proposalAlertText, roleLabel, voterAlertText, type AlertText } from "./messages.ts";
import { accountKind, isDigits, isRecord, parsePolicy, resolveTarget, type Policy } from "./parse.ts";
import { createRpc, DEFAULT_RPC_URLS, type Rpc } from "./rpc.ts";
import { approvalsNeeded, permits } from "./rules/dao.ts";
import {
  BLOCK_TIME_MS,
  DESCRIPTION_MAX_LEN,
  MAX_PROPOSALS_PER_CHECK,
  MAX_VOTER_SCANS_PER_CHECK,
  NEW_KEY_WINDOW_HOURS,
  PROPOSAL_LIST_DEFAULT,
  PROPOSAL_LIST_MAX,
} from "./rules/thresholds.ts";
import { scanAccount } from "./scan.ts";

// Sputnik v2 ProposalKind variant → policy label (`ProposalKind::to_policy_label`).
const KIND_LABEL: Record<string, string> = {
  ChangeConfig: "config",
  ChangePolicy: "policy",
  AddMemberToRole: "add_member_to_role",
  RemoveMemberFromRole: "remove_member_from_role",
  FunctionCall: "call",
  UpgradeSelf: "upgrade_self",
  UpgradeRemote: "upgrade_remote",
  Transfer: "transfer",
  SetStakingContract: "set_vote_token",
  AddBounty: "add_bounty",
  BountyDone: "bounty_done",
  Vote: "vote",
  FactoryInfoUpdate: "factory_info_update",
  ChangePolicyAddOrUpdateRole: "policy_add_or_update_role",
  ChangePolicyRemoveRole: "policy_remove_role",
  ChangePolicyUpdateDefaultVotePolicy: "policy_update_default_vote_policy",
  ChangePolicyUpdateParameters: "policy_update_parameters",
};

type Group = "money" | "governance" | "upgrade";

/** Labels outside these three groups are ignored (UC6 step 3). */
export function groupOf(label: string): Group | null {
  if (label === "transfer" || label === "call") return "money";
  if (label === "add_member_to_role" || label === "remove_member_from_role" || label === "config") return "governance";
  if (label === "policy" || label.startsWith("policy_")) return "governance";
  if (label === "upgrade_self" || label === "upgrade_remote") return "upgrade";
  return null;
}

const VOTES = new Set<string>(["Approve", "Reject", "Remove"]);
const METHOD_NAME = /^[A-Za-z0-9_]{1,64}$/;

interface Proposal {
  id: number;
  label: string;
  variant: string;
  body: Record<string, unknown>;
  description: string;
  proposer: string;
  status: string;
  votes: Record<string, Vote>;
}

/** Null for anything that is not a Sputnik v2 proposal. */
export function parseProposal(raw: unknown): Proposal | null {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.id) || typeof raw.proposer !== "string") return null;
  if (typeof raw.description !== "string" || typeof raw.status !== "string" || !isRecord(raw.votes)) return null;
  let variant: string;
  let body: Record<string, unknown> = {};
  if (typeof raw.kind === "string") variant = raw.kind;
  else if (isRecord(raw.kind) && Object.keys(raw.kind).length === 1) {
    variant = Object.keys(raw.kind)[0] as string;
    const inner = raw.kind[variant];
    if (isRecord(inner)) body = inner;
  } else return null;
  const label = KIND_LABEL[variant];
  if (label === undefined) return null;
  const votes: Record<string, Vote> = {};
  for (const [who, v] of Object.entries(raw.votes)) {
    if (typeof v !== "string" || !VOTES.has(v)) return null;
    votes[who] = v as Vote;
  }
  return {
    id: raw.id as number,
    label,
    variant,
    body,
    // Sputnik UIs append "$$$$<link>" to the description.
    description: (raw.description.split("$$$$")[0] ?? "").slice(0, DESCRIPTION_MAX_LEN),
    proposer: raw.proposer,
    status: raw.status,
    votes,
  };
}

/** Chain ids go into message text only when they pass the account-id check. */
const safeId = (id: unknown): string => (typeof id === "string" && accountKind(id) !== null ? id : "?");
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function actionText(p: Proposal): { vi: string; en: string } {
  const b = p.body;
  switch (p.label) {
    case "transfer": {
      const amount = str(b.amount);
      const to = safeId(b.receiver_id);
      const token = str(b.token_id);
      if (token === "") return ACTION_TEXT.transferNear(formatNear(amount), to);
      return ACTION_TEXT.transferToken(isDigits(amount) ? amount : "?", safeId(token), to);
    }
    case "call": {
      const actions = Array.isArray(b.actions) ? b.actions : [];
      const names = actions.map((a) => (isRecord(a) && typeof a.method_name === "string" && METHOD_NAME.test(a.method_name) ? a.method_name : "?"));
      const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
      return ACTION_TEXT.call(shown || "?", safeId(b.receiver_id));
    }
    case "add_member_to_role":
      return ACTION_TEXT.addMember(safeId(b.member_id), roleLabel(str(b.role), 0));
    case "remove_member_from_role":
      return ACTION_TEXT.removeMember(safeId(b.member_id), roleLabel(str(b.role), 0));
    case "config":
      return ACTION_TEXT.config();
    case "upgrade_self":
      return ACTION_TEXT.upgradeSelf();
    case "upgrade_remote":
      return ACTION_TEXT.upgradeRemote(safeId(b.receiver_id));
    default:
      return ACTION_TEXT.policy();
  }
}

/** The group role that can approve this label and is closest to passing it; ties go to policy order. */
export function tally(policy: Policy, p: Proposal): Pick<ProposalInfo, "approvals_needed" | "approvals_have" | "pending_voters"> {
  const approves = Object.entries(p.votes).filter(([, v]) => v === "Approve").map(([who]) => who);
  let best: { needed: number; have: number; pending: string[] } | null = null;
  for (const role of policy.roles) {
    if (role.kind !== "group" || !permits(role, p.label, "VoteApprove")) continue;
    const needed = approvalsNeeded(policy, role, p.label);
    if (needed === null) continue;
    const members = [...new Set(role.members)];
    const have = members.filter((m) => approves.includes(m)).length;
    const pending = members.filter((m) => !(m in p.votes));
    if (best === null || needed - have < best.needed - best.have) best = { needed, have, pending };
  }
  if (best === null) return { approvals_needed: null, approvals_have: approves.length, pending_voters: [] };
  return { approvals_needed: best.needed, approvals_have: best.have, pending_voters: best.pending };
}

function proposalInfo(p: Proposal, policy: Policy, dao: string, template: string | undefined): ProposalInfo {
  const b = p.body;
  return {
    id: p.id,
    kind_label: p.label,
    description: p.description,
    proposer: p.proposer,
    ...(p.label === "transfer" && {
      transfer: { token_id: str(b.token_id), receiver_id: str(b.receiver_id), amount: str(b.amount) },
    }),
    status: p.status,
    votes: { ...p.votes },
    ...tally(policy, p),
    executed: p.status === "Approved",
    ui_url: template ? template.replaceAll("{dao}", dao).replaceAll("{id}", String(p.id)) : null,
  };
}

const alertId = (network: Network, dao: string, kind: AlertKind, proposalId: number, account: string) =>
  `${network}:${dao}:${kind}:${proposalId}:${account}`;

function alert(
  base: { network: Network; dao: string; createdAt: string },
  kind: AlertKind,
  info: ProposalInfo,
  account: string,
  messages: AlertText,
  evidence?: Evidence,
): KdAlert {
  return {
    schema_version: "kd.alert.v1",
    alert_id: alertId(base.network, base.dao, kind, info.id, account),
    created_at: base.createdAt,
    network: base.network,
    target: base.dao,
    severity: "high",
    kind,
    after_the_fact: info.status !== "InProgress",
    proposal: info,
    ...(evidence && { evidence }),
    messages,
  };
}

type Evidence = NonNullable<KdAlert["evidence"]>;

const codeOf = (e: unknown): string => (isKdError(e) ? e.kd.code : "RPC_ERROR");

/** Newest full-access key added within the window before `head`, or null. */
async function newFullAccessKey(
  voter: string,
  head: HeadBlock,
  opts: { network: Network; rpcUrl?: string | readonly string[]; windowHours: number },
): Promise<Evidence | null> {
  const report = await scanAccount(voter, {
    network: opts.network,
    ...(opts.rpcUrl !== undefined && { rpcUrl: opts.rpcUrl }),
    blockHeight: head.height,
    skipReceiverCheck: true,
  });
  const windowBlocks = (opts.windowHours * 3_600_000) / BLOCK_TIME_MS;
  let newest: Evidence | null = null;
  for (const k of report.members[0]?.keys ?? []) {
    const block = k.created.block_height;
    if (k.permission.type !== "full_access" || block === null || head.height - block > windowBlocks) continue;
    if (newest !== null && block <= newest.key_added_block) continue;
    newest = {
      account_id: voter,
      public_key: k.public_key,
      key_added_block: block,
      key_added_at_est: k.created.at ?? toIsoSeconds(head.timestampMs - (head.height - block) * BLOCK_TIME_MS),
      hours_before_vote_seen: Math.floor(((head.height - block) * BLOCK_TIME_MS) / 3_600_000),
    };
  }
  return newest;
}

function parseLastId(raw: unknown): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (isDigits(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  throw fail("RPC_ERROR", { retryable: false });
}

/**
 * Sputnik v2 `get_last_proposal_id` is the proposal count: ids run 0 .. last-1.
 * `prev = null` records that count and returns no alerts (§4.5 rule 2).
 * Throws when the block, `get_policy` or `get_last_proposal_id` cannot be read; per-proposal and per-voter
 * failures go into `errors` and are retried on the next call.
 */
export async function checkProposals(
  daoId: string,
  prev: ProposalWatchState | null,
  opts: CheckProposalsOptions = {},
): Promise<CheckProposalsResult> {
  const target = resolveTarget(daoId, opts);
  const dao = target.id;
  const network = target.network;
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URLS[network];
  const rpc: Rpc = createRpc({ url: rpcUrl });
  const windowHours = opts.newKeyWindowHours ?? NEW_KEY_WINDOW_HOURS;

  const head = await rpc.block();
  const last = parseLastId(await rpc.callFunction(dao, head.height, "get_last_proposal_id", {}));
  if (prev === null) return { alerts: [], state: { last_proposal_id: last, pending: {} }, errors: [] };

  const policy = parsePolicy(await rpc.callFunction(dao, head.height, "get_policy", {}));
  if (policy === null) throw fail("NOT_A_DAO");

  const createdAt = toIsoSeconds(Date.now());
  const base = { network, dao, createdAt };
  const errors: string[] = [];
  const alerts: KdAlert[] = [];
  const pending: ProposalWatchState["pending"] = {};

  // Pending first (votes are what we watch), then new ids in order; the rest wait for the next call.
  const pendingIds = Object.keys(prev.pending)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n >= 0 && n < last)
    .sort((a, b) => a - b);
  const start = Math.min(prev.last_proposal_id, last);
  const newIds: number[] = [];
  // An id can be pending and above `start` when an earlier transport error held `last_proposal_id` back.
  for (let id = start; id < last; id++) if (!(String(id) in prev.pending)) newIds.push(id);
  // New ids get at least half of the reads, so many open proposals cannot starve new ones. Pending ids
  // rotate from an offset that moves with the block, so every pending proposal is read in turn.
  const newBudget = Math.min(newIds.length, Math.max(MAX_PROPOSALS_PER_CHECK / 2, MAX_PROPOSALS_PER_CHECK - pendingIds.length));
  const newRead = newIds.slice(0, newBudget);
  const offset = pendingIds.length === 0 ? 0 : head.height % pendingIds.length;
  const rotated = [...pendingIds.slice(offset), ...pendingIds.slice(0, offset)];
  const pendingRead = rotated.slice(0, MAX_PROPOSALS_PER_CHECK - newBudget);
  for (const id of rotated.slice(MAX_PROPOSALS_PER_CHECK - newBudget)) pending[String(id)] = prev.pending[String(id)]!;

  // Resume from the first new id not read this time (pending ids are tracked on their own).
  let nextLast = newRead.length < newIds.length ? (newIds[newRead.length] as number) : last;
  let scans = 0;
  const scanned = new Map<string, Evidence | null>();

  const fresh = new Set(newRead);
  for (const id of [...pendingRead, ...newRead]) {
    const isNew = fresh.has(id);
    const seen = prev.pending[String(id)];
    let p: Proposal | null;
    try {
      p = parseProposal(await rpc.callFunction(dao, head.height, "get_proposal", { id }));
      if (p === null || p.id !== id) throw fail("RPC_ERROR", { retryable: false });
    } catch (e) {
      const code = codeOf(e);
      errors.push(`proposal ${id}: ${code}`);
      // Sputnik deletes a removed proposal, so get_proposal fails in the contract (NOT_A_DAO here) for good:
      // drop it and move on. Only a transport error (RPC_ERROR, RATE_LIMITED) is retried on the next call.
      if (code === "NOT_A_DAO") continue;
      if (seen !== undefined) pending[String(id)] = seen;
      if (isNew) nextLast = Math.min(nextLast, id);
      continue;
    }

    const group = groupOf(p.label);
    if (group === null) continue;
    const info = proposalInfo(p, policy, dao, opts.proposalUiUrlTemplate);
    const action = actionText(p);
    const afterTheFact = p.status !== "InProgress";

    if (isNew && group !== "money") {
      const kind: AlertKind = group === "governance" ? "governance_change_proposal" : "code_upgrade_proposal";
      alerts.push(
        alert(base, kind, info, "-", proposalAlertText(group, dao, id, action, safeId(p.proposer), afterTheFact)),
      );
    }

    // Votes not in votes_seen. A voter whose scan failed or was deferred stays unseen, so the next call retries.
    const votesSeen: Record<string, Vote> = { ...(seen?.votes_seen ?? {}) };
    let unseen = 0;
    for (const [voter, vote] of Object.entries(p.votes)) {
      if (seen?.votes_seen[voter] === vote) continue;
      if (accountKind(voter) === null) {
        errors.push(`proposal ${id}: invalid voter id`);
        votesSeen[voter] = vote;
        continue;
      }
      let evidence = scanned.get(voter);
      if (evidence === undefined) {
        if (scans >= MAX_VOTER_SCANS_PER_CHECK) {
          unseen += 1;
          continue;
        }
        scans += 1;
        try {
          evidence = await newFullAccessKey(voter, head, { network, rpcUrl, windowHours });
        } catch (e) {
          errors.push(`voter ${voter}: ${codeOf(e)}`);
          unseen += 1;
          continue;
        }
        scanned.set(voter, evidence);
      }
      votesSeen[voter] = vote;
      if (evidence !== null) {
        alerts.push(
          alert(
            base,
            "voter_new_full_access_key",
            info,
            voter,
            voterAlertText(dao, id, action, voter, evidence.hours_before_vote_seen, afterTheFact),
            evidence,
          ),
        );
      }
    }

    if (unseen > 0) errors.push(`proposal ${id}: ${unseen} voter scan(s) deferred to the next call`);
    // A finished proposal leaves pending (§4.5 rule 4), unless some of its voters are still unscanned.
    if (p.status === "InProgress" || unseen > 0) {
      pending[String(id)] = { kind_label: p.label, votes_seen: votesSeen, first_seen_at: seen?.first_seen_at ?? createdAt };
    }
  }

  return { alerts, state: { last_proposal_id: nextLast, pending }, errors };
}

/**
 * The DAO's newest proposals, newest first, with the same tally as an alert (votes, who is still to vote).
 * Reads RPC only. Throws when the block, `get_policy` or `get_last_proposal_id` cannot be read; a proposal that
 * cannot be read or has a kind this tool does not know goes into `errors` and is left out.
 */
export async function listProposals(
  daoId: string,
  opts: ListProposalsOptions = {},
): Promise<ListProposalsResult> {
  const target = resolveTarget(daoId, opts);
  const dao = target.id;
  const rpc: Rpc = createRpc({ url: opts.rpcUrl ?? DEFAULT_RPC_URLS[target.network] });
  const limit = Math.max(1, Math.min(opts.limit ?? PROPOSAL_LIST_DEFAULT, PROPOSAL_LIST_MAX));

  const head = await rpc.block();
  const total = parseLastId(await rpc.callFunction(dao, head.height, "get_last_proposal_id", {}));
  const policy = parsePolicy(await rpc.callFunction(dao, head.height, "get_policy", {}));
  if (policy === null) throw fail("NOT_A_DAO");

  const proposals: ProposalInfo[] = [];
  const errors: string[] = [];
  for (let id = total - 1; id >= Math.max(0, total - limit); id--) {
    try {
      const p = parseProposal(await rpc.callFunction(dao, head.height, "get_proposal", { id }));
      if (p === null || p.id !== id) throw fail("RPC_ERROR", { retryable: false });
      proposals.push(proposalInfo(p, policy, dao, opts.proposalUiUrlTemplate));
    } catch (e) {
      errors.push(`proposal ${id}: ${codeOf(e)}`);
    }
  }
  return { proposals, total, errors };
}
