import type { KdError, Network } from "key-doctor";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { walletDialog } from "./cleanup-view.ts";
import { breadcrumb, walletControls } from "./report.ts";
import { BOT_URL, BOT_USERNAME, homeHref, pageHref, routeHref, type Page } from "./route.ts";
import { alertLines, watchCommand } from "./watch.ts";
import { NETWORK_STATS, type HomeStats } from "./network-stats.ts";
import { pagePillar, type Pillar } from "./pillars.ts";
import { widthClass } from "./bar-width.ts";

export const EXAMPLE_DAO = "kdoncall.sputnik-v2.testnet";
export const EXAMPLE_ACCOUNT = "kdoncall-p.testnet";

/**
 * One nav item per Sputnik DAO pillar and the pages it stays current on. Your agents lists Budget and Yield agents
 * together, so it stays under Agent Budget, where an owner starts. Alerts is a button, never current.
 */
const NAV: ReadonlyArray<readonly [Page, Pillar, string, ReadonlyArray<Page>]> = [
  ["check", "scan", "Scan DAO", ["check"]],
  ["budget", "budget", "Agent Budget", ["budget", "my-agents", "guard"]],
  ["yield", "yield", "Yield", ["yield"]],
];

export function renderLayout(content: Html, network: Network = "testnet", page: Page = "check"): Html {
  const link = ([p, pillar, label, current]: readonly [Page, Pillar, string, ReadonlyArray<Page>]) =>
    html`<a href="${pageHref(p, network)}" data-nav class="nav-${pillar}"${current.includes(page) ? html` aria-current="page"` : ""}><span class="pillar-dot" aria-hidden="true"></span>${label}</a>`;
  const pillar = pagePillar(page);
  return html`<a class="skip" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="container header-inner">
        <a href="${pageHref("check", network)}" data-nav class="brand"><span class="brand-tile">${icon.logo()}</span><span>Key Doctor</span></a>
        <nav aria-label="Main" class="main-nav">
          ${NAV.map(link)}
          <button type="button" class="nav-btn" data-action="alerts-open">Alerts</button>
        </nav>
        <div class="header-tools">
          ${network === "testnet" ? html`<span class="pill pill-cleanup net-pill">Testnet</span>` : html`<span class="pill pill-note net-pill">Mainnet</span>`}
          <button type="button" class="icon-btn theme-toggle" data-action="theme" aria-label="Dark theme" aria-pressed="false">
            <span class="theme-moon">${icon.moon()}</span><span class="theme-sun">${icon.sun()}</span>
          </button>
          ${walletControls()}
        </div>
      </div>
    </header>
    <main id="main" tabindex="-1" class="container page"${pillar === null ? "" : html` data-pillar="${pillar}"`}>${content}</main>
    <footer class="site-footer">
      <div class="container footer-inner">
        <span>${network === "testnet" ? "Testnet. Contracts are unaudited." : "Mainnet. Your wallet signs, never Key Doctor."}</span>
        <span>Key Doctor never holds your keys. Limits are enforced on-chain.</span>
        <nav aria-label="More pages" class="footer-nav"><a href="${pageHref("mcp", network)}" data-nav${page === "mcp" ? html` aria-current="page"` : ""}>For developers (MCP)</a><a href="${pageHref("roadmap", network)}" data-nav${page === "roadmap" ? html` aria-current="page"` : ""}>Roadmap</a></nav>
      </div>
    </footer>
    <dialog id="alerts-drawer" class="drawer" aria-labelledby="alerts-title"></dialog>
    ${walletDialog()}`;
}

const BOT_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["/check <name>", "Scan an account or DAO now. Stores nothing."],
  ["/changes <name>", "Show what changed since the daily baseline."],
  ["/watch <name>", "Subscribe this chat to key-change and proposal alerts."],
  ["/unwatch <name>", "Stop the alerts for a name."],
  ["/list", "List what this chat watches."],
  ["/help", "Show the commands."],
];

