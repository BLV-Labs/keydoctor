// The Agent Budget page, pure. Everything shown is read from the chain (budget-read.ts); the owner's actions go
// through the owner's wallet, and each button says how many signatures it takes (docs/final-idea.md §11.10.5).
import { dcaPrice, DCA_TESTNET, formatUnits, type Network } from "key-doctor";
import { applyAutoFunding, createCost, fundingMinYocto, parseRecipientLines, planBudget, setupErrorText, SPUTNIK_FACTORY, WIZARD_STEPS, type RecipientRow, type SetupError } from "./budget-create.ts";
import { DCA_DEFAULT_SLIPPAGE, DCA_SLIPPAGE_CHOICES, DCA_STRATEGY, DCA_UNITS, dcaFromForm, PLAN_UNITS, planFromForm, planTotals, type DcaUnit, type PlanUnit } from "./budget-flow.ts";
import { guardCanClose, guardNeedsUpdate, TOP_UP_TEXT, topUpBlocks, withdrawMaxYocto, type BudgetLive, type DcaReadiness, type BudgetPlan, type BudgetProposal, type BudgetRequest } from "./budget-read.ts";
import { formatUtc, nearToYocto, plural, yoctoToNear } from "./format.ts";
import { KEEPER_ACCOUNT } from "./guard-form.ts";
import { hasSwapRights, NEW_AGENT_DEPOSIT } from "./guard-proposals.ts";
import type { GuardLive } from "./guard-read.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { guardMcpCommand } from "./guard-view.ts";
import { copyRow } from "./pages.ts";
import { agentGuideHref, budgetHref, guardHref, pageHref, routeHref } from "./route.ts";
import { avatar } from "./ui.ts";

/** Shown in the form's placeholder text only; creation needs this factory to be deployed and set at build time. */
export const BUDGET_FACTORY_NAME = "keydoctor-guards-v2.testnet";
const EXAMPLE_BUDGET_DAO = "kdoncall.sputnik-v2.testnet";

export type BudgetPanel = "topup" | "withdraw" | "rules" | "add-agent" | "recipients" | "plan" | "dca";
export type ActivityFilter = "all" | "waiting" | "auto" | "rejected";

/** Wording of the signature count on a button or note. */
export const signatures = (n: 1 | 2): string => (n === 1 ? "1 signature" : "2 signatures");

/** What every pop-up that signs says before its button: how many times the wallet will ask. */
export const inWallet = (n: 1 | 2): string => `${signatures(n)} in your wallet`;
const sigLine = (n: 1 | 2): Html => html`<p class="sig-line">${icon.wallet()}<span>${inWallet(n)}</span></p>`;

/**
 * An owner change in two signatures, in words. Signature 1 adds a request to the budget and the wallet shows only the
 * refundable deposit it carries, which reads like a payment of the wrong amount unless the page says so first.
 * `withdraw` names the amount signature 2 sends; elsewhere signature 2 only applies the change.
 */
export function twoSignatureSteps(bondYocto: string, withdraw: Html | null = null): Html {
  const deposit = near(bondYocto);
  return html`<div class="sig-steps">${sigLine(2)}
    <ol class="small muted">
      <li>Signature 1: your wallet shows <strong>${deposit}</strong> going to the budget. That is a refundable deposit that opens the request, not ${withdraw === null ? "a payment" : "the withdrawal"}.</li>
      <li>Signature 2: ${withdraw === null ? html`the change applies and the budget returns the ${deposit} deposit.` : html`the budget sends <strong>${withdraw}</strong> to you and returns the ${deposit} deposit.`}</li>
    </ol></div>`;
}

/** The Withdraw "Agents keep working with…" line: a warning once nothing would be left to spend. */
export function withdrawLeftText(b: BudgetLive, amount: string): { text: string; empty: boolean } {
  const left = balanceAfter(b, "withdraw", amount);
  const max = withdrawMaxYocto(b);
  const typed = nearToYocto(amount);
  const empty = max !== null && typed !== null && BigInt(typed) > 0n && BigInt(typed) >= BigInt(max);
  return { text: empty ? "Your agents will have nothing left to spend until you top up." : `Agents keep working with what is left: ${left}.`, empty };
}

/**
 * The fence in one sentence, from the policy. `perDay` and `perTx` are already worded ("5 NEAR"), so the Edit the fence
 * drawer can use it live with what is typed. A recipient count of 0 and an unknown one are different sentences.
 */
export function fenceSentence(agents: number | null, perDay: string, perTx: string, recipients: number | null): string {
  const who = agents === null ? "Your agents can" : `${plural(agents, "agent")} can`;
  const to = recipients === null ? "only to the recipients you allow" : recipients === 0 ? "only to accounts you approve each time" : `only to ${plural(recipients, "recipient")}`;
  return `${who} spend up to ${perDay} a day and ${perTx} per payment, ${to}. Anything else waits for you.`;
}

const summaryOf = (g: GuardLive): string =>
  g.policy === null
    ? "We could not read the limits. Nothing was changed."
    : fenceSentence(g.agents?.length ?? g.config?.agents ?? null, near(g.policy.max_per_day), near(g.policy.max_per_tx), g.whitelist?.length ?? g.config?.whitelist ?? null);

export const near = (yocto: string | null | undefined): string => (yocto === null || yocto === undefined ? "unknown" : `${yoctoToNear(yocto)} NEAR`);
/** The Balance tile: two decimals, rounded down so it never shows more than can be spent. */
export function nearShort(yocto: string | null | undefined): string {
  if (yocto === null || yocto === undefined || !/^\d+$/.test(yocto)) return "unknown";
  const cents = BigInt(yocto) / 10n ** 22n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")} NEAR`;
}

const LEAD = "A budget your AI agent can spend, within rules you set. Larger payments wait for your approval. Top up or withdraw anytime.";

function head(lead: string): Html {
  return html`<section class="stack-xs"><h1 class="h1">Agent Budget</h1><p class="muted budget-lead">${lead}</p></section>`;
}

/** The DAO form. */
export function renderBudgetStart(dao: string, error: string | null, note: string): Html {
  return html`<form id="budget-dao-form" class="card pad stack-sm budget-narrow" novalidate>
      <label for="budget-dao" class="label">Open a Budget you already have: its account name</label>
      <div class="input-row">
        <input id="budget-dao" name="dao" type="text" class="input mono" value="${dao}" placeholder="${EXAMPLE_BUDGET_DAO}"
          autocomplete="off" autocapitalize="none" spellcheck="false" required${error ? html` aria-invalid="true" aria-describedby="budget-dao-error"` : ""}>
        <button type="submit" class="btn btn-secondary">Open</button>
      </div>
      ${error ? html`<p id="budget-dao-error" class="field-error" role="alert">${error}</p>` : ""}
      <p class="small muted">${note}</p>
    </form>`;
}

export function renderBudgetLoading(dao: string): Html {
  return html`${head("Reading this Budget from the chain…")}
    <section class="card pad stack-sm" aria-busy="true" aria-label="Loading ${dao}"><p class="meta mono" role="status">${dao}</p></section>`;
}

/** Plain words for what a proposal does. A kind this page does not know is named, never guessed at. */
export function describeKind(kind: Record<string, unknown>): string {
  const t = kind.Transfer as { receiver_id?: unknown; amount?: unknown; token_id?: unknown } | undefined;
  if (t !== undefined) {
    const token = t.token_id === "" || t.token_id === undefined ? "NEAR" : String(t.token_id);
    const amount = typeof t.amount === "string" && token === "NEAR" ? yoctoToNear(t.amount) : String(t.amount);
    return `Send ${amount} ${token} to ${String(t.receiver_id)}`;
  }
  const call = kind.FunctionCall as { receiver_id?: unknown; actions?: { method_name?: unknown; deposit?: unknown }[] } | undefined;
  if (call !== undefined) {
    const methods = (call.actions ?? []).map((a) => String(a.method_name)).join(", ");
    const deposit = (call.actions ?? []).reduce((sum, a) => sum + BigInt(typeof a.deposit === "string" && /^\d+$/.test(a.deposit) ? a.deposit : 0), 0n);
    return `Call ${methods} on ${String(call.receiver_id)}${deposit > 0n ? `, attaching ${yoctoToNear(deposit.toString())} NEAR` : ""}`;
  }
  const other = Object.keys(kind)[0] ?? "Unknown request";
  return other.startsWith("ChangePolicy") ? `Change who controls this Budget (${other})` : other;
}

export function percent(spent: string, limit: string): number {
  const max = BigInt(limit);
  return max === 0n ? 0 : Math.min(100, Number((BigInt(spent) * 100n) / max));
}

const hours = (n: number): string => `${n} ${n === 1 ? "hour" : "hours"}`;

/** The DAO's voting period in nanoseconds, the time a waiting item has before it expires; null when unread. */
function proposalPeriod(b: BudgetLive): bigint | null {
  const period = b.dao.policy.proposal_period;
  return typeof period === "string" && /^\d+$/.test(period) ? BigInt(period) : null;
}

/** Whole hours until a proposal expires, rounded up; 0 once it has; null when the chain did not say. */
export function hoursLeft(p: BudgetProposal, b: BudgetLive, now: number): number | null {
  const period = proposalPeriod(b);
  if (p.submission_time === null || period === null) return null;
  const left = Number((BigInt(p.submission_time) + period) / 1_000_000n) - now;
  return left <= 0 ? 0 : Math.ceil(left / 3_600_000);
}

export const expiryText = (left: number | null): string | null => (left === null ? null : left === 0 ? "Expired" : `Expires in ${hours(left)}`);

