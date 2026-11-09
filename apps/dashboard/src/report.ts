import type { Flag, KdReport, KeyInfo, Member, Network, Status } from "key-doctor";
import { formatInt, formatThreshold, formatUtc, keyAgeMs, plural, relativeAge, truncateKey, yoctoToNear } from "./format.ts";
import { walletBar } from "./session.ts";
import { escape, Html as RawHtml, html, type Html } from "./html.ts";
import { icon, statusIcon } from "./icons.ts";
import { keyDialogShell, viewButton } from "./key-detail.ts";
import { accountVerdict, councilMembers, councilVerdict, keyStatus, memberState, moreIssues, tidyIssues, transferVotes, type Verdict } from "./key-verdict.ts";
import { proposalsPlaceholder } from "./proposals-view.ts";
import { NO_PAGING, pageOf, pager, slicePage, type Paging } from "./paging.ts";
import { budgetHref, pageHref, routeHref } from "./route.ts";
import { avatar, cardHead } from "./ui.ts";
import { STATUS_LABEL, adminMembers, groupFlags, mainReason, recentFullAccessKeys } from "./view.ts";

export const statusPill = (status: Status, small = false): Html =>
  html`<span class="pill pill-${status}${small ? " pill-sm" : ""}">${statusIcon(status, small ? 12 : 14)}${STATUS_LABEL[status]}</span>`;

export function breadcrumb(target: string, from: string | null): Html {
  return html`<nav aria-label="Breadcrumb" class="breadcrumb">
    <a href="./" data-nav>Check</a><span aria-hidden="true">/</span>
    ${from ? html`<a href="${routeHref(from)}" data-nav class="mono">${from}</a><span aria-hidden="true">/</span>` : ""}
    <span class="mono" aria-current="page">${target}</span>
  </nav>`;
}

/** Block height, ruleset and time: technical, so it only ever appears inside "More checks and how this works". */
function scannedLine(report: KdReport): Html {
  return html`<p class="small muted">Read at block <span class="mono">${formatInt(report.chain.block_height)}</span> · ${formatUtc(
    report.chain.block_timestamp,
  )} · ruleset ${report.ruleset_version}</p>`;
}

const checkedLine = (report: KdReport): Html => html`<p class="meta">Checked ${formatUtc(report.chain.block_timestamp)}</p>`;

function flagCards(flags: readonly Flag[], heading: string, id: string): Html {
  const groups = groupFlags(flags);
  if (groups.length === 0) return html``;
  return html`<section aria-labelledby="${id}" class="stack">
    <h2 id="${id}" class="h2">${heading}</h2>
    <div class="flag-grid">
      ${groups.map(
        (g) => html`<article class="card flag flag-${g.severity}">
          <div class="flag-head">${statusPill(g.severity, true)}<span class="mono rule-id">${g.rule_id}${g.count > 1 ? ` × ${g.count}` : ""}</span></div>
          <h3 class="h3">${g.title}</h3>
          ${g.explains.map((e) => html`<p class="muted">${e}</p>`)}
          ${g.fixes.map((f) => html`<p><strong>Fix:</strong> ${f}</p>`)}
        </article>`,
      )}
    </div>
  </section>`;
}

function limitsList(report: KdReport): Html {
  const items = [...report.limitations, ...report.errors.map((e) => `Not read: ${e}`)];
  return html`<ul class="list">
    ${items.map((l) => html`<li>${l}</li>`)}
    <li>A key added and removed between two scans is not seen.</li>
    <li>Fixed rules make every conclusion. No AI is involved.</li>
  </ul>`;
}

/** The fine print: everything with a technical word in it lives in one closed <details>. */
function moreChecks(report: KdReport, member: Member | null): Html {
  const notes = member === null ? [] : groupFlags(member.flags).filter((g) => g.severity === "note");
  return html`<details class="card tech more-checks">
    <summary>More checks and how this works</summary>
    <div class="stack-sm more-body">
      ${notes.map((g) => html`<div><h3 class="h3">${g.title}</h3>${g.explains.map((e) => html`<p class="muted">${e}</p>`)}${g.fixes.map((f) => html`<p><strong>Fix:</strong> ${f}</p>`)}</div>`)}
      ${member === null ? "" : html`<p class="small muted">Key age is estimated from the nonce, so it can be off by a little.</p>`}
      ${scannedLine(report)}
      ${limitsList(report)}
    </div>
  </details>`;
}

