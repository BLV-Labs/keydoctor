// Keeper (ADR 0005, GĐ29): calls the plan steps that are due and tells the Budget's chats what happened.
// The Guard decides everything: this job only pays the gas (K2). It never takes an amount, a receiver or a choice.
import { DCA_TESTNET, DEFAULT_RPC_URLS, budgetAlerts, dcaPrice, guardPausedAlert, type KdBudgetAlert, type Plan, type PlanRequest, type PlanStepRecord } from "key-doctor";
import type { Env } from "../env.ts";
import { rpcUrlsFor } from "../core.ts";
import { RpcFailed, createKeeperRpc, guardEvents, loadKeeperKey, panicCode, signCall, swapOutcome, type KeeperKey, type KeeperMethod, type KeeperRpc, type TxOutcome } from "../keeper/near.ts";
import { MAX_MARKS, alertSent, clearSent, markSent, markSentMany, sentIds } from "../store/alerts.ts";
import { acquireLease, releaseLease, saveStep, stepsFor } from "../store/plan-steps.ts";
import { chatsFor } from "../store/subscriptions.ts";
import { sendMessage, type Outgoing } from "../telegram/api.ts";
import { renderBudgetAlert } from "../telegram/render.ts";
import { alertLang, renderFor, sendToChats } from "./deliver.ts";
import { intVar, type JobResult } from "./proposals.ts";

/** Longer than any cycle can run: a cycle that died frees the lease by itself. */
const LEASE_MS = 10 * 60_000;
const PAGE = 50;
/** The free plan allows 50 subrequests per invocation, D1 included. Worst case with these limits: test "stays inside". */
const MAX_SYNCS = 2;
const MAX_SENDS = 4;
/** The newest messages are the ones that can still be unsent; `sentIds` takes 100 ids. */
const MAX_CANDIDATES = 90;
const NEAR = 10n ** 24n;
const NETWORK = "testnet";

export interface KeeperResult extends JobResult {
  skipped: "not_configured" | "locked" | null;
  /** Transactions sent for due steps, whatever the Guard made of them. */
  steps_run: number;
}

interface Config {
  accountId: string;
  secret: string;
  factoryId: string;
  minBalance: bigint;
  maxBalance: bigint;
  maxGuards: number;
  maxSteps: number;
}

interface GuardView {
  guard_id: string;
  dao_id: string;
  ready: boolean;
}

/** What one cycle shares across Guards. */
interface Cycle {
  env: Env;
  cfg: Config;
  rpc: KeeperRpc;
  head: { hash: Uint8Array; timestampNs: bigint };
  result: KeeperResult;
  key: KeeperKey | null;
  nonce: bigint | null;
  canSign: boolean;
  stepsLeft: number;
  syncsLeft: number;
  sendsLeft: number;
}

/** "1.5" NEAR to yocto, or null. */
function parseNear(v: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(v.trim());
  return m ? BigInt(m[1]!) * NEAR + BigInt((m[2] ?? "").padEnd(24, "0")) : null;
}

/** Never the error's own text unless it is known to be safe: nothing from the key may reach a log. */
const reason = (e: unknown): string => (e instanceof RpcFailed || (e instanceof Error && e.message.startsWith("KEEPER_")) ? e.message : "ERROR");

const near = (yocto: bigint): string => (Number(yocto / 10n ** 21n) / 1000).toString();

export async function runKeeperJob(env: Env): Promise<KeeperResult> {
  const result: KeeperResult = { job: "keeper", targets_checked: 0, alerts_sent: 0, alerts: [], errors: [], skipped: null, steps_run: 0 };
  const accountId = env.KEEPER_ACCOUNT_ID ?? "";
  const secret = env.KEEPER_PRIVATE_KEY ?? "";
  const factoryId = env.KEEPER_FACTORY_ID ?? "";
  if (!accountId || !secret || !factoryId) return { ...result, skipped: "not_configured" };
  if (!accountId.endsWith(".testnet") || !factoryId.endsWith(".testnet")) {
    result.errors.push("KEEPER_NOT_TESTNET: ADR 0005 allows the keeper on testnet only");
    return result;
  }
  const minBalance = parseNear(env.KEEPER_MIN_BALANCE ?? "1");
  const maxBalance = parseNear(env.KEEPER_MAX_BALANCE ?? "5");
  if (minBalance === null || maxBalance === null) {
    result.errors.push("KEEPER_BAD_BALANCE_LIMIT: KEEPER_MIN_BALANCE and KEEPER_MAX_BALANCE are amounts in NEAR");
    return result;
  }
  const cfg: Config = {
    accountId,
    secret,
    factoryId,
    minBalance,
    maxBalance,
    maxGuards: intVar(env.KEEPER_MAX_GUARDS_PER_RUN, 3, 1, 3),
    maxSteps: intVar(env.KEEPER_MAX_STEPS_PER_RUN, 3, 0, 3),
  };

  const started = Date.now();
  const cursor = await acquireLease(env.DB, new Date(started).toISOString(), new Date(started + LEASE_MS).toISOString());
  if (cursor === null) return { ...result, skipped: "locked" };
  let next = cursor;
  try {
    next = await runCycle(env, cfg, cursor, result);
  } catch (e) {
    // Nothing was decided here: the Guard keeps the plan due, so the next cycle picks it up.
    result.errors.push(`keeper: ${reason(e)}`);
  } finally {
    await releaseLease(env.DB, new Date().toISOString(), next);
  }
  return result;
}

