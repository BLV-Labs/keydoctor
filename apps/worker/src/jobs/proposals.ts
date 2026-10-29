// UC6 proposal watch (§8.5): one checkProposals per DAO, not per subscription.
import { checkProposals, isKdError, resolveTarget, type Network } from "key-doctor";
import type { D1Database, Env } from "../env.ts";
import { getProposalState, saveProposalState } from "../store/proposal-state.ts";
import { alertMessage, deliver } from "./deliver.ts";

export interface JobResult {
  job: "proposals" | "daily";
  targets_checked: number;
  alerts_sent: number;
  alerts: string[];
  errors: string[];
}

const intVar = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Watched DAOs, the least recently checked first (never checked first of all). */
async function watchedDaos(db: D1Database, limit: number): Promise<{ target: string; network: Network }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.target AS target, s.network AS network, MAX(p.updated_at) AS checked
       FROM subscriptions s LEFT JOIN proposal_state p ON p.target = s.target AND p.network = s.network
       WHERE s.target_type = 'dao'
       GROUP BY s.target, s.network
       ORDER BY checked IS NOT NULL, checked, s.target
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ target: string; network: Network }>();
  return results;
}

export async function runProposalJob(env: Env, only?: string): Promise<JobResult> {
  const result: JobResult = { job: "proposals", targets_checked: 0, alerts_sent: 0, alerts: [], errors: [] };
  let daos: { target: string; network: Network }[];
  if (only !== undefined) {
    const t = resolveTarget(only);
    daos = [{ target: t.id, network: t.network }];
  } else {
    daos = await watchedDaos(env.DB, intVar(env.MAX_DAOS_PER_RUN, 5, 1, 50));
  }

  for (const { target, network } of daos) {
    const rpcUrl = network === "mainnet" ? env.RPC_URL_MAINNET : env.RPC_URL_TESTNET;
    let checked;
    try {
      const prev = await getProposalState(env.DB, target, network);
      checked = await checkProposals(target, prev, {
        network,
        ...(rpcUrl && { rpcUrl }),
        newKeyWindowHours: intVar(env.NEW_KEY_WINDOW_HOURS, 48, 1, 24 * 30),
        ...(env.PROPOSAL_UI_URL_TEMPLATE && { proposalUiUrlTemplate: env.PROPOSAL_UI_URL_TEMPLATE }),
      });
    } catch (e) {
      // A throw keeps the old state, so the next run retries from the same point.
      result.errors.push(`${target}: ${isKdError(e) ? e.kd.code : "ERROR"}`);
      continue;
    }
    result.targets_checked += 1;
    result.errors.push(...checked.errors.map((e) => `${target}: ${e}`));
    let retry = false;
    for (const alert of checked.alerts) {
      result.alerts.push(alert.alert_id);
      const d = await deliver(env, alert, alertMessage(env, alert), target, network);
      if (d.delivered) result.alerts_sent += 1;
      if (d.retry) retry = true;
      result.errors.push(...d.errors);
    }
    // A failed send keeps the old state, so the next run rebuilds the alert; alerts_sent drops the ones that did arrive.
    if (!retry) await saveProposalState(env.DB, target, network, checked.state);
  }
  return result;
}
