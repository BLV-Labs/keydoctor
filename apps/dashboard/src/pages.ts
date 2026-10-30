import type { KdError, Network } from "key-doctor";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { breadcrumb } from "./report.ts";
import { BOT_URL, BOT_USERNAME, homeHref, pageHref, routeHref, type Page } from "./route.ts";
import { alertLines } from "./watch.ts";

export const EXAMPLE_DAO = "kdoncall.sputnik-v2.testnet";
export const EXAMPLE_ACCOUNT = "kdoncall-p.testnet";

const NAV: ReadonlyArray<readonly [Page, string]> = [["check", "Check"], ["oncall", "On Call"], ["agents", "Agents"]];

export function renderLayout(content: Html, network: Network = "testnet", page: Page = "check"): Html {
  const nav = NAV.map(
    ([p, label]) => html`<a href="${pageHref(p, network)}" data-nav${p === page ? html` aria-current="page"` : ""}>${label}</a>`,
  );
  return html`<a class="skip" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="container header-inner">
        <a href="${pageHref("check", network)}" data-nav class="brand">${icon.logo()}<span>Key Doctor</span></a>
        <nav aria-label="Main" class="main-nav">
          ${nav}
        </nav>
        <button type="button" class="icon-btn theme-toggle" data-action="theme" aria-label="Dark theme" aria-pressed="false">
          <span class="theme-moon">${icon.moon()}</span><span class="theme-sun">${icon.sun()}</span>
        </button>
      </div>
    </header>
    <main id="main" tabindex="-1" class="container page">${content}</main>
    <footer class="site-footer">
      <div class="container footer-inner">
        <span>Reads only public data through NEAR RPC. Never signs transactions, never holds keys.</span>
        <span>MIT licensed · built at NEAR HACKATHON</span>
      </div>
    </footer>`;
}

function chip(kind: string, target: string): Html {
  return html`<a class="chip" href="${routeHref(target)}" data-nav><strong>${kind}</strong><span class="mono">${target}</span></a>`;
}

function networkSwitch(network: Network): Html {
  const seg = (n: Network, label: string) =>
    html`<button type="button" class="seg" data-action="network" data-network="${n}" aria-pressed="${String(network === n)}">${label}</button>`;
  return html`<div class="segmented" role="group" aria-label="Network">${seg("testnet", "Testnet")}${seg("mainnet", "Mainnet")}</div>`;
}

/** Example chips use testnet names only; on mainnet the user enters their own account (no real names in the UI). */
function examples(network: Network): Html {
  return network === "testnet"
    ? html`<div class="chips"><span class="small muted">Try:</span>${chip("Personal", EXAMPLE_ACCOUNT)}${chip("DAO council", EXAMPLE_DAO)}</div>`
    : html`<p class="small muted">Mainnet scans read live data. Enter your own account, or your DAO's <span class="mono">*.sputnik-dao.near</span> name.</p>`;
}