export function ago(nanos: string | null, now: number): string {
  if (nanos === null) return "";
  const minutes = Math.floor((now - Number(BigInt(nanos) / 1_000_000n)) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${hours(Math.floor(minutes / 60))} ago`;
  const days = Math.floor(minutes / (60 * 24));
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export const agentName = (g: GuardLive | null, account: string): string => {
  // A plan step is recorded with the Guard as its agent: name it for what it is, not by the Guard's account.
  if (g !== null && account === g.guard_id) return "Scheduled payout";
  const label = g?.agents?.find((a) => a.account_id === account)?.label ?? "";
  return label === "" ? account : label;
};

const nsToUtc = (ns: string): string => formatUtc(new Date(Number(BigInt(ns) / 1_000_000n)).toISOString());

/** "enough for N days at today's pace", from what was spent today; null when nothing was spent or a number is unknown. */
export function runwayText(b: BudgetLive): string | null {
  const spent = b.guard?.window?.spent_in_window;
  if (b.withdrawable === null || spent === undefined || BigInt(spent) === 0n) return null;
  const days = Number(BigInt(b.withdrawable) / BigInt(spent));
  return days < 1 ? "less than a day at today's pace" : `enough for ${plural(days, "day")} at today's pace`;
}

/** The soonest scheduled payout that is still running: the plan with the earliest next run. */
function nextPlan(b: BudgetLive): BudgetPlan | null {
  const live = (b.plans ?? []).filter((p) => p.status === "active" && p.next_run_at !== null);
  return live.sort((x, y) => (BigInt(x.next_run_at ?? 0) < BigInt(y.next_run_at ?? 0) ? -1 : 1))[0] ?? null;
}

const localTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function tiles(b: BudgetLive, now: number): Html {
  const g = b.guard;
  const w = g?.window ?? null;
  const p = g?.policy ?? null;
  const oldest = b.proposals?.at(-1);
  const left = oldest === undefined ? null : hoursLeft(oldest, b, now);
  // The account's NEAR that pays for its storage: counted in `balance`, but no transfer can send it.
  const held = b.balance === null || b.withdrawable === null ? null : BigInt(b.balance) - BigInt(b.withdrawable);
  const runway = runwayText(b);
  const tile = (filter: ActivityFilter, label: string, value: string, notes: string[], extra: Html | "" = "") =>
    html`<button type="button" class="card tile tile-btn" data-action="budget-filter" data-filter="${filter}">
      <span class="tile-label">${label}</span><span class="tile-value">${value}</span>${extra}${notes.filter((n) => n !== "").map((n) => html`<span class="tile-note">${n}</span>`)}</button>`;
  const plan = nextPlan(b);
  const payout =
    plan !== null
      ? html`<span class="tile-value">${near(plan.amount_per_run)}</span><span class="tile-note wrap">to ${plan.receiver_id ?? "a recipient"} · ${nsToUtc(plan.next_run_at ?? "0")}</span>`
      : html`<span class="tile-value">None</span>${b.plans === null ? html`<span class="tile-note">Not available right now</span>` : html`<span class="tile-note"><button type="button" class="btn btn-ghost btn-link" data-action="budget-open" data-panel="plan">Set one up</button></span>`}`;
  return html`<section class="tiles" aria-label="Budget summary">
    ${tile("all", "Balance", nearShort(b.withdrawable), [runway === null ? "Top up any time" : runway, b.usdt === undefined || b.usdt === null ? "" : `USDT in your Budget: ${formatUnits(b.usdt, DCA_TESTNET.token_out_decimals)}`, held === null || held === 0n ? "" : `Plus ${near(held.toString())} kept for account storage, not spendable`])}
    ${tile("auto", "Spent today", w === null ? "unknown" : p === null ? near(w.spent_in_window) : `${yoctoToNear(w.spent_in_window)} / ${near(p.max_per_day)}`,
      [w === null ? "" : `resets ${localTime(w.resets_at)}`],
      w !== null && p !== null ? html`<progress class="progress" max="100" value="${percent(w.spent_in_window, p.max_per_day)}" aria-label="Share of the daily limit spent"></progress>` : "")}
    ${tile("waiting", "Waiting for you", b.proposals === null ? "unknown" : String(b.proposals.length), [left === null || left === 0 ? "Review them below" : `Soonest: ${hours(left)} left`])}
    <div class="card tile">${html`<span class="tile-label">Next scheduled payout</span>`}${payout}</div>
  </section>`;
}

/** Why a payment waited, in the owner's words, with the limit it crossed. An unknown code is shown as it is. */
export function reasonText(code: string, g: GuardLive | null, receiver: string | null = null): string {
  const p = g?.policy ?? null;
  switch (code) {
    case "NOT_WHITELISTED":
      return "Not on your recipient list";
    case "OVER_PER_TX":
      return p === null ? "More than the limit per payment" : `More than the ${near(p.max_per_tx)} limit per payment`;
    case "OVER_DAILY_LIMIT":
      return p === null ? "Over today's limit" : `Over today's ${near(p.max_per_day)} limit`;
    case "OVER_RECIPIENT_LIMIT": {
      const cap = receiver === null ? null : g?.whitelist?.find((w) => w.account_id === receiver)?.max_per_tx ?? null;
      return receiver !== null && cap !== null ? `More than ${receiver}'s ${near(cap)} limit` : "More than this recipient's limit";
    }
    default:
      return code;
  }
}

export const requestOf = (b: BudgetLive, p: BudgetProposal): BudgetRequest | null => b.requests?.find((r) => r.proposal_id === p.id) ?? null;

function needsRow(p: BudgetProposal, b: BudgetLive, now: number): Html {
  const g = b.guard;
  const r = requestOf(b, p);
  const notes = [r !== null && r.memo !== "" ? `“${r.memo}”` : null, expiryText(hoursLeft(p, b, now)), `Request #${p.id}`].filter((n) => n !== null).join(" · ");
  return html`<li class="needs-row">
    <div class="needs-main">
      ${avatar(r?.agent ?? p.proposer)}
      <div class="stack-xs grow-min">
        ${r === null
          ? html`<p class="strong wrap">${describeKind(p.kind)}</p><p class="small muted wrap">${p.description}</p>
              <p class="small muted">Asked by <span class="mono">${p.proposer}</span>${p.proposer === g?.guard_id ? " (for an agent)" : ""}</p>`
          : html`<p class="wrap">${agentName(g, r.agent)} wants to pay <strong>${near(r.amount)}</strong> to <span class="mono">${r.receiver_id}</span></p>`}
        <p class="small muted wrap">${notes}</p>
      </div>
    </div>
    <div class="needs-side">
      ${(r?.reasons ?? []).map((code) => html`<span class="pill pill-cleanup">${icon.alertSmall()}${reasonText(code, g, r?.receiver_id ?? null)}</span>`)}
      <div class="actions">
        <button type="button" class="btn btn-danger" data-action="budget-act" data-id="${p.id}" data-vote="VoteReject">Reject</button>
        <button type="button" class="btn btn-primary" data-action="budget-approve" data-id="${p.id}">Review</button>
      </div>
    </div></li>`;
}

function pendingCard(b: BudgetLive, now: number): Html {
  const proposals = b.proposals;
  const open = proposals !== null && proposals.length > 0;
  const body =
    proposals === null
      ? html`<p class="check-line pad-row">${icon.alert()}<span>Could not read what waits for you right now. Waiting items are unknown, not none.</span></p>`
      : open
        ? html`<ul class="plain-list">${[...proposals].reverse().map((p) => needsRow(p, b, now))}</ul>`
        : html`<p class="muted pad-row">Nothing waits for you.</p>`;
  return html`<section class="card${open ? " card-needs" : ""}" aria-labelledby="b-pending">
    <div class="b-head"><div><h2 id="b-pending" class="b-h">Needs you</h2><p class="small muted">Agents asked for these. They are outside your fence.${open ? " Approve and Reject each take 1 signature." : ""}</p></div></div>
    ${body}</section>`;
}

const REQUEST_STATUS: Record<string, string> = {
  Submitted: "Sent for approval",
  AutoApproved: "Approved by the rules",
  Pending: "Waiting for you",
  Executed: "Paid",
  Rejected: "Rejected",
  Expired: "Expired",
  Failed: "Failed",
};

/** Which Activity chip a request falls under; a request the owner approved and got paid is under All only. */
function activityGroup(r: BudgetRequest): Exclude<ActivityFilter, "all"> | null {
  if (r.status === "Rejected" || r.status === "Expired" || r.status === "Failed") return "rejected";
  if (r.decision === "Auto") return "auto";
  return r.status === "Submitted" || r.status === "Pending" ? "waiting" : null;
}

export function activityRow(r: BudgetRequest, g: GuardLive | null, plans: BudgetPlan[] | null, now: number): Html {
  const group = activityGroup(r);
  const tone = group === "rejected" ? "pill-high" : group === "waiting" ? "pill-cleanup" : "pill-ok";
  const mark = group === "rejected" ? icon.alertSmall() : group === "waiting" ? icon.clock() : group === "auto" ? icon.check() : "";
  // A DCA step pays the wrap contract to swap: it is a sale of NEAR, not a payment to anyone.
  const swap = r.plan_id !== null && plans?.find((p) => p.plan_id === r.plan_id)?.action_type === "swap";
  const paid = r.status === "Executed";
  const label = group === "auto" && paid ? (swap ? "Swapped automatically" : "Paid automatically") : (REQUEST_STATUS[r.status] ?? r.status);
  const reasons = r.reasons.map((c) => reasonText(c, g, r.receiver_id)).join(", ");
  const what = swap
    ? `DCA ${paid ? "sold" : "is selling"} NEAR for USDT`
    : html`${agentName(g, r.agent)} ${paid ? "paid" : "asked to pay"} <span class="mono">${r.receiver_id}</span>`;
  const when = ago(r.created_at, now);
  return html`<li class="activity-row">
    <span class="activity-status"><span class="pill ${tone}">${mark}${label}</span></span>
    <span class="activity-text wrap">${what}${reasons === "" ? "" : html`<span class="small muted activity-why">${reasons}</span>`}</span>
    <span class="activity-amount">${near(r.amount)}</span>
    <span class="activity-time small muted">${r.tx_url ? html`<a href="${r.tx_url}" target="_blank" rel="noopener" title="Open the transaction in the explorer">${when}</a>` : when}</span></li>`;
}

/** The Activity card with one chip pressed. It repaints alone when a chip or a summary tile is pressed. */
export function renderBudgetActivity(b: BudgetLive, filter: ActivityFilter, now: number = Date.now()): Html {
  const chip = (id: ActivityFilter, label: string) =>
    html`<button type="button" class="filter-chip" data-action="budget-filter" data-filter="${id}" aria-pressed="${String(filter === id)}">${label}</button>`;
  const rows = (b.requests ?? []).filter((r) => filter === "all" || activityGroup(r) === filter);
  const body =
    b.requests === null
      ? html`<p class="check-line pad-row">${icon.alert()}<span>Could not read your agents' requests right now.</span></p>`
      : b.requests.length === 0
        ? html`<p class="muted pad-row">No requests yet.</p>`
        : rows.length === 0
          ? html`<p class="muted pad-row">Nothing here yet.</p>`
          : html`<ul class="plain-list">${rows.map((r) => activityRow(r, b.guard, b.plans, now))}</ul>`;
  return html`<section id="budget-activity" class="card" aria-labelledby="b-activity">
    <div class="b-head"><h2 id="b-activity" class="b-h">Activity</h2></div>
    <div class="filter-chips" role="group" aria-label="Filter activity">${chip("all", "All")}${chip("auto", "Paid automatically")}${chip("waiting", "Waited for you")}${chip("rejected", "Rejected")}</div>
    ${body}</section>`;
}

function fenceCard(b: BudgetLive, g: GuardLive): Html {
  const p = g.policy;
  const row = (label: string, value: string | number) => html`<div class="rule-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  return html`<section class="card" aria-labelledby="b-rules"><div class="b-head"><h2 id="b-rules" class="b-h">Fence</h2>
      ${p === null ? "" : html`<button type="button" class="btn btn-ghost" data-action="budget-open" data-panel="rules">Edit</button>`}</div>
    ${p === null
      ? html`<p class="check-line pad-row">${icon.alert()}<span>We could not read the limits. Nothing was changed.</span></p>`
      : html`<dl class="rule-list">
          ${row("Per payment", near(p.max_per_tx))}
          ${row("Per day", near(p.max_per_day))}
          ${row("Requests that can wait per agent", p.max_pending_per_agent)}
          ${row("Contract keeps for its fees", near(p.min_reserve))}
        </dl>`}</section>`;
}

function recipientsCard(g: GuardLive): Html {
  const list = g.whitelist;
  const body =
    list === null
      ? html`<p class="check-line pad-row">${icon.alert()}<span>Could not read the list right now. It is unknown, not empty.</span></p>`
      : list.length === 0
        ? html`<p class="muted pad-row">No recipients yet. Payments to anyone wait for you.</p>`
        : html`<ul class="plain-list">${list.slice(0, 4).map((w) => html`<li class="recipient-row"><span class="stack-xs grow-min"><span class="mono wrap">${w.account_id}</span>${w.label === "" && w.max_per_tx === null ? "" : html`<span class="small muted">${[w.label, w.max_per_tx === null ? "" : `up to ${near(w.max_per_tx)} per payment`].filter((t) => t !== "").join(" · ")}</span>`}</span></li>`)}</ul>
          ${list.length > 4 ? html`<p class="small muted pad-row">and ${list.length - 4} more</p>` : ""}
          <p class="small muted pad-row">Payments to anyone else always wait for you.</p>`;
  return html`<section class="card" aria-labelledby="b-recipients"><div class="b-head"><h2 id="b-recipients" class="b-h">Who agents can pay</h2>
      <button type="button" class="btn btn-ghost" data-action="budget-open" data-panel="recipients">Manage</button></div>${body}</section>`;
}

const agentUse = (a: NonNullable<GuardLive["agents"]>[number]): string =>
  a.spent_24h === undefined ? `${a.pending} waiting` : `${a.pending} waiting · ${near(a.spent_24h)} in last 24h`;

function agentsCard(g: GuardLive): Html {
  const agents = g.agents;
  const body =
    agents === null
      ? html`<p class="check-line pad-row">${icon.alert()}<span>Could not read the agent list right now.</span></p>`
      : agents.length === 0
        ? html`<p class="muted pad-row">No agent yet. Add one to start.</p>`
        : html`<ul class="plain-list">${agents.map((a) => html`<li><button type="button" class="agent-row" data-action="budget-agent-open" data-agent="${a.account_id}">
            ${avatar(a.account_id)}
            <span class="agent-text"><span class="agent-name wrap">${a.label === "" ? a.account_id : a.label}</span><span class="small muted wrap">${a.label === "" ? "" : `${a.account_id} · `}${agentUse(a)}</span></span>
            <span class="pill ${a.enabled ? "pill-ok" : "pill-note"}">${a.enabled ? "On" : "Off"}</span>${icon.chevronRight()}</button></li>`)}</ul>`;
  return html`<section class="card" aria-labelledby="b-agents"><div class="b-head"><h2 id="b-agents" class="b-h">Agents</h2>
      <button type="button" class="btn btn-ghost" data-action="budget-open" data-panel="add-agent">Add agent</button></div>
    ${body}</section>`;
}

const STRATEGIES: ReadonlyArray<readonly [string, string]> = [
  ["Scheduled payouts", "Pay a recipient the same amount on a schedule."],
  ["DCA NEAR → USDT", "Sell NEAR for USDT in small steps. Testnet only for now."],
  ["Auto-stake idle NEAR", "Keep spare NEAR staked until it is needed."],
  ["Rebalance NEAR / USDC", "Hold a target split between the two."],
  ["Take profit", "Sell part of your NEAR at a price you pick."],
];

/** The strategy that runs for real; the others are labelled Coming soon. */
const PAYOUTS = "Scheduled payouts";
const DCA = "DCA NEAR → USDT";

/** "5 minutes", "2 hours", "1 day": the largest unit that divides the interval. */
export function everyText(sec: number): string {
  const [unit, size] = sec % PLAN_UNITS.days === 0 ? ["day", PLAN_UNITS.days] : sec % PLAN_UNITS.hours === 0 ? ["hour", PLAN_UNITS.hours] : sec % PLAN_UNITS.minutes === 0 ? ["minute", PLAN_UNITS.minutes] : ["second", 1];
  const n = sec / size;
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

const PAUSE_TEXT: Record<string, string> = {
  owner: "Paused by you",
  insufficient_balance: "Paused: the Budget ran out of NEAR",
  guard_low_near: "Paused: the Budget account needs more NEAR to file the request",
  failures: "Paused: it no longer fits your rules, or runs kept failing",
};

export function planStatus(p: BudgetPlan): string {
  if (p.status === "paused") return (p.pause_reason !== null && PAUSE_TEXT[p.pause_reason]) || "Paused";
  return p.status === "active" ? "Active" : p.status === "completed" ? "Completed" : "Cancelled";
}

/** One plan with its two-signature Pause / Resume / Cancel. Row id `plan-<id>` is the `&plan=` deep link target. */
function planRow(p: BudgetPlan): Html {
  const what =
    p.action_type === "swap"
      ? `Sell ${near(p.amount_per_run)} for USDT every ${everyText(p.interval_sec)}`
      : p.receiver_id === null
        ? `Plan #${p.plan_id} (${p.action_type})`
        : `${near(p.amount_per_run)} to ${p.receiver_id} every ${everyText(p.interval_sec)}`;
  const meta = [`Run ${p.runs_done} of ${p.runs_total}`, planStatus(p), p.next_run_at === null ? "" : `next ${nsToUtc(p.next_run_at)}`].filter((t) => t !== "").join(" · ");
  const btn = (op: string, label: string) => html`<button type="button" class="btn btn-ghost" data-action="budget-plan" data-op="${op}" data-plan="${p.plan_id}">${label} <span class="sig">${signatures(2)}</span></button>`;
  const open = p.status === "active" || p.status === "paused";
  return html`<li id="plan-${p.plan_id}" class="recipient-row" tabindex="-1"><span class="stack-xs grow-min"><span class="wrap">${what}</span><span class="small muted wrap">${meta}</span></span>
    ${open ? html`<span class="actions">${p.status === "active" ? btn("pause", "Pause") : btn("resume", "Resume")}${btn("cancel", "Cancel")}</span>` : ""}</li>`;
}

/** Scheduled payouts show only once the Guard's plans were read: that read is the proof the Budget has plans. */
function payoutsCard(b: BudgetLive): Html {
  const plans = b.plans;
  if (plans === null) return html``;
  return html`<section class="card" aria-labelledby="b-later">
    <div class="b-head"><h2 id="b-later" class="b-h">Plans</h2><span class="actions"><button type="button" class="btn btn-ghost" data-action="budget-open" data-panel="plan">New payout</button><button type="button" class="btn btn-ghost" data-action="budget-open" data-panel="dca">New DCA</button></span></div>
    ${plans.length === 0 ? html`<p class="muted pad-row">None yet. Pay a recipient on a timetable, or sell NEAR for USDT in small steps.</p>` : html`<ul class="plain-list">${plans.map(planRow)}</ul>`}</section>`;
}

const ALERTS_CARD = html`<section class="card" aria-labelledby="b-alerts">
    <div class="b-head"><h2 id="b-alerts" class="b-h">Alerts</h2><button type="button" class="btn btn-ghost" data-action="alerts-open">Manage</button></div>
    <p class="small muted pad-row">Telegram alerts for risky requests, Budget changes and key changes.</p></section>`;

const explorer = (id: string, network: Network): string => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/address/${id}`;

function technical(b: BudgetLive, g: GuardLive, network: Network): Html {
  const row = (label: string, id: string) =>
    html`<div class="tech-row"><dt>${label}</dt><dd class="mono"><a href="${routeHref(id)}" data-nav>${id}</a> · <a href="${explorer(id, network)}" target="_blank" rel="noopener">Explorer</a></dd></div>`;
  return html`<details class="card tech"><summary>Technical details${icon.chevronRight()}</summary>
    <dl class="tech-list">${row("Sputnik DAO account", b.dao.dao)}${row("Guard account", g.guard_id)}
      <div class="tech-row"><dt>Guard factory</dt><dd class="mono">${b.dao.factory}</dd></div>
      <div class="tech-row"><dt>Requests expire after</dt><dd>${proposalPeriod(b) === null ? "unknown" : hours(Number(proposalPeriod(b)! / 3_600_000_000_000n))}</dd></div>
      <div class="tech-row"><dt>Network</dt><dd>${network}</dd></div>
      ${network === "testnet" && (b.plans ?? []).some((p) => p.action_type === "swap")
        ? html`<div class="tech-row"><dt>Swap exchange</dt><dd class="mono">${DCA_TESTNET.exchange} · pool ${DCA_TESTNET.pool_id}</dd></div>
          <div class="tech-row"><dt>Swap tokens</dt><dd class="mono">${DCA_TESTNET.wrap} → ${DCA_TESTNET.token_out}</dd></div>`
        : ""}</dl>
    <p class="pad-row"><button type="button" class="btn btn-danger" data-action="budget-close" data-guard="${g.guard_id}">Close this Budget</button></p></details>`;
}

/** The state of one budget in a pill: Active, Agents paused, Setup not finished, Status unknown. */
export function budgetStatusPill(g: GuardLive): Html {
  if (g.config === null) return html`<span class="pill pill-cleanup">Status unknown</span>`;
  if (g.config.paused) return html`<span class="pill pill-cleanup">${icon.alertSmall()}Agents paused</span>`;
  return g.in_role ? html`<span class="pill pill-ok">Active</span>` : html`<span class="pill pill-cleanup">Setup not finished</span>`;
}

/** The live page for one DAO that has a Guard. */
export function renderBudget(b: BudgetLive, network: Network, setup: Html | "" = "", now: number = Date.now(), unfinished: UnfinishedSetup | null = null): Html {
  const g = b.guard;
  if (g === null) {
    return html`${head("This account has no Agent Budget yet.")}
      <section class="stack-sm"><p>Account <a class="mono" href="${routeHref(b.dao.dao)}" data-nav>${b.dao.dao}</a> · ${network}</p></section>
      ${unfinished === null ? "" : unfinishedCard(unfinished)}
      <section class="card pad stack-xs"><p class="muted">No finished Agent Budget was found for this account.</p><p class="small"><a href="${guardHref(b.dao.dao)}" data-nav>Team council? Use the council setup page.</a></p></section>
      ${setup}`;
  }
  const paused = g.config?.paused === true;
  const status = budgetStatusPill(g);
  const reserve = g.policy === null || b.withdrawable === null ? null : BigInt(b.withdrawable) < BigInt(g.policy.min_reserve) ? g.policy.min_reserve : null;
  return html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${pageHref("my-agents", network)}" data-nav>Your agents</a><span aria-hidden="true">/</span><span aria-current="page" class="wrap">${b.dao.dao}</span></nav>
    <section class="budget-top" aria-label="Budget">
      <div class="stack-xs grow-min">
        <div class="budget-name"><h1 class="h1 mono wrap">${b.dao.dao}</h1>${status}</div>
        <p class="budget-summary">${summaryOf(g)}${g.policy === null ? html` <button type="button" class="btn btn-ghost btn-link" data-action="rescan">Check again</button>` : ""}</p>
      </div>
      <div class="actions">
        ${paused
          ? html`<button type="button" class="btn btn-primary" data-action="budget-resume">${icon.play()}Resume this Budget <span class="sig">${signatures(2)}</span></button>`
          : html`<button type="button" class="btn btn-danger" data-action="budget-pause" data-guard="${g.guard_id}"${g.config === null ? " disabled" : ""}>${icon.pause()}Pause this Budget</button>`}
        <button type="button" class="btn btn-secondary" data-action="budget-open" data-panel="withdraw">Withdraw</button>
        <button type="button" class="btn ${paused ? "btn-secondary" : "btn-primary"}" data-action="budget-open" data-panel="topup">Top up</button>
      </div>
    </section>
    ${paused ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>Agents are paused. Every payment they ask for is rejected until you resume.</span></p>` : ""}
    ${reserve === null ? "" : html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>Agents cannot pay until you top up above ${near(reserve)}.</span></p>`}
    ${tiles(b, now)}
    <p id="budget-status" class="small" role="status" aria-live="polite"></p>
    <div id="budget-next"></div>
    <div class="budget-cols">
      <div class="budget-main">${pendingCard(b, now)}${renderBudgetActivity(b, "all", now)}</div>
      <aside class="budget-side" aria-label="Budget setup">${fenceCard(b, g)}${recipientsCard(g)}${agentsCard(g)}${payoutsCard(b)}${ALERTS_CARD}</aside>
    </div>
    ${technical(b, g, network)}
    <dialog id="budget-action" class="drawer" aria-labelledby="bp-title"></dialog>`;
}

