// The owner's two-signature flow of an Agent Budget (docs/final-idea.md §11.10.5), pure. Sign 1 adds a proposal;
// the id comes from that transaction's own return value, never from `get_last_proposal_id` (the last proposal may
// be an agent's request). The page reads the proposal back and compares it with what it built; only a match
// unlocks sign 2, `act_proposal(id, action, proposal)`. The installed Sputnik ignores `proposal`, so this
// read-back is the real protection against approving the wrong proposal.
import { nearToYocto, yoctoToNear } from "./format.ts";
import { GUARD_FORM_TEXT, isAccountId, KEEPER_ACCOUNT, MAX_AGENTS, MAX_LABEL_CHARS, MAX_WHITELIST } from "./guard-form.ts";
import { DCA_TESTNET } from "key-doctor";
import { guardChangeProposal, NEW_AGENT_DEPOSIT, type AddProposalArgs } from "./guard-proposals.ts";

export type BudgetFlowCode = "NO_PROPOSAL_ID" | "PROPOSAL_UNREADABLE" | "PROPOSAL_MISMATCH" | "PROPOSAL_NOT_OPEN";

export class BudgetFlowError extends Error {
  readonly code: BudgetFlowCode;
  constructor(code: BudgetFlowCode, message: string) {
    super(message);
    this.name = "BudgetFlowError";
    this.code = code;
  }
}

type Built = AddProposalArgs["proposal"];