export function renderHome(value: string, error: string | null, network: Network = "testnet"): Html {
  const suffix = network === "mainnet" ? ".near" : ".testnet";
  return html`<section class="hero stack-lg">
      <div class="stack">
        <p class="eyebrow">Key health for NEAR accounts and DAO councils</p>
        <h1 class="display">Key Doctor checks your keys, and stays on call while you sleep.</h1>
        <p class="lead">Enter your own NEAR account, or a Sputnik DAO to check its whole council. Key Doctor reads the public keys on chain, scores the risk with fixed rules, and explains each key. No sign-in, and it never holds anyone's keys.</p>
      </div>
      <form id="check-form" class="card pad stack-sm" novalidate>
        <div class="form-head">
          <label for="target" class="label">NEAR account or DAO</label>
          ${networkSwitch(network)}
        </div>
        <div class="input-row">
          <input id="target" name="target" type="text" class="input mono" value="${value}"
            placeholder="${network === "mainnet" ? "your-dao.sputnik-dao.near" : EXAMPLE_DAO}"
            autocomplete="off" autocapitalize="none" spellcheck="false" required
            aria-describedby="target-hint${error ? " target-error" : ""}"${error ? html` aria-invalid="true"` : ""}>
          <button type="submit" class="btn btn-primary btn-lg">${icon.search()}Check</button>
        </div>
        ${error ? html`<p id="target-error" class="field-error" role="alert">${error}</p>` : ""}
        <p id="target-hint" class="small muted">Checking on <strong>${network}</strong>. A name without a suffix gets <span class="mono">${suffix}</span>; a <span class="mono">.near</span> or <span class="mono">.testnet</span> suffix you type always wins.</p>
        ${examples(network)}
      </form>
    </section>

    <section aria-labelledby="who" class="stack">
      <div class="stack-xs">
        <h2 id="who" class="h2">One account, or a whole council</h2>
        <p class="muted">A council member is an ordinary NEAR account that sits in a DAO's council. Every account gets the same checks; a DAO scan simply checks all its council accounts at once.</p>
      </div>
      <div class="grid-2">
        <div class="card pad stack-sm">
          <div class="icon-title">${icon.user()}<h3 class="h3">Any NEAR account</h3></div>
          <p class="small muted">Yours, or a council member's.</p>
          <ul class="list">
            <li>See every key on the account, with the reason each one matters.</li>
            <li>Find unused, old or too-powerful keys before someone else does.</li>
            <li>See whether the account is ready for post-quantum ML-DSA keys.</li>
            <li>A red alert when a full-access key was added in the last 48 hours.</li>
          </ul>
          <a href="${routeHref(EXAMPLE_ACCOUNT)}" data-nav class="link-strong">Check an account →</a>
        </div>
        <div class="card pad stack-sm">
          <div class="icon-title">${icon.users()}<h3 class="h3">A whole DAO council</h3></div>
          <p class="small muted">Everything on the left for every council account, plus:</p>
          <ul class="list">
            <li>Check all council accounts in one scan, sorted by risk.</li>
            <li>See the voting rules: who approves transfers and how many votes it takes.</li>
            <li>Spot an admin role or a council so small that one account decides.</li>
          </ul>
          <a href="${routeHref(EXAMPLE_DAO)}" data-nav class="link-strong">Check a DAO →</a>
        </div>
      </div>
    </section>

    <section aria-labelledby="how" class="stack">
      <h2 id="how" class="h2">What Key Doctor does</h2>
      <div class="grid-3">
        <div class="card pad stack-sm">${icon.key()}<h3 class="h3">Check keys</h3>
          <p class="muted">Reads every access key of an account, or of each council member, at one block height, and scores the risk with fixed rules.</p></div>
        <div class="card pad stack-sm">${icon.list()}<h3 class="h3">Explain each issue</h3>
          <p class="muted">Each issue comes with what it means and how to fix it. The same text appears in the Telegram bot.</p></div>
        <div class="card pad stack-sm">${icon.bellLarge()}<h3 class="h3">On Call</h3>
          <p class="muted">Subscribe in Telegram with <span class="mono">/watch</span> to get key-change and DAO proposal warnings from the Key Doctor bot.</p>
          <a href="${pageHref("oncall")}" data-nav class="link-strong">How On Call works →</a></div>
        <div class="card pad stack-sm">${icon.send()}<h3 class="h3">Use from your AI agent</h3>
          <p class="muted">Connect Claude Code or Codex to the Key Doctor MCP server. Fixed rules make every verdict, no AI.</p>
          <a href="${pageHref("agents")}" data-nav class="link-strong">Connect an agent →</a></div>
      </div>
    </section>`;
}

const BOT_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["/check <name>", "Scan an account or DAO now. Stores nothing."],
  ["/changes <name>", "Show what changed since the daily baseline."],
  ["/watch <name>", "Subscribe this chat to key-change and proposal alerts."],
  ["/unwatch <name>", "Stop the alerts for a name."],
  ["/list", "List what this chat watches."],
  ["/help", "Show the commands."],
];