/** The bell's drawer, which is also what `?page=oncall` opens. The dashboard never writes subscriptions, so it only shows how to subscribe in the bot. */
export function renderAlertsDrawer(target: string | null): Html {
  return html`<div class="drawer-head">
      <div class="drawer-title"><h2 id="alerts-title" class="drawer-h">Alerts</h2><p class="small muted">Key Doctor stays on call in Telegram.</p></div>
      <button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close">${icon.close()}</button>
    </div>
    <div class="drawer-body">
      <ol class="plain drawer-steps">
        <li><span class="step-dot">1</span><div class="stack-xs"><strong>Open the bot</strong><p class="small muted"><span class="mono">@${BOT_USERNAME}</span> on Telegram.</p></div></li>
        <li><span class="step-dot">2</span><div class="stack-xs grow-min"><strong>Send it what to watch</strong>${copyRow(watchCommand(target ?? "<name>"))}</div></li>
        <li><span class="step-dot">3</span><div class="stack-xs"><strong>Council? Add the bot to your group</strong><p class="small muted">Everyone in the group sees the same alert.</p></div></li>
      </ol>
      <div class="stack-xs small">
        <h3 class="drawer-h3">What you will get</h3>
        ${alertLines(true)}
      </div>
      <div class="stack-xs">
        <h3 class="drawer-h3">Bot commands</h3>
        <ul class="plain stack-xs small">${BOT_COMMANDS.map(([c, d]) => html`<li><code class="mono">${c}</code> <span class="muted">${d}</span></li>`)}</ul>
      </div>
      <div class="stack-xs">
        <h3 class="drawer-h3">Limits</h3>
        <ul class="list small">
          <li>A DAO that needs only 1 vote can be warned only after the proposal executes.</li>
          <li>An alert can arrive up to 15 minutes late.</li>
        </ul>
      </div>
    </div>
    <div class="drawer-foot"><a class="btn btn-primary" href="${BOT_URL}" target="_blank" rel="noopener">${icon.send()}Open Telegram</a></div>`;
}

function tryLink(target: string): Html {
  return html`<a class="btn btn-ghost mono" href="${routeHref(target)}" data-nav>${target}</a>`;
}

function networkSwitch(network: Network): Html {
  const seg = (n: Network, label: string) =>
    html`<button type="button" class="seg" data-action="network" data-network="${n}" aria-pressed="${String(network === n)}">${label}</button>`;
  return html`<div class="segmented" role="group" aria-label="Network">${seg("testnet", "Testnet")}${seg("mainnet", "Mainnet")}</div>`;
}

/** Examples use testnet names only; on mainnet the user enters their own account (no real names in the UI). */
function examples(network: Network): Html {
  return network === "testnet"
    ? html`<div class="home-try small muted"><span>Try</span>${tryLink(EXAMPLE_DAO)}${tryLink(EXAMPLE_ACCOUNT)}</div>`
    : html`<p class="small muted">Mainnet scans read live data. Enter your own account, or your DAO's <span class="mono">*.sputnik-dao.near</span> name.</p>`;
}

/** Shown under the field for a name that is not an account id (handoff K1 states). */
export const INVALID_NAME_MESSAGE = "Not a NEAR account name. Names end in .testnet or .near.";

function homeStep(n: number, title: string, body: string, glyph: Html): Html {
  return html`<li class="home-step"><span class="home-tile" aria-hidden="true">${glyph}</span>
    <div class="stack-xs"><p class="eyebrow">Step ${n}</p><h3 class="h3">${title}</h3><p class="small muted">${body}</p></div></li>`;
}

/**
 * A link down to the check card on the same page. Not `data-nav`: navigate() scrolls to the top and repaints, so the
 * click handler scrolls to the card and focuses its input instead. `placeholder` tells the input what to expect.
 */
function jumpToCheck(cta: Html | string, placeholder = "", fillWallet = false): Html {
  return html`<a class="btn btn-secondary" href="#check" data-action="jump-check"${placeholder ? html` data-placeholder="${placeholder}"` : ""}${fillWallet ? html` data-fill="wallet"` : ""}>${cta}</a>`;
}