async function runCycle(env: Env, cfg: Config, cursor: number, result: KeeperResult): Promise<number> {
  const rpc = createKeeperRpc(rpcUrlsFor(env, NETWORK) ?? DEFAULT_RPC_URLS[NETWORK]);
  const head = await rpc.head();
  await checkBalance(env, cfg, await rpc.balance(cfg.accountId), result);

  const page = (from: number) => rpc.view<GuardView[]>(cfg.factoryId, "list_guards", { from_index: from, limit: cfg.maxGuards });
  let guards = await page(cursor);
  // A full last page leaves the cursor at the end of the list. Wrap now, or this cycle checks nothing.
  if (guards.length === 0 && cursor > 0) {
    cursor = 0;
    guards = await page(0);
  }
  const cycle: Cycle = { env, cfg, rpc, head, result, key: null, nonce: null, canSign: true, stepsLeft: cfg.maxSteps, syncsLeft: MAX_SYNCS, sendsLeft: MAX_SENDS };
  for (const g of guards) {
    if (!g.ready) continue;
    result.targets_checked += 1;
    try {
      await runGuard(cycle, g);
    } catch (e) {
      // One broken Guard must not hold back the others.
      result.errors.push(`${g.guard_id}: ${reason(e)}`);
    }
  }
  return guards.length < cfg.maxGuards ? 0 : cursor + guards.length;
}

/** K4: the team tops the account up by hand. Anyone can send NEAR here, so too much is told, not acted on. */
async function checkBalance(env: Env, cfg: Config, balance: bigint, result: KeeperResult): Promise<void> {
  const low = balance < cfg.minBalance;
  if (!low && balance <= cfg.maxBalance) return;
  const alertId = `keeper:${NETWORK}:${cfg.accountId}:${low ? "low" : "high"}_balance:${new Date().toISOString().slice(0, 10)}`;
  if (await alertSent(env.DB, alertId)) return;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.KEEPER_ALERT_CHAT_ID;
  if (!token || !chat) {
    result.errors.push(`${alertId}: no TELEGRAM_BOT_TOKEN or KEEPER_ALERT_CHAT_ID, warning not sent`);
    return;
  }
  const text = low
    ? `Keeper ${cfg.accountId} holds ${near(balance)} NEAR, below the ${near(cfg.minBalance)} NEAR minimum. Top it up or plan steps will stop.`
    : `Keeper ${cfg.accountId} holds ${near(balance)} NEAR, above the ${near(cfg.maxBalance)} NEAR maximum. Move the surplus out.`;
  try {
    await sendMessage(token, chat, { text });
    await markSent(env.DB, { alert_id: alertId });
    result.alerts.push(alertId);
  } catch {
    result.errors.push(`${alertId}: not sent`);
  }
}

/** Key and nonce load on the first signature, so a cycle with nothing due spends no CPU on them. */
async function send(c: Cycle, guardId: string, method: KeeperMethod, args: Record<string, unknown>): Promise<{ tx: TxOutcome; hash: string } | null> {
  let hash = "";
  try {
    c.key ??= await loadKeeperKey(c.cfg.accountId, c.cfg.secret);
    c.nonce = (c.nonce ?? (await c.rpc.nonce(c.cfg.accountId, c.key.publicKey))) + 1n;
    const signed = await signCall(c.key, c.nonce, c.head.hash, guardId, method, args);
    hash = signed.hash;
    return { tx: await c.rpc.sendTx(signed.signed), hash };
  } catch (e) {
    // It may still land, and the local nonce can no longer be trusted. The next cycle reads the chain again.
    c.canSign = false;
    c.result.errors.push(`${guardId}: ${method}${hash && ` ${hash}`}: ${reason(e)}`);
    return null;
  }
}

