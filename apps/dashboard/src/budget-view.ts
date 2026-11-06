// The Agent Budget page, pure. Everything shown is read from the chain (budget-read.ts); the owner's actions go
// through the owner's wallet, and each button says how many signatures it takes (docs/final-idea.md §11.10.5).
import type { Network } from "key-doctor";
import type { BudgetLive, BudgetProposal, BudgetRequest } from "./budget-read.ts";
import { formatUtc, yoctoToNear } from "./format.ts";
import { GUARD_FORM_TEXT, type GuardFormError } from "./guard-form.ts";
import type { GuardLive } from "./guard-read.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { routeHref } from "./route.ts";

/** Shown in the form's placeholder text only; creation needs this factory to be deployed and set at build time. */
export const BUDGET_FACTORY_NAME = "keydoctor-guards-v2.testnet";
const EXAMPLE_BUDGET_DAO = "kdoncall.sputnik-v2.testnet";

export type BudgetPanel = "topup" | "withdraw" | "rules" | "add-agent";

/** Wording of the signature count on a button or note. */
export const signatures = (n: 1 | 2): string => (n === 1 ? "1 signature" : "2 signatures");

const near = (yocto: string | null | undefined): string => (yocto === null || yocto === undefined ? "unknown" : `${yoctoToNear(yocto)} NEAR`);

function head(lead: string): Html {
  return html`<section class="page-head"><div class="stack-sm grow">
      <p class="eyebrow">Agent Budget</p>
      <h1 class="h1">A budget your AI agent can spend, within rules you set</h1>
      <p class="lead">${lead}</p>
    </div></section>`;
}

/** The DAO form. */
export function renderBudgetStart(dao: string, error: string | null, note: string): Html {
  return html`${head("Larger payments wait for your approval. Top up or withdraw anytime. Key Doctor signs nothing; your wallet signs.")}
    <form id="budget-dao-form" class="card pad stack-sm" novalidate>
      <label for="budget-dao" class="label">Sputnik DAO that holds the budget</label>
      <div class="input-row">
        <input id="budget-dao" name="dao" type="text" class="input mono" value="${dao}" placeholder="${EXAMPLE_BUDGET_DAO}"
          autocomplete="off" autocapitalize="none" spellcheck="false" required${error ? html` aria-invalid="true" aria-describedby="budget-dao-error"` : ""}>
        <button type="submit" class="btn btn-primary btn-lg">Open</button>
      </div>
      ${error ? html`<p id="budget-dao-error" class="field-error" role="alert">${error}</p>` : ""}
      <p class="small muted">${note}</p>
    </form>`;
}