/** Connect wallet until a wallet is connected; then an account chip whose menu holds Disconnect. app.ts flips `hidden`. */
export function walletControls(): Html {
  return html`<div class="wallet-ctl" data-wallet-ctl>
    <button type="button" class="btn btn-secondary" data-action="open-wallet" data-wallet-off>${icon.wallet()}<span class="wallet-text">Connect wallet</span></button>
    <details class="wallet-menu" data-wallet-on hidden>
      <summary class="btn btn-secondary wallet-chip" data-wallet-name></summary>
      <div class="wallet-pop"><button type="button" class="btn btn-danger" data-action="disconnect-wallet">Disconnect</button></div>
    </details>
    <span class="small muted" id="wallet-status" role="status"></span>
  </div>`;
}

/** One Revoke (app key) or Delete (full-access key) button; the click reports to the element `statusId`.
 *  Locked (grey, aria-disabled, still clickable to explain why) until app.ts sees the wallet holds the account.
 *  `label` only changes the words on the button; the action and its guards stay the same. */
export function keyButton(k: KeyInfo, statusId: string, label?: string): Html {
  const full = k.permission.type === "full_access";
  const verb = full ? "Delete" : "Revoke";
  return html`<button type="button" class="btn ${full ? "btn-danger" : "btn-warn"} btn-locked self-start" data-action="delete-key" data-key="${k.public_key}" data-status="${statusId}" aria-disabled="true" data-verb="${verb}" aria-label="${verb} key ${truncateKey(k.public_key)} with your wallet">${label ?? verb}</button>`;
}

/** A contract name that may wrap only after a dot, so `app.testnet` never splits as `app.testne` / `t`. */
export function breakAfterDots(name: string): Html {
  return new RawHtml(name.split(".").map(escape).join(".<wbr>"));
}

// ---- K10 Council check ----------------------------------------------------------------------------------------

export const MEMBERS_LIST = "members";
export const KEYS_LIST = "keys";

const stateChip = (tone: Status, label: string): Html => html`<span class="pill pill-sm pill-${tone}">${statusIcon(tone, 12)}${label}</span>`;

function memberRow(member: Member, dao: string, network: Network): Html {
  const failed = member.error !== null;
  const state = memberState(member);
  const reason = failed ? `Could not read this account. ${state.reason}` : state.reason;
  return html`<li>
    <a class="member-row${failed ? " member-row-error" : ""}" href="${routeHref(member.account_id, dao, network)}" data-nav>
      <span class="cell"><span class="cell-label">Member</span><span class="who">${avatar(member.account_id)}<span class="mono wrap">${member.account_id}</span></span></span>
      <span class="cell"><span class="cell-label">State</span>${stateChip(state.tone, state.label)}</span>
      <span class="cell reason reason-${failed ? "high" : member.status}"><span class="cell-label">What we found</span><span class="line-2" title="${reason}">${reason}</span></span>
      <span class="cell view" aria-hidden="true">${failed ? "Retry ›" : "›"}</span>
    </a>
  </li>`;
}

/** The two facts the banner and the side card share: who approves a transfer and how many votes that takes. */
function transferRole(report: KdReport): { role: string; size: number | null } | null {
  const policy = report.dao?.transfer_vote_policy ?? [];
  const first = policy[0];
  if (policy.length !== 1 || first === undefined) return null;
  const role = report.dao?.roles.find((r) => r.name === first.role);
  return { role: first.role, size: role?.kind === "group" ? new Set(role.members).size : null };
}

function moneyCard(report: KdReport): Html {
  const dao = report.dao;
  if (dao === undefined) return html``;
  const admins = adminMembers(report);
  const who = transferRole(report);
  const votes = transferVotes(report);
  return html`<section aria-labelledby="money-h" class="card pad stack-sm">
    <h2 id="money-h" class="h3">How money moves</h2>
    <dl class="dl">
      ${dao.transfer_vote_policy.length === 0
        ? html`<dt>Who can approve a payment</dt><dd>Nobody</dd>`
        : dao.transfer_vote_policy.length > 1
          ? html`<dt>Who can approve a payment</dt><dd>${dao.transfer_vote_policy.map((p) => p.role).join(", ")}</dd><dt>Votes needed</dt><dd>${dao.transfer_vote_policy.map((p) => `${p.role}: ${formatThreshold(p.threshold)}`).join(" · ")}</dd>`
          : html`<dt>Who can approve a payment</dt><dd>${who?.role ?? ""}${who?.size == null ? "" : ` (${plural(who.size, "member")})`}</dd>
            <dt>Votes needed</dt><dd>${votes === null ? formatThreshold(dao.transfer_vote_policy[0]?.threshold) : `${plural(votes, "vote")} (${formatThreshold(dao.transfer_vote_policy[0]?.threshold)})`}</dd>`}
      <dt>Deposit to start a vote</dt><dd>${yoctoToNear(dao.proposal_bond_yocto)} NEAR</dd>
      <dt>Admins</dt><dd>${admins.length === 0 ? "None found" : html`<span class="mono wrap">${admins.join(", ")}</span>`}</dd>
    </dl>
  </section>`;
}