/** K1: a keeper that sits in the Budget's DAO is a privileged key, so this Guard gets no signature. */
async function keeperInDao(c: Cycle, daoId: string): Promise<boolean> {
  const policy = await c.rpc.view<{ roles: { kind: unknown }[] }>(daoId, "get_policy", {});
  return policy.roles.some((r) => {
    const group = (r.kind as { Group?: unknown } | null)?.Group;
    return Array.isArray(group) && group.includes(c.cfg.accountId);
  });
}

const paysKeeper = (plan: Plan, keeper: string): boolean =>
  (plan.action.type === "transfer" && plan.action.receiver_id === keeper) || (plan.action.type === "call" && plan.action.target === keeper);

/** What the Guard made of a step, from its events. Null when it changed nothing. */
function stepRecord(plan: Plan, due: string, hash: string, tx: TxOutcome, now: string): (PlanStepRecord & { tx_hash: string }) | null {
  const base = { plan_id: plan.plan_id, run: plan.runs_done + 1, amount_in: plan.amount_per_run, tx_hash: hash, executed_at: now, due };
  for (const { event, data } of guardEvents(tx)) {
    if (data?.plan_id !== plan.plan_id) continue;
    if (event === "plan_step_executed") {
      const executed: PlanStepRecord & { tx_hash: string } = { ...base, run: data.run, status: "executed", proposal_id: data.proposal_id };
      if (plan.action.type !== "swap") return executed;
      // The Guard cannot see the exchange's outcome (ADR 0007): the number and the refusal come from Rhea's own receipts.
      const swap = swapOutcome(tx, DCA_TESTNET.exchange, DCA_TESTNET.wrap, plan.action.token_out);
      if (swap === null) return executed;
      if ("failed" in swap) return { ...executed, status: "skipped", reason: swap.failed };
      const price = dcaPrice(plan.amount_per_run, swap.amount_out);
      return { ...executed, amount_out: swap.amount_out, ...(price !== null && { price }) };
    }
    if (event === "plan_step_skipped") return { ...base, run: data.run, status: "skipped", reason: data.reason };
    if (event === "plan_paused") return { ...base, status: "failed", reason: data.code ?? data.reason };
  }
  return null;
}

