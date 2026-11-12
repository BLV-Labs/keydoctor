// New yield agent (K7), pure. Five steps: Funds, Where, Limits, How it acts, Review. Nothing here signs: creating
// the agent only saves limits in this browser (yield-settings.ts). The first on-chain move, if the treasury is not
// yet registered with Rhea Lend, appears later as the first suggestion on the Yield agent page.
import type { Network } from "key-doctor";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { pageHref } from "./route.ts";
import { pctText, reviewSentence } from "./yield-agent.ts";
import { readAmount, tokenAmount, tokenRaw } from "./yield-proposals.ts";
import { CHECK_EVERY, CHECK_EVERY_TEXT, type CheckEvery, type LimitInput } from "./yield-settings.ts";
import { limitFields, YIELD_TESTNET_ONLY, aprText, type LimitErrors } from "./yield-view.ts";
import { pillarTag } from "./pillars.ts";

export const YIELD_STEPS = ["Funds", "Where", "Limits", "How it acts", "Review"] as const;

/** One treasury the wallet signs for, with its USDC read. Raw units; null when unread. */
export interface FundRow {
  dao: string;
  total: string | null;
  idle: string | null;
  failed: boolean;
}

export type FundsView = { kind: "signed-out" } | { kind: "loading" } | { kind: "failed" } | { kind: "ready"; rows: FundRow[] };

export interface CreateView {
  network: Network;
  step: number;
  funds: FundsView;
  /** The chosen treasury; "" until one is picked. */
  dao: string;
  /** The chosen treasury's idle amount, raw; null when unread. */
  idle: string | null;
  /** Rhea Lend's supply rate today for the token, a fraction, and whether it is test data. */
  rate: { apr: number; testData: boolean } | null;
  token: { symbol: string; decimals: number };
  values: LimitInput;
  every: CheckEvery;
  errors: LimitErrors;
  /** A message under the step, such as a failed read of a typed treasury. */
  notice: string | null;
}

const later = (title: string, reason: string) =>
  html`<div class="preset preset-later" aria-disabled="true"><span class="strong">${title}</span><span class="small muted">${reason}</span></div>`;

function funds(v: CreateView): Html {
  const sym = v.token.symbol;
  const amount = (raw: string | null) => (raw === null ? "unknown" : `${readAmount(raw, v.token.decimals)} ${sym}`);
  const manual = html`<div class="stack-xs"><label class="label" for="yc-dao">Treasury account name</label>
      <input id="yc-dao" name="dao" type="text" class="input mono" value="${v.dao}" placeholder="team.sputnik-v2.testnet" autocomplete="off" autocapitalize="none" spellcheck="false"${v.notice ? html` aria-invalid="true" aria-describedby="yc-notice"` : ""}>
      <p class="small muted">Anyone can set up the page. Only the treasury's council can act on a suggestion.</p></div>`;
  let body: Html;
  if (v.funds.kind === "ready" && v.funds.rows.length > 0) {
    body = html`<div class="presets">${v.funds.rows.map((r) => {
      const detail = `Total ${amount(r.total)} · Idle ${amount(r.idle)}`;
      if (r.failed) return later(r.dao, "Could not read this treasury right now.");
      if (r.idle === null || BigInt(r.idle) === 0n) return later(r.dao, `Nothing idle to put to work. ${detail}`);
      return html`<button type="button" class="preset" data-action="yield-new-pick" data-dao="${r.dao}" aria-pressed="${String(r.dao === v.dao)}"><span class="strong mono wrap">${r.dao}</span><span class="small muted">${detail}</span></button>`;
    })}</div>`;
  } else if (v.funds.kind === "loading") {
    body = html`<p class="muted" role="status">Reading the treasuries your wallet signs for…</p>`;
  } else {
    const why = v.funds.kind === "ready" ? "No treasury found for this wallet. Type its account name." : v.funds.kind === "failed" ? "Could not read your wallet's treasuries. Type the account name." : "Connect a wallet to pick from your treasuries, or type the account name.";
    body = html`<p class="muted">${why}</p>${manual}`;
  }
  return html`<h2 id="yc-h" class="wiz-h" tabindex="-1">Which funds should it watch?</h2>
    <p class="muted">Pick a treasury. It only looks at idle ${sym}; it never touches the rest.</p>
    ${body}`;
}

function where(v: CreateView): Html {
  const rate = v.rate === null ? "No rate to show" : `${aprText(v.rate.apr)} a year today${v.rate.testData ? " · test data" : ""}`;
  return html`<h2 id="yc-h" class="wiz-h" tabindex="-1">Where should idle funds go?</h2>
    <p class="muted">One place for now.</p>
    <div class="presets">
      <button type="button" class="preset" aria-pressed="true"><span class="strong">Rhea Lend: supply ${v.token.symbol}</span><span class="small muted">${rate}</span></button>
      ${later("Auto-stake", "Later")}${later("Swap", "Later")}
    </div>`;
}