/** One pillar card: the tool's color stripe and tile, what it does in plain words, and where to start. */
function pillarCard(pillar: Pillar, glyph: Html, name: string, title: string, lead: string, points: string[], cta: Html): Html {
  return html`<article class="card pad stack-sm home-path pillar-card pillar-${pillar}" aria-labelledby="pillar-${pillar}">
      <div class="pillar-card-head"><span class="home-tile pillar-tile" aria-hidden="true">${glyph}</span><p class="pillar-name">${name}</p></div>
      <h3 id="pillar-${pillar}" class="h3">${title}</h3><p class="small muted">${lead}</p>
      <ul class="list small">${points.map((p) => html`<li>${p}</li>`)}</ul>
      <div class="home-path-cta actions">${cta}</div>
    </article>`;
}

/** Fixed sample text only; hidden from assistive tech because it shows no real data. */
const HOME_PREVIEW = html`<div class="card pad stack-sm home-preview" aria-hidden="true">
      <div class="home-preview-head">${icon.key()}<strong>Research bot</strong><span class="pill pill-ok">Active</span></div>
      <div><div class="home-preview-row"><span>Spent today</span><span>1.2 of 5 NEAR</span></div><div class="home-bar"><span class="w-24"></span></div></div>
      <div class="home-preview-line"><span class="tone-ok">${icon.check()}</span><span>Paid 0.4 NEAR to <span class="mono">search-api.testnet</span></span></div>
      <div class="home-preview-line"><span class="tone-cleanup">${icon.clock()}</span><span>Waiting for you: 4.5 NEAR to <span class="mono">api-vendor.testnet</span></span></div>
      <div class="home-preview-line"><span class="tone-high">${icon.close()}</span><span>You rejected 500 NEAR to <span class="mono">attacker.testnet</span></span></div>
    </div>`;

const share = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const count = (n: number) => n.toLocaleString("en-US");

/**
 * One ratio as a meter: the number and its words first (they carry the meaning), then the bar, then the raw counts.
 * The bar is decorative for screen readers because the text above it says the same thing.
 */
function meterRow(n: number, d: number, label: string, unit: string): Html {
  const counts = `${count(n)} of ${count(d)} ${unit}`;
  return html`<li class="meter-row">
      <p class="meter-text"><span class="meter-value">${share(n, d)}</span> <span class="meter-label">${label}</span></p>
      <div class="meter" aria-hidden="true" title="${counts}"><span class="${widthClass(n, d)}"></span></div>
      <p class="small muted">${counts}</p>
    </li>`;
}

/** One key type split into "never used" (highlighted) and "in use" (neutral), the two series the legend names. */
function keyBar(name: string, total: number, unused: number): Html {
  return html`<li class="meter-row">
      <p class="meter-text"><span class="meter-value">${share(unused, total)}</span> <span class="meter-label">of council members' ${name} were never used</span></p>
      <div class="seg-bar" aria-hidden="true">
        <span class="bar-seg seg-unused ${widthClass(unused, total)}" title="Never used: ${count(unused)}"></span><span class="bar-seg seg-used" title="In use: ${count(total - unused)}"></span>
      </div>
      <p class="small muted">${count(unused)} of ${count(total)} ${name}</p>
    </li>`;
}