export interface ConfirmedProposal {
  id: number;
  /** The proposal kind exactly as the chain returned it: the `proposal` argument of `act_proposal`. */
  kind: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with sorted keys, so two proposals with the same content compare equal whatever the key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * The proposal id `add_proposal` returned, from the final outcome of sign 1 (`status.SuccessValue` is the base64 of
 * the JSON number). A wallet that returns no outcome gives no id: the page then asks the owner to approve the
 * proposal from the pending list, where it shows with its own id.
 */
export function proposalIdFromOutcome(outcome: unknown): number {
  const first = Array.isArray(outcome) ? outcome[0] : outcome;
  const status = isRecord(first) && isRecord(first.status) ? first.status : null;
  const value = status?.SuccessValue;
  if (typeof value === "string" && value !== "") {
    try {
      const n: unknown = JSON.parse(atob(value));
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
    } catch {
      // falls through to the error below
    }
  }
  throw new BudgetFlowError("NO_PROPOSAL_ID", "The wallet did not return the new request's id. Find it under Needs you and approve it there.");
}

export function sameProposal(built: Built, onChain: unknown): boolean {
  return isRecord(onChain) && onChain.description === built.description && canonical(onChain.kind) === canonical(built.kind);
}

/** Reads proposal `id` back and checks it is open and is exactly `built`. Throws a BudgetFlowError otherwise. */
export async function confirmProposal(built: Built, id: number, read: (id: number) => Promise<unknown>): Promise<ConfirmedProposal> {
  let raw: unknown;
  try {
    raw = await read(id);
  } catch {
    throw new BudgetFlowError("PROPOSAL_UNREADABLE", `Could not read request ${id} back from the chain. Nothing was approved.`);
  }
  if (!isRecord(raw) || raw.id !== id) throw new BudgetFlowError("PROPOSAL_UNREADABLE", `Could not read request ${id} back from the chain. Nothing was approved.`);
  if (!sameProposal(built, raw)) {
    throw new BudgetFlowError("PROPOSAL_MISMATCH", `Request ${id} on the chain is not the one this page built. Nothing was approved.`);
  }
  if (raw.status !== "InProgress") throw new BudgetFlowError("PROPOSAL_NOT_OPEN", `Request ${id} is no longer open (${String(raw.status)}).`);
  return { id, kind: raw.kind as Record<string, unknown> };
}

/** Sign 1 done: the id from its outcome, then the read-back. Resolves to what sign 2 may approve. */
export async function confirmFirstSignature(built: Built, outcome: unknown, read: (id: number) => Promise<unknown>): Promise<ConfirmedProposal> {
  return confirmProposal(built, proposalIdFromOutcome(outcome), read);
}

export type VoteAction = "VoteApprove" | "VoteReject";

/** True when the wallet returned an outcome whose transaction failed. No outcome says nothing either way. */
export function outcomeFailed(outcome: unknown): boolean {
  const first = Array.isArray(outcome) ? outcome[0] : outcome;
  return isRecord(first) && isRecord(first.status) && "Failure" in first.status;
}

/**
 * What a vote did, from the proposal's status after it (null when that could not be read). The wallet's success only
 * says the transaction ran: one vote of several leaves the proposal open, and the installed Sputnik sets no callback
 * on a FunctionCall, so a call the Guard refused still shows `Approved`.
 */
export function voteResultText(id: number, action: VoteAction, kind: Record<string, unknown>, status: unknown): string {
  if (status === null) return `The transaction went through, but the page could not read request #${id} back. Reload to see its state.`;
  if (status === "InProgress") return `Your approval is in. Request #${id} stays open until it has enough approvals.`;
  if (status === "Rejected" && action === "VoteReject") return `Done: request #${id} rejected.`;
  if (status === "Failed") return `Request #${id} was approved but failed on the chain. Nothing changed.`;
  if (status !== "Approved") return `Request #${id} is now ${String(status)}.`;
  if ("FunctionCall" in kind) return `Request #${id} approved. The chain does not say here whether the change worked: reload and check it shows.`;
  return `Done: request #${id} approved.`;
}

/** The arguments of sign 2 and of Approve / Reject. `proposal` is always passed, even though the installed Sputnik ignores it. */
export function actProposalArgs(p: ConfirmedProposal, action: VoteAction): { id: number; action: VoteAction; proposal: Record<string, unknown> } {
  return { id: p.id, action, proposal: p.kind };
}

/** A Transfer out of the DAO: Withdraw. Amount in yoctoNEAR. */
export function withdrawProposal(receiver: string, yocto: string, nearText: string): Built {
  return {
    description: `Withdraw ${nearText} NEAR to ${receiver}`,
    // `msg: null` as the chain returns it, or the read-back never matches.
    kind: { Transfer: { token_id: "", receiver_id: receiver, amount: yocto, msg: null } },
  };
}

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A NEAR amount typed by the owner: a plain decimal above 0, and not above `maxYocto` when the balance is known. */
export function amountFromForm(text: string, maxYocto: string | null): FormResult<{ yocto: string; near: string }> {
  const yocto = nearToYocto(text);
  if (yocto === null || BigInt(yocto) === 0n) return fail("Enter a NEAR amount above 0, e.g. 1.5.");
  if (maxYocto !== null && BigInt(yocto) > BigInt(maxYocto)) return fail("That is more than the budget balance.");
  return { ok: true, value: { yocto, near: text.trim() } };
}

/** Edit rules: the four limits to a `set_policy` proposal on the Guard. Same bounds as the create form. */
export function rulesProposal(guardId: string, v: Record<string, string>): FormResult<AddProposalArgs> {
  const perTx = nearToYocto(v.maxPerTx ?? "");
  const perDay = nearToYocto(v.maxPerDay ?? "");
  const reserve = nearToYocto(v.minReserve ?? "");
  const pendingText = (v.maxPending ?? "").trim();
  const pending = /^\d+$/.test(pendingText) ? Number(pendingText) : NaN;
  if (perTx === null || perDay === null || BigInt(perTx) === 0n || BigInt(perDay) === 0n) return fail("Per payment and per 24 hours need a NEAR amount above 0.");
  if (reserve === null) return fail("Reserve needs a NEAR amount, 0 or more.");
  if (BigInt(perTx) > BigInt(perDay)) return fail("The per-payment limit cannot be above the 24-hour limit.");
  if (!(pending >= 1 && pending <= 100)) return fail("Waiting requests per agent: a whole number from 1 to 100.");
  const policy = { max_per_tx: perTx, max_per_day: perDay, max_pending_per_agent: pending, min_reserve: reserve };
  return { ok: true, value: guardChangeProposal(guardId, "set_policy", { policy }) };
}

/** Add a recipient: an `add_whitelist` proposal on the Guard. A second entry for an account would quietly replace its cap, so it is refused here. */
export function addRecipientProposal(guardId: string, v: Record<string, string>, existing: readonly string[]): FormResult<AddProposalArgs> {
  const account = (v.account ?? "").trim().toLowerCase();
  const label = (v.label ?? "").trim();
  const capText = (v.cap ?? "").trim();
  if (!isAccountId(account)) return fail(GUARD_FORM_TEXT.INVALID_ACCOUNT.en);
  if (account === KEEPER_ACCOUNT) return fail(GUARD_FORM_TEXT.KEEPER_RECIPIENT.en);
  if (existing.includes(account)) return fail("That account is already on your list. Remove it first to change its limit.");
  if (existing.length >= MAX_WHITELIST) return fail(GUARD_FORM_TEXT.TOO_MANY_WHITELIST.en);
  if ([...label].length > MAX_LABEL_CHARS) return fail(GUARD_FORM_TEXT.LABEL_TOO_LONG.en);
  const cap = capText === "" ? null : nearToYocto(capText);
  if (capText !== "" && (cap === null || BigInt(cap) === 0n)) return fail("The limit needs a NEAR amount above 0, or leave it empty.");
  return { ok: true, value: guardChangeProposal(guardId, "add_whitelist", { account_id: account, label, max_per_tx: cap }) };
}

const MAX_ACCOUNT_CHARS = 64;
/** More tries than a Guard has agents to remove in any demo; past this the page says so rather than loop. */
const MAX_AGENT_NAME_TRIES = 50;

/**
 * The first free `a<n>.<guard>`. The chain is the only list: a removed agent's account stays with its old key, and
 * the Guard fails on that name, so `existing` agents are not enough. Null when none fits.
 */
export async function freshAgentAccount(guardId: string, taken: (account: string) => Promise<boolean>): Promise<string | null> {
  for (let n = 1; n <= MAX_AGENT_NAME_TRIES; n += 1) {
    const account = `a${n}.${guardId}`;
    if (account.length > MAX_ACCOUNT_CHARS) return null;
    if (!(await taken(account))) return account;
  }
  return null;
}

/** Why adding an agent would fail on chain, where Sputnik still shows Approved; null when it can go ahead. */
export function addAgentProblem(label: string, existing: readonly string[], available: string | null): string | null {
  if (existing.length >= MAX_AGENTS) return `A Budget takes at most ${MAX_AGENTS} agents. Remove one first.`;
  if (label === "" || [...label].length > MAX_LABEL_CHARS) return `Name: 1 to ${MAX_LABEL_CHARS} characters.`;
  if (available !== null && BigInt(available) < BigInt(NEW_AGENT_DEPOSIT)) return `Adding an agent uses ${yoctoToNear(NEW_AGENT_DEPOSIT)} NEAR of this Budget. Top up first.`;
  return null;
}

/** Add an agent: the Guard makes `account` with this key, so the agent can call the Guard and nothing else. */
export function addAgentProposal(guardId: string, account: string, label: string, publicKey: string): AddProposalArgs {
  return guardChangeProposal(guardId, "add_agent", { account_id: account, label, public_key: publicKey }, NEW_AGENT_DEPOSIT);
}

/** Disable, enable or remove one agent; null for an unknown op. */
export function agentProposal(guardId: string, op: string, account: string): AddProposalArgs | null {
  if (op === "remove") return guardChangeProposal(guardId, "remove_agent", { account_id: account });
  if (op === "disable" || op === "enable") return guardChangeProposal(guardId, "set_agent_enabled", { account_id: account, enabled: op === "enable" });
  return null;
}

/** The catalog id of the one strategy that runs for real (§11.11.1). */
export const PAYOUT_STRATEGY = "scheduled-payouts";
export const MAX_PLAN_RUNS = 1000;
export const PLAN_UNITS = { minutes: 60, hours: 3_600, days: 86_400 } as const;
export type PlanUnit = keyof typeof PLAN_UNITS;
/** `MIN_PLAN_INTERVAL_SEC` in contracts/guard. */
const MIN_PLAN_INTERVAL_SEC = 60;
const MAX_PLAN_INTERVAL_SEC = 365 * 86_400;
const DAY_SEC = 86_400;

/** A Scheduled payout the owner typed, checked. Amounts yoctoNEAR, times milliseconds. */
export interface PayoutPlan {
  receiver: string;
  amount: { yocto: string; near: string };
  interval_sec: number;
  runs: number;
  /** When the first run is due; a time already past is `now`, which the Guard runs at the first keeper cycle. */
  start_ms: number;
  /** True when no future start time was typed. */
  starts_now: boolean;
}

/** What the Guard reads at `create_plan`: the limits and the recipient list. */
export type PlanRules = { policy: { max_per_tx: string; max_per_day: string } | null; whitelist: { account_id: string; max_per_tx: string | null }[] | null };

const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * The setup form to a plan, refused here for everything the Guard's `create_plan` refuses (`check_plan`,
 * `plan_limit_failure` with nothing spent): Sputnik shows a FunctionCall the Guard refused as Approved, so the
 * owner would see a plan that does not exist. The keeper is refused too: it signs for every Budget (ADR 0005 K1).
 */
