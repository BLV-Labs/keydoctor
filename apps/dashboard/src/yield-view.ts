// The Yield agent page, pure. Every number is read from the chain (yield-read.ts) or the library's kd.yield.v1
// report. The page never calls the AI step: suggestions show in the rule order (highest APR first), and the
// council's wallets sign every proposal and vote (yield plan YD4).
import { YIELD_REASON_TEXT, YIELD_WARNING_TEXT, type KdYieldReport, type Network, type YieldOpportunity } from "key-doctor";
import { formatUtc, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { copyRow } from "./pages.ts";
import { pageHref } from "./route.ts";
import { RHEA_STORAGE_YOCTO, tokenAmount, YIELD_ALLOWLIST, YIELD_PREFIX, type YieldAllowlist } from "./yield-proposals.ts";
import type { YieldLive, YieldProposal } from "./yield-read.ts";

export type YieldPanel = "supply" | "withdraw" | "register";
export type YieldState = "farming" | "idle" | "unknown";

const EXAMPLE_DAO = "kdoncall.sputnik-v2.testnet";
const LEAD = "Watches Rhea Lend for your DAO's idle stablecoins and suggests where they could earn. It never moves funds: every supply and every withdraw is a council vote.";
const SIG = html`<span class="sig">1 signature + vote</span>`;

function head(lead: string): Html {
  return html`<section class="stack-xs"><h1 class="h1">Yield agent</h1><p class="muted budget-lead">${lead}</p></section>`;
}

/** Supply APR, a fraction, as a percent with two places. */
export const aprText = (apr: number): string => `${(apr * 100).toFixed(2)}%`;

function usd(n: number | null, testData: boolean): string {
  if (testData) return "test data";
  if (n === null) return "unknown";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return `$${n.toFixed(0)}`;
}

/** Farming once anything is supplied; idle when the read says nothing is; unknown when it could not be read. */
export function yieldState(positions: YieldLive["positions"]): YieldState {
  if (positions === null) return "unknown";
  return positions.length > 0 ? "farming" : "idle";
}

export function yieldStatePill(state: YieldState): Html {
  if (state === "farming") return html`<span class="pill pill-ok">${icon.check()}Farming</span>`;
  if (state === "idle") return html`<span class="pill pill-note">Idle</span>`;
  return html`<span class="pill pill-cleanup">Position unknown</span>`;
}

/** The DAO form. */
export function renderYieldStart(dao: string, error: string | null): Html {
  return html`${head(LEAD)}
    <form id="yield-dao-form" class="card pad stack-sm budget-narrow" novalidate>
      <label for="yield-dao" class="label">The DAO's account name</label>
      <div class="input-row">
        <input id="yield-dao" name="dao" type="text" class="input mono" value="${dao}" placeholder="${EXAMPLE_DAO}"
          autocomplete="off" autocapitalize="none" spellcheck="false" required${error ? html` aria-invalid="true" aria-describedby="yield-dao-error"` : ""}>
        <button type="submit" class="btn btn-secondary">Open</button>
      </div>
      ${error ? html`<p id="yield-dao-error" class="field-error" role="alert">${error}</p>` : ""}
      <p class="small muted">Anyone can read a DAO's Yield page. Only its council can propose or vote, from their own wallets. Proposals are open on testnet only.</p>
    </form>`;
}

export function renderYieldLoading(dao: string): Html {
  return html`${head("Reading this DAO's treasury and Rhea Lend rates…")}
    <section class="card pad stack-sm" aria-busy="true" aria-label="Loading ${dao}"><p class="meta mono" role="status">${dao}</p></section>`;
}

const tile = (label: string, value: Html | string, note: string) =>
  html`<div class="card tile"><span class="tile-label">${label}</span><span class="tile-value">${value}</span><span class="tile-note">${note}</span></div>`;
const amountValue = (raw: string | null | undefined, decimals: number, symbol: string) =>
  raw === null || raw === undefined ? "unknown" : html`${tokenAmount(raw, decimals)} <span class="tile-unit">${symbol}</span>`;

/** The allowlisted token this page acts on (YD0 proved one), with its holding and position. */
function focus(live: YieldLive, list: YieldAllowlist | null) {
  const t = list?.tokens[0] ?? null;
  if (t === null) return null;
  const holding = live.report.holdings.find((h) => h.token_id === t.token_id) ?? null;
  const supplied = live.positions === null ? null : (live.positions.find((p) => p.token_id === t.token_id)?.supplied ?? "0");
  const opportunity = live.report.opportunities.find((o) => o.executable && o.token_id === t.token_id) ?? null;
  return { ...t, holding, supplied, opportunity };
}

function tiles(live: YieldLive, f: NonNullable<ReturnType<typeof focus>>): Html {
  const best = live.report.opportunities.find((o) => o.executable) ?? null;
  const open = f.holding?.open_transfers ?? [];
  const held = open.length === 0 ? "Nothing promised to open transfers" : `Open transfers ${open.map((o) => `#${o.proposal_id}`).join(", ")} hold part of it`;
  return html`<section class="tiles" aria-label="Yield summary">
    ${tile("Idle in the DAO", amountValue(f.holding?.balance, f.decimals, f.symbol), "Balance of the eligible token")}
    ${tile("Available to farm", amountValue(f.holding?.available, f.decimals, f.symbol), held)}
    ${tile("Supplied on Rhea Lend", amountValue(f.supplied, f.decimals, f.symbol), "Interest included · withdraw needs a vote")}
    ${tile("Best supply APR", best === null ? "none" : aprText(best.apr), best === null ? "No candidate on this network" : `${best.symbol} on Rhea Lend${best.test_data ? " · test data" : ""}`)}
  </section>`;
}

function suggestionCard(r: KdYieldReport, canSupply: boolean): Html {
  const byId = new Map(r.opportunities.map((o) => [o.id, o]));
  const items = r.suggestions.flatMap((s, i) => {
    const o = byId.get(s.opportunity_id);
    if (o === undefined) return [];
    const tags = [
      html`<span class="tag">Up to ${tokenAmount(s.max_amount, decimalsOf(r, s.token_id))} ${o.symbol}</span>`,
      o.test_data ? html`<span class="tag tag-warn">Test data</span>` : "",
      ...o.warnings.map((w) => html`<span class="tag tag-warn">${YIELD_WARNING_TEXT[w].en}</span>`),
    ];
    return [
      html`<li class="sugg">
        <span class="rank" aria-label="Rank ${String(i + 1)}">${String(i + 1)}</span>
        <div class="sugg-body">
          <div class="sugg-top"><span class="strong">Supply ${o.symbol} to Rhea Lend</span><span class="apr">${aprText(o.apr)} <span class="small muted">APR</span></span></div>
          <div class="tags">${tags}</div>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-action="yield-open" data-panel="supply"${canSupply ? "" : " disabled"}>Propose</button>
      </li>`,
    ];
  });
  return html`<section class="card" aria-labelledby="y-suggest">
    <div class="b-head">
      <div><h2 id="y-suggest" class="b-h">Suggestion</h2><p class="small muted">Read at block ${r.chain.block_height.toLocaleString("en-US")} · ${formatUtc(r.chain.block_timestamp)}</p></div>
      <span class="pill pill-note pill-sm">Rule order</span>
    </div>
    ${items.length === 0 ? html`<p class="pad muted">No suggestion right now.</p>` : html`<ol class="plain-list sugg-list">${items}</ol>`}
    <p class="small muted pad-row">Ordered by APR, highest first. The AI-assisted order with reasons is in Telegram (<span class="mono">/yield ${r.dao}</span>) and in the MCP tool <span class="mono">yield_suggestions</span>.</p>
    <ul class="plain-list stack-xs pad-row-banner">${r.notes.map((n) => html`<li class="banner banner-note">${icon.info()}<span>${n.en}</span></li>`)}</ul>
  </section>`;
}

function decimalsOf(r: KdYieldReport, tokenId: string): number {
  return r.holdings.find((h) => h.token_id === tokenId)?.decimals ?? 6;
}

function rateRow(o: YieldOpportunity): Html {
  const src = (name: "rhea-lend" | "rhea-api") => {
    const s = o.sources.find((x) => x.name === name);
    return s === undefined ? "—" : aprText(s.apr);
  };
  return html`<tr>
    <td><span class="strong">${o.symbol}</span><span class="small muted mono block wrap">${o.token_id}</span></td>
    <td>${o.network}</td>
    <td class="num strong">${aprText(o.apr)}</td>
    <td class="num${o.test_data ? " muted" : ""}">${usd(o.tvl_usd, o.test_data)}</td>
    <td class="num${o.test_data ? " muted" : ""}">${usd(o.liquidity_usd, o.test_data)}</td>
    <td class="small">Chain ${src("rhea-lend")}<br><span class="muted">API ${src("rhea-api")}</span></td>
    <td>${o.executable ? html`<span class="pill pill-ok pill-sm">Can propose</span>` : html`<span class="pill pill-note pill-sm">Reference</span>`}</td>
  </tr>`;
}

function ratesCard(r: KdYieldReport): Html {
  const rejected = r.rejected.map(
    (x) => html`<li class="rej"><span class="strong mono wrap">${x.token_id}</span><span class="muted">${x.network} · ${x.reasons.map((why) => YIELD_REASON_TEXT[why].en).join(" ")}</span></li>`,
  );
  return html`<section class="card" aria-labelledby="y-rates">
    <div class="b-head"><div><h2 id="y-rates" class="b-h">Rates</h2><p class="small muted">Rhea Lend, two sources each. Only rows on this DAO's network can be proposed.</p></div></div>
    ${r.opportunities.length === 0
      ? html`<p class="pad muted">No row passed the filter.</p>`
      : html`<div class="table-scroll"><table class="key-table rates">
          <thead><tr><th>Token</th><th>Network</th><th class="num">Supply APR</th><th class="num">Total supplied</th><th class="num">Withdrawable</th><th>Sources</th><th>Use</th></tr></thead>
          <tbody>${r.opportunities.map(rateRow)}</tbody></table></div>`}
    ${rejected.length === 0
      ? ""
      : html`<details class="rejected"><summary class="small">Filtered out (${String(rejected.length)})${icon.chevronRight()}</summary><ul class="plain-list small">${rejected}</ul></details>`}
  </section>`;
}

const STATUS_PILL: Record<string, Html> = {
  Approved: html`<span class="pill pill-ok">${icon.check()}Approved</span>`,
  Rejected: html`<span class="pill pill-note">Rejected</span>`,
  Removed: html`<span class="pill pill-note">Removed</span>`,
  Expired: html`<span class="pill pill-note">Expired</span>`,
  Failed: html`<span class="pill pill-cleanup">Failed</span>`,
};

function proposalRow(p: YieldProposal, canVote: boolean): Html {
  const text = p.description.startsWith(YIELD_PREFIX) ? p.description.slice(YIELD_PREFIX.length).trim() : p.description;
  const open = p.status === "InProgress";
  const pill = open ? html`<span class="pill pill-info">${icon.clock()}${String(p.approvals)} approved</span>` : (STATUS_PILL[p.status] ?? html`<span class="pill pill-note">${p.status}</span>`);
  const votes = open && canVote
    ? html`<span class="activity-time actions">
        <button type="button" class="btn btn-danger btn-sm" data-action="yield-vote" data-id="${String(p.id)}" data-vote="VoteReject">Reject</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="yield-vote" data-id="${String(p.id)}" data-vote="VoteApprove">Approve <span class="sig">1 signature</span></button></span>`
    : "";
  return html`<li class="activity-row">
    <span class="activity-status">${pill}</span>
    <span class="activity-text wrap">#${String(p.id)} ${text}<span class="small muted activity-why">Proposed by <span class="mono">${p.proposer}</span></span></span>
    ${votes}
  </li>`;
}

function votesCard(proposals: YieldProposal[] | null, canVote: boolean): Html {
  const body =
    proposals === null
      ? html`<p class="pad muted">The DAO's proposals could not be read right now.</p>`
      : proposals.length === 0
        ? html`<p class="pad muted">No yield proposal among the DAO's newest 40.</p>`
        : html`<ul class="plain-list">${proposals.map((p) => proposalRow(p, canVote))}</ul>`;
  return html`<section class="card" aria-labelledby="y-props">
    <div class="b-head"><div><h2 id="y-props" class="b-h">Council votes</h2><p class="small muted">Supply, withdraw and register proposals, newest first.</p></div></div>
    ${body}
  </section>`;
}

const row = (dt: Html | string, dd: Html | string) => html`<div class="rule-row"><dt>${dt}</dt><dd>${dd}</dd></div>`;

function positionCard(live: YieldLive, f: NonNullable<ReturnType<typeof focus>>, canWithdraw: boolean): Html {
  const registered = live.registered === null ? "unknown" : live.registered ? "Yes" : "Not yet: one register vote first";
  return html`<section class="card" aria-labelledby="y-pos">
    <div class="b-head"><h2 id="y-pos" class="b-h">Position on Rhea Lend</h2>
      ${canWithdraw ? html`<button type="button" class="btn btn-ghost" data-action="yield-open" data-panel="withdraw">Withdraw</button>` : ""}</div>
    <dl class="rule-list">
      ${row("Registered", registered)}
      ${row("Supplied", f.supplied === null ? "unknown" : `${tokenAmount(f.supplied, f.decimals)} ${f.symbol}`)}
      ${row("Supply APR now", f.opportunity === null ? "unknown" : `${aprText(f.opportunity.apr)}${f.opportunity.test_data ? " (test data)" : ""}`)}
    </dl>
  </section>`;
}

function treasuryCard(f: NonNullable<ReturnType<typeof focus>>): Html {
  const h = f.holding;
  const open = h?.open_transfers ?? [];
  return html`<section class="card" aria-labelledby="y-hold">
    <div class="b-head"><h2 id="y-hold" class="b-h">Treasury</h2></div>
    <dl class="rule-list">
      ${row(`${f.symbol} balance`, h?.balance == null ? "unknown" : tokenAmount(h.balance, f.decimals))}
      ${open.map((o) => row(`Promised to open transfer #${o.proposal_id}`, `− ${tokenAmount(o.amount, f.decimals)}`))}
      ${row(html`<span class="strong">Available to farm</span>`, html`<span class="strong">${h?.available == null ? "unknown" : tokenAmount(h.available, f.decimals)}</span>`)}
    </dl>
    ${h?.error ? html`<p class="small muted pad-row">${h.error}</p>` : ""}
  </section>`;
}

function runsCard(dao: string, list: YieldAllowlist | null): Html {
  return html`<section class="card" aria-labelledby="y-set">
    <div class="b-head"><h2 id="y-set" class="b-h">How this agent runs</h2></div>
    <dl class="rule-list">
      ${row("Telegram push", "Checks every 15 minutes for chats that watch")}
      ${row("Pushes when", "Top idea or its APR changes")}
      ${row("Tokens", list === null ? "None on this network yet" : list.tokens.map((t) => t.symbol).join(", "))}
      ${row("Can move funds", html`<span class="strong">No, council votes</span>`)}
    </dl>
    <div class="pad-row stack-xs"><p class="small muted">Turn pushes on in your Telegram chat. <span class="mono">/yield_unwatch</span> turns them off.</p>${copyRow(`/yield_watch ${dao}`)}</div>
  </section>`;
}

function technical(r: KdYieldReport, list: YieldAllowlist | null): Html {
  const extra = [...r.errors, ...r.limitations];
  return html`<details class="card tech"><summary>Technical details${icon.chevronRight()}</summary>
    <dl class="tech-list">
      <div class="tech-row"><dt>Rhea Lend contract</dt><dd class="mono">${list?.lend ?? "proposals off on this network"}</dd></div>
      <div class="tech-row"><dt>Yield ruleset</dt><dd class="mono">${r.yield_ruleset_version}</dd></div>
      <div class="tech-row"><dt>Block</dt><dd class="mono">${String(r.chain.block_height)}</dd></div>
      <div class="tech-row"><dt>Network</dt><dd>${r.chain.network}</dd></div>
    </dl>
    ${extra.length === 0 ? "" : html`<ul class="list small pad-row">${extra.map((e) => html`<li>${e}</li>`)}</ul>`}
  </details>`;
}

/** What the page lets the council do now; each false says why on the page. */
export function yieldActions(live: YieldLive, network: Network) {
  const list = YIELD_ALLOWLIST[network];
  const f = focus(live, list);
  const available = f?.holding?.available ?? null;
  return {
    open: list !== null,
    register: list !== null && live.registered === false,
    supply: list !== null && live.registered === true && available !== null && BigInt(available) > 0n,
    withdraw: list !== null && f?.supplied !== null && f?.supplied !== undefined && BigInt(f.supplied) > 0n,
  };
}

/** The live page for one DAO. */
export function renderYield(live: YieldLive, network: Network): Html {
  const r = live.report;
  const list = YIELD_ALLOWLIST[network];
  const f = focus(live, list);
  const can = yieldActions(live, network);
  const closed = list === null ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>Yield proposals are not open on ${network} yet. Rates show for reference.</span></p>` : "";
  return html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${pageHref("my-agents")}" data-nav>My Agents</a><span aria-hidden="true">/</span><span class="mono">${r.dao}</span><span aria-hidden="true">/</span><span>Yield agent</span></nav>
    ${head(LEAD)}
    <section class="budget-top" aria-label="Yield agent">
      <div class="budget-name"><span class="strong mono wrap">${r.dao}</span>${yieldStatePill(yieldState(live.positions))}<span class="tag">${network}</span></div>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Rescan</button>
        ${can.register ? html`<button type="button" class="btn btn-primary" data-action="yield-open" data-panel="register">Register on Rhea Lend ${SIG}</button>` : ""}
        ${can.withdraw ? html`<button type="button" class="btn btn-secondary" data-action="yield-open" data-panel="withdraw">Withdraw ${SIG}</button>` : ""}
        ${can.open && !can.register ? html`<button type="button" class="btn btn-primary" data-action="yield-open" data-panel="supply"${can.supply ? "" : " disabled"}>Propose supply ${SIG}</button>` : ""}
      </div>
    </section>
    ${closed}
    ${f === null ? "" : tiles(live, f)}
    <p id="yield-status" class="small" role="status"></p>
    <div class="budget-cols">
      <div class="budget-main">${suggestionCard(r, can.supply)}${ratesCard(r)}${votesCard(live.proposals, can.open)}</div>
      <aside class="budget-side" aria-label="Position and settings">
        ${f === null ? "" : html`${positionCard(live, f, can.withdraw)}${treasuryCard(f)}`}
        ${runsCard(r.dao, list)}
        ${technical(r, list)}
      </aside>
    </div>
    <dialog id="yield-action" class="drawer" aria-labelledby="yp-title"></dialog>`;
}

function drawerHead(title: string, note: string): Html {
  return html`<div class="drawer-head">
    <div class="drawer-title"><h2 id="yp-title" class="drawer-h wrap">${title}</h2><p class="small muted">${note}</p></div>
    <button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close">${icon.close()}</button></div>`;
}

const CANCEL = html`<button type="button" class="btn btn-secondary" data-action="close-dialog">Cancel</button>`;
const sumRow = (label: string, value: Html | string) => html`<div class="sum-row"><span class="muted">${label}</span><span class="sum-value wrap">${value}</span></div>`;
const NEXT = html`<div class="stack-xs"><h3 class="drawer-h3">What happens next</h3><ol class="list small">
  <li>Your wallet signs one transaction that adds the proposal and attaches the DAO's bond. It moves no funds.</li>
  <li>The council votes. Funds move only when the vote passes.</li></ol></div>
  <p class="small muted">Receiver, method and token come from code, never from the AI step.</p>`;

/** The drawer for one council action. Null when the network has no allowlist (the page shows no button then). */
export function renderYieldPanel(panel: YieldPanel, live: YieldLive, network: Network, error: string | null = null, amount = ""): Html | null {
  const list = YIELD_ALLOWLIST[network];
  const f = focus(live, list);
  if (list === null || f === null) return null;
  const bond = live.policy === null ? "unknown" : `${yoctoToNear(live.policy.proposal_bond)} NEAR`;
  const err = error ? html`<p id="yp-error" class="field-error" role="alert">${error}</p>` : "";
  const sign = (kind: YieldPanel) => html`<button type="button" class="btn btn-primary" data-action="yield-sign" data-panel="${kind}">Create proposal <span class="sig">1 signature</span></button>`;
  if (panel === "register") {
    return html`${drawerHead("Register the DAO on Rhea Lend", "One time, before the first supply")}
      <div class="drawer-body">
        <div class="sum-box">${sumRow("The DAO pays", `${yoctoToNear(RHEA_STORAGE_YOCTO)} NEAR storage deposit`)}${sumRow("Call", html`<span class="mono">storage_deposit on ${list.lend}</span>`)}${sumRow("Bond from your wallet", bond)}</div>
        ${NEXT}${err}
      </div>
      <div class="drawer-foot">${CANCEL}${sign("register")}</div>`;
  }
  if (panel === "withdraw") {
    return html`${drawerHead("Propose a withdraw", "From Rhea Lend back to the DAO")}
      <div class="drawer-body">
        <div class="sum-box">
          ${sumRow("Rhea Lend returns", `All ${f.supplied === null ? "" : tokenAmount(f.supplied, f.decimals)} ${f.symbol} supplied, interest included`)}
          ${sumRow("To", html`<span class="mono">${live.report.dao}</span>`)}
          ${sumRow("Call", html`<span class="mono">execute (Withdraw) on ${list.lend}</span>`)}
          ${sumRow("Bond from your wallet", bond)}
        </div>
        <p class="small muted">Withdraw first when a payout needs the funds: the vote takes time.</p>
        ${NEXT}${err}
      </div>
      <div class="drawer-foot">${CANCEL}${sign("withdraw")}</div>`;
  }
  const available = f.holding?.available ?? null;
  const max = available === null ? "" : tokenAmount(available, f.decimals);
  return html`<form id="yield-panel-form" class="drawer-form" novalidate>${drawerHead("Propose a supply", `${f.symbol} to Rhea Lend${f.opportunity === null ? "" : ` · ${aprText(f.opportunity.apr)} APR${f.opportunity.test_data ? " (test data)" : ""}`}`)}
    <div class="drawer-body">
      <div class="stack-xs">
        <label class="label" for="yp-amount">Amount</label>
        <div class="input-unit"><input id="yp-amount" name="amount" type="text" class="input mono" inputmode="decimal" value="${amount}" autocomplete="off" spellcheck="false"${error ? html` aria-invalid="true" aria-describedby="yp-error"` : ""}><span class="muted">${f.symbol}</span></div>
        <div class="presets"><button type="button" class="filter-chip" data-action="yield-max" data-amount="${max}"${available === null ? " disabled" : ""}>Max ${max}</button></div>
        <p class="small muted">Available is the DAO's balance minus what open transfers promise.</p>
      </div>
      <div class="sum-box">
        ${sumRow("To", html`<span class="mono">${list.lend}</span>`)}
        ${sumRow("Call", html`<span class="mono">ft_transfer_call on ${f.token_id}</span>`)}
        ${sumRow("Bond from your wallet", bond)}
      </div>
      ${NEXT}${err}
    </div>
    <div class="drawer-foot">${CANCEL}<button type="submit" class="btn btn-primary">Create proposal <span class="sig">1 signature</span></button></div></form>`;
}
