// kd.budget_alert.v1 from chain state (§4.11, §9.5). Pure, like diffReports: the keeper passes what it read and
// sends whatever `alerts_sent` does not hold yet, so a message missed in one cycle comes out of the next.
import { dcaPrice } from "./dca.ts";
import { OWNER_TEXT, ownerActionText, planCompletedText, planPausedText, planSkippedText, planStepText, type AlertText, type SwapFigures, type Text } from "./messages.ts";
import type { BudgetAlertKind, KdBudgetAlert, Network, Plan, PlanStepResult } from "./types.ts";

/** The fields of a Guard `RequestRecord` that matter here. */
export interface PlanRequest {
  request_id: string;
  memo: string;
  proposal_id: number | null;
  status: string;
  plan_id: number | null;
  updated_at: string;
}

/** A transaction the keeper sent, as stored in `plan_steps`. `due` is the slot in nanoseconds. */
export interface PlanStepRecord extends PlanStepResult {
  due: string;
}

export interface BudgetAlertInput {
  network: Network;
  budget: { dao_id: string; guard_id: string };
  plans: readonly Plan[];
  /** Newest first, as `list_requests` returns them. */
  requests: readonly PlanRequest[];
  steps: readonly PlanStepRecord[];
  now: string;
  dashboardUrl?: string;
}

const iso = (ns: string): string => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
const spent = (plan: Plan, run: number): string => (BigInt(plan.amount_per_run) * BigInt(run)).toString();
const txLink = (network: Network, hash: string): string => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;
/** A plan that stopped has no next run to announce. */
const nextRun = (plan: Plan): string | null => (plan.status === "active" && plan.next_run_at !== null ? iso(plan.next_run_at) : null);

/**
 * What a DCA plan got back up to `run`, in bigint with the token's 6 decimals. Only runs the keeper saw carry an
 * `amount_out`, so the average divides by the NEAR of those runs alone. Null figures are left out of the message.
 */
function swapFigures(plan: Plan, run: number, step: PlanStepResult, steps: readonly PlanStepRecord[]): SwapFigures {
  const seen = steps.filter((s) => s.plan_id === plan.plan_id && s.status === "executed" && s.run <= run && s.amount_out !== undefined);
  const out = seen.reduce((n, s) => n + BigInt(s.amount_out!), 0n);
  const inn = seen.reduce((n, s) => n + BigInt(s.amount_in), 0n);
  return {
    ...(step.amount_out !== undefined && { amount_out: step.amount_out }),
    ...(step.price !== undefined && { price: step.price }),
    received: seen.length === 0 ? null : out.toString(),
    avg_price: seen.length === 0 ? null : dcaPrice(inn.toString(), out.toString()),
  };
}