export function planFromForm(v: Record<string, string>, rules: PlanRules, nowMs: number): FormResult<PayoutPlan> {
  const receiver = (v.receiver ?? "").trim();
  const runsText = (v.runs ?? "").trim();
  const everyText = (v.every ?? "").trim();
  const unit = v.unit as PlanUnit;
  const startText = (v.start ?? "").trim();
  if (rules.policy === null || rules.whitelist === null) return fail("Could not read your rules or recipients, so the plan cannot be checked. Reload and try again.");
  if (receiver === KEEPER_ACCOUNT) return fail(GUARD_FORM_TEXT.KEEPER_RECIPIENT.en);
  const entry = rules.whitelist.find((w) => w.account_id === receiver);
  if (entry === undefined) return fail("Pick a recipient from your list. Add the account under Manage recipients first.");
  const amount = amountFromForm(v.amount ?? "", null);
  if (!amount.ok) return amount;
  const yocto = BigInt(amount.value.yocto);
  if (yocto > BigInt(rules.policy.max_per_tx)) return fail(`Amount per run is above your per-request limit (${yoctoToNear(rules.policy.max_per_tx)} NEAR). Lower it or edit your rules.`);
  if (entry.max_per_tx !== null && yocto > BigInt(entry.max_per_tx)) return fail(`Amount per run is above this recipient's limit (${yoctoToNear(entry.max_per_tx)} NEAR).`);
  if (yocto > BigInt(rules.policy.max_per_day)) return fail(`Amount per run is above your 24-hour limit (${yoctoToNear(rules.policy.max_per_day)} NEAR). Lower it or edit your rules.`);
  if (!(unit in PLAN_UNITS) || !/^\d{1,6}$/.test(everyText)) return fail("Every: a whole number of minutes, hours or days.");
  const interval = Number(everyText) * PLAN_UNITS[unit];
  if (interval < MIN_PLAN_INTERVAL_SEC) return fail("Runs must be at least 1 minute apart.");
  if (interval > MAX_PLAN_INTERVAL_SEC) return fail("Runs can be at most 365 days apart.");
  if (!/^\d{1,4}$/.test(runsText) || Number(runsText) < 1 || Number(runsText) > MAX_PLAN_RUNS) return fail(`Number of runs: a whole number from 1 to ${MAX_PLAN_RUNS}.`);
  let start = nowMs;
  if (startText !== "") {
    const typed = DATETIME_LOCAL.test(startText) ? new Date(startText).getTime() : NaN;
    if (Number.isNaN(typed)) return fail("Start: pick a date and time, or leave it empty to start now.");
    start = Math.max(typed, nowMs);
  }
  return { ok: true, value: { receiver, amount: amount.value, interval_sec: interval, runs: Number(runsText), start_ms: start, starts_now: start === nowMs } };
}

