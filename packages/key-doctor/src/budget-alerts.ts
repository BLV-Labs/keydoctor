// kd.budget_alert.v1 from chain state (§4.11, §9.5). Pure, like diffReports: the keeper passes what it read and
// sends whatever `alerts_sent` does not hold yet, so a message missed in one cycle comes out of the next.
import { planCompletedText, planPausedText, planSkippedText, planStepText, type AlertText } from "./messages.ts";
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
    const step: PlanStepResult = steps.find((s) => s.plan_id === plan.plan_id && s.due === due && s.status === "executed") ?? {
      plan_id: plan.plan_id,
      run,
      status: "executed",
      amount_in: plan.amount_per_run,
      ...(r.proposal_id !== null && { proposal_id: r.proposal_id }),
      executed_at: iso(r.updated_at),
    };
    const totals = { spent: spent(plan, run), received: null, avg_price: null };
    // The last run is one message, not two: UC18 expects one message per run, each with its transaction.
    if (plan.status === "completed" && run === plan.runs_total) {
      out.push(alert("plan_completed", plan, `${run}-${due}`, step, planCompletedText(plan.strategy_id, plan.action, plan.amount_per_run, plan.runs_total, totals.spent), totals));
    } else {
      out.push(alert("plan_step_executed", plan, `${run}-${due}`, step, planStepText(plan.strategy_id, plan.action, plan.amount_per_run, run, plan.runs_total, totals.spent, nextRun(plan)), totals));
    }
  }

  // A skip leaves no trace in the Guard's state, only an event, so only skips the keeper saw can be told.
  for (const s of steps) {
    const plan = byId.get(s.plan_id);
    if (s.status !== "skipped" || !plan) continue;
    out.push(alert("plan_step_skipped", plan, `${s.run}-${s.due}`, s, planSkippedText(plan.strategy_id, s.run, plan.runs_total, s.reason ?? "", nextRun(plan))));
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
