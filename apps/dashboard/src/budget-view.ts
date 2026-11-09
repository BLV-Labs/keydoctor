// The Agent Budget page, pure. Everything shown is read from the chain (budget-read.ts); the owner's actions go
// through the owner's wallet, and each button says how many signatures it takes (docs/final-idea.md §11.10.5).
import type { Network } from "key-doctor";
import { SPUTNIK_FACTORY } from "./budget-create.ts";
import type { BudgetLive, BudgetProposal, BudgetRequest } from "./budget-read.ts";
import { nearToYocto, yoctoToNear } from "./format.ts";
import { GUARD_FORM_TEXT, type GuardFormError } from "./guard-form.ts";
import { NEW_AGENT_DEPOSIT } from "./guard-proposals.ts";
import type { GuardLive } from "./guard-read.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { guardMcpCommand } from "./guard-view.ts";
import { copyRow } from "./pages.ts";
import { agentGuideHref, budgetHref, guardHref, routeHref } from "./route.ts";
import { avatar } from "./ui.ts";

/** Shown in the form's placeholder text only; creation needs this factory to be deployed and set at build time. */
export const BUDGET_FACTORY_NAME = "keydoctor-guards-v2.testnet";
const EXAMPLE_BUDGET_DAO = "kdoncall.sputnik-v2.testnet";

export type BudgetPanel = "topup" | "withdraw" | "rules" | "add-agent" | "recipients";
export type ActivityFilter = "all" | "waiting" | "auto" | "rejected";

/** Wording of the signature count on a button or note. */
export const signatures = (n: 1 | 2): string => (n === 1 ? "1 signature" : "2 signatures");

const near = (yocto: string | null | undefined): string => (yocto === null || yocto === undefined ? "unknown" : `${yoctoToNear(yocto)} NEAR`);

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