/** `create_plan(plan)` on the Guard. The deposit pays the plan's storage; the Guard sends back what is not used. */
export function createPlanProposal(guardId: string, plan: PayoutPlan): AddProposalArgs {
  return guardChangeProposal(guardId, "create_plan", {
    plan: {
      action: { type: "transfer", receiver_id: plan.receiver },
      strategy_id: PAYOUT_STRATEGY,
      token_in: "",
      amount_per_run: plan.amount.yocto,
      interval_sec: plan.interval_sec,
      runs_total: plan.runs,
      start_at: (BigInt(plan.start_ms) * 1_000_000n).toString(),
    },
  });
}

/** Pause, resume or cancel one plan; null for an unknown op. */
export function planChangeProposal(guardId: string, op: string, planId: number): AddProposalArgs | null {
  const method = op === "pause" ? "pause_plan" : op === "resume" ? "resume_plan" : op === "cancel" ? "cancel_plan" : null;
  return method === null || !Number.isSafeInteger(planId) || planId < 0 ? null : guardChangeProposal(guardId, method, { plan_id: planId });
}

/** §11.11.4 partial top-up: enough for the next `k` runs. */
const PARTIAL_RUNS = 2n;

/** The numbers under the setup form (§11.11.4), in yoctoNEAR. `spendable` null means the balance is unknown. */
export interface PlanTotals {
  total: string;
  /** max(0, total − spendable); null when the balance is unknown. */
  short: string | null;
  /** max(0, 2 × amount − spendable): enough for the next two runs; null when the balance is unknown. */
  partial: string | null;
  /** The most runs that fall inside one rolling 24 hours, and what they spend of the shared daily limit. */
  runs_per_day: number;
  per_day: string;
  last_run_ms: number;
}

