// The owner's two-signature flow of an Agent Budget (docs/final-idea.md §11.10.5), pure. Sign 1 adds a proposal;
// the id comes from that transaction's own return value, never from `get_last_proposal_id` (the last proposal may
// be an agent's request). The page reads the proposal back and compares it with what it built; only a match
// unlocks sign 2, `act_proposal(id, action, proposal)`. The installed Sputnik ignores `proposal`, so this
// read-back is the real protection against approving the wrong proposal.
import { nearToYocto } from "./format.ts";
import { MAX_AGENTS, MAX_LABEL_CHARS } from "./guard-form.ts";
import { guardChangeProposal, type AddProposalArgs } from "./guard-proposals.ts";

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

/** True when the wallet returned an outcome whose transaction failed. No outcome says nothing either way. */
export function outcomeFailed(outcome: unknown): boolean {
  const first = Array.isArray(outcome) ? outcome[0] : outcome;
  return isRecord(first) && isRecord(first.status) && "Failure" in first.status;
}

/**
 * What a vote did, from the proposal's status after it (null when that could not be read). The wallet's success only
 * says the transaction ran: one vote of several leaves the proposal open, and the installed Sputnik sets no callback
 * on a FunctionCall, so a call the Guard refused still shows `Approved`.
 */
export function voteResultText(id: number, action: VoteAction, kind: Record<string, unknown>, status: unknown): string {
  if (status === null) return `The transaction went through, but the page could not read proposal #${id} back. Reload to see its state.`;
  if (status === "InProgress") return `Your vote is in. Proposal #${id} stays open until it has enough votes.`;
  if (status === "Rejected" && action === "VoteReject") return `Done: proposal #${id} rejected.`;
  if (status === "Failed") return `Proposal #${id} was approved but failed on the chain. Nothing changed.`;
  if (status !== "Approved") return `Proposal #${id} is now ${String(status)}.`;
  if ("FunctionCall" in kind) return `Proposal #${id} approved. The DAO does not report whether the call worked: reload and check the change shows.`;
  return `Done: proposal #${id} approved.`;
}

/** The arguments of sign 2 and of Approve / Reject. `proposal` is always passed, even though the installed Sputnik ignores it. */
export function actProposalArgs(p: ConfirmedProposal, action: VoteAction): { id: number; action: VoteAction; proposal: Record<string, unknown> } {
  return { id: p.id, action, proposal: p.kind };
}

/** A Transfer out of the DAO: Withdraw. Amount in yoctoNEAR. */
export function withdrawProposal(receiver: string, yocto: string, nearText: string): Built {
  return {
    description: `Withdraw ${nearText} NEAR to ${receiver}`,
    // `msg: null` as the chain returns it, or the read-back never matches.
    kind: { Transfer: { token_id: "", receiver_id: receiver, amount: yocto, msg: null } },
  };
}

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A NEAR amount typed by the owner: a plain decimal above 0, and not above `maxYocto` when the balance is known. */
export function amountFromForm(text: string, maxYocto: string | null): FormResult<{ yocto: string; near: string }> {
  const yocto = nearToYocto(text);
  if (yocto === null || BigInt(yocto) === 0n) return fail("Enter a NEAR amount above 0, e.g. 1.5.");
  if (maxYocto !== null && BigInt(yocto) > BigInt(maxYocto)) return fail("That is more than the budget balance.");
  return { ok: true, value: { yocto, near: text.trim() } };
}

/** Edit rules: the four limits to a `set_policy` proposal on the Guard. Same bounds as the create form. */
export function rulesProposal(guardId: string, v: Record<string, string>): FormResult<AddProposalArgs> {
  const perTx = nearToYocto(v.maxPerTx ?? "");
  const perDay = nearToYocto(v.maxPerDay ?? "");
  const reserve = nearToYocto(v.minReserve ?? "");
  const pendingText = (v.maxPending ?? "").trim();
  const pending = /^\d+$/.test(pendingText) ? Number(pendingText) : NaN;
  if (perTx === null || perDay === null || BigInt(perTx) === 0n || BigInt(perDay) === 0n) return fail("Per payment and per 24 hours need a NEAR amount above 0.");
  if (reserve === null) return fail("Reserve needs a NEAR amount, 0 or more.");
  if (BigInt(perTx) > BigInt(perDay)) return fail("The per-payment limit cannot be above the 24-hour limit.");
  if (!(pending >= 1 && pending <= 100)) return fail("Waiting requests per agent: a whole number from 1 to 100.");
  const policy = { max_per_tx: perTx, max_per_day: perDay, max_pending_per_agent: pending, min_reserve: reserve };
  return { ok: true, value: guardChangeProposal(guardId, "set_policy", { policy }) };
}

const ACCOUNT_ID = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(testnet|near)$/;

/** Add an agent: an `add_agent` proposal. The account must be a .testnet / .near name and not already an agent. */
export function addAgentProposal(guardId: string, v: Record<string, string>, existing: string[]): FormResult<AddProposalArgs> {
  const account = (v.agent ?? "").trim();
  const label = (v.label ?? "").trim();
  if (!ACCOUNT_ID.test(account) || account.length > 64) return fail("Enter a valid .testnet or .near account name.");
  if (existing.includes(account)) return fail("That account is already an agent.");
  if (account.endsWith(`.${guardId}`)) return fail("That name is an account of this Guard, which keeps any old key. Use an account of your own.");
  if (existing.length >= MAX_AGENTS) return fail(`A Guard takes at most ${MAX_AGENTS} agents. Remove one first.`);
  if (label === "" || [...label].length > MAX_LABEL_CHARS) return fail(`Label: 1 to ${MAX_LABEL_CHARS} characters.`);
  return { ok: true, value: guardChangeProposal(guardId, "add_agent", { account_id: account, label }) };
}

/** Disable, enable or remove one agent; null for an unknown op. */
export function agentProposal(guardId: string, op: string, account: string): AddProposalArgs | null {
  if (op === "remove") return guardChangeProposal(guardId, "remove_agent", { account_id: account });
  if (op === "disable" || op === "enable") return guardChangeProposal(guardId, "set_agent_enabled", { account_id: account, enabled: op === "enable" });
  return null;
}