const near2 = (yocto: string | undefined): string => (yocto === undefined ? "" : yoctoToNear(yocto));

/** `focusClose` puts the first focus on Close: the safe button of a dialog whose other buttons all sign. */
function drawerHead(title: string, note: string, focusClose = false): Html {
  return html`<div class="drawer-head">
    <div class="drawer-title"><h2 id="bp-title" class="drawer-h wrap">${title}</h2><p class="small muted">${note}</p></div>
    <button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close"${focusClose ? " autofocus" : ""}>${icon.close()}</button></div>`;
}

const CANCEL = html`<button type="button" class="btn btn-secondary" data-action="close-dialog">Cancel</button>`;

/** Top up and Withdraw are small centred dialogs; the rest are drawers. */
export const isModalPanel = (panel: BudgetPanel): boolean => panel === "topup" || panel === "withdraw";

/** The amounts offered as one-press chips in Top up. */
export const TOP_UP_CHIPS: readonly string[] = ["1", "5", "10", "20"];

/** Pause this Budget (every agent in it): what stops, what stays, and what undoing it costs. Cancel has the first focus. */
export function renderBudgetPause(b: BudgetLive): Html {
  const g = b.guard;
  const count = g?.agents?.length ?? g?.config?.agents ?? null;
  return html`<div class="drawer-form">${drawerHead("Pause this Budget?", `${b.dao.dao}${count === null ? "" : ` · ${plural(count, "agent")}`}`)}
    <div class="drawer-body">
      <ul class="list">
        <li>Agents cannot pay or ask for payments.</li>
        <li>Scheduled payouts stop until you resume.</li>
        <li>Payments already waiting for you stay; you can still reject them.</li>
      </ul>
      <p class="small muted">Pausing takes 1 signature. Resuming takes 2, so a stolen agent key cannot undo it.</p>
      ${sigLine(1)}
    </div>
    <div class="drawer-foot"><button type="button" class="btn btn-secondary" data-action="close-dialog" autofocus>Cancel</button>
      <button type="button" class="btn btn-danger-solid" data-action="budget-pause-now" data-guard="${g?.guard_id ?? ""}">Pause now</button></div></div>`;
}

/** Above this many records the Guard cannot clear them in one call (`MAX_RECENT` in contracts/guard), so `close` refuses. */
const CLOSE_MAX_REQUESTS = 200n;

/**
 * What stops `close` before the council votes on it, from the page's reads; the Guard checks again itself. Requests
 * count the agents' waiting ones plus waiting plan steps among the newest requests, so an older waiting plan step can
 * slip past this list and the Guard refuses it with OPEN_REQUESTS.
 */
