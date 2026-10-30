import type { Flag, KdReport, KeyInfo, Member, Network, Status } from "key-doctor";
import { formatInt, formatThreshold, formatUtc, keyAgeMs, plural, relativeAge, truncateKey, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { icon, statusIcon } from "./icons.ts";
import { routeHref } from "./route.ts";
import {
  STATUS_LABEL,
  adminMembers,
  countsLine,
  groupFlags,
  keyMix,
  keyReasons,
  keyTotals,
  keyType,
  mainReason,
  recentFullAccessKeys,
  sortMembers,
} from "./view.ts";

export const statusPill = (status: Status, small = false): Html =>
  html`<span class="pill pill-${status}${small ? " pill-sm" : ""}">${statusIcon(status, small ? 12 : 14)}${STATUS_LABEL[status]}</span>`;

export function breadcrumb(target: string, from: string | null): Html {
  return html`<nav aria-label="Breadcrumb" class="breadcrumb">
    <a href="./" data-nav>Check</a><span aria-hidden="true">/</span>
    ${from ? html`<a href="${routeHref(from)}" data-nav class="mono">${from}</a><span aria-hidden="true">/</span>` : ""}
    <span class="mono" aria-current="page">${target}</span>
  </nav>`;
}

function scannedLine(report: KdReport): Html {
  return html`<p class="meta">Scanned at block <span class="mono">${formatInt(report.chain.block_height)}</span> · ${formatUtc(
    report.chain.block_timestamp,
  )} · ruleset ${report.ruleset_version}</p>`;
}

function reportActions(cleanupHref?: string): Html {
  return html`<div class="actions">
    <button type="button" class="btn btn-secondary" data-action="rescan">${icon.rescan()}Rescan</button>
    ${cleanupHref ? html`<a class="btn btn-secondary" href="${cleanupHref}" data-nav>Open cleanup plan</a>` : ""}
    <button type="button" class="btn btn-primary" data-action="watch" aria-haspopup="dialog">${icon.bell()}Get Telegram alerts</button>
  </div>`;
}

function tile(label: string, value: string, note: string, tone?: Status): Html {
  return html`<div class="card tile">
    <span class="tile-label">${label}</span>
    <span class="tile-value${tone ? ` tone-${tone}` : ""}">${value}</span>
    <span class="tile-note">${note}</span>
  </div>`;
}

function transferNote(report: KdReport): string {
  const policy = report.dao?.transfer_vote_policy ?? [];
  const first = policy[0];
  if (policy.length !== 1 || first === undefined || first.approvals_needed === null) {
    return policy.length === 0 ? "No role can approve transfers" : "See voting rules below";
  }
  const role = report.dao?.roles.find((r) => r.name === first.role);
  const size = role?.kind === "group" ? new Set(role.members).size : null;
  return size === null
    ? `Transfers need ${first.approvals_needed} votes`
    : `Transfers need ${first.approvals_needed} of ${size} votes`;
}

function memberRow(member: Member, dao: string, network: Network): Html {
  const failed = member.error !== null;
  const reason = failed ? `Couldn't read this account. ${mainReason(member)}` : mainReason(member);
  return html`<li>
    <a class="member-row${failed ? " member-row-error" : ""}" href="${routeHref(member.account_id, dao, network)}" data-nav>
      <span class="cell"><span class="cell-label">Member</span><span class="mono wrap">${member.account_id}</span></span>
      <span class="cell"><span class="cell-label">Status</span>${failed ? statusPill("note", true) : statusPill(member.status, true)}</span>
      <span class="cell"><span class="cell-label">Full-access / app keys</span>${failed ? "Unknown" : keyMix(member)}</span>
      <span class="cell reason"><span class="cell-label">Main reason</span>${reason}</span>
      <span class="cell view" aria-hidden="true">${failed ? "Retry →" : "View →"}</span>
    </a>
  </li>`;
}

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

function limitsCard(report: KdReport): Html {
  const items = [...report.limitations, ...report.errors.map((e) => `Not read: ${e}`)];
  return html`<div class="card pad stack-sm">
    <h2 class="h3">Limits of this scan</h2>
    <ul class="list">
      ${items.map((l) => html`<li>${l}</li>`)}
      <li>A key added and removed between two scans is not seen.</li>
      <li>Fixed rules make every conclusion. No AI is involved.</li>
    </ul>
  </div>`;
}

function votingCard(report: KdReport): Html {
  const dao = report.dao;
  if (dao === undefined) return html``;
  const admins = adminMembers(report);
  return html`<div class="card pad stack-sm">
    <h2 class="h3">Voting rules</h2>
    <dl class="dl">
      ${dao.transfer_vote_policy.length === 0
        ? html`<dt>Role that approves transfers</dt><dd>None</dd>`
        : dao.transfer_vote_policy.map((p) => {
            const role = dao.roles.find((r) => r.name === p.role);
            const size = role?.kind === "group" ? ` (${plural(new Set(role.members).size, "member")})` : role ? ` (${role.kind})` : "";
            return html`<dt>Role that approves transfers</dt><dd>${p.role}${size}</dd>
              <dt>Threshold</dt><dd>${formatThreshold(p.threshold)}${
                p.approvals_needed === null ? ` · ${p.weight_kind}` : ` → ${plural(p.approvals_needed, "vote")}`
              }</dd>`;
          })}
      <dt>Proposal bond</dt><dd>${yoctoToNear(dao.proposal_bond_yocto)} NEAR</dd>
      <dt>Admin in policy</dt><dd>${admins.length === 0 ? "None found" : html`<span class="mono wrap">${admins.join(", ")}</span>`}</dd>
    </dl>
  </div>`;
}

export function renderCouncil(report: KdReport): Html {
  const s = report.summary;
  const dao = report.target.id;
  const members = sortMembers(report.members);
  return html`${breadcrumb(dao, null)}
    <section class="page-head">
      <div class="stack-sm grow">
        <div class="tags"><span class="tag">DAO · ${report.chain.network}</span>${statusPill(s.status)}</div>
        <h1 class="h1 mono wrap">${dao}</h1>
        ${scannedLine(report)}
      </div>
      ${reportActions()}
    </section>

    <section aria-label="Summary" class="tiles">
      ${tile("Council", plural(s.council_size, "member"), transferNote(report))}
      ${tile("High risk", formatInt(s.members_high), "Act now", s.members_high > 0 ? "high" : undefined)}
      ${tile("Needs cleanup", formatInt(s.members_cleanup), "Not urgent, worth doing", s.members_cleanup > 0 ? "cleanup" : undefined)}
      ${tile("Quantum-ready", `${s.pq_ready} / ${s.members_scanned}`, "Has ML-DSA and no Ed25519 full-access key left")}
    </section>

    ${flagCards(report.dao_flags, "DAO issues", "dao-flags-h")}

    <section aria-labelledby="members-h" class="card flush">
      <div class="card-head">
        <h2 id="members-h" class="h2">Council members</h2>
        <span class="muted small">Sorted by risk · ${keyTotals(report)}</span>
      </div>
      <div class="table-scroll">
        <div class="member-table">
          <div class="member-row member-head" aria-hidden="true">
            <span>Member</span><span>Status</span><span>Full-access / app keys</span><span>Main reason</span><span></span>
          </div>
          ${members.length === 0
            ? html`<p class="pad muted">This DAO has no council members to scan.</p>`
            : html`<ul class="plain" role="list">${members.map((m) => memberRow(m, dao, report.chain.network))}</ul>`}
        </div>
      </div>
    </section>

    <section class="two-col">${votingCard(report)}${limitsCard(report)}</section>`;
}

function newKeyAlert(member: Member, report: KdReport, inCouncil: boolean): Html {
  const recent = recentFullAccessKeys(member, report.chain.block_timestamp);
  const newest = recent[0];
  if (newest === undefined) return html``;
  const { key, ageMs } = newest;
  const used = key.use_count === 0 ? "has never been used" : key.use_count === null ? "has an unknown use count" : `has been used ${plural(key.use_count, "time")}`;
  const more = recent.length > 1 ? ` ${plural(recent.length - 1, "more full-access key")} also arrived in the last 48 hours.` : "";
  return html`<section role="alert" class="alert-box">
    ${icon.alert()}
    <div class="stack-xs">
      <p class="alert-title">A full-access key was added ${relativeAge(ageMs).toLowerCase()}</p>
      <p>Key <span class="mono">${truncateKey(key.public_key)}</span> was added at block ${
        key.created.block_height === null ? "unknown" : formatInt(key.created.block_height)
      } and ${used}.${more} If you did not add it, the account may be compromised: remove the key in your wallet${
        inCouncil ? " and tell your council through another channel" : ""
      }.</p>
    </div>
  </section>`;
}

function keyRow(key: KeyInfo, member: Member, report: KdReport): Html {
  const type = keyType(key);
  const reasons = keyReasons(key, member);
  const full = key.permission.type === "full_access";
  return html`<tr>
    <td data-label="Public key"><span class="mono" title="${key.public_key}">${truncateKey(key.public_key)}</span></td>
    <td data-label="Type">${type.label}${type.detail ? html`<br><span class="muted small mono wrap">${type.detail}</span>` : ""}</td>
    <td data-label="Added">${relativeAge(keyAgeMs(key, report.chain.block_timestamp))}</td>
    <td data-label="Uses">${key.use_count === null ? "Unknown" : formatInt(key.use_count)}</td>
    <td data-label="Why it matters">${reasons.length === 0 ? html`<span class="muted">No issue found</span>` : reasons.join(" · ")}</td>
    <td data-label="Action"><button type="button" class="btn btn-secondary" data-action="delete-key" data-key="${key.public_key}" aria-label="${full ? "Delete" : "Revoke"} key ${truncateKey(key.public_key)} with Meteor">${full ? "Delete" : "Revoke"}</button></td>
  </tr>`;
}

function keysTable(member: Member, report: KdReport): Html {
  return html`<section aria-labelledby="keys-h" class="card flush">
    <div class="card-head">
      <h2 id="keys-h" class="h2">Every key</h2>
      <span class="muted small">Key age is estimated from the nonce</span>
    </div>
    ${member.keys.length === 0
      ? html`<p class="pad muted">This account has no access keys.</p>`
      : html`<div class="table-scroll">
          <table class="key-table">
            <thead><tr><th scope="col">Public key</th><th scope="col">Type</th><th scope="col">Added</th><th scope="col">Uses</th><th scope="col">Why it matters</th><th scope="col">Action</th></tr></thead>
            <tbody>${member.keys.map((k) => keyRow(k, member, report))}</tbody>
          </table>
        </div>
        <p class="pad small muted" id="key-status" role="status"></p>`}
    <p class="pad small muted footnote">Revoke and Delete ask Meteor Wallet to remove one key; you approve the transaction there. Key Doctor never signs transactions and never holds keys.</p>
  </section>`;
}

export function renderAccount(report: KdReport, from: string | null): Html {
  const member = report.members[0];
  const id = report.target.id;
  if (member === undefined) return html`${breadcrumb(id, from)}<p>Empty report.</p>`;
  const inCouncil = from !== null;
  return html`${breadcrumb(id, from)}
    <section class="page-head">
      <div class="stack-sm grow">
        <div class="tags"><span class="tag">Account · ${report.chain.network}</span>${statusPill(member.status)}</div>
        <h1 class="h1 mono wrap">${id}</h1>
        <p class="meta">${countsLine(member)}</p>
        ${scannedLine(report)}
        ${from
          ? html`<p class="meta">Opened from the council of <a href="${routeHref(from)}" data-nav class="mono">${from}</a>. The checks are the same for any account.</p>`
          : ""}
      </div>
      ${reportActions(member.error === null ? `${routeHref(id, from, report.chain.network)}&view=cleanup` : undefined)}
    </section>
    ${member.error !== null ? html`<section role="alert" class="alert-box">${icon.alert()}<p>${mainReason(member)}</p></section>` : ""}
    ${newKeyAlert(member, report, inCouncil)}
    ${member.flags.length === 0 && member.error === null
      ? html`<section class="card pad ok-box">${statusIcon("ok", 18)}<p>No issues found for this account.</p></section>`
      : flagCards(member.flags, "Issues found", "flags-h")}
    ${keysTable(member, report)}
    <section class="two-col">${limitsCard(report)}</section>`;
}