export function renderBudgetLoading(dao: string): Html {
  return html`${head("Reading the DAO, its Guard and its requests from NEAR RPC…")}
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
  const call = kind.FunctionCall as { receiver_id?: unknown; actions?: { method_name?: unknown }[] } | undefined;
  if (call !== undefined) {
    const methods = (call.actions ?? []).map((a) => String(a.method_name)).join(", ");
    return `Call ${methods} on ${String(call.receiver_id)}`;
  }
  return Object.keys(kind)[0] ?? "Unknown proposal";
}

function percent(spent: string, limit: string): number {
  const max = BigInt(limit);
  return max === 0n ? 0 : Math.min(100, Number((BigInt(spent) * 100n) / max));
}

function tiles(b: BudgetLive): Html {
  const g = b.guard;
  const w = g?.window ?? null;
  const p = g?.policy ?? null;
  const pending = b.proposals === null ? "unknown" : String(b.proposals.length);
  const agents = g?.config ? String(g.config.agents) : "unknown";
  return html`<section class="tiles" aria-label="Budget summary">
    <div class="card tile"><span class="tile-label">Budget balance</span><span class="tile-value">${near(b.balance)}</span><span class="tile-note">Held by ${b.dao.dao}. USDC: not available yet.</span></div>
    <div class="card tile"><span class="tile-label">Spent in the last 24h</span>
      <span class="tile-value">${w === null ? "unknown" : near(w.spent_in_window)}</span>
      ${w !== null && p !== null
        ? html`<progress class="progress" max="100" value="${percent(w.spent_in_window, p.max_per_day)}" aria-label="Share of the daily limit spent"></progress>
          <span class="tile-note">of ${near(p.max_per_day)} · resets ${formatUtc(w.resets_at)}</span>`
        : ""}</div>
    <div class="card tile"><span class="tile-label">Waiting for approval</span><span class="tile-value">${pending}</span><span class="tile-note">Open proposals in the DAO</span></div>
    <div class="card tile"><span class="tile-label">Agents</span><span class="tile-value">${agents}</span><span class="tile-note">${g === null ? "" : g.guard_id}</span></div>
  </section>`;
}

function pendingCard(proposals: BudgetProposal[] | null, guardId: string | null): Html {
  const body =
    proposals === null
      ? html`<p class="check-line">${icon.alert()}<span>Could not read the DAO's proposals right now. Pending items are unknown, not none.</span></p>`
      : proposals.length === 0
        ? html`<p class="muted">Nothing waits for you.</p>`
        : html`<ul class="stack-sm plain-list">${proposals.map((p) => html`<li class="budget-row">
            <div class="stack-xs grow">
              <p class="strong">#${p.id} · ${describeKind(p.kind)}</p>
              <p class="small muted wrap">${p.description}</p>
              <p class="small muted">Proposed by <span class="mono">${p.proposer}</span>${p.proposer === guardId ? " (the Guard, for an agent request)" : ""}</p>
            </div>
            <div class="actions">
              <button type="button" class="btn btn-primary" data-action="budget-act" data-id="${p.id}" data-vote="VoteApprove">Approve <span class="sig">${signatures(1)}</span></button>
              <button type="button" class="btn btn-secondary" data-action="budget-act" data-id="${p.id}" data-vote="VoteReject">Reject <span class="sig">${signatures(1)}</span></button>
            </div></li>`)}</ul>`;
  return html`<section class="card" aria-labelledby="b-pending"><div class="card-head"><h2 id="b-pending" class="h2">Needs you</h2></div><div class="pad stack">${body}</div></section>`;
}

function agentsCard(g: GuardLive): Html {
  const agents = g.agents;
  const body =
    agents === null
      ? html`<p class="check-line">${icon.alert()}<span>Could not read the agent list right now.</span></p>`
      : agents.length === 0
        ? html`<p class="muted">No agent yet.</p>`
        : html`<ul class="stack-sm plain-list">${agents.map((a) => html`<li class="budget-row">
            <div class="stack-xs grow"><p class="strong mono wrap">${a.account_id}</p><p class="small muted">${a.label} · ${a.pending} waiting</p></div>
            <span class="pill ${a.enabled ? "pill-ok" : "pill-note"}">${a.enabled ? "Active" : "Disabled"}</span>
            <div class="actions">
              <button type="button" class="btn btn-secondary" data-action="budget-agent" data-op="${a.enabled ? "disable" : "enable"}" data-agent="${a.account_id}">${a.enabled ? "Disable" : "Enable"} <span class="sig">${signatures(2)}</span></button>
              <button type="button" class="btn btn-danger" data-action="budget-agent" data-op="remove" data-agent="${a.account_id}">Remove <span class="sig">${signatures(2)}</span></button>
            </div></li>`)}</ul>`;
  return html`<section class="card" aria-labelledby="b-agents"><div class="card-head"><h2 id="b-agents" class="h2">Agents</h2>
      <button type="button" class="btn btn-secondary" data-action="budget-open" data-panel="add-agent">Add an agent <span class="sig">${signatures(2)}</span></button></div>
    <div class="pad stack">${body}</div></section>`;
}

function rulesCard(g: GuardLive): Html {
  const p = g.policy;
  return html`<section class="card" aria-labelledby="b-rules"><div class="card-head"><h2 id="b-rules" class="h2">Rules</h2>
      ${p === null ? "" : html`<button type="button" class="btn btn-secondary" data-action="budget-open" data-panel="rules">Edit rules <span class="sig">${signatures(2)}</span></button>`}</div>
    <div class="pad">${p === null
      ? html`<p class="check-line">${icon.alert()}<span>Could not read the rules. They are unknown, not absent.</span></p>`
      : html`<div class="table-scroll"><table class="info-table"><tbody>
          <tr><th scope="row">Per payment</th><td>${near(p.max_per_tx)}</td></tr>
          <tr><th scope="row">Per 24 hours</th><td>${near(p.max_per_day)}</td></tr>
          <tr><th scope="row">Waiting requests per agent</th><td>${p.max_pending_per_agent}</td></tr>
          <tr><th scope="row">Reserve kept</th><td>${near(p.min_reserve)}</td></tr>
          <tr><th scope="row">Allowed receivers</th><td>${g.config === null ? "unknown" : g.config.whitelist}</td></tr>
        </tbody></table></div>`}</div></section>`;
}