export function closeBlockers(b: BudgetLive, version: string | null): string[] {
  const g = b.guard;
  if (version === null) return ["The Budget version could not be read. Reload the page and try again."];
  if (!guardCanClose(version)) return [`This Budget runs version ${version}. Closing needs version 1.4.0 or later: update it first.`];
  const out: string[] = [];
  const waiting =
    (g?.agents ?? []).reduce((n, a) => n + a.pending, 0) + (b.requests ?? []).filter((r) => r.plan_id !== null && (r.status === "Submitted" || r.status === "Pending")).length;
  if (waiting > 0) out.push(`${plural(waiting, "payment")} still ${waiting === 1 ? "waits" : "wait"} for your decision. Approve or reject ${waiting === 1 ? "it" : "them"} first.`);
  const open = (b.plans ?? []).filter((p) => p.status === "active" || p.status === "paused").length;
  if (open > 0) out.push(`${plural(open, "scheduled payout")} can still run. Cancel ${open === 1 ? "it" : "them"} first; a paused one counts, since it could be resumed.`);
  const held = g?.config?.requests;
  if (held !== undefined && BigInt(held) > CLOSE_MAX_REQUESTS) {
    out.push(`This Budget holds ${held} payment records, more than the ${CLOSE_MAX_REQUESTS} it can clear, so it cannot be closed. Its spare NEAR can still come back with withdraw_excess on the council page.`);
  }
  return out;
}

/**
 * Close this Budget (Guard 1.4.0): what is lost for good, or what stops it first. Cancel has the first focus. A Budget
 * on an older version gets only the Update button; `version` is `kd_guard_info.version`, null when unread.
 */
export function renderBudgetClose(b: BudgetLive, version: string | null): Html {
  const g = b.guard;
  const blockers = closeBlockers(b, version);
  const update = version !== null && !guardCanClose(version);
  const note = `${b.dao.dao}${g === null ? "" : ` · ${g.guard_id}`}`;
  if (blockers.length > 0) {
    return html`<div class="drawer-form">${drawerHead("Close this Budget?", note, true)}
      <div class="drawer-body">
        <p>Before you can close it:</p>
        <ul class="list">${blockers.map((t) => html`<li>${t}</li>`)}</ul>
        ${update ? twoSignatureSteps(b.dao.policy.proposal_bond) : ""}
      </div>
      <div class="drawer-foot">${CANCEL}${update ? html`<button type="button" class="btn btn-primary" data-action="budget-close-update">Update this Budget</button>` : ""}</div></div>`;
  }
  return html`<div class="drawer-form">${drawerHead("Close this Budget?", note, true)}
    <div class="drawer-body">
      <ul class="list">
        <li>The Budget account is deleted. All its NEAR, the storage it locks included, goes back to <span class="mono">${b.dao.dao}</span>.</li>
        <li>Agents can no longer ask for payments, and no payout can be scheduled.</li>
        <li>Agent accounts keep what is left of their gas fund.</li>
        <li>This cannot be undone. A new Budget needs a new name.</li>
      </ul>
      ${twoSignatureSteps(b.dao.policy.proposal_bond)}
    </div>
    <div class="drawer-foot">${CANCEL}<button type="button" class="btn btn-danger-solid" data-action="budget-close-now" data-guard="${g?.guard_id ?? ""}">Close Budget</button></div></div>`;
}

const sumRow = (label: string, value: Html | string) => html`<div class="sum-row"><span class="muted">${label}</span><span class="sum-value wrap">${value}</span></div>`;

/**
 * What the spendable balance becomes after a top up or withdrawal of what is typed; the spendable balance as it is
 * while nothing valid is typed. Spendable, like the balance card: the NEAR kept for storage is never counted.
 */
export function balanceAfter(b: BudgetLive, panel: "topup" | "withdraw", amount: string): string {
  if (b.withdrawable === null) return "unknown";
  const yocto = BigInt(nearToYocto(amount) ?? 0);
  const after = panel === "topup" ? BigInt(b.withdrawable) + yocto : BigInt(b.withdrawable) - yocto;
  return near((after > 0n ? after : 0n).toString());
}

/** The pop-up for one owner action, with its signature count in plain words. `values.to` is the connected account. */
export function renderBudgetPanel(panel: BudgetPanel, b: BudgetLive, error: string | null = null, values: Record<string, string> = {}, now: number = Date.now(), dca: DcaView | null = null): Html {
  const v = (name: string, fallback = "") => values[name] ?? fallback;
  const p = b.guard?.policy ?? null;
  const field = (name: string, label: string, value: string, placeholder = "", opts: { mono?: boolean; unit?: boolean; hint?: string; was?: string } = {}) => {
    const describedBy = [error ? "bp-error" : "", opts.hint !== undefined ? `bp-${name}-hint` : ""].filter((t) => t !== "").join(" ");
    const input = html`<input id="bp-${name}" name="${name}" type="text" class="input${opts.mono ? " mono" : ""}" value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"${describedBy === "" ? "" : html` aria-describedby="${describedBy}"`}${opts.was === undefined ? "" : html` data-was="${opts.was}"`}>`;
    return html`<div class="stack-xs"><label class="label" for="bp-${name}">${label}${opts.was === undefined ? "" : html` <span class="small muted">(was ${opts.was})</span>`}</label>${opts.unit ? html`<div class="input-unit">${input}<span class="muted">NEAR</span></div>` : input}${opts.hint === undefined ? "" : html`<p id="bp-${name}-hint" class="small muted">${opts.hint}</p>`}</div>`;
  };
  const err = error ? html`<p id="bp-error" class="field-error" role="alert">${error}</p>` : "";
  const form = (title: string, note: string, body: Html, submit: string, opts: { disabled?: boolean } = {}) =>
    html`<form id="budget-panel-form" class="drawer-form" data-panel="${panel}" novalidate>${drawerHead(title, note)}
      <div class="drawer-body">${body}${err}</div>
      <div class="drawer-foot">${CANCEL}<button type="submit" class="btn btn-primary"${opts.disabled ? " disabled" : ""}>${submit}</button></div></form>`;
  switch (panel) {
    case "topup": {
      const blocked = v("blocked");
      return form(`Top up ${b.dao.dao}`, "Agents spend from this balance.", html`
        ${field("amount", "Amount", v("amount"), "5", { unit: true })}
        <div class="chips" role="group" aria-label="Quick amounts">${TOP_UP_CHIPS.map((n) => html`<button type="button" class="filter-chip" data-action="budget-chip" data-amount="${n}">${n}</button>`)}</div>
        <div class="sum-box">${sumRow("From", html`<span class="mono">${v("to", "your connected wallet")}</span>`)}${sumRow("Balance now", near(b.withdrawable))}${sumRow("Balance after", html`<span id="bp-after">${balanceAfter(b, "topup", v("amount"))}</span>`)}</div>
        ${blocked === ""
          ? ""
          : html`<p class="banner banner-high">${icon.alertSmall()}<span>${blocked}</span></p>
            <button type="button" class="btn btn-secondary btn-start" data-action="copy-command" data-command="${b.dao.dao}"><span data-copy-label>Copy budget account</span></button>`}
        ${sigLine(1)}`, "Top up", { disabled: blocked !== "" });
    }
    case "withdraw": {
      const max = withdrawMaxYocto(b);
      const maxNear = max === null ? null : yoctoToNear(max);
      const left = withdrawLeftText(b, v("amount"));
      const typed = v("amount").trim();
      return form(`Withdraw from ${b.dao.dao}`, "Move NEAR back to your wallet.", html`
        <div class="stack-xs">
          <label class="label" for="bp-amount">Amount</label>
          <div class="input-unit">
            <input id="bp-amount" name="amount" type="text" class="input" value="${v("amount")}" placeholder="1" autocomplete="off" spellcheck="false" inputmode="decimal"${maxNear === null ? "" : html` aria-describedby="bp-amount-hint${error ? " bp-error" : ""}"`}>
            ${maxNear === null ? "" : html`<button type="button" class="btn btn-ghost btn-max" data-action="budget-full" data-amount="${maxNear}" aria-label="Withdraw the most you can, ${maxNear} NEAR">Max</button>`}
            <span class="muted">NEAR</span>
          </div>
          ${maxNear === null
            ? ""
            : html`<p id="bp-amount-hint" class="small muted">Up to <button type="button" class="link-btn" data-action="budget-full" data-amount="${maxNear}">${maxNear} NEAR</button>. Requests waiting for you keep their deposit in the budget.</p>`}
        </div>
        <div class="sum-box">${sumRow("To", html`<span class="mono">${v("to", "your connected wallet")}</span>`)}</div>
        <p id="bp-left" class="small ${left.empty ? "tone-cleanup" : "muted"}">${left.text}</p>
        ${twoSignatureSteps(b.dao.policy.proposal_bond, html`<span id="bp-echo">${typed === "" ? "the amount above" : `${typed} NEAR`}</span>`)}`, "Withdraw");
    }
    case "rules": {
      const was = (yocto: string | undefined) => (yocto === undefined ? undefined : `${yoctoToNear(yocto)} NEAR`);
      const agents = b.guard?.agents?.length ?? b.guard?.config?.agents ?? null;
      const recipients = b.guard?.whitelist?.length ?? b.guard?.config?.whitelist ?? null;
      const perTx = v("maxPerTx", near2(p?.max_per_tx));
      const perDay = v("maxPerDay", near2(p?.max_per_day));
      const changed = p !== null && (perTx !== near2(p.max_per_tx) || perDay !== near2(p.max_per_day) || v("maxPending", String(p.max_pending_per_agent)) !== String(p.max_pending_per_agent) || v("minReserve", near2(p.min_reserve)) !== near2(p.min_reserve));
      return form("Edit the fence", `${b.dao.dao} · changes apply after you sign`, html`
        <div class="grid-2">
          ${field("maxPerTx", "Per payment", perTx, "", { unit: true, was: was(p?.max_per_tx) })}
          ${field("maxPerDay", "Per day", perDay, "", { unit: true, was: was(p?.max_per_day), hint: "Rolling 24 hours." })}
          ${field("maxPending", "Requests that can wait per agent", v("maxPending", p === null ? "" : String(p.max_pending_per_agent)), "", { hint: "Extra requests are refused until you answer.", was: p === null ? undefined : String(p.max_pending_per_agent) })}
          ${field("minReserve", "Contract keeps for its fees", v("minReserve", near2(p?.min_reserve)), "", { unit: true, was: was(p?.min_reserve), hint: "NEAR the spending contract keeps for itself. Not budget money; 0 is fine." })}
        </div>
        <p id="bp-fence-error" class="field-error" role="alert" hidden>Per payment cannot be more than per day.</p>
        <p id="bp-summary" class="budget-summary" data-agents="${agents ?? ""}" data-recipients="${recipients ?? ""}">${fenceSentence(agents, `${perDay} NEAR`, `${perTx} NEAR`, recipients)}</p>
        ${twoSignatureSteps(b.dao.policy.proposal_bond)}`, "Save changes", { disabled: !changed });
    }
    case "add-agent":
      return form("Add an agent", "It follows the same fence.", html`
        ${field("label", "Agent name", v("label"), "payroll bot")}
        ${agentLimits(b.dao.dao)}
        <p class="small muted">This page makes the agent's key and its own account. ${yoctoToNear(NEW_AGENT_DEPOSIT)} NEAR leaves the Budget: 0.5 NEAR is the agent's gas, the rest pays for storage and what is not used comes back. You then get the key file and the command for your agent.</p>
        ${twoSignatureSteps(b.dao.policy.proposal_bond)}`, "Add agent");
    case "recipients":
      return form("Who agents can pay", "Payments to anyone else wait for you.", html`
        ${recipientList(b.guard?.whitelist ?? null)}
        ${field("account", "Add a recipient", v("account"), "vendor.kdoncall.testnet", { mono: true })}
        ${field("label", "Name (optional)", v("label"), "vendor")}
        ${field("cap", "Limit per payment (optional)", v("cap"), "2", { unit: true, hint: "Leave empty to use the fence limit." })}
        <p class="small muted">Each add or remove is its own request. A small storage deposit leaves the Budget when you add one; what is not used comes back.</p>
        ${twoSignatureSteps(b.dao.policy.proposal_bond)}`, "Add recipient");
    case "plan":
      return planPanel(b, error, values, now, field, err);
    case "dca":
      return dcaPanel(b, error, values, now, field, err, dca);
  }
}

/** What the DCA pop-up needs besides the Budget: the network, the live checklist reads and the price quote of one run. */
export interface DcaView {
  network: Network;
  /** null while the checklist reads are unread or failed. */
  readiness: DcaReadiness | null;
  /** The exchange's answer for one run, in USDT base units; null when unread. */
  quote: string | null;
  /** True when this build knows the factory to update from. */
  canUpdate: boolean;
}

type CheckState = "done" | "todo" | "unknown";
interface CheckItem {
  label: string;
  state: CheckState;
  /** The button that fixes a todo item. */
  fix?: Html;
}