function agentCard(dao: string): Html {
  return html`<section aria-labelledby="agent-link-h" class="card pad stack-sm">
    <h2 id="agent-link-h" class="h3">Let an agent pay from this treasury</h2>
    <p class="muted">Give an AI agent a spending limit. The council stays in charge of the rest.</p>
    <a class="btn btn-secondary self-start" href="${budgetHref(dao)}" data-nav>Set up an agent budget</a>
  </section>`;
}

export function renderCouncil(report: KdReport, paging: Paging = NO_PAGING): Html {
  const dao = report.target.id;
  const v = councilVerdict(report);
  const size = report.summary.council_size;
  const worst = councilMembers(report)[0];
  const worstState = worst === undefined ? "no members" : memberState(worst).label;
  const { items: members, window } = slicePage(councilMembers(report), pageOf(paging, MEMBERS_LIST));
  return html`${breadcrumb(dao, null)}
    <section class="page-head">
      <div class="stack-sm grow">
        <div class="tags"><span class="tag">Council · ${report.chain.network}</span></div>
        <h1 class="h1 mono wrap">${dao}</h1>
        ${checkedLine(report)}
      </div>
    </section>

    <section class="verdict verdict-${v.tone}" aria-labelledby="verdict-h"${v.tone === "high" ? html` role="alert"` : ""}>
      <span class="verdict-icon">${v.tone === "high" ? icon.alert() : statusIcon(v.tone, 22)}</span>
      <div class="verdict-body stack-xs">
        <h2 id="verdict-h" class="verdict-title">${v.title}</h2>
        <p>${v.text}</p>
        <p class="small muted">${plural(size, "member")} · ${v.votesNeeded === null ? "voting rules below" : `${plural(v.votesNeeded, "vote")} needed to move money`} · Worst state: ${worstState}</p>
        <div class="actions">
          <button type="button" class="btn btn-primary" data-action="watch" aria-haspopup="dialog">${icon.bell()}Warn me before votes</button>
          <button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Check again</button>
        </div>
      </div>
    </section>

    <div class="council-cols">
      <div class="council-main stack-lg">
        ${flagCards(report.dao_flags, "Voting rules to review", "dao-flags-h")}

        <section aria-labelledby="members-h" class="card flush" tabindex="-1" data-list-anchor="${MEMBERS_LIST}">
          ${cardHead("members-h", "Members", "Riskiest first")}
          <div class="table-scroll">
            <div class="member-table">
              <div class="member-row member-head" aria-hidden="true">
                <span>Member</span><span>State</span><span>What we found</span><span></span>
              </div>
              ${members.length === 0
                ? html`<p class="pad muted">This council has no members to check.</p>`
                : html`<ul class="plain" role="list">${members.map((m) => memberRow(m, dao, report.chain.network))}</ul>`}
            </div>
          </div>
          ${pager(MEMBERS_LIST, "Members", window, paging)}
        </section>

        ${proposalsPlaceholder()}
      </div>
      <aside class="council-aside stack" aria-label="Rules and next steps">
        ${moneyCard(report)}
        ${agentCard(dao)}
      </aside>
    </div>

    ${moreChecks(report, null)}`;
}

// ---- K6 Key check ---------------------------------------------------------------------------------------------