const REQUEST_STATUS: Record<string, string> = {
  Submitted: "Sent to the DAO",
  AutoApproved: "Approved by the rules",
  Pending: "Waiting for approval",
  Executed: "Paid",
  Rejected: "Rejected",
  Expired: "Expired",
  Failed: "Failed",
};

function requestsCard(requests: BudgetRequest[] | null): Html {
  const body =
    requests === null
      ? html`<p class="check-line">${icon.alert()}<span>Could not read the Guard's requests right now.</span></p>`
      : requests.length === 0
        ? html`<p class="muted">No requests yet.</p>`
        : html`<div class="table-scroll"><table class="info-table"><thead><tr><th>Agent</th><th>To</th><th>Amount</th><th>Status</th></tr></thead><tbody>
            ${requests.map((r) => html`<tr><td class="mono wrap">${r.agent}</td><td class="mono wrap">${r.receiver_id}</td><td>${near(r.amount)}</td>
              <td>${REQUEST_STATUS[r.status] ?? r.status}${r.reasons.length > 0 ? html` <span class="small muted">(${r.reasons.join(", ")})</span>` : ""}</td></tr>`)}
          </tbody></table></div>`;
  return html`<section class="card" aria-labelledby="b-requests"><div class="card-head"><h2 id="b-requests" class="h2">Recent requests</h2></div><div class="pad">${body}</div></section>`;
}

const NOT_YET = html`<section class="card pad stack-sm" aria-labelledby="b-later">
    <h2 id="b-later" class="h2">Not available yet</h2>
    <p class="small muted">Strategies, scheduled plans, DCA and USDC balances are not built in this version.</p></section>`;

/** The live page for one DAO that has a Guard. */
export function renderBudget(b: BudgetLive, network: Network, setup: Html | "" = ""): Html {
  const g = b.guard;
  if (g === null) {
    return html`${head("This DAO has no Agent Budget yet.")}
      <section class="stack-sm"><p>DAO <a class="mono" href="${routeHref(b.dao.dao)}" data-nav>${b.dao.dao}</a> · ${network}</p></section>
      <section class="card pad"><p class="muted">No ready Guard from <span class="mono">${b.dao.factory}</span> serves this DAO.</p></section>
      ${setup}`;
  }
  const paused = g.config?.paused === true;
  const status = paused ? html`<span class="pill pill-high">Paused</span>` : g.in_role ? html`<span class="pill pill-ok">Active</span>` : html`<span class="pill pill-cleanup">Not in role agent-guard</span>`;
  return html`${head("Agents spend within the rules. Anything larger waits here for you.")}
    <section class="card pad budget-top" aria-label="Budget">
      <div class="stack-xs grow"><p class="strong mono wrap">${b.dao.dao}</p><p class="small muted">Guard <span class="mono">${g.guard_id}</span> · ${network}</p></div>
      ${status}
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="budget-open" data-panel="topup">Top up <span class="sig">${signatures(1)}</span></button>
        <button type="button" class="btn btn-secondary" data-action="budget-open" data-panel="withdraw">Withdraw <span class="sig">${signatures(2)}</span></button>
        <button type="button" class="btn btn-danger" data-action="budget-pause" data-guard="${g.guard_id}"${paused ? " disabled" : ""}>Pause agents <span class="sig">${signatures(1)}</span></button>
      </div>
      <div class="wallet-line">
        <span data-wallet-off class="small muted">No wallet connected.</span>
        <span data-wallet-on hidden class="small">Connected: <span data-wallet-name></span></span>
        <button type="button" class="btn btn-tint" data-action="open-wallet" data-wallet-off>Connect Wallet</button>
        <button type="button" class="btn btn-tint" data-action="disconnect-wallet" data-wallet-on hidden>Disconnect</button>
      </div>
      <p id="wallet-status" class="small" role="status"></p>
    </section>
    ${tiles(b)}
    <div id="budget-action"></div>
    <p id="budget-status" class="small" role="status"></p>
    <div id="budget-next"></div>
    ${pendingCard(b.proposals, g.guard_id)}
    ${agentsCard(g)}
    ${rulesCard(g)}
    ${requestsCard(b.requests)}
    ${NOT_YET}`;
}