function percent(spent: string, limit: string): number {
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
function hoursLeft(p: BudgetProposal, b: BudgetLive, now: number): number | null {
  const period = proposalPeriod(b);
  if (p.submission_time === null || period === null) return null;
  const left = Number((BigInt(p.submission_time) + period) / 1_000_000n) - now;
  return left <= 0 ? 0 : Math.ceil(left / 3_600_000);
}

const expiryText = (left: number | null): string | null => (left === null ? null : left === 0 ? "Expired" : `Expires in ${hours(left)}`);

function ago(nanos: string | null, now: number): string {
  if (nanos === null) return "";
  const minutes = Math.floor((now - Number(BigInt(nanos) / 1_000_000n)) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${hours(Math.floor(minutes / 60))} ago`;
  const days = Math.floor(minutes / (60 * 24));
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const agentName = (g: GuardLive | null, account: string): string => {
  const label = g?.agents?.find((a) => a.account_id === account)?.label ?? "";
  return label === "" ? account : label;
};

function tiles(b: BudgetLive, now: number): Html {
  const g = b.guard;
  const w = g?.window ?? null;
  const p = g?.policy ?? null;
  const oldest = b.proposals?.at(-1);
  const left = oldest === undefined ? null : hoursLeft(oldest, b, now);
  const off = g?.agents?.filter((a) => !a.enabled).length ?? null;
  // The account's NEAR that pays for its storage: counted in `balance`, but no transfer can send it.
  const held = b.balance === null || b.withdrawable === null ? null : BigInt(b.balance) - BigInt(b.withdrawable);
  const tile = (filter: ActivityFilter, label: string, value: string, note: string, extra: Html | "" = "") =>
    html`<button type="button" class="card tile tile-btn" data-action="budget-filter" data-filter="${filter}">
      <span class="tile-label">${label}</span><span class="tile-value">${value}</span>${extra}<span class="tile-note">${note}</span></button>`;
  return html`<section class="tiles" aria-label="Budget summary">
    ${tile("all", "Budget balance", near(b.withdrawable), held === null || held === 0n ? "Top up or withdraw anytime" : `Plus ${near(held.toString())} kept for account storage, not spendable`)}
    ${tile("auto", "Spent in last 24h", w === null ? "unknown" : p === null ? near(w.spent_in_window) : `${yoctoToNear(w.spent_in_window)} / ${near(p.max_per_day)}`,
      w === null ? "" : `${near(w.remaining)} left today`,
      w !== null && p !== null ? html`<progress class="progress" max="100" value="${percent(w.spent_in_window, p.max_per_day)}" aria-label="Share of the daily limit spent"></progress>` : "")}
    ${tile("waiting", "Waiting for your approval", b.proposals === null ? "unknown" : String(b.proposals.length), left === null || left === 0 ? "Approve or reject them below" : `Oldest: ${hours(left)} left`)}
    ${tile("all", "Agents", g?.config ? String(g.config.agents) : "unknown", off === null ? "" : off === 0 ? "All on" : `${off} off`)}
  </section>`;
}

/** Why the Guard held a payment, in the owner's words, with the limit it crossed. An unknown code is shown as it is. */
function reasonText(code: string, g: GuardLive | null): string {
  const p = g?.policy ?? null;
  switch (code) {
    case "NOT_WHITELISTED":
      return "Recipient is not on your list";
    case "OVER_PER_TX":
      return p === null ? "Over your per-request limit" : `Over your ${near(p.max_per_tx)} per-request limit`;
    case "OVER_DAILY_LIMIT":
      return p === null ? "Over your 24-hour limit" : `Over your ${near(p.max_per_day)} 24-hour limit`;
    case "OVER_RECIPIENT_LIMIT":
      return "Over the limit for this recipient";
    default:
      return code;
  }
}

const requestOf = (b: BudgetLive, p: BudgetProposal): BudgetRequest | null => b.requests?.find((r) => r.proposal_id === p.id) ?? null;

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
      ${(r?.reasons ?? []).map((code) => html`<span class="pill pill-cleanup">${icon.alertSmall()}${reasonText(code, g)}</span>`)}
      <div class="actions">
        <button type="button" class="btn btn-danger" data-action="budget-act" data-id="${p.id}" data-vote="VoteReject">Reject <span class="sig">${signatures(1)}</span></button>
        <button type="button" class="btn btn-primary" data-action="budget-approve" data-id="${p.id}">Approve… <span class="sig">${signatures(1)}</span></button>
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
    <div class="b-head"><div><h2 id="b-pending" class="b-h">Needs you</h2><p class="small muted">Agents asked for these. They are outside your rules.</p></div></div>
    ${body}</section>`;
}

const REQUEST_STATUS: Record<string, string> = {
  Submitted: "Sent for approval",
  AutoApproved: "Approved by the rules",
  Pending: "Waiting",
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

function activityRow(r: BudgetRequest, g: GuardLive | null, now: number): Html {
  const group = activityGroup(r);
  const tone = group === "rejected" ? "pill-high" : group === "waiting" ? "pill-cleanup" : "pill-ok";
  const mark = group === "rejected" ? icon.alertSmall() : group === "waiting" ? icon.clock() : group === "auto" ? icon.check() : "";
  const label = group === "auto" ? "Auto-approved" : (REQUEST_STATUS[r.status] ?? r.status);
  const reasons = r.reasons.map((c) => reasonText(c, g)).join(", ");
  return html`<li class="activity-row">
    <span class="activity-status"><span class="pill ${tone}">${mark}${label}</span></span>
    <span class="activity-text wrap">${agentName(g, r.agent)} ${r.status === "Executed" ? "paid" : "asked to pay"} <span class="mono">${r.receiver_id}</span>${reasons === "" ? "" : html`<span class="small muted activity-why">${reasons}</span>`}</span>
    <span class="activity-amount">${near(r.amount)}</span>
    <span class="activity-time small muted">${ago(r.created_at, now)}</span></li>`;
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
          : html`<ul class="plain-list">${rows.map((r) => activityRow(r, b.guard, now))}</ul>`;
  return html`<section id="budget-activity" class="card" aria-labelledby="b-activity">
    <div class="b-head"><h2 id="b-activity" class="b-h">Activity</h2></div>
    <div class="filter-chips" role="group" aria-label="Filter activity">${chip("all", "All")}${chip("waiting", "Waiting")}${chip("auto", "Auto-approved")}${chip("rejected", "Rejected")}</div>
    ${body}</section>`;
}

function rulesCard(b: BudgetLive, g: GuardLive): Html {
  const p = g.policy;
  const period = proposalPeriod(b);
  const row = (label: string, value: string | number) => html`<div class="rule-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  return html`<section class="card" aria-labelledby="b-rules"><div class="b-head"><h2 id="b-rules" class="b-h">Spending rules</h2>
      ${p === null ? "" : html`<button type="button" class="btn btn-ghost" data-action="budget-open" data-panel="rules">Edit rules <span class="sig">${signatures(2)}</span></button>`}</div>
    ${p === null
      ? html`<p class="check-line pad-row">${icon.alert()}<span>Could not read the rules. They are unknown, not absent.</span></p>`
      : html`<dl class="rule-list">
          ${row("Per request", near(p.max_per_tx))}
          ${row("Rolling 24 hours", near(p.max_per_day))}
          ${row("Allowed recipients", g.config === null ? "unknown" : g.config.whitelist)}
          ${row("Waiting items per agent", p.max_pending_per_agent)}
          ${row("Waiting items expire after", period === null ? "unknown" : hours(Number(period / 3_600_000_000_000n)))}
          ${row("Reserve kept", near(p.min_reserve))}
        </dl>
        <div class="pad-row"><button type="button" class="btn btn-ghost btn-start" data-action="budget-open" data-panel="recipients">Manage recipients <span class="sig">${signatures(2)}</span></button></div>`}</section>`;
}

const agentUse = (a: NonNullable<GuardLive["agents"]>[number]): string =>
  a.spent_24h === undefined ? `${a.pending} waiting` : `${a.pending} waiting · ${near(a.spent_24h)} in last 24h`;

function agentsCard(g: GuardLive): Html {
  const agents = g.agents;
  const body =
    agents === null
      ? html`<p class="check-line pad-row">${icon.alert()}<span>Could not read the agent list right now.</span></p>`
      : agents.length === 0
        ? html`<p class="muted pad-row">No agent yet.</p>`
        : html`<ul class="plain-list">${agents.map((a) => html`<li><button type="button" class="agent-row" data-action="budget-agent-open" data-agent="${a.account_id}">
            ${avatar(a.account_id)}
            <span class="agent-text"><span class="agent-name wrap">${a.label === "" ? a.account_id : a.label}</span><span class="small muted wrap">${a.label === "" ? "" : `${a.account_id} · `}${agentUse(a)}</span></span>
            <span class="pill ${a.enabled ? "pill-ok" : "pill-note"}">${a.enabled ? "On" : "Off"}</span>${icon.chevronRight()}</button></li>`)}</ul>`;
  return html`<section class="card" aria-labelledby="b-agents"><div class="b-head"><h2 id="b-agents" class="b-h">Agents</h2>
      <button type="button" class="btn btn-ghost" data-action="budget-open" data-panel="add-agent">Add an agent <span class="sig">${signatures(2)}</span></button></div>
    ${body}</section>`;
}

const STRATEGIES: ReadonlyArray<readonly [string, string]> = [
  ["Scheduled payouts", "Pay a recipient the same amount on a schedule."],
  ["DCA NEAR → USDT", "Sell NEAR for USDT in small steps."],
  ["Auto-stake idle NEAR", "Keep spare NEAR staked until it is needed."],
  ["Rebalance NEAR / USDC", "Hold a target split between the two."],
  ["Take profit", "Sell part of your NEAR at a price you pick."],
];

const STRATEGIES_CARD = html`<section class="card" aria-labelledby="b-later">
    <div class="b-head"><div><h2 id="b-later" class="b-h">Strategies</h2><p class="small muted">Not available yet: strategies, scheduled plans and USDC balances are not built in this version.</p></div></div>
    <ul class="plain-list">${STRATEGIES.map(([name]) => html`<li class="strategy-row"><span>${name}</span><span class="small muted">Coming soon</span></li>`)}</ul></section>`;

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
      <div class="tech-row"><dt>Network</dt><dd>${network}</dd></div></dl></details>`;
}

/** The live page for one DAO that has a Guard. */
export function renderBudget(b: BudgetLive, network: Network, setup: Html | "" = "", now: number = Date.now()): Html {
  const g = b.guard;
  if (g === null) {
    return html`${head("This account has no Agent Budget yet.")}
      <section class="stack-sm"><p>Account <a class="mono" href="${routeHref(b.dao.dao)}" data-nav>${b.dao.dao}</a> · ${network}</p></section>
      <section class="card pad stack-xs"><p class="muted">No finished Agent Budget was found for this account.</p><p class="small"><a href="${guardHref(b.dao.dao)}" data-nav>Team council? Use the council setup page.</a></p></section>
      ${setup}`;
  }
  const paused = g.config?.paused === true;
  const status = g.config === null ? html`<span class="pill pill-cleanup">Status unknown</span>` : paused ? html`<span class="pill pill-cleanup">${icon.alertSmall()}Agents paused</span>` : g.in_role ? html`<span class="pill pill-ok">Active</span>` : html`<span class="pill pill-cleanup">Setup not finished</span>`;
  return html`${head(LEAD)}
    <section class="budget-top" aria-label="Budget">
      <div class="budget-name"><span class="strong mono wrap">${b.dao.dao}</span>${status}</div>
      <div class="actions">
        ${paused
          ? html`<button type="button" class="btn btn-secondary" data-action="budget-resume">${icon.play()}Resume agents <span class="sig">${signatures(2)}</span></button>`
          : html`<button type="button" class="btn btn-secondary" data-action="budget-pause" data-guard="${g.guard_id}"${g.config === null ? " disabled" : ""}>${icon.pause()}Pause agents <span class="sig">${signatures(1)}</span></button>`}
        <button type="button" class="btn btn-secondary" data-action="budget-open" data-panel="withdraw">Withdraw <span class="sig">${signatures(2)}</span></button>
        <button type="button" class="btn btn-primary" data-action="budget-open" data-panel="topup">Top up <span class="sig">${signatures(1)}</span></button>
      </div>
    </section>
    ${paused ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>Agents are paused. Every payment they ask for is rejected until you resume.</span></p>` : ""}
    ${tiles(b, now)}
    <p id="budget-status" class="small" role="status"></p>
    <div id="budget-next"></div>
    <div class="budget-cols">
      <div class="budget-main">${pendingCard(b, now)}${renderBudgetActivity(b, "all", now)}</div>
      <aside class="budget-side" aria-label="Budget setup">${rulesCard(b, g)}${agentsCard(g)}${STRATEGIES_CARD}${ALERTS_CARD}</aside>
    </div>
    ${technical(b, g, network)}
    <dialog id="budget-action" class="drawer" aria-labelledby="bp-title"></dialog>`;
}

const near2 = (yocto: string | undefined): string => (yocto === undefined ? "" : yoctoToNear(yocto));

function drawerHead(title: string, note: string): Html {
  return html`<div class="drawer-head">
    <div class="drawer-title"><h2 id="bp-title" class="drawer-h wrap">${title}</h2><p class="small muted">${note}</p></div>
    <button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close">${icon.close()}</button></div>`;
}

const CANCEL = html`<button type="button" class="btn btn-secondary" data-action="close-dialog">Cancel</button>`;

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

/** The drawer for one owner action, with its signature count in plain words. `values.to` is the connected account. */
export function renderBudgetPanel(panel: BudgetPanel, b: BudgetLive, error: string | null = null, values: Record<string, string> = {}): Html {
  const v = (name: string, fallback = "") => values[name] ?? fallback;
  const p = b.guard?.policy ?? null;
  const field = (name: string, label: string, value: string, placeholder = "", opts: { mono?: boolean; unit?: boolean } = {}) => {
    const input = html`<input id="bp-${name}" name="${name}" type="text" class="input${opts.mono ? " mono" : ""}" value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"${error ? html` aria-describedby="bp-error"` : ""}>`;
    return html`<div class="stack-xs"><label class="label" for="bp-${name}">${label}</label>${opts.unit ? html`<div class="input-unit">${input}<span class="muted">NEAR</span></div>` : input}</div>`;
  };
  const err = error ? html`<p id="bp-error" class="field-error" role="alert">${error}</p>` : "";
  const form = (title: string, note: string, body: Html, submit: string) =>
    html`<form id="budget-panel-form" class="drawer-form" data-panel="${panel}" novalidate>${drawerHead(title, note)}
      <div class="drawer-body">${body}${err}</div>
      <div class="drawer-foot">${CANCEL}<button type="submit" class="btn btn-primary">${submit}</button></div></form>`;
  switch (panel) {
    case "topup":
      return form("Top up", "From your wallet to this Budget.", html`
        ${field("amount", "Amount", v("amount"), "5", { unit: true })}
        <div class="sum-box">${sumRow("Balance now", near(b.withdrawable))}${sumRow("Balance after", html`<span id="bp-after">${balanceAfter(b, "topup", v("amount"))}</span>`)}</div>
        <p class="small muted">${signatures(1)}: a NEAR transfer from your connected account to <span class="mono">${b.dao.dao}</span>. The page first checks on the chain who controls this Budget.</p>`, "Top up in wallet");
    case "withdraw":
      return form("Withdraw", "Back to your wallet.", html`
        ${field("amount", "Amount", v("amount"), "1", { unit: true })}
        ${b.withdrawable === null ? "" : html`<button type="button" class="btn btn-ghost btn-start" data-action="budget-full" data-amount="${yoctoToNear(b.withdrawable)}">Use full balance (${near(b.withdrawable)})</button>`}
        <div class="sum-box">${sumRow("To", html`<span class="mono">${v("to", "your connected wallet")}</span>`)}${sumRow("Most you can withdraw", near(b.withdrawable))}${sumRow("Balance after", html`<span id="bp-after">${balanceAfter(b, "withdraw", v("amount"))}</span>`)}</div>
        <p class="small muted">${signatures(2)}. Signature 1 asks to send the money from <span class="mono">${b.dao.dao}</span> to your connected account. The page then reads the request back from the chain and, only if it matches, asks for signature 2 to approve it.</p>`, "Start withdrawal");
    case "rules":
      return form("Edit spending rules", "These apply after your second signature.", html`
        <div class="grid-2">
          ${field("maxPerTx", "Per request", v("maxPerTx", near2(p?.max_per_tx)), "", { unit: true })}
          ${field("maxPerDay", "Rolling 24 hours", v("maxPerDay", near2(p?.max_per_day)), "", { unit: true })}
          ${field("maxPending", "Waiting items per agent", v("maxPending", p === null ? "" : String(p.max_pending_per_agent)))}
          ${field("minReserve", "Reserve kept", v("minReserve", near2(p?.min_reserve)), "", { unit: true })}
        </div>
        <p class="small muted">${signatures(2)}: a request to change your limits, then your approval once the page has checked it.</p>`, "Save new rules");
    case "add-agent":
      return form("Add an agent", "It follows the same spending rules.", html`
        ${field("label", "Agent name", v("label"), "payroll bot")}
        ${agentLimits(b.dao.dao)}
        <p class="small muted">${signatures(2)}. This page makes the agent's key and its own account. ${yoctoToNear(NEW_AGENT_DEPOSIT)} NEAR leaves the Budget: 0.5 NEAR is the agent's gas, the rest pays for storage and what is not used comes back. You then get the key file and the command for your agent.</p>`, "Add agent");
    case "recipients":
      return form("Allowed recipients", "Payments to these accounts can go through without you, within your limits.", html`
        ${recipientList(b.guard?.whitelist ?? null)}
        ${field("account", "Add a recipient", v("account"), "vendor.kdoncall.testnet", { mono: true })}
        ${field("label", "Name (optional)", v("label"), "vendor")}
        ${field("cap", "Limit per payment for this recipient (optional)", v("cap"), "2", { unit: true })}
        <p class="small muted">${signatures(2)} for each add or remove. A small storage deposit leaves the Budget when you add one; what is not used comes back.</p>`, "Add recipient");
  }
}

/** What is on the list now, each with its own two-signature Remove. Unknown is said, never shown as an empty list. */
function recipientList(list: NonNullable<GuardLive["whitelist"]> | null): Html {
  if (list === null) return html`<p class="check-line">${icon.alert()}<span>Could not read the list right now. It is unknown, not empty.</span></p>`;
  if (list.length === 0) return html`<p class="banner banner-cleanup">${icon.info()}<span>No recipients yet: every payment your agent asks for will wait for your approval.</span></p>`;
  return html`<ul class="plain-list">${list.map((w) => html`<li class="recipient-row"><span class="stack-xs grow-min"><span class="mono wrap">${w.account_id}</span>${w.label === "" && w.max_per_tx === null ? "" : html`<span class="small muted">${[w.label, w.max_per_tx === null ? "" : `up to ${near(w.max_per_tx)} per payment`].filter((t) => t !== "").join(" · ")}</span>`}</span>
    <button type="button" class="btn btn-ghost" data-action="budget-recipient-drop" data-account="${w.account_id}" aria-label="Remove ${w.account_id}">Remove</button></li>`)}</ul>`;
}

/** The check before Approve: what will be paid and why it was held. A recipient not on the list needs the amount typed back. */
export function renderBudgetApprove(p: BudgetProposal, b: BudgetLive, now: number = Date.now()): Html {
  const r = requestOf(b, p);
  const unknown = r?.reasons.includes("NOT_WHITELISTED") === true;
  const expiry = expiryText(hoursLeft(p, b, now));
  return html`${drawerHead(r === null ? `Approve request #${p.id}?` : "Approve this payment?", r === null ? "It waits for your approval." : `${agentName(b.guard, r.agent)} asked for it. It is outside your rules.`)}
    <div class="drawer-body">
      <div class="sum-box">
        ${r === null
          ? sumRow("What it does", describeKind(p.kind))
          : html`${sumRow("Amount", near(r.amount))}${sumRow("To", html`<span class="mono">${r.receiver_id}</span>`)}${r.reasons.length > 0 ? sumRow("Why it waits", r.reasons.map((c) => reasonText(c, b.guard)).join(", ")) : ""}${r.memo === "" ? "" : sumRow("Memo", r.memo)}`}
        ${expiry === null ? "" : sumRow("Time left", expiry)}
      </div>
      ${unknown && r !== null
        ? html`<p class="banner banner-high">${icon.alertSmall()}<span>You have not allowed this recipient. Check the account before you approve.</span></p>
          <div class="stack-xs"><label class="label" for="approve-check">Type ${yoctoToNear(r.amount)} to confirm</label>
            <input id="approve-check" type="text" class="input" autocomplete="off" spellcheck="false" data-expect="${yoctoToNear(r.amount)}"></div>`
        : ""}
      <p class="small muted">${signatures(1)}: your approval of request #${p.id}. The page checks it against the chain first.</p>
    </div>
    <div class="drawer-foot">${CANCEL}<button type="button" class="btn btn-primary" data-action="budget-act" data-id="${p.id}" data-vote="VoteApprove"${unknown ? " disabled" : ""}>Approve <span class="sig">${signatures(1)}</span></button></div>`;
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
  unpause: "Resume agents",
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

/** After the last signature of a new Budget. */
export function renderBudgetKey(agent: string, guardId: string, dao: string, network: Network, problem: string | null): Html {
  return html`<div class="stack-sm">
    <p>${problem === null ? "Your budget is created and checked against the chain." : `Signature 2 went through, but the chain does not show a finished budget: ${problem}.`}</p>
    ${agentConnect(agent, guardId, dao, network)}
    <div class="actions"><a class="btn btn-tint" href="${budgetHref(dao)}" data-nav>Open the budget to top up</a></div>
  </div>`;
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
export const BALANCED_RULES: Readonly<Record<string, string>> = { maxPerTx: "5", maxPerDay: "20", maxPendingPerAgent: "3", minReserve: "1", funding: "5" };
/** §10.3 names this preset without numbers: these are a quarter of Balanced's 24-hour limit, with a tight per-request one. */
export const CAUTIOUS_RULES: Readonly<Record<string, string>> = { maxPerTx: "1", maxPerDay: "5", maxPendingPerAgent: "2", minReserve: "1", funding: "5" };

const RULE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["maxPerTx", "Per request (NEAR)"],
  ["maxPerDay", "Rolling 24 hours (NEAR)"],
  ["maxPendingPerAgent", "Waiting items per agent"],
  ["minReserve", "Reserve kept (NEAR)"],
  ["funding", "Set aside for waiting requests (NEAR)"],
];

const STEPS: ReadonlyArray<readonly [string, string]> = [
  ["Create", "Pick rules for how much your agent can spend."],
  ["Top up", "Move only what the agent may use. Withdraw anytime."],
  ["Connect your agent", "Small payments go through. Larger ones wait for you."],
];

/** The allowed recipients added so far, one line each of `account, label, cap` in the hidden whitelist field. */
export function renderRecipients(raw: string): Html {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return html`<p class="banner banner-cleanup">${icon.info()}<span>No recipients yet: every payment your agent asks for will wait for your approval.</span></p>`;
  return html`<ul class="plain-list">${lines.map((line, i) => html`<li class="recipient-row"><span class="mono wrap">${line}</span>
    <button type="button" class="btn btn-ghost" data-action="budget-recipient-remove" data-line="${i}" aria-label="Remove ${line}">Remove</button></li>`)}</ul>`;
}

/** The create form for a DAO with no Budget. `available` is false while the Agent Budget Guard factory is not deployed. */
export function renderBudgetSetup(available: boolean, values: Record<string, string> = {}, errors: GuardFormError[] = [], result: string | null = null): Html {
  const errorFor = (name: string) => errors.filter((e) => e.field === name || e.field.startsWith(`${name}.`));
  const message = (e: GuardFormError) => {
    const at = /\.(\d+)/.exec(e.field);
    return `${at ? `Line ${Number(at[1]) + 1}: ` : ""}${GUARD_FORM_TEXT[e.code].en}`;
  };
  const invalid = (name: string) => (errorFor(name).length > 0 ? html` aria-invalid="true" aria-describedby="bs-${name}-error"` : "");
  const fieldError = (name: string) => (errorFor(name).length > 0 ? html`<p id="bs-${name}-error" class="field-error">${errorFor(name).map(message).join(" ")}</p>` : "");
  const field = (name: string, label: string, placeholder = "") =>
    html`<div class="stack-xs"><label class="label" for="bs-${name}">${label}</label>
      <input id="bs-${name}" name="${name}" type="text" class="input" value="${values[name] ?? BALANCED_RULES[name] ?? ""}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"${invalid(name)}>${fieldError(name)}</div>`;
  const custom = values.preset === "custom" || RULE_FIELDS.some(([n]) => errorFor(n).length > 0);
  const chosen = custom ? "custom" : values.preset === "cautious" ? "cautious" : "balanced";
  const presetNote = (r: Readonly<Record<string, string>>) => `${r.maxPerTx} NEAR per request, ${r.maxPerDay} NEAR per 24 hours`;
  const preset = (id: string, title: string, note: string, on: boolean) =>
    html`<button type="button" class="preset" data-action="budget-preset" data-preset="${id}" aria-pressed="${String(on)}"><span class="strong">${title}</span><span class="small muted">${note}</span></button>`;
  const whitelist = values.whitelist ?? "";
  return html`<form id="budget-setup-form" class="card setup-card budget-narrow" novalidate aria-label="Create an Agent Budget">
    ${errors.length > 0 ? html`<p class="field-error" role="alert">Fix the fields marked below.</p>` : ""}
    <div class="stack-xs"><label class="label" for="bs-name">Budget name</label>
      <div class="name-row"><input id="bs-name" name="name" type="text" class="input mono" value="${values.name ?? ""}" placeholder="payroll" autocomplete="off" autocapitalize="none" spellcheck="false"${invalid("name")}><span class="mono small muted">.${SPUTNIK_FACTORY}</span></div>
      <p id="b-name-msg" class="small" role="status"></p>${fieldError("name")}</div>
    <fieldset class="stack-sm plain-field"><legend class="setup-h">Spending rules</legend>
      <input type="hidden" name="preset" value="${chosen}">
      <div class="presets">${preset("cautious", "Cautious", presetNote(CAUTIOUS_RULES), chosen === "cautious")}${preset("balanced", "Balanced", presetNote(BALANCED_RULES), chosen === "balanced")}${preset("custom", "Custom", "Set your own limits", custom)}</div>
      <div id="bs-custom" class="grid-2"${custom ? "" : " hidden"}>${RULE_FIELDS.map(([n, l]) => field(n, l))}</div>
    </fieldset>
    ${field("agentLabel", "First agent name", "payroll bot")}
    <div class="stack-xs"><label class="label" for="bs-recipient">Allowed recipients (optional)</label>
      <div class="input-row"><input id="bs-recipient" type="text" class="input mono" placeholder="vendor.kdoncall.testnet" autocomplete="off" autocapitalize="none" spellcheck="false"${invalid("whitelist")}>
        <button type="button" class="btn btn-secondary" data-action="budget-recipient-add">${icon.plus()}Add</button></div>
      <textarea name="whitelist" hidden>${whitelist}</textarea>
      <div id="bs-recipients">${renderRecipients(whitelist)}</div>${fieldError("whitelist")}</div>
    <div class="sum-box"><p class="strong">${signatures(2)} now, 1 more to top up</p>
      <p class="small muted">${available ? "This creates a new Budget that only your account controls, with one agent. It takes 2 signatures." : html`Creating a budget is not available yet: the Agent Budget factory <span class="mono">${BUDGET_FACTORY_NAME}</span> is not deployed. You can fill in the form to check your rules.`}</p></div>
    <p class="banner banner-cleanup">${icon.alertSmall()}<span>Testnet only. The contracts are unaudited.</span></p>
    <div class="actions"><button type="submit" class="btn btn-primary">Create Agent Budget</button></div>
    <div id="budget-setup-status" class="small" role="status">${result ?? ""}</div>
  </form>`;
}

/** The page without a Budget: what it is until a wallet is connected, then the form. `syncWallet` picks which half shows. */
export function renderBudgetCreate(form: Html): Html {
  return html`<div class="budget-intro" data-wallet-off>
      <section class="budget-hero"><h1 class="display">Agent Budget</h1><p class="budget-hero-lead">${LEAD}</p>
        <button type="button" class="btn btn-primary" data-action="open-wallet">${icon.wallet()}Connect wallet</button></section>
      <ol class="plain how-steps">${STEPS.map(([title, note], i) => html`<li><span class="step-dot">${i + 1}</span><div class="stack-xs"><strong>${title}</strong><p class="small muted">${note}</p></div></li>`)}</ol>
      <section class="stack-sm" aria-labelledby="b-strategies"><h2 id="b-strategies" class="h2">Strategies</h2>
        <div class="strategy-grid">${STRATEGIES.map(([name, note]) => html`<article class="card strategy-card"><div class="strategy-head"><h3 class="strategy-h">${name}</h3><span class="pill pill-note">Coming soon</span></div><p class="small muted">${note}</p></article>`)}</div></section>
    </div>
    <div class="stack" data-wallet-on hidden>
      <section class="stack-xs"><h1 class="h1">Create Agent Budget</h1><p class="muted budget-lead">${LEAD}</p></section>
      <ol class="plain setup-steps" aria-label="Setup steps">${STEPS.map(([title], i) => html`<li><span class="step-dot">${i + 1}</span><span class="strong">${title}</span></li>`)}</ol>
      ${form}
    </div>`;
}