function verdictBanner(v: Verdict, member: Member, report: KdReport, cleanupHref: string, inCouncil: boolean): Html {
  const reviewLink = html`<a class="btn btn-secondary" href="${cleanupHref}" data-nav>Review</a>`;
  switch (v.kind) {
    case "new-key": {
      const { key, ageMs } = v;
      const used = key.use_count === 0 ? "It has never been used." : key.use_count === null ? "We could not tell if it was used." : `It has been used ${plural(key.use_count, "time")}.`;
      const more = v.more > 0 ? ` ${plural(v.more, "more master key")} also arrived in the last 48 hours.` : "";
      return html`<section role="alert" class="verdict verdict-high" aria-labelledby="verdict-h">
        <span class="verdict-icon">${icon.alert()}</span>
        <div class="verdict-body stack-xs">
          <h2 id="verdict-h" class="verdict-title">A new master key was added ${relativeAge(ageMs).toLowerCase()}</h2>
          <p>Key <span class="mono">${truncateKey(key.public_key)}</span> can do anything with this account. ${used}${more} If this was not you, remove it now${
            inCouncil ? " and tell your council through another channel" : ""
          }.</p>
          <div class="actions">
            ${keyButton(key, "banner-status", "Remove it now")}
            <button type="button" class="btn btn-secondary" data-action="known-key" data-key="${key.public_key}">That was me</button>
          </div>
          <p class="small muted" id="banner-status" role="status"></p>
        </div>
      </section>`;
    }
    case "issue":
      return html`<section role="alert" class="verdict verdict-high" aria-labelledby="verdict-h">
        <span class="verdict-icon">${icon.alert()}</span>
        <div class="verdict-body stack-xs">
          <h2 id="verdict-h" class="verdict-title">${v.issue.title}</h2>
          <p>${v.issue.why}</p>
          <div class="actions">${reviewLink}</div>
        </div>
      </section>`;
    case "tidy":
      return html`<section class="verdict verdict-cleanup" aria-labelledby="verdict-h">
        <span class="verdict-icon">${statusIcon("cleanup", 22)}</span>
        <div class="verdict-body stack-xs">
          <h2 id="verdict-h" class="verdict-title">${plural(v.count, "thing")} to tidy up</h2>
          <p>Nothing is urgent. A few small fixes make this account safer.</p>
          <div class="actions">${reviewLink}</div>
        </div>
      </section>`;
    case "ok":
      return html`<section class="verdict verdict-ok" aria-labelledby="verdict-h">
        <span class="verdict-icon">${statusIcon("ok", 22)}</span>
        <div class="verdict-body stack-xs">
          <h2 id="verdict-h" class="verdict-title">Nothing to fix</h2>
          <p>${member.keys.length === 0 ? "This account has no access keys." : `We checked ${plural(member.keys.length, "key")} and found nothing wrong.`}</p>
        </div>
      </section>`;
  }
}

function tidyRows(v: Verdict, member: Member, cleanupHref: string): Html {
  const issues = moreIssues(v, tidyIssues(member));
  if (issues.length === 0) return html``;
  const heading = v.kind === "tidy" ? "What to tidy up" : `${plural(issues.length, "more thing")} to tidy up`;
  return html`<section aria-labelledby="tidy-h" class="card flush">
    ${cardHead("tidy-h", heading, "Worst first")}
    <ul class="plain divided" role="list">
      ${issues.map(
        (i) => html`<li class="tidy-row">
          <span class="grow-min stack-xs"><span class="tidy-title">${stateChip(i.severity, i.severity === "high" ? "Act now" : "Tidy up")} ${i.title}</span><span class="small muted">${i.why}</span></span>
          <a class="head-link" href="${cleanupHref}" data-nav>Review →</a>
        </li>`,
      )}
    </ul>
  </section>`;
}

/** `isNew`: an unconfirmed full-access key added in the last 48 hours (the one the banner names). Only that row is tinted. */
function keyRow(key: KeyInfo, member: Member, report: KdReport, isNew: boolean): Html {
  const status = keyStatus(key, member, isNew);
  const can =
    key.permission.type === "full_access"
      ? html`Everything (master key)`
      : html`Use <span class="mono wrap-soft">${breakAfterDots(key.permission.receiver_id)}</span>`;
  return html`<tr${isNew ? html` class="row-new"` : ""}>
    <td data-label="Key"><span class="mono" title="${key.public_key}">${truncateKey(key.public_key)}</span></td>
    <td data-label="What it can do">${can}</td>
    <td data-label="Added">${relativeAge(keyAgeMs(key, report.chain.block_timestamp))}</td>
    <td data-label="Uses" class="num">${key.use_count === null ? "Unknown" : formatInt(key.use_count)}</td>
    <td data-label="Status">${stateChip(status.tone, status.label)}</td>
    <td data-label="Action"><div class="actions">${keyButton(key, "key-status")}${viewButton(key)}</div></td>
  </tr>`;
}

