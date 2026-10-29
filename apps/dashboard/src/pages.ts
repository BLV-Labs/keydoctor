import type { KdError } from "key-doctor";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { breadcrumb } from "./report.ts";
import { BOT_URL, routeHref } from "./route.ts";

export const EXAMPLE_DAO = "kd-demo.sputnik-dao.testnet";
export const EXAMPLE_ACCOUNT = "a.kd-demo.testnet";

export function renderLayout(content: Html): Html {
  return html`<a class="skip" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="container header-inner">
        <a href="./" data-nav class="brand">${icon.logo()}<span>Key Doctor</span></a>
        <nav aria-label="Main" class="main-nav">
          <a href="./" data-nav>Check</a>
          <a href="${BOT_URL}" target="_blank" rel="noopener">Telegram bot</a>
        </nav>
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

export function renderHome(value: string, error: string | null): Html {
  return html`<section class="hero stack-lg">
      <div class="stack">
        <p class="eyebrow">Key health for NEAR accounts and DAO councils</p>
        <h1 class="display">Key Doctor checks your keys, and stays on call while you sleep.</h1>
        <p class="lead">Enter your own NEAR account, or a Sputnik DAO to check its whole council. Key Doctor reads the public keys on chain, scores the risk with fixed rules, and explains each key. No sign-in, and it never holds anyone's keys.</p>
      </div>
      <form id="check-form" class="card pad stack-sm" novalidate>
        <label for="target" class="label">NEAR account or DAO</label>
        <div class="input-row">
          <input id="target" name="target" type="text" class="input mono" value="${value}" placeholder="${EXAMPLE_DAO}"
            autocomplete="off" autocapitalize="none" spellcheck="false" required
            aria-describedby="target-hint${error ? " target-error" : ""}"${error ? html` aria-invalid="true"` : ""}>
          <button type="submit" class="btn btn-primary btn-lg">${icon.search()}Check</button>
        </div>
        ${error ? html`<p id="target-error" class="field-error" role="alert">${error}</p>` : ""}
        <p id="target-hint" class="small muted">The network comes from the name suffix: <span class="mono">.near</span> is mainnet, <span class="mono">.testnet</span> is testnet.</p>
        <div class="chips"><span class="small muted">Try:</span>${chip("Personal", EXAMPLE_ACCOUNT)}${chip("DAO council", EXAMPLE_DAO)}</div>
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
          <p class="muted">Subscribe in Telegram with <span class="mono">/watch</span> to get key-change and DAO proposal warnings from the Key Doctor bot.</p></div>
      </div>
    </section>`;
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

export function renderError(target: string, from: string | null, err: KdError): Html {
  return html`${breadcrumb(target, from)}
    <section class="page-head"><div class="stack-sm grow"><h1 class="h1 mono wrap">${target}</h1></div></section>
    <section role="alert" class="alert-box">
      ${icon.alert()}
      <div class="stack-sm">
        <p class="alert-title">${err.code === "NOT_FOUND" ? "Account not found" : err.code === "INVALID_TARGET" ? "Invalid name" : "Scan failed"}</p>
        <p>${err.message.en}</p>
        <div class="actions">
          ${err.retryable ? html`<button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Try again</button>` : ""}
          <a href="./" data-nav class="btn btn-secondary">Check another account</a>
        </div>
      </div>
    </section>`;
}