const near2 = (yocto: string | undefined): string => (yocto === undefined ? "" : yoctoToNear(yocto));

/** The drawer-style form for one owner action, with its signature count in plain words. */
export function renderBudgetPanel(panel: BudgetPanel, b: BudgetLive, error: string | null = null, values: Record<string, string> = {}): Html {
  const v = (name: string, fallback = "") => values[name] ?? fallback;
  const p = b.guard?.policy ?? null;
  const field = (name: string, label: string, value: string, placeholder = "", mono = false) =>
    html`<div class="stack-xs"><label class="label" for="bp-${name}">${label}</label>
      <input id="bp-${name}" name="${name}" type="text" class="input${mono ? " mono" : ""}" value="${value}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"${error ? html` aria-describedby="bp-error"` : ""}></div>`;
  const err = error ? html`<p id="bp-error" class="field-error" role="alert">${error}</p>` : "";
  const close = html`<button type="button" class="btn btn-secondary" data-action="budget-close">Cancel</button>`;
  switch (panel) {
    case "topup":
      return html`<form id="budget-panel-form" class="card pad stack" data-panel="topup" novalidate aria-labelledby="bp-title">
        <h2 id="bp-title" class="h2">Top up</h2>
        <p class="small muted">${signatures(1)}: a NEAR transfer from your connected account to <span class="mono">${b.dao.dao}</span>. The page first checks the DAO's roles.</p>
        ${field("amount", "Amount (NEAR)", v("amount"), "5")}${err}
        <div class="actions"><button type="submit" class="btn btn-primary">Top up in wallet</button>${close}</div></form>`;
    case "withdraw":
      return html`<form id="budget-panel-form" class="card pad stack" data-panel="withdraw" novalidate aria-labelledby="bp-title">
        <h2 id="bp-title" class="h2">Withdraw</h2>
        <p class="small muted">${signatures(2)}. Signature 1 proposes a transfer from <span class="mono">${b.dao.dao}</span> to your connected account. The page then reads the proposal back from the chain and, only if it matches, asks for signature 2 to approve it.</p>
        ${field("amount", "Amount (NEAR)", v("amount"), "1")}${err}
        <div class="actions"><button type="submit" class="btn btn-primary">Propose withdrawal</button>${close}</div></form>`;
    case "rules":
      return html`<form id="budget-panel-form" class="card pad stack" data-panel="rules" novalidate aria-labelledby="bp-title">
        <h2 id="bp-title" class="h2">Edit rules</h2>
        <p class="small muted">${signatures(2)}: a proposal that changes the Guard's limits, then your approval once the page has checked it.</p>
        <div class="grid-2">
          ${field("maxPerTx", "Per payment (NEAR)", v("maxPerTx", near2(p?.max_per_tx)))}
          ${field("maxPerDay", "Per 24 hours (NEAR)", v("maxPerDay", near2(p?.max_per_day)))}
          ${field("maxPending", "Waiting requests per agent", v("maxPending", p === null ? "" : String(p.max_pending_per_agent)))}
          ${field("minReserve", "Reserve kept (NEAR)", v("minReserve", near2(p?.min_reserve)))}
        </div>${err}
        <div class="actions"><button type="submit" class="btn btn-primary">Propose new rules</button>${close}</div></form>`;
    case "add-agent":
      return html`<form id="budget-panel-form" class="card pad stack" data-panel="add-agent" novalidate aria-labelledby="bp-title">
        <h2 id="bp-title" class="h2">Add an agent</h2>
        <p class="small muted">${signatures(2)}: a proposal that adds the agent account to the Guard, then your approval once the page has checked it. Adding attaches 0.01 NEAR for storage.</p>
        ${field("agent", "Agent account", v("agent"), "bot.kdoncall.testnet", true)}
        ${field("label", "Label", v("label"), "payroll bot")}${err}
        <div class="actions"><button type="submit" class="btn btn-primary">Propose agent</button>${close}</div></form>`;
  }
}