export function planTotals(plan: Pick<PayoutPlan, "amount" | "runs" | "interval_sec" | "start_ms">, spendable: string | null): PlanTotals {
  const amount = BigInt(plan.amount.yocto);
  const total = amount * BigInt(plan.runs);
  const left = (need: bigint) => (spendable === null ? null : (need > BigInt(spendable) ? need - BigInt(spendable) : 0n).toString());
  const runsPerDay = Math.min(plan.runs, Math.floor((DAY_SEC - 1) / plan.interval_sec) + 1);
  return {
    total: total.toString(),
    short: left(total),
    partial: left(amount * (BigInt(plan.runs) < PARTIAL_RUNS ? BigInt(plan.runs) : PARTIAL_RUNS)),
    runs_per_day: runsPerDay,
    per_day: (amount * BigInt(runsPerDay)).toString(),
    last_run_ms: plan.start_ms + (plan.runs - 1) * plan.interval_sec * 1000,
  };
}

/** The catalog id of the DCA strategy (GĐ31). */
export const DCA_STRATEGY = "dca-near";
/** DCA also offers weeks. */
export const DCA_UNITS = { ...PLAN_UNITS, weeks: 604_800 } as const;
export type DcaUnit = keyof typeof DCA_UNITS;
/** The "max price drop" choices in basis points (the Guard accepts 1 to 500). */
export const DCA_SLIPPAGE_CHOICES: readonly number[] = [50, 100, 200];
export const DCA_DEFAULT_SLIPPAGE = 100;

/** A DCA plan the owner typed, checked. Amounts yoctoNEAR, times milliseconds. */
export interface DcaPlan {
  amount: { yocto: string; near: string };
  interval_sec: number;
  runs: number;
  start_ms: number;
  starts_now: boolean;
  slippage_bps: number;
}

/**
 * The DCA form to a plan, refused here for what the Guard's `create_plan` refuses (limits, interval, slippage): Sputnik
 * shows a FunctionCall the Guard refused as Approved. "Stop after" is a count of runs or an end date; the Guard stores
 * runs only, so an end date becomes `floor((end - start) / interval) + 1` runs (0 or more than the maximum is refused).
 */