/** Network-wide numbers from `pnpm stats` (GĐ10) as two small charts. Every number and its source block come from the JSON. */
export function renderNetworkStats(s: HomeStats): Html {
  const date = s.block_timestamp.slice(0, 10);
  return html`<section class="card pad stack home-numbers" aria-labelledby="numbers">
      <div class="stack-xs"><p class="eyebrow home-eyebrow">Measured on NEAR mainnet</p>
        <h2 id="numbers" class="h2">How safe are Sputnik DAO treasuries on NEAR?</h2></div>
      <div class="chart-cols">
        <figure class="chart stack-sm" aria-labelledby="numbers-daos">
          <figcaption id="numbers-daos" class="chart-title">Councils</figcaption>
          <ul class="plain meter-list">
            ${meterRow(s.council_size.one_member, s.daos_scanned, "of Sputnik DAOs have a one-person council", "DAOs")}
            ${meterRow(s.daos_single_vote_transfer, s.daos_scanned, "of Sputnik DAOs let one account approve a payment", "DAOs")}
            ${meterRow(s.members_high, s.council_members, "of council members are at high risk", "members")}
          </ul>
        </figure>
        <figure class="chart stack-sm" aria-labelledby="numbers-keys">
          <figcaption id="numbers-keys" class="chart-title">Council members' keys</figcaption>
          <ul class="plain meter-list">
            ${keyBar("full-access keys", s.full_access_keys, s.full_access_keys_never_used)}
            ${keyBar("app keys", s.function_call_keys, s.function_call_keys_never_used)}
          </ul>
          <ul class="plain chart-legend small" aria-label="Legend">
            <li><span class="swatch seg-unused" aria-hidden="true"></span>Never used</li>
            <li><span class="swatch seg-used" aria-hidden="true"></span>In use</li>
          </ul>
        </figure>
      </div>
      <p class="small muted">${s.scope === "all" ? `All ${count(s.daos_scanned)} readable Sputnik DAOs on ${s.network} (${count(s.daos_active)} active in the last ${s.active_days} days)` : `${count(s.daos_scanned)} Sputnik DAOs on ${s.network} active in the last ${s.active_days} days`}, read at block ${count(s.block_height)} (${date}), ruleset ${s.ruleset_version}. ${s.daos_failed} DAOs could not be read and are left out. Rerun with <code class="mono">pnpm stats --block ${s.block_height}${s.scope === "all" ? " --all" : ""}</code>.</p>
    </section>`;
}