/** The DCA checklist (§11.11.4), in the order the owner does it. Start is possible only when every item is done. */
function dcaChecklist(b: BudgetLive, dca: DcaView | null, connected: boolean): CheckItem[] {
  const g = b.guard;
  const r = dca?.readiness ?? null;
  const fixBtn = (action: string, label: string, disabled = false) =>
    html`<button type="button" class="btn btn-secondary" data-action="${action}"${disabled ? " disabled" : ""}>${label} <span class="sig">${signatures(2)}</span></button>`;
  const items: CheckItem[] = [
    connected
      ? { label: "Wallet connected", state: "done" }
      : { label: "Connect the owner's wallet", state: "todo", fix: html`<button type="button" class="btn btn-secondary" data-action="open-wallet">Connect Wallet</button>` },
  ];
  if (r === null) items.push({ label: "Checking your Budget…", state: "unknown" });
  else if (r.version === null) items.push({ label: "Could not read the Budget version", state: "unknown" });
  else if (guardNeedsUpdate(r.version)) items.push({ label: "Update your Budget so it can swap", state: "todo", fix: fixBtn("dca-upgrade", "Update your Budget", !dca?.canUpdate || r.latestHash === null) });
  else items.push({ label: "Budget is up to date", state: "done" });
  items.push(g !== null && hasSwapRights(b.dao.policy, g.guard_id) ? { label: "Swaps are allowed", state: "done" } : { label: "Allow swaps for this Budget", state: "todo", fix: fixBtn("dca-allow", "Allow swaps") });
  if (r === null || r.registrations === null) items.push({ label: "Could not read the USDT setup", state: "unknown" });
  else {
    const missing = r.registrations.filter((x) => !x.registered).length;
    items.push(missing === 0 ? { label: "USDT is enabled", state: "done" } : { label: "Enable USDT for this Budget", state: "todo", fix: fixBtn("dca-usdt", "Enable USDT") });
  }
  return items;
}

const checklistHtml = (items: CheckItem[]): Html =>
  html`<ul class="plain-list k5-checks">${items.map((i) => html`<li class="k5-check"><span class="k5-mark ${i.state === "done" ? "k5-ok" : "k5-warn"}">${i.state === "done" ? icon.check() : icon.alertSmall()}</span><span class="grow-min">${i.label}</span>${i.fix ?? ""}</li>`)}</ul>`;

const DCA_UNIT_LABELS: Record<DcaUnit, string> = { minutes: "minutes", hours: "hours", days: "days", weeks: "weeks" };

/**
 * DCA setup (GĐ31): the checklist, the form, then a review the owner checks before signing. Testnet only: on mainnet it
 * says so and offers no Start. A review that no longer passes goes back to the edit step with the reason.
 */
