// Your agents (K2), pure: an inbox of everything that needs the owner across all budgets, then every budget and yield
// agent as a card, the latest activity and the alerts line. Data: agents-read.ts (the council's budgets and yield agents).
import type { Network } from "key-doctor";
import type { AgentRow, BudgetCard, MyAgents } from "./agents-read.ts";
import type { BudgetLive, BudgetProposal, BudgetRequest } from "./budget-read.ts";
import { activityRow, agentName, ago, budgetStatusPill, describeKind, expiryText, hoursLeft, near, percent, reasonText, requestOf } from "./budget-view.ts";
import { plural, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { budgetHref, pageHref, yieldHref, yieldNewHref } from "./route.ts";
import { avatar } from "./ui.ts";
import { YIELD_ALLOWLIST, tokenAmount } from "./yield-proposals.ts";

/** Waiting rows shown before "Show all". */
export const NEEDS_SHOWN = 5;
/** Events in Recent activity. */
export const ACTIVITY_SHOWN = 5;

/** `data-agents-for` names the accounts this view was read for, so a wallet change re-reads it. */
function head(accounts: readonly string[], sub: string | null = null): Html {
  return html`<section class="stack-xs" data-agents-for="${accounts.join(",")}"><h1 class="h1">Your agents</h1>${sub === null ? "" : html`<p class="muted budget-lead">${sub}</p>`}</section>`;
}

const NEW_AGENT = html`<details class="menu">
  <summary class="btn btn-primary">${icon.plus()}New agent</summary>
  <div class="pop card">
    <a class="pop-item" href="${pageHref("budget")}" data-nav><span class="strong">Pay for things</span><span class="small muted">Spends from a budget within your limits. Needs 2 signatures.</span></a>
    <a class="pop-item" href="${yieldNewHref()}" data-nav><span class="strong">Earn on idle funds</span><span class="small muted">Watches Rhea Lend for idle stablecoins and suggests moves. You approve every one.</span></a>
  </div>
</details>`;

/** Written into by the wallet actions (Reject, Review): the status line and the dialog they use live here. */
const ACTION_HOST = html`<p id="budget-status" class="small" role="status" aria-live="polite"></p>
  <dialog id="budget-action" class="drawer" aria-labelledby="bp-title"></dialog>`;

export function renderMyAgentsSignedOut(): Html {
  return html`${head([])}
    <section class="card pad stack-xs budget-narrow">
      <p class="strong">Connect your wallet to see your agents</p>
      <p class="small muted">Key Doctor only reads. Your wallet signs.</p>
      <button type="button" class="btn btn-primary btn-start" data-action="open-wallet">Connect wallet</button>
      <p class="small"><a href="${pageHref("budget")}" data-nav>Or open one budget by name</a></p>
    </section>`;
}

export function renderMyAgentsLoading(accounts: readonly string[]): Html {
  return html`${head(accounts)}
    <section class="card pad stack-sm" aria-busy="true" aria-label="Loading agents"><p class="meta" role="status">Finding the budgets and agents of <span class="mono">${accounts.join(", ")}</span>…</p></section>`;
}

export function renderMyAgentsError(message: string, accounts: readonly string[]): Html {
  return html`${head(accounts)}
    <section class="card pad stack-xs budget-narrow">
      <p class="check-line small">${icon.alertSmall()}<span>${message}</span></p>
      <button type="button" class="btn btn-secondary btn-start" data-action="rescan">Try again</button>
    </section>`;
}

/** One waiting request of one budget. */
export interface WaitingItem {
  dao: string;
  live: BudgetLive;
  proposal: BudgetProposal;
  request: BudgetRequest | null;
  /** Whole hours left; null when the chain did not say. */
  left: number | null;
}

const submitted = (i: WaitingItem): bigint => BigInt(i.proposal.submission_time ?? "0");

/** The waiting requests of every budget that was read, newest first. An expired one is dropped: it shows in Recent activity. */
export function waitingItems(cards: readonly BudgetCard[], now: number): WaitingItem[] {
  const items = cards.flatMap(({ dao, live }) =>
    live === null
      ? []
      : (live.proposals ?? []).map((proposal): WaitingItem => ({ dao, live, proposal, request: requestOf(live, proposal), left: hoursLeft(proposal, live, now) })),
  );
  return items.filter((i) => i.left !== 0).sort((a, b) => (submitted(a) < submitted(b) ? 1 : submitted(a) > submitted(b) ? -1 : 0));
}

function waitingRow(i: WaitingItem, hidden: boolean): Html {
  const g = i.live.guard;
  const r = i.request;
  const expiry = expiryText(i.left);
  const meta = [r === null ? i.proposal.description : r.reasons.map((c) => reasonText(c, g, r.receiver_id)).join(", "), i.dao, expiry === null ? null : expiry.replace("Expires", "expires")]
    .filter((t) => t !== null && t !== "")
    .join(" · ");
  return html`<li class="inbox-row"${hidden ? html` hidden data-inbox-extra` : ""}>
    <span class="inbox-mark">${icon.clock()}</span>
    <div class="inbox-text">
      <p class="strong wrap">${r === null ? describeKind(i.proposal.kind) : html`${agentName(g, r.agent)} wants to pay <span class="nowrap">${near(r.amount)}</span> to <span class="mono">${r.receiver_id}</span>`}</p>
      <p class="small muted wrap">${meta}</p>
    </div>
    <div class="actions">
      <button type="button" class="btn btn-secondary btn-sm" data-action="budget-act" data-dao="${i.dao}" data-id="${i.proposal.id}" data-vote="VoteReject">Reject</button>
      <button type="button" class="btn btn-primary btn-sm" data-action="budget-approve" data-dao="${i.dao}" data-id="${i.proposal.id}">Review</button>
    </div></li>`;
}

function needsYou(cards: readonly BudgetCard[], now: number): Html {
  const items = waitingItems(cards, now);
  const unread = cards.filter((c) => c.live !== null && c.live.proposals === null).length;
  const pill = items.length === 0 ? "" : html`<span class="pill pill-cleanup">${icon.clock()}${String(items.length)} waiting</span>`;
  const more = items.length > NEEDS_SHOWN ? html`<button type="button" class="btn btn-ghost btn-link" data-action="agents-show-all">Show all ${String(items.length)}</button>` : "";
  return html`<section class="stack-xs" aria-labelledby="ma-needs">
    <div class="inbox-head"><h2 id="ma-needs" class="h2">Needs you</h2>${pill}</div>
    ${items.length === 0
      ? html`<p class="muted">Nothing needs you right now.</p>`
      : html`<p class="small muted">Agents asked for these. They are outside your limits. Approve and Reject each take 1 signature.</p>
        <ul class="plain-list inbox">${items.map((i, n) => waitingRow(i, n >= NEEDS_SHOWN))}</ul>${more}`}
    ${unread === 0 ? "" : html`<p class="small muted">${plural(unread, "budget")} could not show what waits. Those items are unknown, not none.</p>`}</section>`;
}

function budgetCard(card: BudgetCard): Html {
  const b = card.live;
  if (b === null) {
    return html`<div class="agent-card agent-card-failed">
      <div class="agent-card-head">${avatar(card.dao)}<span class="strong mono wrap">${card.dao}</span></div>
      <p class="check-line small">${icon.alertSmall()}<span>Could not read this budget</span></p>
      <div><button type="button" class="btn btn-secondary btn-sm" data-action="agents-retry" data-dao="${card.dao}">Try again</button></div></div>`;
  }
  const g = b.guard;
  if (g === null) {
    return html`<a class="agent-card" href="${budgetHref(card.dao)}" data-nav>
      <div class="agent-card-head">${avatar(card.dao)}<span class="strong mono wrap">${card.dao}</span><span class="pill pill-cleanup">Setup not finished</span></div>
      <p class="small muted">No finished budget was found for this account yet.</p></a>`;
  }
  const w = g.window;
  const p = g.policy;
  const agents = g.agents?.length ?? g.config?.agents ?? null;
  const recipients = g.whitelist?.length ?? g.config?.whitelist ?? null;
  const last = (b.requests ?? []).find((r) => r.status === "Executed" && r.created_at !== null);
  const meta = [agents === null ? null : plural(agents, "agent"), recipients === null ? null : plural(recipients, "recipient"), last === undefined ? null : `last payment ${ago(last.created_at, Date.now()).toLowerCase()}`]
    .filter((t) => t !== null)
    .join(" · ");
  return html`<a class="agent-card" href="${budgetHref(card.dao)}" data-nav>
    <div class="agent-card-head">${avatar(card.dao)}<span class="strong mono wrap">${card.dao}</span>${budgetStatusPill(g)}</div>
    <div class="agent-card-nums">
      <div><p class="small muted">Balance</p><p class="agent-card-big">${near(b.withdrawable)}</p></div>
      <div class="grow-min"><p class="small muted">Spent today</p>
        <p class="strong">${w === null ? "unknown" : p === null ? near(w.spent_in_window) : `${yoctoToNear(w.spent_in_window)} of ${near(p.max_per_day)}`}</p>
        ${w !== null && p !== null ? html`<progress class="progress" max="100" value="${percent(w.spent_in_window, p.max_per_day)}" aria-label="Share of the daily limit spent"></progress>` : ""}</div>
    </div>
    ${meta === "" ? "" : html`<p class="small muted">${meta}</p>`}</a>`;
}

function yieldCard(row: AgentRow, network: Network): Html {
  const token = YIELD_ALLOWLIST[network]?.tokens[0] ?? null;
  const pill =
    row.status === "farming"
      ? html`<span class="pill pill-ok">${icon.check()}Farming</span>`
      : row.status === "idle"
        ? html`<span class="pill pill-note">Idle</span>`
        : html`<span class="pill pill-cleanup">Status unknown</span>`;
  const supplied = row.supplied === null || token === null ? "unknown" : `${tokenAmount(row.supplied, token.decimals)} ${token.symbol}`;
  return html`<a class="agent-card" href="${yieldHref(row.dao)}" data-nav>
    <div class="agent-card-head">${avatar(`yield:${row.dao}`)}<span class="stack-xs grow-min"><span class="strong">Yield agent</span><span class="small muted mono wrap">${row.dao}</span></span>${pill}</div>
    <div><p class="small muted">Supplied on Rhea Lend</p><p class="agent-card-big">${supplied}</p></div>
    <p class="small muted">Suggests only. You approve every move.${network === "testnet" ? " Test data, not real yield." : ""}</p></a>`;
}

const NEW_CARD = html`<div class="agent-card agent-card-new">${icon.plus()}<span class="strong">New agent</span><a class="link-btn" href="${pageHref("budget")}" data-nav>Pay for things</a><a class="link-btn" href="${yieldNewHref()}" data-nav>Earn on idle funds</a></div>`;

/** The newest events across budgets, each worded by its own budget's agents. */
function recentActivity(cards: readonly BudgetCard[], now: number): Html {
  const events = cards
    .flatMap(({ live }) => (live?.requests ?? []).map((r) => ({ r, g: live?.guard ?? null })))
    .sort((a, b) => (BigInt(a.r.created_at ?? "0") < BigInt(b.r.created_at ?? "0") ? 1 : BigInt(a.r.created_at ?? "0") > BigInt(b.r.created_at ?? "0") ? -1 : 0))
    .slice(0, ACTIVITY_SHOWN);
  return html`<section class="card" aria-labelledby="ma-activity">
    <div class="b-head"><h2 id="ma-activity" class="b-h">Recent activity</h2></div>
    ${events.length === 0 ? html`<p class="muted pad-row">No requests yet.</p>` : html`<ul class="plain-list">${events.map((e) => activityRow(e.r, e.g, now))}</ul>`}</section>`;
}

const ALERTS = html`<section id="alerts" class="card" aria-labelledby="ma-alerts">
  <div class="b-head"><div><h2 id="ma-alerts" class="b-h">Alerts</h2><p class="small muted">Telegram alerts for risky requests, budget changes and key changes.</p></div>
  <button type="button" class="btn btn-secondary" data-action="alerts-open">${icon.bell()}Manage alerts</button></div></section>`;

export function renderMyAgents(data: MyAgents, accounts: readonly string[], cards: readonly BudgetCard[], now: number = Date.now()): Html {
  const yields = data.rows.filter((r) => r.kind === "yield");
  const agents = data.rows.length;
  if (cards.length === 0 && yields.length === 0) {
    const note = data.unread === 0 ? "" : html`<p class="small muted">${plural(data.unread, "budget")} could not be read, so this page cannot tell if you sit on ${data.unread === 1 ? "it" : "them"}.</p>`;
    return html`${head(accounts)}
      <section class="card pad stack-xs budget-narrow">
        <p class="strong">No agents yet</p>
        <p class="small muted">Give your first agent a budget in about 2 minutes.</p>
        <div class="actions"><a class="btn btn-primary" href="${pageHref("budget")}" data-nav>${icon.plus()}Pay for things</a><a class="btn" href="${yieldNewHref()}" data-nav>Earn on idle funds</a></div>
        ${note}
      </section>`;
  }
  const sub = `${plural(cards.length, "budget")} · ${plural(agents, "agent")} · everything they did in the last 24 hours`;
  const unread = data.unread === 0 ? "" : html`<p class="small muted">${plural(data.unread, "budget")} could not be read, so this page cannot tell if you sit on ${data.unread === 1 ? "it" : "them"}.</p>`;
  return html`<div class="agents-top">${head(accounts, sub)}<div class="actions">${NEW_AGENT}</div></div>
    ${ACTION_HOST}${needsYou(cards, now)}
    <section class="stack-xs" aria-labelledby="ma-cards">
      <h2 id="ma-cards" class="h2">Budgets and yield agents</h2>
      <div class="agent-cards">${cards.map(budgetCard)}${yields.map((r) => yieldCard(r, data.network))}${NEW_CARD}</div>
      ${unread}</section>
    ${recentActivity(cards, now)}${ALERTS}`;
}