/** What the owner sees between the two signatures: the id from the outcome, matched, ready for signature 2. */
export function renderBudgetNext(id: number, description: string): Html {
  return html`<section class="card pad stack-sm" aria-labelledby="bn-title">
    <h2 id="bn-title" class="h2">Signature 2 of 2</h2>
    <p class="small">Proposal #${id} on the chain matches what this page built: <span class="strong">${description}</span>.</p>
    <div class="actions"><button type="button" class="btn btn-primary" data-action="budget-sign2">Approve proposal #${id} in wallet</button></div></section>`;
}

const SETUP_FIELDS: ReadonlyArray<readonly [string, string, string]> = [
  ["name", "Budget name", "payroll"],
  ["maxPerTx", "Max per payment (NEAR)", "5"],
  ["maxPerDay", "Max per 24 hours (NEAR)", "10"],
  ["maxPendingPerAgent", "Waiting requests per agent", "3"],
  ["minReserve", "Reserve kept (NEAR)", "1"],
  ["funding", "Funding for the Guard (NEAR)", "5"],
];

const SETUP_LISTS: ReadonlyArray<readonly [string, string, string]> = [
  ["agents", "Agents: account, label (one per line)", "bot.kdoncall.testnet, payroll bot"],
  ["whitelist", "Allowed receivers, optional: account, label, cap in NEAR or empty (one per line)", "vendor.kdoncall.testnet, vendor, 2"],
];

/** The create form for a DAO with no Budget. `available` is false while the Agent Budget Guard factory is not deployed. */
export function renderBudgetSetup(available: boolean, values: Record<string, string> = {}, errors: GuardFormError[] = [], result: string | null = null): Html {
  const errorFor = (name: string) => errors.filter((e) => e.field === name || e.field.startsWith(`${name}.`));
  const message = (e: GuardFormError) => {
    const at = /\.(\d+)/.exec(e.field);
    return `${at ? `Line ${Number(at[1]) + 1}: ` : ""}${GUARD_FORM_TEXT[e.code].en}`;
  };
  const field = (name: string, label: string, placeholder: string, multi: boolean) => {
    const errs = errorFor(name);
    const invalid = errs.length > 0 ? html` aria-invalid="true" aria-describedby="bs-${name}-error"` : "";
    const input = multi
      ? html`<textarea id="bs-${name}" name="${name}" class="input textarea mono" rows="3" placeholder="${placeholder}" spellcheck="false"${invalid}>${values[name] ?? ""}</textarea>`
      : html`<input id="bs-${name}" name="${name}" type="text" class="input${name === "name" ? " mono" : ""}" value="${values[name] ?? ""}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"${invalid}>`;
    return html`<div class="stack-xs"><label class="label" for="bs-${name}">${label}</label>${input}
      ${errs.length > 0 ? html`<p id="bs-${name}-error" class="field-error">${errs.map(message).join(" ")}</p>` : ""}</div>`;
  };
  return html`<form id="budget-setup-form" class="card pad stack" novalidate aria-labelledby="bs-title">
    <h2 id="bs-title" class="h2">Create an Agent Budget</h2>
    <ol class="small muted steps"><li>Create the budget</li><li>Top up</li><li>Connect your agent</li></ol>
    <p class="check-line">${icon.info()}<span>${available
      ? "Creating a budget from this page is not available yet. You can fill in the form to check your rules."
      : html`Creating a budget is not available yet: the Agent Budget factory <span class="mono">${BUDGET_FACTORY_NAME}</span> is not deployed. You can fill in the form to check your rules.`}</span></p>
    <p class="check-line">${icon.alert()}<span>Testnet only, not audited.</span></p>
    ${errors.length > 0 ? html`<p class="field-error" role="alert">Fix the fields marked below.</p>` : ""}
    <div class="grid-2">${SETUP_FIELDS.map(([n, l, p]) => field(n, l, p, false))}</div>
    ${SETUP_LISTS.map(([n, l, p]) => field(n, l, p, true))}
    <div class="actions"><button type="submit" class="btn btn-primary">Check my rules</button></div>
    <p id="budget-setup-status" class="small" role="status">${result ?? ""}</p>
  </form>`;
}