function keysTable(member: Member, report: KdReport, paging: Paging, known: ReadonlySet<string>, cleanupHref?: string): Html {
  const bar = walletBar("visitor", report.target.id, null, report.chain.network);
  const { items: keys, window } = slicePage(member.keys, pageOf(paging, KEYS_LIST));
  const fresh = new Set(recentFullAccessKeys(member, report.chain.block_timestamp).map((r) => r.key.public_key).filter((k) => !known.has(k)));
  return html`<section aria-labelledby="keys-h" class="card flush" tabindex="-1" data-list-anchor="${KEYS_LIST}">
    ${cardHead("keys-h", "All keys", plural(member.keys.length, "key"), cleanupHref ? { href: cleanupHref, label: "Clean up keys" } : undefined)}
    ${member.keys.length === 0
      ? html`<p class="pad muted">This account has no access keys.</p>`
      : html`<div class="pad">${bar}</div>
        <div class="table-scroll">
          <table class="key-table">
            <thead><tr><th scope="col">Key</th><th scope="col">What it can do</th><th scope="col">Added</th><th scope="col" class="num">Uses</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
            <tbody>${keys.map((k) => keyRow(k, member, report, fresh.has(k.public_key)))}</tbody>
          </table>
        </div>
        ${pager(KEYS_LIST, "Keys", window, paging)}
        <div class="pad stack-sm">
          <p class="small muted">Revoke and Delete unlock once the connected wallet holds this account. Details always works.</p>
          <p class="small muted" id="key-status" role="status"></p>
        </div>
        ${keyDialogShell()}`}
    <p class="pad small muted footnote">Revoke and Delete ask your wallet (Meteor, Here or HOT) to remove one key; you approve the transaction there. Keyfence never signs transactions and never holds keys.</p>
  </section>`;
}

function linkCards(network: Network): Html {
  return html`<section class="link-cards" aria-label="Next steps">
    <div class="card pad stack-sm">
      <h2 class="h3">Get a Telegram message when this changes</h2>
      <p class="muted">We watch these keys and message you when one is added.</p>
      <button type="button" class="btn btn-secondary self-start" data-action="watch" aria-haspopup="dialog">${icon.bell()}Get Telegram alerts</button>
    </div>
    <div class="card pad stack-sm">
      <h2 class="h3">Let an AI agent pay with a limit</h2>
      <p class="muted">Give an agent a spending budget instead of a key that can do everything.</p>
      <a class="btn btn-secondary self-start" href="${pageHref("budget", network)}" data-nav>Set up an agent budget</a>
    </div>
  </section>`;
}

/** `known`: public keys the viewer marked "That was me" in this browser. They stay in the table but stop driving the banner. */
export function renderAccount(report: KdReport, from: string | null, paging: Paging = NO_PAGING, known: ReadonlySet<string> = new Set()): Html {
  const member = report.members[0];
  const id = report.target.id;
  if (member === undefined) return html`${breadcrumb(id, from)}<p>Empty report.</p>`;
  const inCouncil = from !== null;
  const cleanupHref = `${routeHref(id, from, report.chain.network)}&view=cleanup`;
  const failed = member.error !== null;
  const v = accountVerdict(member, report, known);
  return html`${breadcrumb(id, from)}
    <section class="page-head">
      <div class="stack-sm grow">
        <div class="tags"><span class="tag">Account · ${report.chain.network}</span></div>
        <h1 class="h1 mono wrap">${id}</h1>
        ${checkedLine(report)}
        ${from
          ? html`<p class="meta">Opened from the council of <a href="${routeHref(from)}" data-nav class="mono">${from}</a>. The checks are the same for any account.</p>`
          : ""}
      </div>
      <div class="actions"><button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Check again</button></div>
    </section>
    ${failed
      ? html`<section role="alert" class="alert-box">${icon.alert()}<div class="stack-xs"><p class="alert-title">We could not read this account</p><p>${mainReason(member)} The risk is unknown, not low.</p></div></section>`
      : verdictBanner(v, member, report, cleanupHref, inCouncil)}
    ${failed ? "" : tidyRows(v, member, cleanupHref)}
    ${keysTable(member, report, paging, known, failed ? undefined : cleanupHref)}
    ${linkCards(report.chain.network)}
    ${moreChecks(report, member)}`;
}
