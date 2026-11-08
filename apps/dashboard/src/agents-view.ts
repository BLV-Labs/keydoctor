// My Agents, pure: every agent of every DAO where the connected wallet sits on the council (agents-read.ts).
import type { Network } from "key-doctor";
import type { AgentRow, AgentStatus, MyAgents } from "./agents-read.ts";
import { yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { budgetHref, pageHref, yieldHref } from "./route.ts";
import { avatar } from "./ui.ts";
import { YIELD_ALLOWLIST, tokenAmount } from "./yield-proposals.ts";

export type AgentFilter = "all" | "needs" | "payment" | "yield" | "off";

const LEAD =
  "Every agent working for a DAO you sit on. Payment agents spend within your Budget rules. Yield agents suggest where idle stablecoins could earn, and the council votes on every move.";

/** `data-agents-for` names the accounts this view was read for, so a wallet change re-reads it. */
function head(accounts: readonly string[]): Html {
  return html`<section class="stack-xs" data-agents-for="${accounts.join(",")}"><h1 class="h1">My Agents</h1><p class="muted budget-lead">${LEAD}</p></section>`;
}

const NEW_AGENT = html`<details class="menu">
  <summary class="btn btn-primary">${icon.plus()}New agent</summary>
  <div class="pop card">
    <a class="pop-item" href="${pageHref("budget")}" data-nav><span class="strong">Payment agent</span><span class="small muted">Spends from an Agent Budget within your rules. Needs 2 signatures.</span></a>
    <a class="pop-item" href="${pageHref("yield")}" data-nav><span class="strong">Yield agent</span><span class="small muted">Watches Rhea Lend for a DAO's idle stablecoins. Suggests only, the council votes.</span></a>
  </div>
</details>`;

export function renderMyAgentsSignedOut(): Html {
  return html`${head([])}
    <section class="card pad stack-xs budget-narrow">
      <p class="strong">Wallet not connected</p>
      <p class="small muted">Connect the wallet you use on your DAO council to see its agents. Key Doctor only reads; your wallet signs.</p>
      <button type="button" class="btn btn-primary btn-start" data-action="open-wallet">Connect wallet</button>
      <p class="small"><a href="${pageHref("budget")}" data-nav>Or open one DAO by name</a></p>
    </section>`;
}

export function renderMyAgentsLoading(accounts: readonly string[]): Html {
  return html`${head(accounts)}
    <section class="card pad stack-sm" aria-busy="true" aria-label="Loading agents"><p class="meta" role="status">Finding the DAOs where <span class="mono">${accounts.join(", ")}</span> sits on the council…</p></section>`;
}

export function renderMyAgentsError(message: string, accounts: readonly string[]): Html {
  return html`${head(accounts)}
    <section class="card pad stack-xs budget-narrow">
      <p class="check-line small">${icon.alertSmall()}<span>${message}</span></p>
      <button type="button" class="btn btn-secondary btn-start" data-action="rescan">Try again</button>
    </section>`;
}

/** Needs-you rows first, then the read order (DAO by DAO). */
const RANK: Record<AgentStatus, number> = { waiting: 0, unknown: 1, on: 2, farming: 2, idle: 3, off: 4 };

export function agentMatches(row: AgentRow, filter: AgentFilter): boolean {
  if (filter === "all") return true;
  if (filter === "needs") return row.status === "waiting";
  if (filter === "off") return row.status === "off";
  return row.kind === filter;
}

function statusPill(row: AgentRow): Html {
  switch (row.status) {
    case "waiting":
      return html`<span class="pill pill-cleanup">${icon.clock()}${String(row.pending)} ${row.pending === 1 ? "waits" : "wait"} for you</span>`;
    case "on":
      return html`<span class="pill pill-ok">${icon.check()}On</span>`;
    case "farming":
      return html`<span class="pill pill-ok">${icon.check()}Farming</span>`;
    case "idle":
      return html`<span class="pill pill-note">Idle</span>`;
    case "off":
      return html`<span class="pill pill-note">Off</span>`;
    default:
      return html`<span class="pill pill-cleanup">Unknown</span>`;
  }
}

function daoCell(dao: string): Html {
  const dot = dao.indexOf(".");
  const [name, rest] = dot < 0 ? [dao, ""] : [dao.slice(0, dot), dao.slice(dot + 1)];
  return html`<td class="small" title="${dao}"><span class="mono strong">${name}</span><span class="mono muted block">${rest}</span></td>`;
}

function agentRow(row: AgentRow, network: Network): Html {
  const token = YIELD_ALLOWLIST[network]?.tokens[0] ?? null;
  const who =
    row.kind === "yield"
      ? html`<div class="who">${avatar(`yield:${row.dao}`)}<span class="who-text"><span class="strong">Yield agent</span><span class="small muted">${
          row.supplied === null || token === null ? "Rhea Lend" : `Rhea Lend · ${tokenAmount(row.supplied, token.decimals)} ${token.symbol} supplied`
        }</span></span></div>`
      : html`<div class="who">${avatar(row.account ?? row.label)}<span class="who-text"><span class="strong">${row.label || row.account}</span><span class="small muted mono wrap">${row.account}</span></span></div>`;
  const open =
    row.kind === "yield"
      ? html`<a class="btn btn-secondary btn-sm" href="${yieldHref(row.dao)}" data-nav>Open</a>`
      : row.status === "waiting"
        ? html`<a class="btn btn-primary btn-sm" href="${budgetHref(row.dao)}" data-nav>Review</a>`
        : html`<a class="btn btn-secondary btn-sm" href="${budgetHref(row.dao)}" data-nav>Open</a>`;
  const spent = row.kind === "yield" ? "—" : row.spent_24h === null ? "unknown" : `${yoctoToNear(row.spent_24h)} NEAR`;
  return html`<tr data-agent-kind="${row.kind}" data-agent-status="${row.status}"${row.status === "waiting" ? html` class="row-new" data-tone="cleanup"` : ""}>
    <td>${who}</td>
    <td>${row.kind === "yield" ? html`<span class="tag tag-yield">Yield</span>` : html`<span class="tag">Payment</span>`}</td>
    ${daoCell(row.dao)}
    <td>${statusPill(row)}</td>
    <td class="num">${spent}</td>
    <td>${open}</td>
  </tr>`;
}

const tile = (label: string, value: Html | string, note: string) =>
  html`<div class="card tile"><span class="tile-label">${label}</span><span class="tile-value">${value}</span><span class="tile-note">${note}</span></div>`;

function tiles(data: MyAgents): Html {
  const payment = data.rows.filter((r) => r.kind === "payment");
  const yields = data.rows.filter((r) => r.kind === "yield");
  const waiting = payment.reduce((n, r) => n + (r.status === "waiting" ? r.pending : 0), 0);
  const waitingDaos = new Set(payment.filter((r) => r.status === "waiting").map((r) => r.dao));
  const spentKnown = payment.filter((r) => r.spent_24h !== null);
  const spent = spentKnown.reduce((s, r) => s + BigInt(r.spent_24h ?? "0"), 0n);
  const token = YIELD_ALLOWLIST[data.network]?.tokens[0] ?? null;
  const farming = yields.filter((r) => r.supplied !== null && r.supplied !== "0");
  const supplied = yields.reduce((s, r) => s + BigInt(r.supplied ?? "0"), 0n);
  return html`<section class="tiles" aria-label="Summary">
    ${tile("Agents", String(data.rows.length), `${String(payment.length)} payment · ${String(yields.length)} yield`)}
    ${tile("Waiting for your approval", String(waiting), waiting === 0 ? "Nothing waits for you" : `On ${[...waitingDaos].join(", ")}`)}
    ${tile("Spent by agents in last 24h", `${yoctoToNear(spent.toString())} NEAR`, spentKnown.length === payment.length ? `Across ${String(new Set(payment.map((r) => r.dao)).size)} Budgets` : "Some Guards do not report it")}
    ${tile(
      "Supplied on Rhea Lend",
      token === null ? "—" : html`${tokenAmount(supplied.toString(), token.decimals)} <span class="tile-unit">${token.symbol}</span>`,
      `From ${String(farming.length)} DAO${farming.length === 1 ? "" : "s"}${data.network === "testnet" ? " · test data, not real yield" : ""}`,
    )}
  </section>`;
}

function chips(rows: AgentRow[]): Html {
  const filters: [AgentFilter, string][] = [["all", "All"], ["needs", "Needs you"], ["payment", "Payment"], ["yield", "Yield"], ["off", "Off"]];
  return html`<div class="filter-chips" role="group" aria-label="Filter agents">${filters.map(
    ([f, label]) =>
      html`<button type="button" class="filter-chip" data-action="agents-filter" data-filter="${f}" aria-pressed="${f === "all" ? "true" : "false"}">${label} ${String(rows.filter((r) => agentMatches(r, f)).length)}</button>`,
  )}</div>`;
}

function daoList(data: MyAgents): Html {
  const items = data.daos.map((d) => {
    const pay = data.rows.filter((r) => r.dao === d.dao && r.kind === "payment").length;
    const hasYield = data.rows.some((r) => r.dao === d.dao && r.kind === "yield");
    const what = d.error ?? `${pay === 0 ? "No payment agent" : `${String(pay)} payment agent${pay === 1 ? "" : "s"}`}${hasYield ? " · Yield on" : ""}`;
    return html`<li class="dao-row"><span class="mono wrap">${d.dao}</span><span class="small${d.error === null ? " muted" : ""}">${what}</span><span class="dao-actions">
      <a href="${budgetHref(d.dao)}" data-nav class="btn btn-ghost btn-sm">Budget</a>
      <a href="${yieldHref(d.dao)}" data-nav class="btn btn-ghost btn-sm">${hasYield ? "Yield" : "Add yield agent"}</a></span></li>`;
  });
  return html`<section class="card" aria-labelledby="ma-daos">
    <div class="b-head"><div><h2 id="ma-daos" class="b-h">Your DAOs</h2><p class="small muted">Where your wallet is a council member.</p></div></div>
    <ul class="plain-list">${items}</ul>
  </section>`;
}

export function renderMyAgents(data: MyAgents, accounts: readonly string[]): Html {
  const top = html`<section class="budget-top" aria-label="Scope">
    <div class="budget-name"><span class="small muted">Found from <span class="mono">${accounts.join(", ")}</span> in ${String(data.daos.length)} DAO${data.daos.length === 1 ? "" : "s"}</span><span class="tag">${data.network}</span></div>
    <div class="actions"><button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Rescan</button>${NEW_AGENT}</div>
  </section>`;
  const unread = data.unread === 0 ? "" : html`<p class="small muted">${String(data.unread)} DAO${data.unread === 1 ? "" : "s"} on the factory could not be read, so the page cannot tell if you sit on ${data.unread === 1 ? "it" : "them"}.</p>`;
  const errors = data.daos
    .filter((d) => d.error !== null)
    .map((d) => html`<p class="check-line small">${icon.alertSmall()}<span>${d.error} Its agents are unknown, not absent.</span></p>`);
  if (data.daos.length === 0) {
    return html`${head(accounts)}${top}${unread}
      <section class="card pad stack-xs budget-narrow">
        <p class="strong">No DAO found</p>
        <p class="small muted">None of your connected accounts sits on the council of a DAO with a Guard or a Yield page opened here. Start with a payment agent or a yield agent.</p>
        <div class="actions"><a class="btn btn-secondary" href="${pageHref("budget")}" data-nav>Payment agent</a><a class="btn btn-secondary" href="${pageHref("yield")}" data-nav>Yield agent</a></div>
      </section>`;
  }
  const rows = [...data.rows].sort((a, b) => RANK[a.status] - RANK[b.status]);
  const list =
    rows.length === 0
      ? html`<p class="pad muted">You sit on ${String(data.daos.length)} DAO${data.daos.length === 1 ? "" : "s"} and ${data.daos.length === 1 ? "it has" : "they have"} no agent yet. Use New agent to start one.</p>`
      : html`${chips(rows)}<div class="table-scroll"><table class="key-table agents">
          <thead><tr><th>Agent</th><th>Type</th><th>DAO</th><th>Status</th><th class="num">Last 24h</th><th><span class="sr-only">Open</span></th></tr></thead>
          <tbody>${rows.map((r) => agentRow(r, data.network))}</tbody></table></div>`;
  return html`${head(accounts)}${top}${tiles(data)}${errors}${unread}
    <section class="card" aria-labelledby="ma-list">
      <div class="b-head"><div><h2 id="ma-list" class="b-h">Agents</h2><p class="small muted">Sorted by what needs you first.</p></div></div>
      ${list}
      <p class="small muted pad footnote">A payment agent shows here when its Guard lists it. A yield agent shows here for a DAO you sit on once its Yield page was opened in this browser. Key Doctor never holds an agent's key.</p>
    </section>
    ${daoList(data)}`;
}
