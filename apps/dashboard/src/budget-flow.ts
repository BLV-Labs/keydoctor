// The owner's two-signature flow of an Agent Budget (docs/final-idea.md §11.10.5), pure. Sign 1 adds a proposal;
// the id comes from that transaction's own return value, never from `get_last_proposal_id` (the last proposal may
// be an agent's request). The page reads the proposal back and compares it with what it built; only a match
// unlocks sign 2, `act_proposal(id, action, proposal)`. The installed Sputnik ignores `proposal`, so this
// read-back is the real protection against approving the wrong proposal.
import type { AddProposalArgs } from "./guard-proposals.ts";

export type BudgetFlowCode = "NO_PROPOSAL_ID" | "PROPOSAL_UNREADABLE" | "PROPOSAL_MISMATCH" | "PROPOSAL_NOT_OPEN";

export class BudgetFlowError extends Error {
  readonly code: BudgetFlowCode;
  constructor(code: BudgetFlowCode, message: string) {
    super(message);
    this.name = "BudgetFlowError";
    this.code = code;
  }
}

type Built = AddProposalArgs["proposal"];

export interface ConfirmedProposal {
  id: number;
  /** The proposal kind exactly as the chain returned it: the `proposal` argument of `act_proposal`. */
  kind: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with sorted keys, so two proposals with the same content compare equal whatever the key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * The proposal id `add_proposal` returned, from the final outcome of sign 1 (`status.SuccessValue` is the base64 of
 * the JSON number). A wallet that returns no outcome gives no id: the page then asks the owner to approve the
 * proposal from the pending list, where it shows with its own id.
 */
export function proposalIdFromOutcome(outcome: unknown): number {
  const first = Array.isArray(outcome) ? outcome[0] : outcome;
  const status = isRecord(first) && isRecord(first.status) ? first.status : null;
  const value = status?.SuccessValue;
  if (typeof value === "string" && value !== "") {
    try {
      const n: unknown = JSON.parse(atob(value));
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
    } catch {
      // falls through to the error below
    }
  }
  throw new BudgetFlowError("NO_PROPOSAL_ID", "The wallet did not return the new proposal's id. Find the proposal under Needs you and approve it there.");
}

export function sameProposal(built: Built, onChain: unknown): boolean {
  return isRecord(onChain) && onChain.description === built.description && canonical(onChain.kind) === canonical(built.kind);
}

/** Reads proposal `id` back and checks it is open and is exactly `built`. Throws a BudgetFlowError otherwise. */
export async function confirmProposal(built: Built, id: number, read: (id: number) => Promise<unknown>): Promise<ConfirmedProposal> {
  let raw: unknown;
  try {
    raw = await read(id);
  } catch {
    throw new BudgetFlowError("PROPOSAL_UNREADABLE", `Could not read proposal ${id} back from the chain. Nothing was approved.`);
  }
  if (!isRecord(raw) || raw.id !== id) throw new BudgetFlowError("PROPOSAL_UNREADABLE", `Could not read proposal ${id} back from the chain. Nothing was approved.`);
  if (!sameProposal(built, raw)) {
    throw new BudgetFlowError("PROPOSAL_MISMATCH", `Proposal ${id} on the chain is not the one this page built. Nothing was approved.`);
  }
  if (raw.status !== "InProgress") throw new BudgetFlowError("PROPOSAL_NOT_OPEN", `Proposal ${id} is no longer open (${String(raw.status)}).`);
  return { id, kind: raw.kind as Record<string, unknown> };
}

/** Sign 1 done: the id from its outcome, then the read-back. Resolves to what sign 2 may approve. */
export async function confirmFirstSignature(built: Built, outcome: unknown, read: (id: number) => Promise<unknown>): Promise<ConfirmedProposal> {
  return confirmProposal(built, proposalIdFromOutcome(outcome), read);
}

export type VoteAction = "VoteApprove" | "VoteReject";

/** The arguments of sign 2 and of Approve / Reject. `proposal` is always passed, even though the installed Sputnik ignores it. */
export function actProposalArgs(p: ConfirmedProposal, action: VoteAction): { id: number; action: VoteAction; proposal: Record<string, unknown> } {
  return { id: p.id, action, proposal: p.kind };
}

/** A Transfer out of the DAO: Withdraw. Amount in yoctoNEAR. */
export function withdrawProposal(receiver: string, yocto: string, nearText: string): Built {
  return {
    description: `Withdraw ${nearText} NEAR to ${receiver}`,
    kind: { Transfer: { token_id: "", receiver_id: receiver, amount: yocto } },
  };
}
