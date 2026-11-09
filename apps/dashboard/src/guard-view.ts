// The Agent Guard page, pure. The page builds `add_proposal` calls for a council member's wallet: the council
// votes in its usual DAO UI, and only a passed proposal creates or changes a Guard. The one direct call is a
// guardian's `pause`, which can only stop a Guard.
import type { Network } from "key-doctor";
import { formatUtc, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { GUARD_FORM_TEXT, type GuardFormError } from "./guard-form.ts";
import { GUARD_METHODS, GUARD_ROLE, type AddProposalArgs, type RawPolicy } from "./guard-proposals.ts";
import type { GuardDao, GuardLive } from "./guard-read.ts";
import { copyRow } from "./pages.ts";
import { pageHref, routeHref } from "./route.ts";

const EXAMPLE_GUARD_DAO = "kdoncall.sputnik-v2.testnet";

function head(lead: string): Html {
  return html`<section class="page-head"><div class="stack-sm grow">
      <p class="eyebrow">Agent Guard</p>
      <h1 class="h1">Let an AI agent pay, within limits the council set</h1>
      <p class="lead">${lead}</p>
    </div></section>`;
}

/** The DAO form. `factory` empty means this build has no Guard factory (KD_GUARD_FACTORY). */
export function renderGuardStart(dao: string, error: string | null, factory: string): Html {
  if (factory === "") {
    return html`${head("Each Guard is a locked contract that can only propose transfers to the DAO, within its limits.")}
      <section class="card pad stack-sm"><p class="strong">No Guard factory in this build</p>
        <p class="small muted">Build the dashboard with <span class="mono">KD_GUARD_FACTORY=&lt;factory account&gt;</span>. See the README.</p></section>`;
  }
  return html`${head("A council member proposes the Guard here. The council votes in its usual DAO UI. Keyfence signs nothing; your wallet signs the proposals.")}
    <form id="guard-dao-form" class="card pad stack-sm" novalidate>
      <label for="guard-dao" class="label">Sputnik DAO</label>
      <div class="input-row">
        <input id="guard-dao" name="dao" type="text" class="input mono" value="${dao}" placeholder="${EXAMPLE_GUARD_DAO}"
          autocomplete="off" autocapitalize="none" spellcheck="false" required${error ? html` aria-invalid="true" aria-describedby="guard-dao-error"` : ""}>
        <button type="submit" class="btn btn-primary">Open</button>
      </div>
      ${error ? html`<p id="guard-dao-error" class="field-error" role="alert">${error}</p>` : ""}
      <p class="small muted">Factory <span class="mono">${factory}</span>. Guards are created on its network only.</p>
    </form>`;
}

export function renderGuardLoading(dao: string): Html {
  return html`${head("Reading the DAO policy and its Guards from NEAR RPC…")}
    <section class="card pad stack-sm" aria-busy="true" aria-label="Loading ${dao}"><p class="meta mono" role="status">${dao}</p></section>`;
}

const near = (yocto: string | undefined): string => (yocto === undefined ? "unknown" : `${yoctoToNear(yocto)} NEAR`);

function row(label: string, value: Html | string): Html {
  return html`<tr><th scope="row">${label}</th><td>${value}</td></tr>`;
}

/** Plugs the Guard MCP into Claude Code on the agent owner's machine, inside a clone of this repo. */
export const guardMcpCommand = (network: Network, guardId: string, agent: string): string =>
  `claude mcp add guard -e NEAR_NETWORK=${network} -e GUARD_CONTRACT_ID=${guardId} -e AGENT_ACCOUNT_ID=${agent} -e AGENT_KEY_PATH=$HOME/.config/key-doctor/${agent}.json -- pnpm --silent --filter guard-mcp start`;

/** The agent owner's two commands for one agent: its function-call key, then the Guard MCP for Claude Code. */
function agentSteps(g: GuardLive, agent: string, network: Network): Html {
  const addKey = `near account add-key ${agent} grant-function-call-access --allowance '1 NEAR' --contract-account-id ${g.guard_id} --function-names 'request_transfer, sync_request' use-manually-provided-public-key ed25519:<agent public key> network-config ${network} sign-with-keychain send`;
  const mcp = guardMcpCommand(network, g.guard_id, agent);
  return html`<div class="stack-sm"><p class="strong mono wrap">${agent}</p>
    <p class="small muted">1. Give the agent a key that can only call this Guard (keep the private key in a mode-600 file, never in a repo):</p>${copyRow(addKey)}
    <p class="small muted">2. Add the Guard MCP to Claude Code on the agent owner's machine:</p>${copyRow(mcp)}</div>`;
}

const METHOD_HINT: Record<(typeof GUARD_METHODS)[number], string> = {
  set_policy: '{"policy":{"max_per_tx":"<yocto>","max_per_day":"<yocto>","max_pending_per_agent":3,"min_reserve":"<yocto>"}}',
  add_agent: '{"account_id":"<agent>","label":"<label>"}',
  remove_agent: '{"account_id":"<agent>"}',
  set_agent_enabled: '{"account_id":"<agent>","enabled":false}',
  add_whitelist: '{"account_id":"<receiver>","label":"<label>","max_per_tx":null}',
  remove_whitelist: '{"account_id":"<receiver>"}',
  add_guardian: '{"account_id":"<guardian>"}',
  unpause: "{}",
  withdraw_excess: "{}",
};

function changeForm(g: GuardLive): Html {
  const options = GUARD_METHODS.map((m) => html`<option value="${m}">${m}</option>`);
  const hints = GUARD_METHODS.map((m) => html`<tr><td><code class="mono">${m}</code></td><td><code class="mono wrap">${METHOD_HINT[m]}</code></td></tr>`);
  const id = `change-${g.guard_id}`;
  return html`<details class="stack-sm"><summary class="strong">Propose a change</summary>
    <form class="stack-sm guard-change-form" data-guard="${g.guard_id}" novalidate>
      <label class="label" for="${id}-method">Method</label>
      <select id="${id}-method" name="method" class="input">${options}</select>
      <label class="label" for="${id}-args">Arguments (JSON, amounts in yoctoNEAR)</label>
      <textarea id="${id}-args" name="args" class="input textarea mono" rows="4" spellcheck="false">{}</textarea>
      <p class="small muted">Methods that add an entry attach 0.01 NEAR for storage; the Guard refunds the rest to the DAO.</p>
      <div class="table-scroll"><table class="info-table"><thead><tr><th>Method</th><th>Arguments</th></tr></thead><tbody>${hints}</tbody></table></div>
      <button type="submit" class="btn btn-secondary self-start">Preview proposal</button>
    </form></details>`;
}

/** Emergency stop (a guardian signs `pause` directly) and retire (a proposal removing the Guard from the role). */
function controls(g: GuardLive): Html {
  const id = g.guard_id;
  const pause = g.config?.paused
    ? html`<p class="small muted">Paused: every request fails until the DAO passes an <code class="mono">unpause</code> proposal (Propose a change below).</p>`
    : g.config !== null && g.config.guardians.length > 0
      ? html`<div class="stack-xs">
          <p class="small">A guardian stops this Guard at once, without a vote. Only a DAO <code class="mono">unpause</code> proposal restarts it.</p>
          <button type="button" class="btn btn-danger self-start" data-action="guard-pause" data-guard="${id}">Pause now (guardian)</button>
          <p class="small" role="status" data-pause-status="${id}"></p>
        </div>`
      : g.config !== null
        ? html`<p class="small muted">No guardian: only a DAO proposal can pause this Guard. Add one with <code class="mono">add_guardian</code>.</p>`
        : "";
  const retire = g.in_role
    ? html`<div class="stack-xs">
        <p class="small">A Guard cannot be deleted. Removing it from role <code class="mono">${GUARD_ROLE}</code> stops it proposing transfers.</p>
        <button type="button" class="btn btn-secondary self-start" data-action="guard-retire" data-guard="${id}">Propose retire</button>
      </div>`
    : "";
  return html`<div class="stack-sm"><h3 class="h3">Stop</h3>${pause}${retire}</div>`;
}

export function renderGuardCard(g: GuardLive, network: Network): Html {
  const status = !g.ready
    ? html`<span class="pill pill-note">Creating</span>`
    : g.config?.paused
      ? html`<span class="pill pill-high">Paused</span>`
      : g.in_role
        ? html`<span class="pill pill-ok">Active</span>`
        : html`<span class="pill pill-cleanup">Not in role ${GUARD_ROLE}</span>`;
  const p = g.policy;
  const w = g.window;
  const unreadable = g.ready && (g.config === null || p === null);
  return html`<section class="card" aria-labelledby="g-${g.guard_id}">
    <div class="card-head"><h2 id="g-${g.guard_id}" class="h2 mono wrap">${g.guard_id}</h2>${status}</div>
    <div class="pad stack">
      ${!g.in_role && g.ready ? html`<p class="check-line">${icon.info()}<span>The DAO role <span class="mono">${GUARD_ROLE}</span> does not list this Guard yet, so it cannot propose transfers. Vote the role proposal through in the DAO.</span></p>` : ""}
      ${unreadable ? html`<p class="check-line">${icon.alert()}<span>Could not read this Guard's views right now. Its limits are unknown, not absent.</span></p>` : ""}
      ${p === null ? "" : html`<div class="table-scroll"><table class="info-table"><tbody>
        ${row("Per transfer", near(p.max_per_tx))}
        ${row("Per 24 hours", near(p.max_per_day))}
        ${row("Spent in window", w === null ? "unknown" : html`${near(w.spent_in_window)}, ${near(w.remaining)} left, resets ${formatUtc(w.resets_at)}`)}
        ${row("Pending per agent", String(p.max_pending_per_agent))}
        ${row("Reserve kept", near(p.min_reserve))}
        ${g.config === null ? "" : row("Whitelisted receivers", String(g.config.whitelist))}
        ${g.config === null ? "" : row("Guardians (can pause)", g.config.guardians.length === 0 ? "none" : g.config.guardians.join(", "))}
      </tbody></table></div>`}
      ${g.agents === null || g.agents.length === 0 ? "" : html`<div class="stack"><h3 class="h3">Agent owner setup</h3>
        ${g.agents.map((a) => agentSteps(g, a.account_id, network))}</div>`}
      ${g.ready ? controls(g) : ""}
      ${g.ready ? changeForm(g) : ""}
    </div></section>`;
}

const FIELDS: ReadonlyArray<readonly [string, string, string]> = [
  ["name", "Name", "payroll"],
  ["maxPerTx", "Max per transfer (NEAR)", "5"],
  ["maxPerDay", "Max per 24 hours (NEAR)", "10"],
  ["maxPendingPerAgent", "Pending requests per agent", "3"],
  ["minReserve", "Reserve the Guard keeps (NEAR)", "1"],
  ["funding", "Funding from the DAO (NEAR)", "5"],
];

const LISTS: ReadonlyArray<readonly [string, string, string]> = [
  ["agents", "Agents: account, label (one per line)", "bot.kdoncall.testnet, payroll bot"],
  ["whitelist", "Receivers: account, label, cap in NEAR or empty (one per line)", "vendor.kdoncall.testnet, vendor, 2"],
  ["guardians", "Guardians who can pause (one per line, optional)", "alice.kdoncall.testnet"],
];

/** The create form; `values` and `errors` come back from a failed submit so nothing typed is lost. */
export function renderGuardCreate(factory: string, values: Record<string, string> = {}, errors: GuardFormError[] = []): Html {
  const errorFor = (name: string) => errors.filter((e) => e.field === name || e.field.startsWith(`${name}.`));
  const message = (e: GuardFormError) => {
    const at = /\.(\d+)/.exec(e.field);
    return `${at ? `Line ${Number(at[1]) + 1}: ` : ""}${GUARD_FORM_TEXT[e.code].en}`;
  };
  const field = (name: string, label: string, placeholder: string, multi: boolean) => {
    const errs = errorFor(name);
    const invalid = errs.length > 0 ? html` aria-invalid="true" aria-describedby="gf-${name}-error"` : "";
    const input = multi
      ? html`<textarea id="gf-${name}" name="${name}" class="input textarea mono" rows="3" placeholder="${placeholder}" spellcheck="false"${invalid}>${values[name] ?? ""}</textarea>`
      : html`<input id="gf-${name}" name="${name}" type="text" class="input${name === "name" ? " mono" : ""}" value="${values[name] ?? ""}" placeholder="${placeholder}" autocomplete="off" spellcheck="false"${invalid}>`;
    return html`<div class="stack-xs"><label class="label" for="gf-${name}">${label}</label>${input}
      ${errs.length > 0 ? html`<p id="gf-${name}-error" class="field-error">${errs.map(message).join(" ")}</p>` : ""}</div>`;
  };
  return html`<form id="guard-create-form" class="card pad stack" novalidate aria-labelledby="gc-title">
    <h2 id="gc-title" class="h2">Create a Guard</h2>
    <p class="small muted">The Guard is created as <span class="mono">&lt;name&gt;.${factory}</span>, locked from birth: only DAO proposals can change it.</p>
    ${errors.length > 0 ? html`<p class="field-error" role="alert">Fix the fields marked below.</p>` : ""}
    <div class="grid-2">${FIELDS.map(([n, l, p]) => field(n, l, p, false))}</div>
    ${LISTS.map(([n, l, p]) => field(n, l, p, true))}
    <button type="submit" class="btn btn-primary self-start">Preview proposals</button>
  </form>`;
}

export function renderGuardDao(state: GuardDao, network: Network, createValues?: Record<string, string>, errors?: GuardFormError[]): Html {
  const cards = state.guards.map((g) => renderGuardCard(g, network));
  return html`${head("A council member proposes here; the council votes in its usual DAO UI.")}
    <section class="stack-sm"><p>DAO <a class="mono" href="${routeHref(state.dao)}" data-nav>${state.dao}</a> · proposal bond ${near(state.policy.proposal_bond)} each · <a href="${pageHref("guard")}" data-nav>Other DAO</a></p></section>
    ${cards.length === 0 ? html`<section class="card pad"><p class="muted">This DAO has no Guard from <span class="mono">${state.factory}</span> yet.</p></section>` : cards}
    ${renderGuardCreate(state.factory, createValues, errors)}
    <div id="guard-preview"></div>`;
}

/** What the wallet will be asked to sign: every `add_proposal` call, decoded, with the total it attaches. */
export interface GuardPreview {
  dao: string;
  bond: string;
  proposals: AddProposalArgs[];
  notes: string[];
}

function decodeBase64Json(b64: string): string {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)), null, 2);
  } catch {
    return b64;
  }
}

function proposalBody(p: AddProposalArgs): Html {
  const kind = p.proposal.kind;
  const call = kind.FunctionCall as { receiver_id: string; actions: { method_name: string; args: string; deposit: string }[] } | undefined;
  if (call !== undefined) {
    return html`${call.actions.map(
      (a) => html`<p class="small">Calls <code class="mono">${call.receiver_id}.${a.method_name}</code> with ${near(a.deposit)} from the DAO when it passes.</p>
        <pre class="mono small wrap">${decodeBase64Json(a.args)}</pre>`,
    )}`;
  }
  const policy = (kind.ChangePolicy as { policy: RawPolicy } | undefined)?.policy;
  const role = policy?.roles.find((r) => r.name === GUARD_ROLE);
  if (role === undefined) {
    return html`<p class="small">Replaces the DAO policy. Every other role stays as it is; role <code class="mono">${GUARD_ROLE}</code> is removed.</p>`;
  }
  return html`<p class="small">Replaces the DAO policy. Every role stays as it is; role <code class="mono">${GUARD_ROLE}</code> becomes:</p>
    <pre class="mono small wrap">${JSON.stringify(role, null, 2)}</pre>`;
}

export function renderGuardPreview(p: GuardPreview): Html {
  const total = (BigInt(p.bond) * BigInt(p.proposals.length)).toString();
  return html`<section class="card pad stack" aria-labelledby="gp-title">
    <h2 id="gp-title" class="h2">Proposals to sign</h2>
    <ol class="stack">${p.proposals.map((x) => html`<li class="stack-xs"><p class="strong">${x.proposal.description}</p>${proposalBody(x)}</li>`)}</ol>
    ${p.notes.map((n) => html`<p class="check-line">${icon.info()}<span>${n}</span></p>`)}
    <p>One transaction to <span class="mono">${p.dao}</span>, attaching the proposal bond ${p.proposals.length === 1 ? "" : `× ${p.proposals.length} `}= <strong>${near(total)}</strong>. The bond comes back when each proposal is finalised.</p>
    <div class="actions"><button type="button" class="btn btn-primary" data-action="guard-sign">Sign in wallet</button></div>
    <p id="guard-sign-status" class="small" role="status"></p>
  </section>`;
}

/** After the wallet submitted: where the council votes. */
export function renderGuardSubmitted(dao: string): Html {
  return html`Submitted. The council votes in its DAO UI; <a href="${routeHref(dao)}" data-nav>see the proposals on the council page</a>.`;
}
