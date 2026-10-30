// The DAO's newest proposals (C7). Loaded after the council report paints, so a slow proposal read never delays it.
import type { ListProposalsResult, ProposalInfo } from "key-doctor";
import { formatInt, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";

/** The section renderCouncil paints at once; `renderProposals` fills it. */
export const PROPOSALS_ID = "proposals";

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

const kindText = (label: string): string => KIND_TEXT[label] ?? (label.startsWith("policy_") ? "Change policy" : label.replaceAll("_", " "));

function votesLine(p: ProposalInfo): string {
  const approve = Object.values(p.votes).filter((v) => v === "Approve").length;
  const reject = Object.values(p.votes).filter((v) => v === "Reject").length;
  const need = p.approvals_needed === null ? "" : ` of ${formatInt(p.approvals_needed)} needed`;
  return `${formatInt(approve)} approve${need}${reject > 0 ? `, ${formatInt(reject)} reject` : ""}`;
}

/** A token transfer shows the raw amount and token id: NEAR decimals would misstate it. */
function transferLine(t: NonNullable<ProposalInfo["transfer"]>): Html {
  const amount = t.token_id === "" ? html`${t.amount === "?" ? "?" : yoctoToNear(t.amount)} NEAR` : html`${t.amount} units of token <span class="mono wrap">${t.token_id}</span>`;
  return html`<p>Send <strong>${amount}</strong> to <span class="mono wrap">${t.receiver_id}</span></p>`;
}

function row(p: ProposalInfo): Html {
  const voters = Object.entries(p.votes);
  return html`<li class="stack-xs pad">
    <div class="tags">
      <span class="tag">#${String(p.id)}</span><span class="tag">${kindText(p.kind_label)}</span><span class="tag">${p.status}</span>
    </div>
    ${p.transfer ? transferLine(p.transfer) : ""}
    ${p.description === "" ? "" : html`<p class="wrap">${p.description}</p>`}
    <p class="small muted">Proposed by <span class="mono wrap">${p.proposer}</span> · ${votesLine(p)}</p>
    ${voters.length === 0 ? "" : html`<p class="small">${voters.map(([who, v]) => html`<span class="mono wrap">${who}</span> ${v.toLowerCase()}d · `)}</p>`}
    ${p.pending_voters.length === 0 || p.status !== "InProgress" ? "" : html`<p class="small muted">Still to vote: <span class="mono wrap">${p.pending_voters.join(", ")}</span></p>`}
  </li>`;
}

export function proposalsPlaceholder(): Html {
  return html`<section id="${PROPOSALS_ID}" aria-labelledby="proposals-h" class="card flush">
    <div class="card-head"><h2 id="proposals-h" class="h2">Proposals</h2></div>
    <p class="pad muted" role="status">Loading proposals…</p>
  </section>`;
}

/** `result` null = the read failed; the council report above stays valid. */
export function renderProposals(result: ListProposalsResult | null): Html {
  const body =
    result === null
      ? html`<p class="pad muted">Could not read proposals right now. The council report above is not affected.</p>`
      : result.proposals.length === 0
        ? html`<p class="pad muted">${result.total === 0 ? "This DAO has no proposals yet." : "No proposal could be read right now."}</p>`
        : html`<ul class="plain" role="list">${result.proposals.map(row)}</ul>${
            result.errors.length > 0 ? html`<p class="pad small muted">${formatInt(result.errors.length)} proposal(s) could not be read and are not shown.</p>` : ""
          }`;
  const count = result === null ? "" : `Newest ${formatInt(result.proposals.length)} of ${formatInt(result.total)}`;
  return html`<div class="card-head"><h2 id="proposals-h" class="h2">Proposals</h2><span class="muted small">${count}</span></div>${body}`;
}
