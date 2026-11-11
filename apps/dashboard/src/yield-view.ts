// The Yield agent page, pure. Every number is read from the chain (yield-read.ts) or the library's kd.yield.v1
// report. The page never calls the AI step: suggestions show in the rule order (highest APR first), and the
// council's wallets sign every proposal and vote (yield plan YD4).
import { bestSupply, supplyAprAfter, YIELD_REASON_TEXT, yearlyEarnings, type KdYieldReport, type Network, type YieldOpportunity } from "key-doctor";
import { formatUtc, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { copyRow } from "./pages.ts";
import { pageHref } from "./route.ts";
import { pctText, suggest, summarySentence, votesNeeded } from "./yield-agent.ts";
import { allowedYieldKind, describeYieldKind, RHEA_STORAGE_YOCTO, tokenAmount, tokenRaw, YIELD_ALLOWLIST, type YieldAllowlist, type YieldMove } from "./yield-proposals.ts";
import type { YieldLive, YieldProposal } from "./yield-read.ts";
import { CHECK_EVERY_TEXT, type LimitField, type LimitInput, type YieldSettings } from "./yield-settings.ts";
import { pillarTag } from "./pillars.ts";

export type YieldPanel = "supply" | "withdraw" | "register";
export type YieldState = "farming" | "idle" | "unknown";

const EXAMPLE_DAO = "kdoncall.sputnik-v2.testnet";
const LEAD = "Watches Rhea Lend for your treasury's idle stablecoins and suggests where they could earn. It never moves funds: every move is a council vote.";
export const YIELD_TESTNET_ONLY = "Yield works on testnet only for now";
const SIG = html`<span class="sig">1 signature + vote</span>`;

function head(lead: string): Html {
  return html`<section class="stack-xs">${pillarTag("yield")}<h1 class="h1">Yield agent</h1><p class="muted budget-lead">${lead}</p></section>`;
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
      <label for="yield-dao" class="label">The treasury's account name</label>
      <div class="input-row">
        <input id="yield-dao" name="dao" type="text" class="input mono" value="${dao}" placeholder="${EXAMPLE_DAO}"
          autocomplete="off" autocapitalize="none" spellcheck="false" required${error ? html` aria-invalid="true" aria-describedby="yield-dao-error"` : ""}>
        <button type="submit" class="btn btn-secondary">Open</button>
      </div>
      ${error ? html`<p id="yield-dao-error" class="field-error" role="alert">${error}</p>` : ""}
      <p class="small muted">Anyone can read a treasury's Yield page. Only its council can ask for a move or vote, from their own wallets. Moves are open on testnet only.</p>
    </form>`;
}

export function renderYieldLoading(dao: string): Html {
  return html`${head("Reading this treasury and the Rhea Lend rates…")}
    <section class="card pad stack-sm" aria-busy="true" aria-label="Loading ${dao}"><p class="meta mono" role="status">${dao}</p></section>`;
}

const tile = (label: string, value: Html | string, note: string) =>
  html`<div class="card tile"><span class="tile-label">${label}</span><span class="tile-value">${value}</span><span class="tile-note">${note}</span></div>`;
const amountValue = (raw: string | null | undefined, decimals: number, symbol: string) =>
  raw === null || raw === undefined ? "unknown" : html`${tileAmount(raw, decimals)} <span class="tile-unit">${symbol}</span>`;

/**
 * A tile amount: two decimals rounded down, so a tile never shows more than is there, with thousands
 * separators so a long balance fits a phone-width tile and reads at a glance. Inputs and proposals keep
 * the exact `tokenAmount`.
 */
export function tileAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return "unknown";
  const v = BigInt(raw);
  const cents = decimals >= 2 ? v / 10n ** BigInt(decimals - 2) : v * 10n ** BigInt(2 - decimals);
  if (cents === 0n && v > 0n) return "less than 0.01";
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * An amount in a sentence: exact, since it is what the vote would move, with thousands separators so a long
 * number reads at a glance. Never for input values or `data-amount`: `tokenRaw` does not parse commas.
 */
export function readAmount(raw: string, decimals: number): string {
  const exact = tokenAmount(raw, decimals);
  if (exact === "unknown") return exact;
  const [int = "", frac] = exact.split(".");
  const grouped = BigInt(int).toLocaleString("en-US");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/** The allowlisted token this page acts on (YD0 proved one), with its holding and position. */
function focus(live: YieldLive, list: YieldAllowlist | null) {
  const t = list?.tokens[0] ?? null;
  if (t === null) return null;
  const holding = live.report.holdings.find((h) => h.token_id === t.token_id) ?? null;
  const supplied = live.positions === null ? null : (live.positions.find((p) => p.token_id === t.token_id)?.supplied ?? "0");
  const opportunity = live.report.opportunities.find((o) => o.executable && o.token_id === t.token_id) ?? null;
  const pool = live.pools?.find((p) => p.token_id === t.token_id) ?? null;
  return { ...t, holding, supplied, opportunity, pool };
}

type Focus = NonNullable<ReturnType<typeof focus>>;

const tokenOf = (network: Network) => YIELD_ALLOWLIST[network]?.tokens[0] ?? null;

/** A move in plain words, for the suggestion and the history. */
function moveText(m: YieldMove, network: Network): string {
  const t = tokenOf(network);
  const sym = t?.symbol ?? "";
  if (m.kind === "register") return "Register with Rhea Lend";
  if (m.kind === "withdraw") return m.amount === null ? `Take all ${sym} back from Rhea Lend` : `Take ${readAmount(m.amount, t?.decimals ?? 6)} ${sym} back from Rhea Lend`;
  return `Put ${readAmount(m.amount, t?.decimals ?? 6)} ${sym} on Rhea Lend`;
}

function tiles(f: Focus, settings: YieldSettings | null): Html {
  const keep = settings === null || BigInt(settings.keepReady) === 0n ? null : tokenAmount(settings.keepReady, f.decimals);
  const open = f.holding?.open_transfers ?? [];
  const idleNote = keep !== null ? `${keep} ${f.symbol} kept ready` : open.length === 0 ? "Nothing promised to open transfers" : `Open transfers ${open.map((o) => `#${o.proposal_id}`).join(", ")} hold part of it`;
  const o = f.opportunity;
  return html`<section class="tiles" aria-label="Yield summary">
    ${tile("Working on Rhea Lend", amountValue(f.supplied, f.decimals, f.symbol), "Interest included · taking it back needs a vote")}
    ${tile("Idle now", amountValue(f.holding?.available, f.decimals, f.symbol), idleNote)}
    ${tile("Rate today", o === null ? "none" : html`${aprText(o.apr)} <span class="tile-unit">a year</span>`, o === null ? "No row on this network" : `Rhea Lend${o.test_data ? " · test data" : ""}`)}
  </section>`;
}

/** Whole tokens with thousands separators: rounding the projection is honest, it is an estimate. */
function whole(raw: bigint, decimals: number): string {
  const n = raw / 10n ** BigInt(decimals);
  return n === 0n && raw > 0n ? "less than 1" : n.toLocaleString("en-US");
}

/**
 * What the treasury's position would earn after it changes by `change` raw units (+ supply, - withdraw), from Rhea
 * Lend's rate model. Null when the pool or the position could not be read.
 */
function projection(f: Focus, change: bigint): string | null {
  if (f.pool === null || f.supplied === null) return null;
  const left = BigInt(f.supplied) + change;
  if (left < 0n) return null;
  const rate = `Rate ${aprText(supplyAprAfter(f.pool, 0n))} → ${aprText(supplyAprAfter(f.pool, change))} a year`;
  if (left === 0n) return `${rate}. Nothing of the treasury's stays on Rhea Lend.`;
  const yearly = yearlyEarnings(f.pool, BigInt(f.supplied), change);
  return `${rate}. The treasury's ${whole(left, f.decimals)} ${f.symbol} there would earn about ${whole(yearly, f.decimals)} ${f.symbol} a year, if borrowing stays as it is.`;
}

const fmtVotes = (approvals: number, needed: number | null) => (needed === null ? `${String(approvals)} approved` : `${String(approvals)} of ${String(needed)} needed`);

function suggestionCard(live: YieldLive, network: Network, f: Focus, settings: YieldSettings | null, featured: YieldProposal | null, canVote: boolean): Html {
  const r = live.report;
  const needed = votesNeeded(live.policy);
  const prompt = settings === null
    ? html`<div class="banner banner-note">${icon.info()}<span>No limits set yet. <button type="button" class="link-btn" data-action="yield-limits-open">Set limits</button></span></div>`
    : "";
  let body: Html;
  if (featured !== null) {
    const move = describeYieldKind(network, featured.kind) as YieldMove;
    body = html`<div class="stack-sm">
      <div class="sugg-top"><span class="strong">${moveText(move, network)}</span><span class="pill pill-info">${icon.clock()}${fmtVotes(featured.approvals, needed)}</span></div>
      <p class="small muted">Waiting for the council. Funds move only when the vote passes.</p>
      ${canVote ? html`<div class="actions">
        <button type="button" class="btn btn-danger btn-sm" data-action="yield-vote" data-id="${String(featured.id)}" data-vote="VoteReject">Reject</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="yield-vote" data-id="${String(featured.id)}" data-vote="VoteApprove">Approve <span class="sig">1 signature</span></button></div>` : ""}
    </div>`;
  } else {
    const s = suggest({ settings, apr: f.opportunity?.apr ?? null, idle: f.holding?.available ?? null, supplied: f.supplied, registered: live.registered, pool: f.pool, decimals: f.decimals, symbol: f.symbol });
    if (s.kind === "nothing") {
      body = html`<p class="strong">Nothing to do: ${s.reason}</p>`;
    } else {
      const amount = tokenAmount(s.amount, f.decimals);
      const shown = readAmount(s.amount, f.decimals);
      const rate = f.opportunity === null ? "" : `Rate today ${aprText(f.opportunity.apr)} a year${f.opportunity.test_data ? " (test data)" : ""}. `;
      const keep = settings === null || BigInt(settings.keepReady) === 0n ? "" : `, with ${readAmount(settings.keepReady, f.decimals)} ${f.symbol} kept ready`;
      const after = projection(f, BigInt(s.amount));
      const allAfter = s.all === undefined ? null : projection(f, BigInt(s.all));
      const best = s.all === undefined
        ? ""
        : html`<p class="small muted">${shown} ${f.symbol} earns the treasury the most: each deposit lowers the rate for the whole pool. Putting all ${readAmount(s.all, f.decimals)} ${f.symbol} in: ${allAfter ?? "unknown"}</p>`;
      body = s.kind === "register"
        ? html`<div class="stack-sm">
            <div class="sugg-top"><span class="strong">Register with Rhea Lend first</span></div>
            <p class="small muted">${rate}One time, before the first move. Then ${shown} ${f.symbol} can go to work.</p>
            <div class="actions"><button type="button" class="btn btn-primary btn-sm" data-action="yield-open" data-panel="register">Propose ${SIG}</button></div></div>`
        : html`<div class="stack-sm">
            <div class="sugg-top"><span class="strong">Put ${shown} ${f.symbol} on Rhea Lend</span></div>
            <p class="small muted">${rate}${s.all === undefined ? `${shown} ${f.symbol} is idle${keep}.` : `${readAmount(s.all, f.decimals)} ${f.symbol} is idle${keep}.`}</p>
            ${after === null ? "" : html`<p class="small">${after}</p>`}${best}
            <div class="actions"><button type="button" class="btn btn-primary btn-sm" data-action="yield-open" data-panel="supply" data-amount="${amount}">Propose ${SIG}</button></div></div>`;
    }
  }
  return html`<section class="card" aria-labelledby="y-suggest">
    <div class="b-head"><div><h2 id="y-suggest" class="b-h">Suggestion</h2><p class="small muted">Read at block ${r.chain.block_height.toLocaleString("en-US")} · ${formatUtc(r.chain.block_timestamp)}</p></div></div>
    <div class="pad stack-sm">${body}${prompt}</div>
    <p class="small muted pad-row">An optional AI ranking with reasons is in Telegram (<span class="mono">/yield ${r.dao}</span>) and in the MCP tool <span class="mono">yield_suggestions</span>.</p>
  </section>`;
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

/** The full rates table and filtered-out rows. Only used inside Technical details, so it has no nested <details>. */
function ratesTable(r: KdYieldReport): Html {
  const rejected = r.rejected.map(
    (x) => html`<li class="rej"><span class="strong mono wrap">${x.token_id}</span><span class="muted">${x.network} · ${x.reasons.map((why) => YIELD_REASON_TEXT[why].en).join(" ")}</span></li>`,
  );
  return html`<h3 class="drawer-h3">Rates</h3>
    ${r.opportunities.length === 0
      ? html`<p class="small muted">No row passed the filter.</p>`
      : html`<div class="table-scroll"><table class="key-table rates">
          <thead><tr><th>Token</th><th>Network</th><th class="num">Supply APR</th><th class="num">Total supplied</th><th class="num">Withdrawable</th><th>Sources</th><th>Use</th></tr></thead>
          <tbody>${r.opportunities.map(rateRow)}</tbody></table></div>`}
    ${rejected.length === 0 ? "" : html`<h3 class="drawer-h3">Filtered out (${String(rejected.length)})</h3><ul class="plain-list small">${rejected}</ul>`}`;
}

function ratesNow(r: KdYieldReport): Html {
  const rows = r.opportunities.slice(0, 4).map(
    (o) => html`<div class="rule-row"><dt>${o.symbol}</dt><dd>${aprText(o.apr)} a year${o.test_data ? html` <span class="tag tag-warn">Test data</span>` : ""}</dd></div>`,
  );
  return html`<section class="card" aria-labelledby="y-rates">
    <div class="b-head"><h2 id="y-rates" class="b-h">Rates now</h2></div>
    ${rows.length === 0 ? html`<p class="pad muted">No rate to show.</p>` : html`<dl class="rule-list">${rows}</dl>`}
    <p class="small muted pad-row">Rhea Lend supply rates. Data for the council, not financial advice.</p>
  </section>`;
}

const STATUS_PILL: Record<string, Html> = {
  Approved: html`<span class="pill pill-ok">${icon.check()}Approved</span>`,
  Rejected: html`<span class="pill pill-note">Rejected</span>`,
  Removed: html`<span class="pill pill-note">Removed</span>`,
  Expired: html`<span class="pill pill-note">Expired</span>`,
  Failed: html`<span class="pill pill-cleanup">Failed</span>`,
};

function historyRow(p: YieldProposal, network: Network, needed: number | null, canVote: boolean): Html {
  const move = describeYieldKind(network, p.kind);
  const text = move === null ? "A different kind of vote" : moveText(move, network);
  const open = p.status === "InProgress";
  const pill = open ? html`<span class="pill pill-info">${icon.clock()}${fmtVotes(p.approvals, needed)}</span>` : (STATUS_PILL[p.status] ?? html`<span class="pill pill-note">${p.status}</span>`);
  const warn = allowedYieldKind(network, p.kind) ? "" : html`<span class="small activity-why">${icon.alertSmall()} Not a move this page builds (${callText(p.kind)}). Check it with the council before you vote.</span>`;
  const votes = open && canVote && move !== null
    ? html`<span class="activity-time actions">
        <button type="button" class="btn btn-danger btn-sm" data-action="yield-vote" data-id="${String(p.id)}" data-vote="VoteReject">Reject</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="yield-vote" data-id="${String(p.id)}" data-vote="VoteApprove">Approve <span class="sig">1 signature</span></button></span>`
    : "";
  return html`<li class="activity-row">
    <span class="activity-status">${pill}</span>
    <span class="activity-text wrap">#${String(p.id)} ${text}<span class="small muted activity-why">Asked by <span class="mono">${p.proposer}</span></span>${warn}</span>
    ${votes}
  </li>`;
}

/** What the vote really calls, from its kind (never its description). */
function callText(kind: Record<string, unknown>): string {
  const fc = kind.FunctionCall as { receiver_id?: unknown; actions?: Array<{ method_name?: unknown }> } | undefined;
  if (fc === undefined || typeof fc !== "object" || fc === null) return Object.keys(kind)[0] ?? "unknown kind";
  const methods = Array.isArray(fc.actions) ? fc.actions.map((a) => String(a?.method_name)).join(", ") : "?";
  return `${String(fc.receiver_id)}: ${methods}`;
}

function historyCard(proposals: YieldProposal[] | null, shown: YieldProposal[], network: Network, needed: number | null, canVote: boolean): Html {
  const body =
    proposals === null
      ? html`<p class="pad muted">The treasury's votes could not be read right now.</p>`
      : shown.length === 0
        ? html`<p class="pad muted">No moves yet.</p>`
        : html`<ul class="plain-list">${shown.map((p) => historyRow(p, network, needed, canVote))}</ul>`;
  return html`<section class="card" aria-labelledby="y-props">
    <div class="b-head"><div><h2 id="y-props" class="b-h">History</h2><p class="small muted">Moves the council was asked for, newest first.</p></div></div>
    ${body}
  </section>`;
}

const row = (dt: Html | string, dd: Html | string) => html`<div class="rule-row"><dt>${dt}</dt><dd>${dd}</dd></div>`;

function limitsCard(settings: YieldSettings | null, f: Focus | null): Html {
  const d = f?.decimals ?? 6;
  const sym = f?.symbol ?? "";
  return html`<section class="card" aria-labelledby="y-lim">
    <div class="b-head"><h2 id="y-lim" class="b-h">Limits</h2>
      ${f === null ? "" : html`<button type="button" class="btn btn-ghost" data-action="yield-limits-open">${settings === null ? "Set limits" : "Edit"}</button>`}</div>
    ${settings === null
      ? html`<p class="pad muted">No limits set. Suggestions use everything idle.</p>`
      : html`<dl class="rule-list">
          ${row("Most it may put to work", `${tokenAmount(settings.maxPut, d)} ${sym}`)}
          ${row("Always keep ready", `${tokenAmount(settings.keepReady, d)} ${sym}`)}
          ${row("Only act above", `${pctText(settings.minApr)}% a year`)}
          ${row("Checks rates", `every ${CHECK_EVERY_TEXT[settings.checkEvery]}`)}
          ${row("How it acts", "Suggests, you approve each move")}
        </dl>`}
  </section>`;
}

function takeBackCard(f: Focus | null, canWithdraw: boolean): Html {
  return html`<section class="card" aria-labelledby="y-back">
    <div class="b-head"><h2 id="y-back" class="b-h">Take money back</h2></div>
    <div class="pad stack-sm">
      <p class="small muted">${f === null || f.supplied === null || BigInt(f.supplied) === 0n ? "Nothing is working on Rhea Lend right now." : `Brings part or all of the ${tokenAmount(f.supplied, f.decimals)} ${f.symbol} back, interest included. The council votes first.`}</p>
      <button type="button" class="btn btn-secondary" data-action="yield-open" data-panel="withdraw"${canWithdraw ? "" : " disabled"}>Take it back ${SIG}</button>
    </div>
  </section>`;
}

function technical(live: YieldLive, list: YieldAllowlist | null, f: Focus | null): Html {
  const r = live.report;
  const extra = [...r.errors, ...r.limitations];
  const registered = live.registered === null ? "unknown" : live.registered ? "Yes" : "Not yet";
  return html`<details class="card tech"><summary>Technical details${icon.chevronRight()}</summary>
    <dl class="tech-list">
      <div class="tech-row"><dt>Rhea Lend contract</dt><dd class="mono">${list?.lend ?? "not open on this network"}</dd></div>
      <div class="tech-row"><dt>Registered with Rhea Lend</dt><dd>${registered}</dd></div>
      <div class="tech-row"><dt>Treasury balance</dt><dd>${f?.holding?.balance == null ? "unknown" : `${tokenAmount(f.holding.balance, f.decimals)} ${f.symbol}`}</dd></div>
      <div class="tech-row"><dt>Yield ruleset</dt><dd class="mono">${r.yield_ruleset_version}</dd></div>
      <div class="tech-row"><dt>Block</dt><dd class="mono">${String(r.chain.block_height)}</dd></div>
      <div class="tech-row"><dt>Network</dt><dd>${r.chain.network}</dd></div>
    </dl>
    ${ratesTable(r)}
    ${r.notes.length === 0 ? "" : html`<ul class="list small">${r.notes.map((n) => html`<li>${n.en}</li>`)}</ul>`}
    ${extra.length === 0 ? "" : html`<ul class="list small pad-row">${extra.map((e) => html`<li>${e}</li>`)}</ul>`}
    <div class="stack-xs"><p class="small muted">Telegram pushes: <span class="mono">/yield_watch</span> turns them on for a chat, <span class="mono">/yield_unwatch</span> turns them off.</p>${copyRow(`/yield_watch ${r.dao}`)}</div>
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

function statePill(settings: YieldSettings | null): Html {
  if (settings === null) return html`<span class="pill pill-note">No limits set</span>`;
  return settings.paused ? html`<span class="pill pill-note">Paused</span>` : html`<span class="pill pill-ok">${icon.check()}Watching</span>`;
}

/** The live page for one treasury (K8). Settings are this browser's limits; null runs the page without them. */
export function renderYield(live: YieldLive, network: Network, settings: YieldSettings | null = null): Html {
  const r = live.report;
  const list = YIELD_ALLOWLIST[network];
  const f = focus(live, list);
  const can = yieldActions(live, network);
  const needed = votesNeeded(live.policy);
  const proposals = live.proposals ?? [];
  const featured = list === null ? null : (proposals.find((p) => p.status === "InProgress" && describeYieldKind(network, p.kind) !== null) ?? null);
  const shown = proposals.filter((p) => p !== featured);
  const summary = f === null ? LEAD : summarySentence(settings, f.decimals, f.symbol);
  const closed = list === null ? html`<p class="banner banner-cleanup">${icon.alertSmall()}<span>${YIELD_TESTNET_ONLY}. Rates show for reference.</span></p>` : "";
  return html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${pageHref("my-agents")}" data-nav>Your agents</a><span aria-hidden="true">/</span><span>Yield agent</span></nav>
    ${head(summary)}
    <section class="budget-top" aria-label="Yield agent">
      <div class="budget-name"><span class="strong mono wrap">${r.dao}</span>${list === null ? "" : statePill(settings)}<span class="tag">${network}</span></div>
      <div class="actions">
        ${list !== null && settings !== null ? html`<button type="button" class="btn btn-secondary" data-action="yield-pause">${settings.paused ? "Resume" : "Pause"}</button>` : ""}
        ${list !== null ? html`<button type="button" class="btn btn-secondary" data-action="yield-limits-open">${settings === null ? "Set limits" : "Edit limits"}</button>` : ""}
        <button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Rescan</button>
      </div>
    </section>
    ${closed}
    ${f === null ? "" : tiles(f, settings)}
    <p id="yield-status" class="small" role="status"></p>
    <div class="budget-cols">
      <div class="budget-main">
        ${f === null ? "" : suggestionCard(live, network, f, settings, featured, can.open)}
        ${historyCard(live.proposals, shown, network, needed, can.open)}
      </div>
      <aside class="budget-side" aria-label="Rates and limits">
        ${ratesNow(r)}
        ${list === null ? "" : limitsCard(settings, f)}
        ${list === null ? "" : takeBackCard(f, can.withdraw)}
        ${technical(live, list, f)}
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
/** The bond is the DAO's proposal bond: the wallet that asks pays it, and the DAO pays it back once the vote ends. */
const next = (bond: string) => html`<div class="stack-xs"><h3 class="drawer-h3">What happens next</h3><ol class="list small">
  <li>Your wallet signs one transaction that asks the council for this move. It moves no funds. The treasury holds ${bond} from your wallet as its proposal bond and returns it when the vote passes or is rejected.</li>
  <li>The council votes. Funds move only when the vote passes.</li></ol></div>
  <p class="small muted">Receiver, method and token come from code, never from the AI step.</p>`;

/**
 * The live line under the amount: the rate and yearly earnings after the move, or "" when the amount is not one
 * the drawer would accept. In the Take back drawer an empty amount means all of it.
 */
export function yieldPreview(panel: YieldPanel, live: YieldLive, network: Network, amountText: string): string {
  const f = focus(live, YIELD_ALLOWLIST[network]);
  if (f === null || f.supplied === null || panel === "register") return "";
  const supplied = BigInt(f.supplied);
  const typed = amountText.trim();
  const raw = panel === "withdraw" && typed === "" ? f.supplied : tokenRaw(typed, f.decimals);
  if (raw === null || BigInt(raw) === 0n) return "";
  if (panel === "withdraw") return BigInt(raw) > supplied ? "" : (projection(f, -BigInt(raw)) ?? "");
  return projection(f, BigInt(raw)) ?? "";
}

/** The drawer for one council action. Null when the network has no allowlist (the page shows no button then). */
export function renderYieldPanel(panel: YieldPanel, live: YieldLive, network: Network, error: string | null = null, amount = "", cap: string | null = null): Html | null {
  const list = YIELD_ALLOWLIST[network];
  const f = focus(live, list);
  if (list === null || f === null) return null;
  const bond = live.policy === null ? "the bond" : `${yoctoToNear(live.policy.proposal_bond)} NEAR`;
  const bondRow = sumRow("Proposal bond (returned)", live.policy === null ? "unknown" : bond);
  const err = error ? html`<p id="yp-error" class="field-error" role="alert">${error}</p>` : "";
  const preview = html`<p id="yp-preview" class="small" aria-live="polite">${yieldPreview(panel, live, network, amount)}</p>`;
  const input = html`<div class="input-unit"><input id="yp-amount" name="amount" type="text" class="input mono" inputmode="decimal" value="${amount}" autocomplete="off" spellcheck="false"${error ? html` aria-invalid="true" aria-describedby="yp-error"` : ""}><span class="muted">${f.symbol}</span></div>`;
  if (panel === "register") {
    return html`${drawerHead("Register this treasury with Rhea Lend", "One time, before the first move")}
      <div class="drawer-body">
        <div class="sum-box">${sumRow("The treasury pays", `${yoctoToNear(RHEA_STORAGE_YOCTO)} NEAR storage deposit`)}${sumRow("Call", html`<span class="mono">storage_deposit on ${list.lend}</span>`)}${bondRow}</div>
        ${next(bond)}${err}
      </div>
      <div class="drawer-foot">${CANCEL}<button type="button" class="btn btn-primary" data-action="yield-sign" data-panel="register">Ask the council <span class="sig">1 signature</span></button></div>`;
  }
  const submit = html`<button type="submit" class="btn btn-primary">Ask the council <span class="sig">1 signature</span></button>`;
  if (panel === "withdraw") {
    const all = f.supplied === null ? "" : tokenAmount(f.supplied, f.decimals);
    return html`<form id="yield-panel-form" class="drawer-form" data-panel="withdraw" novalidate>${drawerHead("Take money back", "From Rhea Lend back to the treasury")}
      <div class="drawer-body">
        <div class="stack-xs">
          <label class="label" for="yp-amount">Amount to take back</label>
          ${input}
          <div class="presets"><button type="button" class="filter-chip" data-action="yield-max" data-amount="${all}"${all === "" ? " disabled" : ""}>All ${all}</button></div>
          <p class="small muted">Leave it empty to take everything back, interest included. ${all === "" ? "" : `${all} ${f.symbol} is on Rhea Lend now.`}</p>
          ${preview}
        </div>
        <div class="sum-box">
          ${sumRow("To", html`<span class="mono">${live.report.dao}</span>`)}
          ${sumRow("Call", html`<span class="mono">execute (Withdraw) on ${list.lend}</span>`)}
          ${bondRow}
        </div>
        <p class="small muted">Take money back first when a payout needs it: the vote takes time.</p>
        ${next(bond)}${err}
      </div>
      <div class="drawer-foot">${CANCEL}${submit}</div></form>`;
  }
  const available = f.holding?.available ?? null;
  const max = cap ?? (available === null ? "" : tokenAmount(available, f.decimals));
  const maxRaw = max === "" ? null : tokenRaw(max, f.decimals);
  const best = f.pool === null || f.supplied === null || maxRaw === null ? null : bestSupply(f.pool, BigInt(f.supplied), BigInt(maxRaw), f.decimals);
  const bestChip = best === null || best === 0n || maxRaw === null || best >= BigInt(maxRaw)
    ? ""
    : html`<button type="button" class="filter-chip" data-action="yield-max" data-amount="${tokenAmount(best.toString(), f.decimals)}">Best ${tokenAmount(best.toString(), f.decimals)}</button>`;
  const bestNote = best === 0n
    ? " Putting more in would lower what the treasury earns: each deposit lowers the rate for the whole pool."
    : bestChip === "" ? "" : " Best earns the treasury the most a year if borrowing stays as it is.";
  return html`<form id="yield-panel-form" class="drawer-form" data-panel="supply" novalidate>${drawerHead("Put money to work", `${f.symbol} on Rhea Lend${f.opportunity === null ? "" : ` · ${aprText(f.opportunity.apr)} a year${f.opportunity.test_data ? " (test data)" : ""}`}`)}
    <div class="drawer-body">
      <div class="stack-xs">
        <label class="label" for="yp-amount">Amount to put in</label>
        ${input}
        <div class="presets">${bestChip}<button type="button" class="filter-chip" data-action="yield-max" data-amount="${max}"${max === "" ? " disabled" : ""}>Max ${max}</button></div>
        <p class="small muted">${cap === null ? "Available is the treasury's balance minus what open transfers promise." : "Max follows your limits. The code still checks the amount against what the treasury really has available."}${bestNote}</p>
        ${preview}
      </div>
      <div class="sum-box">
        ${sumRow("To", html`<span class="mono">${list.lend}</span>`)}
        ${sumRow("Call", html`<span class="mono">ft_transfer_call on ${f.token_id}</span>`)}
        ${bondRow}
      </div>
      ${next(bond)}${err}
    </div>
    <div class="drawer-foot">${CANCEL}${submit}</div></form>`;
}

export interface LimitErrors extends Partial<Record<LimitField, string>> {}

/** The three limit inputs, shared by the New yield agent wizard (K7) and the Edit limits drawer (K8). */
export function limitFields(v: LimitInput, errors: LimitErrors, symbol: string, idleText: string | null, p: string): Html {
  const field = (name: LimitField, label: string, hint: string, unit: string) => html`<div class="stack-xs">
      <label class="label" for="${p}-${name}">${label}</label>
      <div class="input-unit"><input id="${p}-${name}" name="${name}" type="text" class="input mono" inputmode="decimal" value="${v[name]}" autocomplete="off" spellcheck="false"
        aria-describedby="${p}-${name}-hint${errors[name] ? ` ${p}-${name}-error` : ""}"${errors[name] ? html` aria-invalid="true"` : ""}><span class="muted">${unit}</span></div>
      <p id="${p}-${name}-hint" class="small muted">${hint}</p>
      ${errors[name] ? html`<p id="${p}-${name}-error" class="field-error" role="alert">${errors[name] as string}</p>` : ""}
    </div>`;
  return html`${field("maxPut", "Most it may put to work", idleText === null ? "The most it will ever suggest putting on Rhea Lend." : `The most it will ever suggest putting on Rhea Lend. At most ${idleText} ${symbol}.`, symbol)}
    ${field("keepReady", "Always keep ready", "Left untouched in the treasury so payouts are never short. 0 keeps nothing back.", symbol)}
    ${field("minApr", "Only act above", "It stays quiet while the rate is at or below this.", "% a year")}`;
}

/** The Edit limits drawer (K8): the same fields and checks as K7, saved to this browser. */
export function renderYieldLimits(live: YieldLive, network: Network, settings: YieldSettings | null, values: LimitInput | null = null, errors: LimitErrors = {}): Html | null {
  const list = YIELD_ALLOWLIST[network];
  const f = focus(live, list);
  if (list === null || f === null) return null;
  const idle = f.holding?.available == null ? null : BigInt(f.holding.available) + (f.supplied === null ? 0n : BigInt(f.supplied));
  const ceilingText = idle === null || idle === 0n ? null : tokenAmount(idle.toString(), f.decimals);
  const v = values ?? {
    maxPut: settings === null ? (ceilingText ?? "") : tokenAmount(settings.maxPut, f.decimals),
    keepReady: settings === null ? "0" : tokenAmount(settings.keepReady, f.decimals),
    minApr: settings === null ? "0" : pctText(settings.minApr),
  };
  return html`<form id="yield-limits-form" class="drawer-form" novalidate>${drawerHead("Limits", "Saved in this browser. They shape what is suggested, not what the council can approve.")}
    <div class="drawer-body">
      ${limitFields(v, errors, f.symbol, null, "yl")}
      ${ceilingText === null ? "" : html`<p class="small muted">The treasury has ${ceilingText} ${f.symbol} to work with today. A higher limit is fine: suggestions never go above what is idle.</p>`}
    </div>
    <div class="drawer-foot">${CANCEL}<button type="submit" class="btn btn-primary">Save limits</button></div></form>`;
}