function dcaPanel(b: BudgetLive, error: string | null, values: Record<string, string>, now: number, field: Field, err: Html | "", dca: DcaView | null): Html {
  const v = (name: string, fallback = "") => values[name] ?? fallback;
  const g = b.guard;
  const title = "Sell NEAR for USDT";
  const note = `${b.dao.dao} sells a little NEAR for USDT on a timetable.`;
  const shell = (body: Html, foot: Html) => html`<form id="budget-panel-form" class="drawer-form" data-panel="dca" novalidate>${drawerHead(title, note)}
      <div class="drawer-body">${body}${err}</div><div class="drawer-foot">${foot}</div></form>`;
  if (dca !== null && dca.network !== "testnet") {
    return shell(html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>Selling NEAR for USDT runs on testnet only for now. It is not available on mainnet.</span></p>`, html`<button type="button" class="btn btn-secondary" data-action="close-dialog">Close</button>`);
  }
  const items = dcaChecklist(b, dca, v("connected") === "1");
  const ready = items.every((i) => i.state === "done");
  const checked = values.step === "confirm" && error === null ? dcaFromForm(values, { policy: g?.policy ?? null }, now) : null;
  const unit = v("unit", "days");
  const stop = v("stop", "times");
  const slippage = v("slippage", String(DCA_DEFAULT_SLIPPAGE));
  if (checked !== null && checked.ok) {
    const plan = checked.value;
    const t = planTotals(plan, b.withdrawable);
    const hidden = ["amount", "every", "unit", "stop", "runs", "end", "slippage", "start"].map((k) => html`<input type="hidden" name="${k}" value="${v(k)}">`);
    const maxDay = g?.policy?.max_per_day ?? null;
    const overDay = maxDay !== null && BigInt(t.per_day) > BigInt(maxDay);
    const left = maxDay === null || g?.window == null ? null : BigInt(maxDay) - BigInt(g.window.spent_in_window);
    const quote = dca?.quote ?? null;
    const price = quote === null ? null : dcaPrice(plan.amount.yocto, quote);
    return shell(html`<input type="hidden" name="step" value="confirm">${hidden}
      <div class="sum-box">
        ${sumRow("Sell each time", `${plan.amount.near} NEAR`)}
        ${sumRow("Every", everyText(plan.interval_sec))}
        ${sumRow("How many times", String(plan.runs))}
        ${sumRow("First run", plan.starts_now ? "Right away" : formatUtc(new Date(plan.start_ms).toISOString()))}
        ${sumRow("Last run", formatUtc(new Date(t.last_run_ms).toISOString()))}
        ${sumRow("Total to sell", near(t.total))}
        ${sumRow("Max price drop", `${plan.slippage_bps / 100} %`)}
        ${sumRow("Spendable now", near(b.withdrawable))}
        ${left === null ? "" : sumRow("Left today for agents", near((left > 0n ? left : 0n).toString()))}
      </div>
      ${quote === null
        ? html`<p class="small muted">The current price could not be read. The sale still checks it at every run.</p>`
        : html`<p class="small">Right now ${plan.amount.near} NEAR gets about ${formatUnits(quote, DCA_TESTNET.token_out_decimals)} USDT${price === null ? "" : html` (${price} USDT per NEAR)`}, testnet price.</p>`}
      ${t.short === null
        ? html`<p class="check-line">${icon.alert()}<span>Could not read the balance, so the page cannot tell whether it covers every run.</span></p>`
        : BigInt(t.short) > 0n
          ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>The Budget is ${near(t.short)} short of all runs. The plan still starts; it pauses and alerts you when the money runs out. Top up first to cover it.</span></p>`
          : ""}
      ${overDay ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>Up to ${t.runs_per_day} runs fall in one 24 hours (${near(t.per_day)}), above your 24-hour limit of ${near(maxDay)}. A run over the limit moves to the next slot; it is not lost.</span></p>` : ""}
      ${checklistHtml(items)}
      <p class="small muted">Each run counts against the same 24-hour limit as your agents' payments. Key Doctor fee: free during testing. Prices can change. This is not investment advice.</p>
      <p class="small muted">0.01 NEAR storage deposit leaves the Budget; what is not used comes back.</p>
      ${twoSignatureSteps(b.dao.policy.proposal_bond)}`,
      html`<button type="button" class="btn btn-secondary" data-action="budget-dca-edit">Back</button><button type="submit" class="btn btn-primary"${ready ? "" : " disabled"}>Start selling</button>`);
  }
  const body = html`<input type="hidden" name="step" value="edit">
    <input type="hidden" name="connected" value="${v("connected")}">
    ${checklistHtml(items)}
    ${field("amount", "NEAR to sell each time", v("amount"), "0.1", { unit: true })}
    <div class="grid-2">
      <div class="stack-xs"><label class="label" for="bp-every">How often</label>
        <div class="input-unit"><input id="bp-every" name="every" type="text" inputmode="numeric" class="input" value="${v("every", "1")}" autocomplete="off">
          <select name="unit" class="input" aria-label="Unit">${(Object.keys(DCA_UNITS) as DcaUnit[]).map((u) => html`<option value="${u}"${u === unit ? " selected" : ""}>${DCA_UNIT_LABELS[u]}</option>`)}</select></div></div>
      <div class="stack-xs"><label class="label" for="bp-slippage">Max price drop</label>
        <select id="bp-slippage" name="slippage" class="input">${DCA_SLIPPAGE_CHOICES.map((bps) => html`<option value="${bps}"${String(bps) === slippage ? " selected" : ""}>${bps / 100} %</option>`)}</select></div>
    </div>
    <div class="grid-2">
      <div class="stack-xs"><label class="label" for="bp-stop">Stop</label>
        <select id="bp-stop" name="stop" class="input"><option value="times"${stop === "times" ? " selected" : ""}>After a number of times</option><option value="date"${stop === "date" ? " selected" : ""}>On an end date</option></select></div>
      ${stop === "date"
        ? html`<div class="stack-xs"><label class="label" for="bp-end">End date (your local time)</label><input id="bp-end" name="end" type="datetime-local" class="input" value="${v("end")}"></div>`
        : field("runs", "How many times", v("runs", "10"))}
    </div>
    <div class="stack-xs"><label class="label" for="bp-start">First run (your local time, optional)</label>
      <input id="bp-start" name="start" type="datetime-local" class="input" value="${v("start")}"><p class="small muted">Empty or past: the first run is due right away.</p></div>
    <p class="small muted">If the price drops more than the max between the quote and the swap, that run is skipped. Runs must fit your fence: ${near(g?.policy?.max_per_tx)} per payment, ${near(g?.policy?.max_per_day)} a day.</p>
    ${twoSignatureSteps(b.dao.policy.proposal_bond)}`;
  return shell(body, html`${CANCEL}<button type="submit" class="btn btn-primary">Review</button>`);
}

type Field = (name: string, label: string, value: string, placeholder?: string, opts?: { mono?: boolean; unit?: boolean }) => Html;

const PLAN_UNIT_LABELS: Record<PlanUnit, string> = { minutes: "minutes", hours: "hours", days: "days" };

/**
 * Scheduled payouts setup (§11.11.4): the form, then a review the owner checks before signing. A balance short of all
 * runs does not block: the plan starts and pauses with an alert when the money runs out. The review re-checks the
 * form, and a form that no longer passes goes back to the edit step with the reason.
 */
function planPanel(b: BudgetLive, error: string | null, values: Record<string, string>, now: number, field: Field, err: Html | ""): Html {
  const v = (name: string, fallback = "") => values[name] ?? fallback;
  const g = b.guard;
  const rules = { policy: g?.policy ?? null, whitelist: g?.whitelist ?? null };
  const checked = values.step === "confirm" && error === null ? planFromForm(values, rules, now) : null;
  const shell = (body: Html, foot: Html) => html`<form id="budget-panel-form" class="drawer-form" data-panel="plan" novalidate>${drawerHead("New scheduled payout", `${b.dao.dao} pays a recipient on a timetable.`)}
      <div class="drawer-body">${body}${checked !== null && !checked.ok ? html`<p id="bp-error" class="field-error" role="alert">${checked.error}</p>` : err}</div>
      <div class="drawer-foot">${foot}</div></form>`;
  if (checked !== null && checked.ok) {
    const plan = checked.value;
    const t = planTotals(plan, b.withdrawable);
    const hidden = ["receiver", "amount", "every", "unit", "runs", "start"].map((k) => html`<input type="hidden" name="${k}" value="${v(k)}">`);
    const maxDay = g?.policy?.max_per_day ?? null;
    const overDay = maxDay !== null && BigInt(t.per_day) > BigInt(maxDay);
    return shell(html`<input type="hidden" name="step" value="confirm">${hidden}
      <div class="sum-box">
        ${sumRow("To", html`<span class="mono">${plan.receiver}</span>`)}
        ${sumRow("Amount each time", `${plan.amount.near} NEAR`)}
        ${sumRow("Every", everyText(plan.interval_sec))}
        ${sumRow("How many times", String(plan.runs))}
        ${sumRow("First payment", plan.starts_now ? "Right away" : formatUtc(new Date(plan.start_ms).toISOString()))}
        ${sumRow("Last payment", formatUtc(new Date(t.last_run_ms).toISOString()))}
        ${sumRow("Total", near(t.total))}
        ${sumRow("Spendable now", near(b.withdrawable))}
      </div>
      ${t.short === null
        ? html`<p class="check-line">${icon.alert()}<span>Could not read the balance, so the page cannot tell whether it covers every run.</span></p>`
        : BigInt(t.short) > 0n
          ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>The Budget is ${near(t.short)} short of all runs. The plan still starts; it pauses and alerts you when the money runs out.${t.partial !== null && BigInt(t.partial) > 0n ? ` Top up at least ${near(t.partial)} to cover the next ${plan.runs < 2 ? "run" : "2 runs"}.` : ""}</span></p>`
          : ""}
      ${overDay ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>Up to ${t.runs_per_day} runs fall in one 24 hours (${near(t.per_day)}), above your 24-hour limit of ${near(maxDay)}. A run over the limit moves to the next slot; it is not lost.</span></p>` : ""}
      <p class="small muted">Each run counts against the same 24-hour limit as your agents' payments. Key Doctor fee: free during testing. Prices can change. This is not investment advice.</p>
      <p class="small muted">0.01 NEAR storage deposit leaves the Budget; what is not used comes back.</p>
      ${twoSignatureSteps(b.dao.policy.proposal_bond)}`,
      html`<button type="button" class="btn btn-secondary" data-action="budget-plan-edit">Back</button><button type="submit" class="btn btn-primary">Start schedule</button>`);
  }
  const list = (rules.whitelist ?? []).filter((w) => w.account_id !== KEEPER_ACCOUNT);
  const to = v("receiver", list[0]?.account_id ?? "");
  const unit = v("unit", "days");
  const start = v("start");
  const body = rules.whitelist === null
    ? html`<p class="check-line">${icon.alert()}<span>Could not read your recipients right now. Reload and try again.</span></p>`
    : list.length === 0
      ? html`<p class="banner banner-cleanup">${icon.info()}<span>Add a recipient first: a scheduled payout pays someone you allow.</span></p>
        <button type="button" class="btn btn-ghost btn-start" data-action="budget-open" data-panel="recipients">Manage recipients</button>`
      : html`<div class="stack-xs"><label class="label" for="bp-receiver">Pay to</label>
          <select id="bp-receiver" name="receiver" class="input mono">${list.map((w) => html`<option value="${w.account_id}"${w.account_id === to ? " selected" : ""}>${w.label === "" ? w.account_id : `${w.label} (${w.account_id})`}</option>`)}</select></div>
        ${field("amount", "Amount each time", v("amount"), "1", { unit: true })}
        <div class="grid-2">
          <div class="stack-xs"><label class="label" for="bp-every">How often</label>
            <div class="input-unit"><input id="bp-every" name="every" type="text" inputmode="numeric" class="input" value="${v("every", "1")}" autocomplete="off">
              <select name="unit" class="input" aria-label="Unit">${(Object.keys(PLAN_UNITS) as PlanUnit[]).map((u) => html`<option value="${u}"${u === unit ? " selected" : ""}>${PLAN_UNIT_LABELS[u]}</option>`)}</select></div></div>
          ${field("runs", "How many times", v("runs", "3"))}
        </div>
        <div class="stack-xs"><label class="label" for="bp-start">First payment (your local time, optional)</label>
          <input id="bp-start" name="start" type="datetime-local" class="input" value="${start}"><p class="small muted">Empty or past: the first payment is due right away.</p></div>
        <p class="small muted">Each payment is made when it is due. Payments must fit your fence: ${near(g?.policy?.max_per_tx)} per payment, ${near(g?.policy?.max_per_day)} a day.</p>
        ${twoSignatureSteps(b.dao.policy.proposal_bond)}`;
  return shell(html`<input type="hidden" name="step" value="edit">${body}`,
    html`${CANCEL}<button type="submit" class="btn btn-primary"${list.length === 0 ? " disabled" : ""}>Review</button>`);
}

/** What is on the list now, each with its own two-signature Remove. Unknown is said, never shown as an empty list. */
function recipientList(list: NonNullable<GuardLive["whitelist"]> | null): Html {
  if (list === null) return html`<p class="check-line">${icon.alert()}<span>Could not read the list right now. It is unknown, not empty.</span></p>`;
  if (list.length === 0) return html`<p class="banner banner-cleanup">${icon.info()}<span>No recipients yet: every payment your agent asks for will wait for your approval.</span></p>`;
  return html`<ul class="plain-list">${list.map((w) => html`<li class="recipient-row"><span class="stack-xs grow-min"><span class="mono wrap">${w.account_id}</span>${w.label === "" && w.max_per_tx === null ? "" : html`<span class="small muted">${[w.label, w.max_per_tx === null ? "" : `up to ${near(w.max_per_tx)} per payment`].filter((t) => t !== "").join(" · ")}</span>`}</span>
    <button type="button" class="btn btn-ghost" data-action="budget-recipient-drop" data-account="${w.account_id}" aria-label="Remove ${w.account_id}">Remove</button></li>`)}</ul>`;
}

/** The check before Approve: what will be paid and why it waited. A recipient not on the list needs the amount typed back. */
export function renderBudgetApprove(p: BudgetProposal, b: BudgetLive, now: number = Date.now()): Html {
  const r = requestOf(b, p);
  const g = b.guard;
  const left = hoursLeft(p, b, now);
  const expiry = expiryText(left);
  if (left === 0) {
    return html`${drawerHead("This request expired", "Nobody answered in time, so it can no longer be approved.", true)}
      <div class="drawer-body"><p class="muted">${r === null ? describeKind(p.kind) : `${agentName(g, r.agent)} asked to pay ${near(r.amount)} to ${r.receiver_id}.`} The agent can ask again.</p></div>
      <div class="drawer-foot"><button type="button" class="btn btn-secondary" data-action="close-dialog">Close</button></div>`;
  }
  const unknown = r?.reasons.includes("NOT_WHITELISTED") === true;
  const sub = r === null ? "It waits for your approval." : [agentName(g, r.agent), b.dao.dao, expiry === null ? null : expiry.replace("Expires", "expires")].filter((t) => t !== null).join(" · ");
  const check = (ok: boolean, text: string) => html`<li class="k5-check"><span class="k5-mark ${ok ? "k5-ok" : "k5-warn"}">${ok ? icon.check() : icon.alertSmall()}</span><span>${text}</span></li>`;
  const checks = (req: BudgetRequest): Html => {
    const amount = BigInt(req.amount);
    const after = b.withdrawable === null ? null : BigInt(b.withdrawable) - amount;
    const w = g?.window ?? null;
    const dayMax = g?.policy?.max_per_day ?? null;
    const dayAfter = w === null ? null : BigInt(w.spent_in_window) + amount;
    const cap = g?.whitelist?.find((x) => x.account_id === req.receiver_id)?.max_per_tx ?? null;
    return html`<ul class="plain-list k5-checks">
      ${check(!unknown, unknown ? `${req.receiver_id} is not on your recipient list` : `${req.receiver_id} is on your recipient list${cap === null ? "" : `, up to ${near(cap)} per payment`}`)}
      ${after === null ? check(false, "Balance unknown right now") : check(after >= 0n, after >= 0n ? `Balance after: ${near(after.toString())}. ${near(g?.policy?.min_reserve)} stays in the budget.` : `The balance is ${near(b.withdrawable)}: not enough for this payment`)}
      ${dayAfter === null || dayMax === null ? check(false, "Today's spending unknown right now") : check(dayAfter <= BigInt(dayMax), `Today: ${yoctoToNear(dayAfter.toString())} of ${near(dayMax)} after this payment`)}
    </ul>`;
  };
  const why = r === null || r.reasons.length === 0 ? "" : html`<div class="stack-xs"><h3 class="drawer-h3">Why it waited</h3><ul class="list small">${r.reasons.map((c) => html`<li>${reasonText(c, g, r.receiver_id)}</li>`)}</ul></div>`;
  return html`${drawerHead(r === null ? `Approve request #${p.id}?` : "Approve this payment?", sub, true)}
    <div class="drawer-body">
      ${r === null
        ? html`<div class="sum-box">${sumRow("What it does", describeKind(p.kind))}${expiry === null ? "" : sumRow("Time left", expiry)}</div>`
        : html`<div class="k5-amount-box"><p class="k5-amount">${yoctoToNear(r.amount)} <span>NEAR</span></p><p>to <span class="mono wrap">${r.receiver_id}</span></p>${r.memo === "" ? "" : html`<p class="small muted">Agent's note: “${r.memo}”</p>`}</div>
          ${why}${checks(r)}`}
      ${unknown && r !== null
        ? html`<p class="banner banner-high">${icon.alertSmall()}<span>You have not allowed this recipient. Check the account before you approve.</span></p>
          <div class="stack-xs"><label class="label" for="approve-check">Type ${yoctoToNear(r.amount)} to confirm</label>
            <input id="approve-check" type="text" class="input" autocomplete="off" spellcheck="false" data-expect="${yoctoToNear(r.amount)}"></div>`
        : ""}
      <p class="small muted">Approve and Reject each ask your wallet for one signature. The page checks the request against the chain first.</p>
      ${sigLine(1)}
    </div>
    <div class="drawer-foot"><button type="button" class="btn btn-danger" data-action="budget-act" data-id="${p.id}" data-vote="VoteReject">Reject</button>
      <button type="button" class="btn btn-primary" data-action="budget-act" data-id="${p.id}" data-vote="VoteApprove"${unknown ? " disabled" : ""}>Approve and sign</button></div>`;
}

/** The short "what an agent can do" of §11.12, with the way to the full guide. */
function agentLimits(dao: string): Html {
  return html`<div class="stack-xs"><h3 class="drawer-h3">What this agent can do</h3><ul class="list small">
      <li>See your rules, balance and what is left for today</li><li>Ask to pay one recipient, paid at once if it is within your rules</li><li>See the status of its own requests</li></ul></div>
    <div class="stack-xs"><h3 class="drawer-h3">What it cannot do</h3><p class="small muted">The blockchain enforces this, not the agent.</p><ul class="list small">
      <li>Withdraw from the Budget</li><li>Change rules, add recipients or raise limits</li><li>Approve its own larger payments</li><li>Add or remove other agents</li><li>Call any other contract</li><li>Use your key</li></ul></div>
    <a class="small" href="${agentGuideHref(dao)}" target="_blank" rel="noopener">How your agent works</a>`;
}

/** What one agent can and cannot do, and the owner's controls over it. */
export function renderBudgetAgent(a: NonNullable<GuardLive["agents"]>[number], b: BudgetLive): Html {
  const period = proposalPeriod(b);
  return html`${drawerHead(a.label === "" ? a.account_id : a.label, `${a.enabled ? "On" : "Off"} · ${agentUse(a)}`)}
    <div class="drawer-body">
      ${agentLimits(b.dao.dao)}
      <div class="stack-xs"><h3 class="drawer-h3">When it asks to pay</h3><ul class="list small">
        <li><strong>Paid at once:</strong> the recipient is on your list and the amount fits the per-request and 24-hour limits.</li>
        <li><strong>Waits for you:</strong> any of those fails.${period === null ? "" : ` It expires in ${hours(Number(period / 3_600_000_000_000n))}.`}</li>
        <li><strong>Rejected at once:</strong> agents paused, agent off, too many waiting, or a duplicate.</li></ul></div>
      <p class="small mono wrap">${a.account_id}</p>
    </div>
    <div class="drawer-foot">
      <button type="button" class="btn btn-danger" data-action="budget-agent" data-op="remove" data-agent="${a.account_id}">Remove <span class="sig">${signatures(2)}</span></button>
      <button type="button" class="btn ${a.enabled ? "btn-danger" : "btn-primary"}" data-action="budget-agent" data-op="${a.enabled ? "disable" : "enable"}" data-agent="${a.account_id}">${a.enabled ? "Turn off agent" : "Turn on agent"} <span class="sig">${signatures(2)}</span></button>
    </div>`;
}

const CHANGE_NAME: Record<string, string> = {
  set_policy: "Change the spending rules",
  add_agent: "Add an agent",
  remove_agent: "Remove an agent",
  set_agent_enabled: "Turn an agent on or off",
  add_whitelist: "Add a recipient",
  remove_whitelist: "Remove a recipient",
  unpause: "Resume this Budget",
  upgrade: "Update your Budget",
  create_plan: "Start a plan",
};

/** The built request in the owner's words; what this page did not name keeps its on-chain description. */
function changeName(description: string): string {
  return CHANGE_NAME[/^Agent Guard \S+: (\w+)$/.exec(description)?.[1] ?? ""] ?? description;
}

/** What the owner sees between the two signatures: the id from the outcome, matched, ready for signature 2. */
export function renderBudgetNext(id: number, description: string): Html {
  return html`<section class="card pad stack-sm" aria-labelledby="bn-title">
    <h2 id="bn-title" class="h2">Signature 2 of 2</h2>
    <p class="small">Request #${id} on the chain matches what this page built: <span class="strong">${changeName(description)}</span>.</p>
    <div class="actions"><button type="button" class="btn btn-primary" data-action="budget-sign2">Approve request #${id} in wallet</button></div></section>`;
}

/** The test line of §11.12.7: the first thing to ask an agent once it is plugged in. */
export const AGENT_TEST_PROMPT = "How much can I still spend today?";

/** The three steps of §11.12.7. The private key exists only on this page, so saving it comes before anything else. */
function agentConnect(agent: string, guardId: string, dao: string, network: Network): Html {
  const move = `mkdir -p ~/.config/key-doctor && mv ~/Downloads/${agent}.json ~/.config/key-doctor/ && chmod 600 ~/.config/key-doctor/${agent}.json`;
  return html`<ol class="plain drawer-steps">
      <li><span class="step-dot">1</span><div class="stack-xs grow-min"><strong>Save the agent's key</strong>
        <p class="small strong">It exists only on this page, and leaving loses it.</p>
        <button type="button" class="btn btn-primary btn-start" data-action="budget-key">Download agent key</button>
        <p class="small muted">Do not send this file to anyone. It only lets the agent ask to spend within your rules; it cannot withdraw money.</p>
        <p class="small muted">Then move it where the agent reads it:</p>${copyRow(move)}</div></li>
      <li><span class="step-dot">2</span><div class="stack-xs grow-min"><strong>Connect it to Claude Code</strong>
        <p class="small muted">Run this inside a clone of the Key Doctor repo.</p>${copyRow(guardMcpCommand(network, guardId, agent))}</div></li>
      <li><span class="step-dot">3</span><div class="stack-xs grow-min"><strong>Ask your agent</strong>${copyRow(AGENT_TEST_PROMPT)}
        <a class="small" href="${agentGuideHref(dao)}" target="_blank" rel="noopener">How your agent works</a></div></li>
    </ol>`;
}

/** After the last signature of Add an agent. */
export function renderAgentAdded(agent: string, guardId: string, dao: string, network: Network, problem: string | null): Html {
  return html`<section class="card pad stack-sm" aria-labelledby="aa-title">
    <h2 id="aa-title" class="h2">Connect your agent</h2>
    <p class="small">${problem === null ? html`<span class="mono">${agent}</span> is added and checked against the chain.` : `Your approval went through, but the chain does not show a finished agent: ${problem}.`}</p>
    ${agentConnect(agent, guardId, dao, network)}
    <div class="actions"><a class="btn btn-tint" href="${budgetHref(dao)}" data-nav>Back to the Budget</a></div>
  </section>`;
}

/** The Balanced preset (docs/final-idea.md example). Custom opens these same fields. */
export const BALANCED_RULES: Readonly<Record<string, string>> = { maxPerTx: "5", maxPerDay: "20", maxPendingPerAgent: "3", minReserve: "0" };
/** §10.3 names this preset without numbers: these are a quarter of Balanced's 24-hour limit, with a tight per-request one. */
export const CAUTIOUS_RULES: Readonly<Record<string, string>> = { maxPerTx: "1", maxPerDay: "5", maxPendingPerAgent: "2", minReserve: "0" };

const STEPS: ReadonlyArray<readonly [string, string]> = [
  ["Create", "Pick rules for how much your agent can spend."],
  ["Top up", "Move only what the agent may use. Withdraw anytime."],
  ["Connect your agent", "Small payments go through. Larger ones wait for you."],
];

const WIZARD_LEAD = "About 2 minutes. You sign twice in your wallet at the end; nothing is created before that.";

/** The fields a step shows. The others ride along as hidden inputs, so one form always holds the whole wizard. */
const STEP_FIELDS: Record<number, readonly string[]> = {
  1: ["name", "maxPerTx", "maxPerDay", "maxPendingPerAgent", "minReserve", "funding", "fundingAuto"],
  2: [],
  3: ["agentLabel"],
  4: [],
};
const CARRIED = ["name", "maxPerTx", "maxPerDay", "maxPendingPerAgent", "minReserve", "funding", "fundingAuto", "agentLabel"];
/** The rule fields of step 1 with the one line under each that says what to type. */
const FENCE_LABELS: ReadonlyArray<readonly [string, string, string]> = [
  ["maxPerTx", "Per payment (NEAR)", "The biggest single payment your agent can make without asking you. Anything bigger waits for your approval."],
  ["maxPerDay", "Per day (NEAR)", "The most your agents can pay in any 24 hours without asking you. Scheduled payouts count too."],
  ["maxPendingPerAgent", "Waiting payments per agent", "How many payments can wait for your approval at once. Each one holds a 0.1 NEAR deposit you get back."],
];

/** Step 1's money line: what signature 1 sends, before any spending money. Null code storage: not read yet. */
export function setupCostText(values: Record<string, string>, codeStorageYocto: string | null): string {
  const cost = createCost(values.funding ?? "", codeStorageYocto);
  if (cost === null) return "Creating this budget costs at least 6 NEAR in signature 1. The exact amount shows once it is read from the chain.";
  return `Creating this budget costs about ${yoctoToNear(cost.total)} NEAR in signature 1: ${yoctoToNear(cost.account)} NEAR for the budget account's storage, ${yoctoToNear(cost.contract)} NEAR for the spending contract and ${yoctoToNear(cost.fees)} NEAR set aside for fees. Spending money comes later, with Top up.`;
}

const nearAmount = (v: string): string => `${v.trim()} NEAR`;

/** The plain sentence at the top of Review. */
export function reviewSentence(agent: string, perPay: string, perDay: string, recipients: number): string {
  const to = recipients === 0 ? "only to accounts you approve each time" : `only to ${plural(recipients, "recipient")}`;
  return `${agent} can spend up to ${nearAmount(perPay)} per payment and ${nearAmount(perDay)} a day, ${to}.`;
}

/** A recipient row. Its account is checked against the chain as it is typed. */
function recipientRow(r: RecipientRow, i: number, errors: SetupError[]): Html {
  const own = errors.filter((e) => e.field.startsWith(`whitelist.${i}.`));
  const bad = (part: string) => (own.some((e) => e.field.endsWith(part)) ? html` aria-invalid="true"` : "");
  return html`<div class="rcpt-row" data-rcpt>
    <div class="rcpt-cell rcpt-account"><input name="r-account" class="input mono" value="${r.account}" placeholder="vendor.testnet" aria-label="Account" autocomplete="off" autocapitalize="none" spellcheck="false"${bad("account_id")}>
      <span class="rcpt-check small" role="status"></span></div>
    <input name="r-label" class="input" value="${r.label}" placeholder="Name" aria-label="Name" autocomplete="off"${bad("label")}>
    <input name="r-cap" class="input" value="${r.cap}" placeholder="No limit" inputmode="decimal" aria-label="Limit in NEAR (optional)" autocomplete="off"${bad("max_per_tx")}>
    <button type="button" class="icon-btn" data-action="budget-recipient-remove" data-row="${i}" aria-label="Remove recipient ${i + 1}">${icon.close()}</button>
    ${own.length > 0 ? html`<p class="field-error rcpt-error">${own.map(setupErrorText).join(" ")}</p>` : ""}</div>`;
}

/** What sits inside the recipient list: the empty note, or a header and one row each. */
export function renderRecipientList(rows: readonly RecipientRow[], errors: SetupError[] = []): Html {
  if (rows.length === 0) return html`<p class="banner banner-cleanup">${icon.info()}<span>No recipients yet. Every payment your agents ask for will wait for you.</span></p>`;
  return html`<div class="rcpt-head small muted" aria-hidden="true"><span>Account</span><span>Name</span><span>Limit (optional)</span><span></span></div>${rows.map((r, i) => recipientRow(r, i, errors))}
    ${errors.filter((e) => e.field === "whitelist").map((e) => html`<p class="field-error">${setupErrorText(e)}</p>`)}`;
}

/** The wizard for a new Budget: Fence, Recipients, Agent, Review. `available` is false while the factory is not deployed. */
export function renderBudgetSetup(available: boolean, values: Record<string, string> = {}, errors: SetupError[] = [], result: string | null = null, at: number = 1, codeStorageYocto: string | null = null): Html {
  const step = Math.min(4, Math.max(1, Math.trunc(at) || 1));
  const all = applyAutoFunding({ ...BALANCED_RULES, ...values });
  const val = (name: string): string => all[name] ?? "";
  const errorFor = (name: string) => errors.filter((e) => e.field === name);
  const invalid = (name: string) => (errorFor(name).length > 0 ? html` aria-invalid="true" aria-describedby="bs-${name}-error"` : "");
  const fieldError = (name: string) => (errorFor(name).length > 0 ? html`<p id="bs-${name}-error" class="field-error">${errorFor(name).map(setupErrorText).join(" ")}</p>` : "");
  const field = (name: string, label: string, placeholder = "", hint: Html | "" = "") =>
    html`<div class="stack-xs"><label class="label" for="bs-${name}">${label}</label>
      <input id="bs-${name}" name="${name}" type="text" class="input${name === "name" ? " mono" : ""}" value="${val(name)}" placeholder="${placeholder}" autocomplete="off" autocapitalize="none" spellcheck="false"${invalid(name)}>${hint}${fieldError(name)}</div>`;
  const hintText = (name: string, text: string) => html`<p id="bs-${name}-hint" class="small muted">${text}</p>`;
  const rows = parseRecipientLines(values.whitelist ?? "");
  const agent = (values.agentLabel ?? "").trim();
  const custom = values.preset === "custom" || FENCE_LABELS.some(([n]) => errorFor(n).length > 0);
  const auto = all.fundingAuto !== "0";
  const advancedOpen = !auto || errorFor("funding").length > 0 || errorFor("minReserve").length > 0;
  const min = fundingMinYocto(val("maxPendingPerAgent"), val("minReserve"));
  const chosen = custom ? "custom" : values.preset === "cautious" ? "cautious" : "balanced";
  const presetNote = (r: Readonly<Record<string, string>>) => `${r.maxPerTx} NEAR per payment · ${r.maxPerDay} NEAR a day · ${r.maxPendingPerAgent} can wait for you`;
  const preset = (id: string, title: string, note: string, on: boolean) =>
    html`<button type="button" class="preset" data-action="budget-preset" data-preset="${id}" aria-pressed="${String(on)}"><span class="strong">${title}</span><span class="small muted">${note}</span></button>`;

  const fence = html`<h2 id="bs-h" class="wiz-h" tabindex="-1">Build the fence</h2>
    <p class="muted">How much may your agents spend without asking you?</p>
    ${field("name", "Budget name", "payroll", html`<p class="small muted">Only you see this name. The account will be <span id="bs-account" class="mono wrap">${(val("name").trim() || "name") + "." + SPUTNIK_FACTORY}</span></p><p id="b-name-msg" class="small" role="status"></p>`)}
    <fieldset class="stack-sm plain-field"><legend class="label">How careful should it be?</legend>
      <div class="presets">${preset("cautious", "Cautious", presetNote(CAUTIOUS_RULES), chosen === "cautious")}${preset("balanced", "Balanced", presetNote(BALANCED_RULES), chosen === "balanced")}${preset("custom", "Custom", "Set every number yourself", custom)}</div>
      <div id="bs-custom" class="grid-2"${custom ? "" : " hidden"}>${FENCE_LABELS.map(([n, l, h]) => field(n, l, "", hintText(n, h)))}</div>
    </fieldset>
    <details id="bs-advanced" class="setup-advanced"${advancedOpen ? " open" : ""}><summary class="strong">Advanced</summary>
      <div class="grid-2">
        ${field("funding", "Set aside for fees (NEAR)", "", html`<p id="bs-funding-hint" class="small muted">Not spending money. Pays the 0.1 NEAR deposit of each waiting payment and your agent's network fees. <span id="bs-funding-min">${min === null ? "" : auto ? `Filled in for your rules: at least ${yoctoToNear(min.toString())} NEAR.` : `At least ${yoctoToNear(min.toString())} NEAR for your rules.`}</span>${auto ? "" : html` <button type="button" class="link-btn" data-action="budget-funding-auto">Use the minimum</button>`}</p>`)}
        ${field("minReserve", "Contract keeps for its fees (NEAR)", "0", hintText("minReserve", "NEAR the spending contract keeps for itself, never budget money. 0 is fine."))}
      </div>
      <input type="hidden" name="fundingAuto" value="${auto ? "1" : "0"}">
    </details>
    <p id="bs-cost" class="banner banner-note small">${icon.info()}<span>${setupCostText(all, codeStorageYocto)}</span></p>`;

  const recipients = html`<h2 id="bs-h" class="wiz-h" tabindex="-1">Who may your agents pay?</h2>
    <p class="muted">Payments to these accounts go through inside the fence. Payments to anyone else always wait for you.</p>
    <div id="bs-rcpts" class="rcpt-list">${renderRecipientList(rows, errors)}</div>
    <div class="actions"><button type="button" class="btn btn-secondary" data-action="budget-recipient-add">${icon.plus()}Add recipient</button></div>`;

  const can = ["Pay your recipients inside the fence", "Ask you for anything bigger", "See its own limits and history"];
  const cannot = ["Touch your wallet or other accounts", "Change its own limits", "Pay anyone you did not list without you"];
  const agentStep = html`<h2 id="bs-h" class="wiz-h" tabindex="-1">Your first agent</h2>
    <p class="muted">The agent gets its own key. That key can only ask this budget for payments.</p>
    ${field("agentLabel", "Agent name", "payroll bot")}
    <div class="grid-2 can-cards">
      <section class="card pad stack-xs" aria-labelledby="bs-can"><h3 id="bs-can" class="strong">It can</h3><ul class="can-list">${can.map((t) => html`<li><span class="text-ok">${icon.check()}</span>${t}</li>`)}</ul></section>
      <section class="card pad stack-xs" aria-labelledby="bs-cannot"><h3 id="bs-cannot" class="strong">It cannot</h3><ul class="can-list">${cannot.map((t) => html`<li><span class="text-high">${icon.close()}</span>${t}</li>`)}</ul></section>
    </div>`;

  let review: Html;
  {
    const planned = codeStorageYocto === null ? null : planBudget((n) => all[n] ?? "", null, BUDGET_FACTORY_NAME, codeStorageYocto);
    const sum = (label: string, body: Html | string) => html`<div class="sum-row"><dt class="muted">${label}</dt><dd>${body}</dd></div>`;
    const name = val("name").trim();
    const count = rows.length;
    const cost =
      planned === null
        ? "Not read from the chain yet. Your wallet shows the exact amount before you approve."
        : planned.ok
          ? `About ${yoctoToNear(planned.plan.firstDepositYocto)} NEAR in signature 1: the budget account's storage, the spending contract and the fee set-aside. The 0.2 NEAR of deposits in signature 2 come back.`
          : "Fix the earlier steps to see it.";
    review = html`<h2 id="bs-h" class="wiz-h" tabindex="-1">Review and create</h2>
      <p class="strong">${reviewSentence(agent === "" ? "Your agent" : agent, val("maxPerTx"), val("maxPerDay"), count)}</p>
      <dl class="sum-box review-rows">
        ${sum("Budget", html`<span class="strong">${name}</span> <span class="mono small muted wrap">${name}.${SPUTNIK_FACTORY}</span>`)}
        ${sum("Set aside for fees", nearAmount(val("funding")))}
        ${sum("Limits", `${nearAmount(val("maxPerTx"))} per payment · ${nearAmount(val("maxPerDay"))} a day`)}
        ${sum("Recipients", count === 0 ? "None. Every payment waits for you." : plural(count, "recipient"))}
        ${sum("Agent", agent)}
        ${sum("One-time cost", cost)}
      </dl>
      <section class="stack-xs" aria-labelledby="bs-next"><h3 id="bs-next" class="strong">What happens next</h3>
        <ol class="plain-list wiz-next"><li>Signature 1 creates the budget account.</li><li>Signature 2 adds the spending contract and your agent.</li><li>You download the agent's key and paste one command into your agent tool.</li></ol></section>
      <p class="banner banner-cleanup">${icon.alertSmall()}<span>Testnet only. The contracts are unaudited.</span></p>
      ${available ? sigLine(2) : html`<p class="small muted">Creating a budget is not available yet: the Agent Budget factory <span class="mono">${BUDGET_FACTORY_NAME}</span> is not deployed. Your rules can still be checked.</p>`}`;
  }

  const body = step === 1 ? fence : step === 2 ? recipients : step === 3 ? agentStep : review;
  const carried = CARRIED.filter((n) => !STEP_FIELDS[step]!.includes(n)).map((n) => html`<input type="hidden" name="${n}" value="${val(n)}">`);
  const whitelistCarrier = step === 2 ? "" : html`<input type="hidden" name="whitelist" value="${values.whitelist ?? ""}">`;
  return html`<form id="budget-setup-form" class="card setup-card budget-narrow" novalidate aria-label="New agent budget" data-step="${step}">
    <ol class="wiz-steps" aria-label="Steps">${WIZARD_STEPS.map((t, i) => html`<li class="wiz-step" data-state="${i + 1 < step ? "done" : i + 1 === step ? "now" : "todo"}"${i + 1 === step ? html` aria-current="step"` : ""}><span class="step-dot">${i + 1 < step ? icon.check() : i + 1}</span><span>${t}</span></li>`)}</ol>
    <input type="hidden" name="step" value="${step}"><input type="hidden" name="preset" value="${chosen}">${carried}${whitelistCarrier}
    ${errors.length > 0 ? html`<p class="field-error" role="alert">Fix the fields marked below.</p>` : ""}
    <div class="wiz-body stack-sm">${body}</div>
    <div class="wiz-foot" id="bs-actions">
      ${step > 1 ? html`<button type="button" class="btn btn-secondary" data-action="budget-setup-back" id="bs-back">Back</button>` : html`<span></span>`}
      <button type="submit" class="btn btn-primary" id="bs-primary">${step < 4 ? "Continue" : "Create budget · sign 1 of 2"}</button>
    </div>
    <div id="budget-setup-status" class="small" role="status" aria-live="polite">${result ?? ""}</div>
  </form>`;
}

/** Shown on the Budget page of a DAO that sign 1 made and sign 2 never finished. */
export interface UnfinishedSetup {
  /** The values the wizard saved after sign 1; without them the owner starts the form again with the same name. */
  canFinish: boolean;
}

function unfinishedCard(u: UnfinishedSetup): Html {
  return html`<section class="card pad stack-xs" aria-labelledby="bu-title">
    <h2 id="bu-title" class="h2">Setup not finished</h2>
    <p>This budget account was created, but its spending contract and your agent were not added yet.</p>
    ${u.canFinish
      ? html`${sigLine(1)}<div class="actions"><button type="button" class="btn btn-primary" data-action="budget-finish-setup">Finish setup · sign 2 of 2</button></div>`
      : html`<p class="small muted">Fill in the form below with the same budget name. It picks up where it stopped, and signature 1 is not repeated.</p>`}
  </section>`;
}

/** The head of a centred pop-up; `close` is the data-action of its × button. */
function modalHead(id: string, title: string, note: string, close: string): Html {
  return html`<div class="drawer-head">
    <div class="drawer-title"><h2 id="${id}" class="drawer-h wrap">${title}</h2><p class="small muted">${note}</p></div>
    <button type="button" class="icon-btn" data-action="${close}" aria-label="Close">${icon.close()}</button></div>`;
}

export interface AgentKeyReady {
  /** The name the owner gave the agent. */
  label: string;
  /** The agent's account: the key file is named after it. */
  account: string;
  budget: string;
  guardId: string;
  dao: string;
  network: Network;
  /** Set when the chain does not show a finished budget after signature 2. */
  problem: string | null;
}

const CONNECT_TABS: ReadonlyArray<readonly [string, string]> = [["claude", "Claude Code"], ["mcp", "Other MCP app"], ["script", "Script"]];

/** P2: the one time the agent's key can be saved, then how to plug the agent in. */
export function renderAgentKeyReady(a: AgentKeyReady): Html {
  const keyPath = `$HOME/.config/key-doctor/${a.account}.json`;
  const move = `mkdir -p ~/.config/key-doctor && mv ~/Downloads/${a.account}.json ~/.config/key-doctor/ && chmod 600 ~/.config/key-doctor/${a.account}.json`;
  const env = `NEAR_NETWORK=${a.network}\nGUARD_CONTRACT_ID=${a.guardId}\nAGENT_ACCOUNT_ID=${a.account}\nAGENT_KEY_PATH=${keyPath}`;
  return html`<div class="drawer-form">${modalHead("ak-title", `${a.label} is ready`, "Save its key now. Key Doctor cannot show it again.", "budget-key-done")}
    <div class="drawer-body stack-sm">
      ${a.problem === null ? "" : html`<p class="banner banner-high" role="alert">${icon.alert()}<span>Signature 2 went through, but the chain does not show a finished budget: ${a.problem}.</span></p>`}
      <p class="banner banner-note">${icon.key()}<span>This key can only ask ${a.budget} for payments. It cannot touch your wallet.</span></p>
      <section class="stack-xs" aria-labelledby="ak-1"><h3 id="ak-1" class="strong">1 · Download the key</h3>
        <div class="actions"><button type="button" id="ak-download" class="btn btn-primary" data-action="budget-key">Download key</button></div>
        <p class="small muted">Saved as <span class="mono wrap">${a.account}.json</span>. Do not send this file to anyone.</p></section>
      <section class="stack-xs" aria-labelledby="ak-2"><h3 id="ak-2" class="strong">2 · Connect your agent</h3>
        <div class="chips" role="group" aria-label="Agent tool">${CONNECT_TABS.map(([id, label], i) => html`<button type="button" class="chip" data-action="budget-connect-tab" data-tab="${id}" aria-pressed="${String(i === 0)}">${label}</button>`)}</div>
        <div data-tab-panel="claude" class="stack-xs"><p class="small muted">Move the key where the agent reads it, then run this inside a clone of the Key Doctor repo.</p>${copyRow(move)}${copyRow(guardMcpCommand(a.network, a.guardId, a.account))}</div>
        <div data-tab-panel="mcp" class="stack-xs" hidden><p class="small muted">Start the agent's MCP server with these settings from the Key Doctor repo.</p>${copyRow(env)}${copyRow("pnpm --silent --filter guard-mcp start")}</div>
        <div data-tab-panel="script" class="stack-xs" hidden><p class="small muted">Read the key file and ask the budget for a payment with its <span class="mono">request_transfer</span> call. Use these settings.</p>${copyRow(env)}</div></section>
      <section class="stack-xs" aria-labelledby="ak-3"><h3 id="ak-3" class="strong">3 · Try it</h3><p class="small muted">Ask your agent:</p>${copyRow(AGENT_TEST_PROMPT)}</section>
    </div>
    <div class="drawer-foot"><a class="small" href="${agentGuideHref(a.dao)}" target="_blank" rel="noopener">How your agent works</a>
      <button type="button" class="btn btn-primary" data-action="budget-key-done">Done</button></div>
  </div>`;
}

/** The confirm before anything drops an agent key that was never downloaded. */
export function renderLeaveKey(agent: string): Html {
  return html`<div class="drawer-form">${modalHead("lk-title", "Leave without the agent key?", `${agent} · not downloaded yet`, "budget-leave-stay")}
    <div class="drawer-body"><p>The key is shown only once. Without it, ${agent} cannot connect, and you would remove it and add a new agent.</p></div>
    <div class="drawer-foot"><button type="button" class="btn btn-secondary" data-action="budget-leave-anyway">Leave anyway</button>
      <button type="button" class="btn btn-primary" data-action="budget-leave-download" autofocus>Download key</button></div>
  </div>`;
}

/** The page without a Budget: what it is until a wallet is connected, then the form. `syncWallet` picks which half shows. */
export function renderBudgetCreate(form: Html): Html {
  return html`<div class="budget-intro" data-wallet-off>
      <section class="budget-hero"><h1 class="display">Agent Budget</h1><p class="budget-hero-lead">${LEAD}</p>
        <button type="button" class="btn btn-primary" data-action="open-wallet">${icon.wallet()}Connect wallet</button></section>
      <ol class="plain how-steps">${STEPS.map(([title, note], i) => html`<li><span class="step-dot">${i + 1}</span><div class="stack-xs"><strong>${title}</strong><p class="small muted">${note}</p></div></li>`)}</ol>
      <section class="stack-sm" aria-labelledby="b-strategies"><h2 id="b-strategies" class="h2">Strategies</h2>
        <div class="strategy-grid">${STRATEGIES.map(([name, note]) => html`<article class="card strategy-card"><div class="strategy-head"><h3 class="strategy-h">${name}</h3><span class="pill pill-note">${name === PAYOUTS || name === DCA ? "After setup" : "Coming soon"}</span></div><p class="small muted">${note}</p></article>`)}</div></section>
    </div>
    <div class="stack" data-wallet-on hidden>
      <section class="stack-xs"><h1 class="h1">New agent budget</h1><p class="muted budget-lead">${WIZARD_LEAD}</p></section>
      ${form}
    </div>`;
}