export function dcaFromForm(v: Record<string, string>, rules: Pick<PlanRules, "policy">, nowMs: number): FormResult<DcaPlan> {
  const everyText = (v.every ?? "").trim();
  const unit = v.unit as DcaUnit;
  const startText = (v.start ?? "").trim();
  const slippage = Number(v.slippage ?? DCA_DEFAULT_SLIPPAGE);
  if (rules.policy === null) return fail("Could not read your rules, so the plan cannot be checked. Reload and try again.");
  const amount = amountFromForm(v.amount ?? "", null);
  if (!amount.ok) return amount;
  const yocto = BigInt(amount.value.yocto);
  if (yocto > BigInt(rules.policy.max_per_tx)) return fail(`NEAR per run is above your per-request limit (${yoctoToNear(rules.policy.max_per_tx)} NEAR). Lower it or edit your rules.`);
  if (yocto > BigInt(rules.policy.max_per_day)) return fail(`NEAR per run is above your 24-hour limit (${yoctoToNear(rules.policy.max_per_day)} NEAR). Lower it or edit your rules.`);
  if (!(unit in DCA_UNITS) || !/^\d{1,6}$/.test(everyText)) return fail("Every: a whole number of minutes, hours, days or weeks.");
  const interval = Number(everyText) * DCA_UNITS[unit];
  if (interval < MIN_PLAN_INTERVAL_SEC) return fail("Runs must be at least 1 minute apart.");
  if (interval > MAX_PLAN_INTERVAL_SEC) return fail("Runs can be at most 365 days apart.");
  if (!DCA_SLIPPAGE_CHOICES.includes(slippage)) return fail("Pick a max price drop from the list.");
  let start = nowMs;
  if (startText !== "") {
    const typed = DATETIME_LOCAL.test(startText) ? new Date(startText).getTime() : NaN;
    if (Number.isNaN(typed)) return fail("Start: pick a date and time, or leave it empty to start now.");
    start = Math.max(typed, nowMs);
  }
  let runs: number;
  if (v.stop === "date") {
    const endText = (v.end ?? "").trim();
    const end = DATETIME_LOCAL.test(endText) ? new Date(endText).getTime() : NaN;
    if (Number.isNaN(end)) return fail("End date: pick a date and time.");
    runs = Math.floor((end - start) / (interval * 1000)) + 1;
    if (runs < 1 || end < start) return fail("The end date is before the first run. Pick a later date or start earlier.");
    if (runs > MAX_PLAN_RUNS) return fail(`That end date gives ${runs} runs, more than the ${MAX_PLAN_RUNS} allowed. Run less often or pick an earlier date.`);
  } else {
    const runsText = (v.runs ?? "").trim();
    if (!/^\d{1,4}$/.test(runsText) || Number(runsText) < 1 || Number(runsText) > MAX_PLAN_RUNS) return fail(`Number of runs: a whole number from 1 to ${MAX_PLAN_RUNS}.`);
    runs = Number(runsText);
  }
  return { ok: true, value: { amount: amount.value, interval_sec: interval, runs, start_ms: start, starts_now: start === nowMs, slippage_bps: slippage } };
}

/** `create_plan(plan)` with a swap step: the Guard sells `amount_per_run` NEAR for USDT on the testnet exchange. */
export function createDcaProposal(guardId: string, plan: DcaPlan): AddProposalArgs {
  return guardChangeProposal(guardId, "create_plan", {
    plan: {
      action: { type: "swap", pool_id: DCA_TESTNET.pool_id, token_out: DCA_TESTNET.token_out, max_slippage_bps: plan.slippage_bps },
      strategy_id: DCA_STRATEGY,
      token_in: "",
      amount_per_run: plan.amount.yocto,
      interval_sec: plan.interval_sec,
      runs_total: plan.runs,
      start_at: (BigInt(plan.start_ms) * 1_000_000n).toString(),
    },
  });
}