export function budgetAlerts(input: BudgetAlertInput): KdBudgetAlert[] {
  const { network, budget, plans, requests, steps, now } = input;
  const dashboard = input.dashboardUrl ? `${input.dashboardUrl.replace(/\/+$/, "")}/?page=budget&dao=${encodeURIComponent(budget.dao_id)}` : "";

  const alert = (kind: BudgetAlertKind, plan: Plan, slot: string, step: PlanStepResult | undefined, messages: AlertText, totals?: KdBudgetAlert["totals"]): KdBudgetAlert => ({
    schema_version: "kd.budget_alert.v1",
    alert_id: `${network}:${budget.dao_id}:${kind}:${plan.plan_id}:${slot}`,
    created_at: now,
    network,
    budget,
    kind,
    severity: kind === "plan_paused" ? "high" : "note",
    muteable: kind === "plan_step_executed",
    plan,
    ...(step && { step }),
    ...(totals && { totals }),
    links: { ...(step?.tx_hash && { tx: txLink(network, step.tx_hash) }), dashboard },
    messages,
  });

  const out: KdBudgetAlert[] = [];
  const byId = new Map(plans.map((p) => [p.plan_id, p]));

  // Every approved step, oldest first. The chain says it ran; `steps` only adds the transaction when the keeper sent it.
  for (const r of [...requests].reverse()) {
    if (r.status !== "AutoApproved" && r.status !== "Executed") continue;
    const plan = r.plan_id === null ? undefined : byId.get(r.plan_id);
    const due = /^plan-\d+-(\d+)$/.exec(r.request_id)?.[1];
    const run = Number(/^plan \d+ run (\d+)$/.exec(r.memo)?.[1]);
    if (!plan || due === undefined || !Number.isInteger(run)) continue;
    // The keeper saw this run's swap refused: the skip message is the one for this run, not a second "done".
    if (steps.some((x) => x.plan_id === plan.plan_id && x.due === due && x.status === "skipped")) continue;
    const step: PlanStepResult = steps.find((s) => s.plan_id === plan.plan_id && s.due === due && s.status === "executed") ?? {
      plan_id: plan.plan_id,
      run,
      status: "executed",
      amount_in: plan.amount_per_run,
      ...(r.proposal_id !== null && { proposal_id: r.proposal_id }),
      executed_at: iso(r.updated_at),
    };
    const swap = plan.action.type === "swap" ? swapFigures(plan, run, step, steps) : undefined;
    const totals = { spent: spent(plan, run), received: swap?.received ?? null, avg_price: swap?.avg_price ?? null };
    // The last run is one message, not two: UC18 expects one message per run, each with its transaction.
    if (plan.status === "completed" && run === plan.runs_total) {
      out.push(alert("plan_completed", plan, `${run}-${due}`, step, planCompletedText(plan.strategy_id, plan.action, plan.amount_per_run, plan.runs_total, totals.spent, swap), totals));
    } else {
      out.push(alert("plan_step_executed", plan, `${run}-${due}`, step, planStepText(plan.strategy_id, plan.action, plan.amount_per_run, run, plan.runs_total, totals.spent, nextRun(plan), swap), totals));
    }
  }

  // A skip leaves no trace in the Guard's state, only an event, so only skips the keeper saw can be told.
  for (const s of steps) {
    const plan = byId.get(s.plan_id);
    if (s.status !== "skipped" || !plan) continue;
    out.push(alert("plan_step_skipped", plan, `${s.run}-${s.due}`, s, planSkippedText(plan.strategy_id, s.run, plan.runs_total, s.reason ?? "", nextRun(plan), plan.amount_per_run)));
  }

  for (const plan of plans) {
    if (plan.status !== "paused" || plan.pause_reason === "owner") continue;
    const failed = steps.filter((s) => s.plan_id === plan.plan_id && s.status === "failed");
    const last = failed[failed.length - 1];
    const run = plan.runs_done + 1;
    out.push(alert("plan_paused", plan, `${run}-${failed.length}`, last, planPausedText(plan.strategy_id, run, plan.runs_total, plan.pause_reason, last?.reason ?? null)));
  }
  return out;
}

export type OwnerActionKind = NonNullable<KdBudgetAlert["owner_action"]>["action"];

/** One thing the owner did. The schema's list has no `enable_agent` or `resume_agents`: those go out as `add_agent` and `pause_agents`, and the text says which. */
export interface OwnerStep {
  action: OwnerActionKind;
  text: Text;
}

export interface OwnerAlertInput {
  network: Network;
  budget: { dao_id: string; guard_id: string };
  /** Never empty. The first step names the alert; every step is in the text, so a second action in a proposal cannot hide. */
  steps: readonly OwnerStep[];
  /** `<proposal_id>:1`, or `pause:open` for the one pause that has no proposal. */
  slot: string;
  proposalId: number | null;
  /** True when the message may only claim the vote (see `ownerActionText`). */
  voteOnly: boolean;
  /** The account that acted, for the Key Check link. */
  account: string | null;
  now: string;
  dashboardUrl?: string;
}

/** High and never muted: this is the warning when the owner's key is stolen (§9.5). */
export function ownerAlert(input: OwnerAlertInput): KdBudgetAlert {
  const { network, budget, steps, proposalId, account } = input;
  const base = input.dashboardUrl?.replace(/\/+$/, "") ?? "";
  const page = account === null ? `page=budget&dao=${encodeURIComponent(budget.dao_id)}` : `target=${encodeURIComponent(account)}`;
  return {
    schema_version: "kd.budget_alert.v1",
    alert_id: `${network}:${budget.dao_id}:budget_owner_action:${input.slot}`,
    created_at: input.now,
    network,
    budget,
    kind: "budget_owner_action",
    severity: "high",
    muteable: false,
    owner_action: { action: steps[0]!.action, proposal_id: proposalId, summary: steps.map((s) => s.text.en).join("; ") },
    links: { dashboard: base ? `${base}/?${page}` : "" },
    messages: ownerActionText(budget.dao_id, steps.map((s) => s.text), input.voteOnly ? proposalId : null),
  };
}

/** `pause()` is a guardian's own call: no proposal, and nothing on chain says who made it. The id stays the same for one whole pause. */
export function guardPausedAlert(input: { network: Network; budget: { dao_id: string; guard_id: string }; now: string; dashboardUrl?: string }): KdBudgetAlert {
  return ownerAlert({ ...input, steps: [{ action: "pause_agents", text: OWNER_TEXT.pauseAgents() }], slot: "pause:open", proposalId: null, voteOnly: false, account: null });
}