export function renderHome(value: string, error: string | null, network: Network = "testnet", signedIn = false, stats: HomeStats = NETWORK_STATS): Html {
  const suffix = network === "mainnet" ? ".near" : ".testnet";
  const daoPlaceholder = network === "mainnet" ? "your-dao.sputnik-dao.near" : EXAMPLE_DAO;
  const primary = signedIn
    ? html`<a class="btn btn-primary" href="${pageHref("my-agents")}" data-nav>Go to your agents</a>`
    : html`<a class="btn btn-primary" href="${pageHref("budget")}" data-nav>${icon.plus()}Set up an agent budget</a>`;
  return html`<section class="home-hero">
      <div class="stack home-hero-text">
        <p class="eyebrow home-eyebrow">Built for Sputnik DAO councils on NEAR</p>
        <h1 class="display">Keep your DAO's keys, agents and idle funds in check.</h1>
        <p class="lead">Key Doctor scans every council member's keys, gives your AI agents a budget an on-chain contract enforces, and finds where idle stablecoins can earn. It never holds your keys.</p>
        <div class="actions">${primary}${jumpToCheck(html`${icon.key()}Scan a DAO's keys`, daoPlaceholder)}</div>
        <ul class="plain pillar-chips small" aria-label="Three tools">
          <li class="pillar-scan"><span class="pillar-dot" aria-hidden="true"></span>Scan DAO</li>
          <li class="pillar-budget"><span class="pillar-dot" aria-hidden="true"></span>Agent Budget</li>
          <li class="pillar-yield"><span class="pillar-dot" aria-hidden="true"></span>Yield</li>
        </ul>
      </div>
      ${HOME_PREVIEW}
    </section>

    <section aria-labelledby="who" class="stack-sm">
      <h2 id="who" class="h2">Three tools for one Sputnik DAO</h2>
      <div class="home-paths">
        ${pillarCard("scan", icon.users(), "Scan DAO", "Know who can move the treasury", "Every council member's keys and the voting rules, checked with fixed rules and explained in plain words.", ["Each member's keys checked with 14 rules", "Telegram warning before the final vote", "Step-by-step cleanup from your own wallet"], html`${jumpToCheck("Scan a council", daoPlaceholder)}${jumpToCheck("Check my own keys", network === "mainnet" ? "your-name.near" : EXAMPLE_ACCOUNT, true)}`)}
        ${pillarCard("budget", icon.list(), "Agent Budget", "Let an AI agent pay, within limits", "The agent holds a key that can only ask for money. Payments inside the limits go out; the rest wait for the council.", ["Daily budget and limit per payment", "Allowed recipients", "Scheduled payouts and DCA"], html`<a class="btn btn-secondary" href="${pageHref("budget", network)}" data-nav>Set up an agent budget</a>`)}
        ${pillarCard("yield", icon.trend(), "Yield", "Put idle stablecoins to work", "Reads Rhea Lend rates for the DAO's idle tokens and suggests a move. The council votes on every move.", ["Suggestions capped at the free balance", "Every number comes from code, not a model", "Data, not financial advice"], html`<a class="btn btn-secondary" href="${pageHref("yield", network)}" data-nav>Open the yield agent</a>`)}
      </div>
    </section>

    ${renderNetworkStats(stats)}

    <section class="card pad stack" aria-labelledby="how"><h2 id="how" class="h2">How it works for a council</h2>
      <ol class="plain home-steps">
        ${homeStep(1, "Scan the council", "Type the DAO name. Every member's keys and the voting rules come back in plain words.", icon.search())}
        ${homeStep(2, "Fence your agents", "Pick a daily budget, a limit per payment and who the agent may pay. The contract enforces it, not the agent.", icon.check())}
        ${homeStep(3, "Stay on call", "Risky votes, new keys and payments that wait for the council arrive in Telegram.", icon.bell())}
      </ol></section>

    <section id="check" class="card pad stack-sm" aria-labelledby="check-h">
      <h2 id="check-h" class="h2">Check any NEAR account or DAO</h2>
      <p class="small muted">Free. Reads public data only. No sign-in needed to check. Connecting a wallet is only for removing your own keys.</p>
      <form id="check-form" class="stack-sm" novalidate>
        <div class="form-head">
          <label for="target" class="label">Account or DAO name</label>
          ${networkSwitch(network)}
        </div>
        <div class="input-row">
          <input id="target" name="target" type="text" class="input mono" value="${value}"
            placeholder="${daoPlaceholder}"
            autocomplete="off" autocapitalize="none" spellcheck="false" required
            aria-describedby="target-hint${error ? " target-error" : ""}"${error ? html` aria-invalid="true"` : ""}>
          <button type="submit" class="btn btn-primary">${icon.search()}Check</button>
        </div>
        ${error ? html`<p id="target-error" class="field-error" role="alert">${error}</p>` : ""}
        <p id="target-hint" class="small muted">Checking on <strong>${network}</strong>. A name without a suffix gets <span class="mono">${suffix}</span>; a <span class="mono">.near</span> or <span class="mono">.testnet</span> suffix you type always wins.</p>
        ${examples(network)}
      </form>
    </section>

    <ul class="plain home-trust small">
      <li>${icon.check()}<span>Limits are enforced by an on-chain contract, not by the agent.</span></li>
      <li>${icon.check()}<span>Your agent never gets your wallet key, only one that asks for payments.</span></li>
      <li>${icon.check()}<span>Every payment that waits for you arrives in Telegram too.</span></li>
    </ul>`;
}

const AGENT_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["diagnose", "Verdict for an account or DAO council (kd.report_summary.v1). Read-only."],
  ["list_keys", "One row per access key, filterable. Read-only."],
  ["list_proposals", "A DAO's proposals with votes and who still has to vote. Read-only."],
  ["compare", "Diff against the stored baseline (kd.diff.v1). Moves the baseline only with update_baseline: true."],
  ["watch", "Two one-time Telegram links that subscribe a chat (kd.watch_link.v1)."],
  ["preflight", "Verdict allow, review or block for the account an agent is about to sign or pay from (kd.preflight.v1). Block means a full-access key was added in the last 48 hours. Read-only."],
  ["yield_suggestions", "A DAO's idle tokens and Rhea Lend rates, with suggestions capped at the free balance (kd.yield.v1). Data, not financial advice. Read-only."],
];

const AGENT_PROMPTS = [
  `Check the keys of ${EXAMPLE_DAO}`,
  `Which council members of ${EXAMPLE_DAO} have a full-access key?`,
  `What changed on ${EXAMPLE_DAO} since the last baseline?`,
];

export function copyRow(command: string): Html {
  return html`<div class="command-row"><code class="command mono wrap">${command}</code>
    <button type="button" class="btn btn-secondary" data-action="copy-command" data-command="${command}">${icon.copy()}<span data-copy-label>Copy</span></button></div>`;
}

export function renderAgents(workerUrl = ""): Html {
  const endpoint = workerUrl === "" ? "" : `${workerUrl}/mcp`;
  const add = `claude mcp add --transport http key-doctor ${endpoint}`;
  const curl = `curl -s ${endpoint} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"diagnose","arguments":{"target":"${EXAMPLE_DAO}"}}}'`;
  const rows = AGENT_TOOLS.map(([n, d]) => html`<tr><td><code class="mono">${n}</code></td><td>${d}</td></tr>`);
  const prompts = AGENT_PROMPTS.map((p) => html`<li>${p}</li>`);
  return html`<section class="page-head"><div class="stack-sm grow">
      <p class="eyebrow">Agents</p>
      <h1 class="h1">Use Key Doctor from your AI agent</h1>
      <p class="lead">Fixed rules make every verdict, no AI. MCP holds no NEAR keys.</p>
    </div></section>
    ${endpoint === ""
      ? html`<section class="card pad stack-sm"><p class="strong">Self-host: see the README</p><p class="small muted">This build has no Worker URL, so there is no public endpoint to show.</p></section>`
      : html`<section class="card pad stack" aria-labelledby="ag-start"><h2 id="ag-start" class="h2">Connect</h2>
          <div class="stack-sm"><p class="strong">Endpoint</p>${copyRow(endpoint)}</div>
          <div class="stack-sm"><p class="strong">Claude Code</p>${copyRow(add)}</div>
          <div class="stack-sm"><p class="strong">Try it with curl</p>${copyRow(curl)}</div>
        </section>`}
    <section class="stack-sm" aria-labelledby="ag-tools"><h2 id="ag-tools" class="h2">Tools</h2>
      <div class="card table-scroll"><table class="info-table"><thead><tr><th>Tool</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <section class="card pad stack-sm" aria-labelledby="ag-ask"><h2 id="ag-ask" class="h2">Ask your agent</h2><ul class="list">${prompts}</ul></section>`;
}