export function renderOnCall(): Html {
  const rows = BOT_COMMANDS.map(([c, d]) => html`<tr><td><code class="mono">${c}</code></td><td>${d}</td></tr>`);
  return html`<section class="page-head"><div class="stack-sm grow">
      <p class="eyebrow">On Call</p>
      <h1 class="h1">Key Doctor watches while you sleep</h1>
      <p class="lead">The Telegram bot checks proposals every 15 minutes and diffs keys every day at 02:00 UTC. It only reads public chain data and never signs anything.</p>
    </div></section>
    <section class="card pad stack-sm" aria-labelledby="oc-get"><h2 id="oc-get" class="h2">Alerts you get</h2>${alertLines(true)}</section>
    <section class="card pad stack" aria-labelledby="oc-steps"><h2 id="oc-steps" class="h2">Set it up</h2>
      <ol class="steps">
        <li><span class="step-num" aria-hidden="true">1</span><div class="stack-sm grow"><p class="strong">Open the bot</p>
          <a class="btn btn-primary self-start" href="${BOT_URL}" target="_blank" rel="noopener">${icon.send()}Open @${BOT_USERNAME}</a></div></li>
        <li><span class="step-num" aria-hidden="true">2</span><div class="stack-sm grow"><p class="strong">Send the watch command</p>
          <div class="command-row"><code class="command mono">/watch ${EXAMPLE_DAO}</code>
          <button type="button" class="btn btn-secondary" data-action="copy-command" data-command="/watch ${EXAMPLE_DAO}">${icon.copy()}<span data-copy-label>Copy</span></button></div></div></li>
        <li><span class="step-num" aria-hidden="true">3</span><div class="stack-sm grow"><p class="strong">Add the bot to your council group</p>
          <p class="small muted">Send the same command in the group so every member gets the alerts.</p></div></li>
      </ol></section>
    <section class="stack-sm" aria-labelledby="oc-cmds"><h2 id="oc-cmds" class="h2">Bot commands</h2>
      <div class="card table-scroll"><table class="info-table"><thead><tr><th>Command</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <section class="card pad stack-sm" aria-labelledby="oc-limits"><h2 id="oc-limits" class="h2">Limits</h2>
      <p class="check-line">${icon.info()}<span>A DAO that needs only 1 vote can be warned only after the proposal executes.</span></p>
      <p class="check-line">${icon.info()}<span>An alert can arrive up to one cron interval (15 minutes) late.</span></p>
    </section>`;
}

const AGENT_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["diagnose", "Verdict for an account or DAO council (kd.report_summary.v1). Read-only."],
  ["list_keys", "One row per access key, filterable. Read-only."],
  ["list_proposals", "A DAO's proposals with votes and who still has to vote. Read-only."],
  ["compare", "Diff against the stored baseline (kd.diff.v1). Moves the baseline only with update_baseline: true."],
  ["watch", "Two one-time Telegram links that subscribe a chat (kd.watch_link.v1)."],
];

const AGENT_PROMPTS = [
  `Check the keys of ${EXAMPLE_DAO}`,
  `Which council members of ${EXAMPLE_DAO} have a full-access key?`,
  `What changed on ${EXAMPLE_DAO} since the last baseline?`,
];

function copyRow(command: string): Html {
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
  const rows = Array.from({ length: 3 }, () => html`<div class="skeleton-row"><span></span><span></span><span></span></div>`);
  return html`${breadcrumb(target, from)}
    <section class="page-head">
      <div class="stack-sm grow">
        <h1 class="h1 mono wrap">${target}</h1>
        <p class="meta" role="status">Reading keys from NEAR RPC…</p>
      </div>
    </section>
    <section class="card pad stack-sm" aria-busy="true" aria-label="Loading scan results">${rows}</section>`;
}

export function renderError(target: string, from: string | null, err: KdError, network: Network = "testnet"): Html {
  return html`${breadcrumb(target, from)}
    <section class="page-head"><div class="stack-sm grow"><h1 class="h1 mono wrap">${target}</h1></div></section>
    <section role="alert" class="alert-box">
      ${icon.alert()}
      <div class="stack-sm">
        <p class="alert-title">${err.code === "NOT_FOUND" ? "Account not found" : err.code === "INVALID_TARGET" ? "Invalid name" : "Scan failed"}</p>
        <p>${err.message.en}</p>
        <div class="actions">
          ${err.retryable ? html`<button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Try again</button>` : ""}
          <a href="${homeHref(network)}" data-nav class="btn btn-secondary">Check another account</a>
        </div>
      </div>
    </section>`;
}