async function runGuard(c: Cycle, g: GuardView): Promise<void> {
  const { rpc, result, env } = c;
  const now = new Date().toISOString();
  const { paused: guardPaused } = await rpc.view<{ paused: boolean }>(g.guard_id, "get_config", {});
  const readPlans = () => rpc.view<Plan[]>(g.guard_id, "get_plans", { from: 0, limit: PAGE });
  let plans = await readPlans();
  // A Budget with no plan can be paused too.
  if (plans.length === 0) return tell(c, g, [], [], now, guardPaused);
  if (plans.length === PAGE) result.errors.push(`${g.guard_id}: only the first ${PAGE} plans are served`);

  // Read once per Guard, and fail closed: an unreadable policy throws before anything is signed.
  let allowed: boolean | null = null;
  const maySign = async (): Promise<boolean> => {
    if (allowed === null) {
      allowed = !(await keeperInDao(c, g.dao_id));
      if (!allowed) result.errors.push(`${g.guard_id}: K1: keeper is a member of ${g.dao_id}, nothing signed`);
    }
    return allowed;
  };

  const due = plans.filter((p) => p.status === "active" && p.next_run_at !== null && BigInt(p.next_run_at) <= c.head.timestampNs);
  let changed = false;
  for (const plan of due) {
    if (!c.canSign || c.stepsLeft === 0 || !(await maySign())) break;
    if (paysKeeper(plan, c.cfg.accountId)) {
      result.errors.push(`${g.guard_id}: K1: plan ${plan.plan_id} pays the keeper, not called`);
      continue;
    }
    c.stepsLeft -= 1;
    const sent = await send(c, g.guard_id, "execute_plan_step", { plan_id: plan.plan_id });
    if (!sent) break;
    result.steps_run += 1;
    changed = true;
    const code = panicCode(sent.tx.status.Failure);
    // Not due or not active: someone else called first (K2 lets anyone), and that is fine.
    if (code === "PLAN_NOT_DUE" || code === "PLAN_NOT_ACTIVE") continue;
    const step = stepRecord(plan, plan.next_run_at!, sent.hash, sent.tx, now);
    if (step) await saveStep(env.DB, g.guard_id, step);
    else result.errors.push(`${g.guard_id}: plan ${plan.plan_id}: ${code ?? "NO_EVENT"} ${sent.hash}`);
  }
  if (changed) plans = await readPlans();

  const all = await rpc.view<PlanRequest[]>(g.guard_id, "list_requests", { from: 0, limit: PAGE });
  const requests = all.filter((r) => r.plan_id !== null);

  // A step can still fail after its vote, and only `sync_request` shows it. Oldest first.
  for (const r of requests.filter((x) => x.status === "AutoApproved").reverse()) {
    if (!c.canSign || c.syncsLeft === 0 || !(await maySign())) break;
    c.syncsLeft -= 1;
    const sent = await send(c, g.guard_id, "sync_request", { request_id: r.request_id });
    if (!sent) break;
    if (sent.tx.status.SuccessValue) r.status = (JSON.parse(atob(sent.tx.status.SuccessValue)) as { status: string }).status;
    const paused = guardEvents(sent.tx).find((e) => e.event === "plan_paused" && e.data?.plan_id === r.plan_id);
    const plan = plans.find((p) => p.plan_id === r.plan_id);
    if (paused && plan) {
      const run = Number(/ run (\d+)$/.exec(r.memo)?.[1]);
      await saveStep(env.DB, g.guard_id, {
        plan_id: plan.plan_id,
        run,
        status: "failed",
        reason: paused.data.code ?? paused.data.reason,
        amount_in: plan.amount_per_run,
        tx_hash: sent.hash,
        executed_at: now,
        due: r.request_id.split("-").pop()!,
      });
    }
  }

  await tell(c, g, plans, requests, now, guardPaused);
}

const budgetMessage = (env: Env, a: KdBudgetAlert): Outgoing => renderFor(alertLang(env), (l) => renderBudgetAlert(l, a));

/** Send first, record after (§8.5): a crash between the two repeats a message, it never loses one. */
async function tell(c: Cycle, g: GuardView, plans: Plan[], requests: PlanRequest[], now: string, guardPaused: boolean): Promise<void> {
  const { env, result } = c;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const budget = { dao_id: g.dao_id, guard_id: g.guard_id };
  const link = env.DASHBOARD_URL ? { dashboardUrl: env.DASHBOARD_URL } : {};
  const planAlerts = plans.length === 0 ? [] : budgetAlerts({ network: NETWORK, budget, plans, requests, steps: await stepsFor(env.DB, g.guard_id), now, ...link }).slice(-MAX_CANDIDATES);
  // `pause()` is the one owner action with no proposal, so the proposal job cannot see it (§9.5). The row lives as long
  // as the pause: gone after it, the next pause is told. First in line, because it is the warning the plans are not.
  const pause = guardPausedAlert({ network: NETWORK, budget, now, ...link });
  const sent = await sentIds(env.DB, [pause.alert_id, ...planAlerts.map((a) => a.alert_id)]);
  if (!guardPaused && sent.has(pause.alert_id)) await clearSent(env.DB, pause.alert_id);
  const alerts = guardPaused ? [pause, ...planAlerts] : planAlerts;
  const fresh = alerts.filter((a) => !sent.has(a.alert_id));
  if (fresh.length === 0) return;

  const chats = await chatsFor(env.DB, g.dao_id, NETWORK);
  if (chats.length === 0) {
    // Nobody to tell. Recording them keeps a later /watch from replaying the plan's past.
    await markSentMany(env.DB, fresh.slice(0, MAX_MARKS));
    return;
  }
  const done: KdBudgetAlert[] = [];
  for (const alert of fresh.slice(0, MAX_MARKS)) {
    if (c.sendsLeft <= 0) break;
    c.sendsLeft -= chats.length;
    const r = await sendToChats(env.DB, token, alert.alert_id, budgetMessage(env, alert), chats);
    result.errors.push(...r.errors);
    if (r.retry) break;
    done.push(alert);
    if (r.sent > 0) {
      result.alerts_sent += 1;
      result.alerts.push(alert.alert_id);
    }
  }
  await markSentMany(env.DB, done);
}
