// The DAO's proposals (C7), newest first, one page at a time. Loaded after the council report paints, so a slow
// proposal read never delays it.
import type { ListProposalsResult, ProposalInfo, Vote } from "key-doctor";
import { clamp } from "./clamp.ts";
import { formatInt, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { statusIcon } from "./icons.ts";
import { NO_PAGING, PAGE_SIZE, pager, pageWindow, type Paging } from "./paging.ts";

/** The section renderCouncil paints at once; `renderProposals` fills it. */
export const PROPOSALS_ID = "proposals";
export const PROPOSALS_LIST = "proposals";

const KIND_TEXT: Record<string, string> = {
  transfer: "Transfer",
  call: "Function call",
  add_member_to_role: "Add member",
  remove_member_from_role: "Remove member",
  config: "Change config",
  policy: "Change policy",
  upgrade_self: "Upgrade DAO",
  upgrade_remote: "Upgrade contract",
};

/** Kinds that change who controls the DAO or its code: the bot warns the council about these too. */
const GOVERNANCE = new Set(["add_member_to_role", "remove_member_from_role", "config", "policy", "upgrade_self", "upgrade_remote"]);

const kindText = (label: string): string => KIND_TEXT[label] ?? (label.startsWith("policy_") ? "Change policy" : label.replaceAll("_", " "));
const isGovernance = (label: string): boolean => GOVERNANCE.has(label) || label.startsWith("policy_");

/** Sputnik statuses → pill tone and a readable label. Unknown statuses stay neutral. */
const STATUS: Record<string, { tone: "info" | "ok" | "high" | "note"; label: string }> = {
  InProgress: { tone: "info", label: "In progress" },
  Approved: { tone: "ok", label: "Approved" },
  Rejected: { tone: "high", label: "Rejected" },
  Removed: { tone: "high", label: "Removed" },
  Failed: { tone: "high", label: "Failed" },
  Expired: { tone: "note", label: "Expired" },
  Moved: { tone: "note", label: "Moved" },
};

const VOTE: Record<Vote, { tone: "ok" | "high"; text: string }> = {
  Approve: { tone: "ok", text: "approved" },
  Reject: { tone: "high", text: "rejected" },
  Remove: { tone: "high", text: "voted to remove" },
};

function statusPill(status: string): Html {
  const s = STATUS[status] ?? { tone: "note" as const, label: status };
  return html`<span class="pill pill-sm pill-${s.tone}">${s.label}</span>`;
}

function votesLine(p: ProposalInfo): string {
  const approve = Object.values(p.votes).filter((v) => v === "Approve").length;
  const reject = Object.values(p.votes).filter((v) => v !== "Approve").length;
  const need = p.approvals_needed === null ? "" : ` of ${formatInt(p.approvals_needed)} needed`;
  return `${formatInt(approve)} approve${need}${reject > 0 ? `, ${formatInt(reject)} against` : ""}`;
}

/** A token transfer shows the raw amount and token id: NEAR decimals would misstate it. */
function transferLine(t: NonNullable<ProposalInfo["transfer"]>): Html {
  const amount = t.token_id === "" ? html`${t.amount === "?" ? "?" : yoctoToNear(t.amount)} NEAR` : html`${t.amount} units of token <span class="mono wrap">${t.token_id}</span>`;
  return html`<p class="wrap">Send <strong>${amount}</strong> to <span class="mono wrap">${t.receiver_id}</span></p>`;
}

function votersLine(voters: [string, Vote][]): Html {
  return clamp(
    html`<span class="small">${voters.map(([who, v], i) => html`${i > 0 ? " · " : ""}<span class="mono">${who}</span> <span class="vote vote-${VOTE[v].tone}">${VOTE[v].text}</span>`)}</span>`,
    2,
  );
}

function row(p: ProposalInfo): Html {
  const voters = Object.entries(p.votes);
  const governance = isGovernance(p.kind_label);
  return html`<li class="stack-xs pad proposal-row">
    <div class="tags">
      <span class="tag mono">#${String(p.id)}</span>
      ${governance
        ? html`<span class="tag tag-warn" title="Changes who controls the DAO or its code">${statusIcon("cleanup", 12)}${kindText(p.kind_label)}<span class="sr-only"> (governance change)</span></span>`
        : html`<span class="tag">${kindText(p.kind_label)}</span>`}
      ${statusPill(p.status)}
    </div>
    ${p.transfer ? transferLine(p.transfer) : ""}
    ${p.description === "" ? "" : clamp(p.description, 3)}
    <p class="small muted">Proposed by <span class="mono wrap">${p.proposer}</span> · ${votesLine(p)}</p>
    ${voters.length === 0 ? "" : votersLine(voters)}
    ${p.pending_voters.length === 0 || p.status !== "InProgress"
      ? ""
      : clamp(html`<span class="small muted">Still to vote: <span class="mono">${p.pending_voters.join(", ")}</span></span>`, 2)}
    ${p.ui_url !== null && /^https:\/\//.test(p.ui_url) ? html`<a class="small strong self-start" href="${p.ui_url}" target="_blank" rel="noopener">Open proposal →</a>` : ""}
  </li>`;
}

const head = (note: string): Html =>
  html`<div class="card-head"><h2 id="proposals-h" class="h2">Proposals</h2><span class="muted small">${note}</span></div>`;

export function proposalsPlaceholder(): Html {
  return html`<section id="${PROPOSALS_ID}" aria-labelledby="proposals-h" class="card flush" tabindex="-1" data-list-anchor="${PROPOSALS_LIST}">
    ${head("Newest first")}
    <p class="pad muted" role="status">Loading proposals…</p>
  </section>`;
}

/** `result` null = the read failed; the council report above stays valid. `page` is the page that was read. */
export function renderProposals(result: ListProposalsResult | null, page = 1, paging: Paging = NO_PAGING): Html {
  if (result === null) return html`${head("Newest first")}<p class="pad muted">Could not read proposals right now. The council report above is not affected.</p>`;
  if (result.total === 0) return html`${head("Newest first")}<p class="pad muted">This DAO has no proposals yet.</p>`;
  const w = pageWindow(result.total, page, PAGE_SIZE);
  const body =
    result.proposals.length === 0
      ? html`<p class="pad muted">No proposal on this page could be read right now.</p>`
      : html`<ul class="plain divided" role="list">${result.proposals.map(row)}</ul>`;
  const unread =
    result.errors.length > 0 && result.proposals.length > 0
      ? html`<p class="pad small muted">${formatInt(result.errors.length)} proposal(s) on this page could not be read and are not shown.</p>`
      : "";
  return html`${head(`Newest first · ${formatInt(result.total)} in total`)}${body}${unread}${pager(PROPOSALS_LIST, "Proposals", w, paging)}`;
}
