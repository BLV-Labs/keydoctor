import type { Network, ProposalWatchState } from "key-doctor";
import type { D1Database } from "../env.ts";

export async function getProposalState(db: D1Database, target: string, network: Network): Promise<ProposalWatchState | null> {
  const row = await db
    .prepare("SELECT last_proposal_id, pending_json FROM proposal_state WHERE target = ? AND network = ?")
    .bind(target, network)
    .first<{ last_proposal_id: number; pending_json: string }>();
  if (row === null) return null;
  return { last_proposal_id: row.last_proposal_id, pending: JSON.parse(row.pending_json) as ProposalWatchState["pending"] };
}

export async function saveProposalState(db: D1Database, target: string, network: Network, state: ProposalWatchState): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO proposal_state (target, network, last_proposal_id, pending_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(target, network, state.last_proposal_id, JSON.stringify(state.pending), new Date().toISOString())
    .run();
}

/** Moves the DAO to the back of the proposal job's queue without changing its state (a retry after a failed send). */
export async function touchProposalState(db: D1Database, target: string, network: Network): Promise<void> {
  await db.prepare("UPDATE proposal_state SET updated_at = ? WHERE target = ? AND network = ?").bind(new Date().toISOString(), target, network).run();
}