function limits(v: CreateView): Html {
  const idleText = v.idle === null ? null : tokenAmount(v.idle, v.token.decimals);
  return html`<h2 id="yc-h" class="wiz-h" tabindex="-1">Set its limits</h2>
    <p class="muted">The agent suggests within these. You can change them any time.</p>
    ${limitFields(v.values, v.errors, v.token.symbol, idleText, "yc")}`;
}

function acts(v: CreateView): Html {
  return html`<h2 id="yc-h" class="wiz-h" tabindex="-1">How should it act?</h2>
    <div class="presets">
      <button type="button" class="preset" aria-pressed="true"><span class="strong">Suggest, I approve each move</span><span class="small muted">It tells the council what to do. Funds move only when the vote passes.</span></button>
      ${later("Move on its own", "No spending limit for tokens exists on chain yet, so every move needs a council vote.")}
    </div>
    <fieldset class="stack-sm plain-field"><legend class="label">Check rates every</legend>
      <div class="presets">${CHECK_EVERY.map((e) => html`<button type="button" class="filter-chip" data-action="yield-new-every" data-every="${e}" aria-pressed="${String(e === v.every)}">${CHECK_EVERY_TEXT[e]}</button>`)}</div></fieldset>
    <p class="small muted">An optional AI ranking with reasons is in Telegram and in the MCP tool <span class="mono">yield_suggestions</span>. It only orders ideas.</p>`;
}

function review(v: CreateView): Html {
  const put = tokenRaw(v.values.maxPut, v.token.decimals) ?? "0";
  const keep = v.values.keepReady.trim() === "" ? "0" : (tokenRaw(v.values.keepReady, v.token.decimals) ?? "0");
  const pct = Number(v.values.minApr.trim() === "" ? "0" : v.values.minApr) / 100;
  const sum = (label: string, body: Html | string) => html`<div class="sum-row"><dt class="muted">${label}</dt><dd>${body}</dd></div>`;
  const sym = v.token.symbol;
  return html`<h2 id="yc-h" class="wiz-h" tabindex="-1">Review and create</h2>
    <p class="strong">${reviewSentence({ maxPut: put, keepReady: keep, minApr: pct, checkEvery: v.every }, v.token.decimals, sym)}</p>
    <dl class="sum-box review-rows">
      ${sum("Treasury", html`<span class="mono wrap">${v.dao}</span>`)}
      ${sum("Where", `Rhea Lend, supply ${sym}`)}
      ${sum("Most it may put to work", `${readAmount(put, v.token.decimals)} ${sym}`)}
      ${sum("Always keep ready", `${readAmount(keep, v.token.decimals)} ${sym}`)}
      ${sum("Only act above", `${pctText(pct)}% a year`)}
      ${sum("How it acts", "Suggests, you approve each move")}
    </dl>
    <p class="banner banner-note">${icon.info()}<span>Nothing is signed and creating costs nothing. If the treasury is not registered with Rhea Lend yet, the first suggestion will be that one-time step.</span></p>`;
}

/** The wizard. Mainnet shows one line instead of the form. */
export function renderYieldCreate(v: CreateView): Html {
  const crumbs = html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${pageHref("my-agents")}" data-nav>Your agents</a><span aria-hidden="true">/</span><span>New yield agent</span></nav>
    <section class="stack-xs">${pillarTag("yield")}<h1 class="h1">New yield agent</h1><p class="muted budget-lead">Watches idle stablecoins and suggests where they could earn. It never moves funds.</p></section>`;
  if (v.network === "mainnet") return html`${crumbs}<p class="banner banner-cleanup">${icon.alertSmall()}<span>${YIELD_TESTNET_ONLY}.</span></p>`;
  const step = Math.min(5, Math.max(1, Math.trunc(v.step) || 1));
  const body = [funds, where, limits, acts, review][step - 1]!(v);
  const canGo = step !== 1 || v.dao !== "" || v.funds.kind !== "ready";
  return html`${crumbs}
    <form id="yield-create-form" class="card setup-card budget-narrow" novalidate aria-label="New yield agent" data-step="${step}">
      <ol class="wiz-steps" aria-label="Steps">${YIELD_STEPS.map((t, i) => html`<li class="wiz-step" data-state="${i + 1 < step ? "done" : i + 1 === step ? "now" : "todo"}"${i + 1 === step ? html` aria-current="step"` : ""}><span class="step-dot">${i + 1 < step ? icon.check() : i + 1}</span><span>${t}</span></li>`)}</ol>
      <div class="wiz-body stack-sm">${body}</div>
      ${v.notice ? html`<p id="yc-notice" class="field-error" role="alert">${v.notice}</p>` : ""}
      <div class="wiz-foot">
        ${step > 1 ? html`<button type="button" class="btn btn-secondary" data-action="yield-new-back">Back</button>` : html`<span></span>`}
        <button type="submit" class="btn btn-primary"${canGo ? "" : " disabled"}>${step < 5 ? "Continue" : "Create agent"}</button>
      </div>
      <div id="yield-create-status" class="small" role="status" aria-live="polite"></div>
    </form>`;
}