export function renderScanning(target: string, from: string | null): Html {
  // The bars fade in after 300 ms (CSS), so a fast read never flashes a skeleton.
  const rows = Array.from({ length: 3 }, () => html`<div class="skeleton-row"><span></span><span></span><span></span></div>`);
  return html`${breadcrumb(target, from)}
    <section class="page-head">
      <div class="stack-sm grow">
        <h1 class="h1 mono wrap">${target}</h1>
        <p class="meta" role="status">Reading keys from NEAR…</p>
        <p class="small muted">Usually 2–5 seconds.</p>
      </div>
    </section>
    <section class="card pad stack-sm skeleton-late" aria-busy="true" aria-label="Loading scan results">${rows}</section>`;
}

export function renderError(target: string, from: string | null, err: KdError, network: Network = "testnet"): Html {
  const missing = err.code === "NOT_FOUND";
  const invalid = err.code === "INVALID_TARGET";
  return html`${breadcrumb(target, from)}
    <section class="page-head"><div class="stack-sm grow"><h1 class="h1 mono wrap">${target}</h1></div></section>
    <section role="alert" class="alert-box">
      ${icon.alert()}
      <div class="stack-sm">
        <p class="alert-title">${missing ? html`No account called <span class="mono">${target}</span>` : invalid ? "Invalid name" : "We could not read the chain"}</p>
        <p>${missing ? "Check the spelling, and whether it ends in .testnet or .near." : invalid ? err.message.en : "The risk is unknown, not low. Nothing was changed."}</p>
        <div class="actions">
          ${err.retryable && !missing ? html`<button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Try again</button>` : ""}
          <a href="${homeHref(network)}" data-nav class="btn btn-secondary">Try another name</a>
        </div>
      </div>
    </section>`;
}
