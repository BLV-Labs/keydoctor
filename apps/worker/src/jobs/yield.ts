// Yield push (YD3, plan Y20): reads Rhea Lend for each opted-in DAO and messages the chats in yield_watches only
// when the top suggestion changes or its APR moves past YIELD_PUSH_APR_DELTA. Send first, record after.
import { isKdError, resolveTarget, shouldPushYield, type KdYieldReport, type Network } from "key-doctor";
import type { Env } from "../env.ts";
import { councilStatus, scanYield } from "../core.ts";
import { getYieldTop, saveYieldTop, touchYieldChecked, watchedYieldDaos, yieldChatsFor, type YieldTop } from "../store/yield.ts";
import { renderYield } from "../telegram/render.ts";
import { yieldAdvice } from "../yield/agent.ts";
import { alertLang, renderFor, sendToChats } from "./deliver.ts";
import { intVar, type JobResult } from "./proposals.ts";

/** The first suggestion in rule order, with its APR. */
export function topOf(r: KdYieldReport): YieldTop | null {
  const s = r.suggestions[0];
  const o = s === undefined ? undefined : r.opportunities.find((x) => x.id === s.opportunity_id);
  return o === undefined ? null : { id: o.id, apr: o.apr };
}

/** A read failure can drop a suggestion, so a report with any error never decides a push. */
export const isComplete = (r: KdYieldReport) => r.errors.length === 0 && r.holdings.every((h) => h.error === null);

export async function runYieldJob(env: Env, only?: string): Promise<JobResult> {
  const result: JobResult = { job: "yield", targets_checked: 0, alerts_sent: 0, alerts: [], errors: [] };
  let daos: { target: string; network: Network }[];
  if (only !== undefined) {
    const t = resolveTarget(only);
    daos = [{ target: t.id, network: t.network }];
  } else {
    // About 10 subrequests per DAO (Rhea reads on two networks and the Rhea API), plus a council scan and one send
    // per chat on a push: one DAO per cycle by default, the least recently checked first.
    daos = await watchedYieldDaos(env.DB, intVar(env.MAX_YIELD_DAOS_PER_RUN, 1, 1, 3));
  }

  for (const { target, network } of daos) {
    let report: KdYieldReport;
    try {
      report = await scanYield({ target, network }, env);
    } catch (e) {
      // A throw keeps the old state, so the next run compares against the same top.
      result.errors.push(`${target}: ${isKdError(e) ? e.kd.code : "ERROR"}`);
      continue;
    }
    result.targets_checked += 1;
    const prev = await getYieldTop(env.DB, target, network);
    const next = topOf(report);
    if (!isComplete(report)) {
      result.errors.push(...report.errors.map((e) => `${target}: ${e}`));
      if (prev !== undefined) await touchYieldChecked(env.DB, target, network);
      continue;
    }
    if (prev === undefined) {
      // First look at this DAO: record what is there, push nothing (the chat saw the report when it opted in).
      await saveYieldTop(env.DB, target, network, next);
      continue;
    }
    if (!shouldPushYield(prev.top, next)) {
      await touchYieldChecked(env.DB, target, network);
      continue;
    }

    const alertId = `yield:${network}:${target}:${next === null ? "none" : `${next.id}@${next.apr}`}`;
    result.alerts.push(alertId);
    const chats = await yieldChatsFor(env.DB, target, network);
    const token = env.TELEGRAM_BOT_TOKEN;
    if (chats.length === 0 || !token) {
      await saveYieldTop(env.DB, target, network, next);
      continue;
    }
    // Only on a push: a council scan costs a subrequest per member, and the model runs only here, never on a quiet
    // cycle (plan Y20).
    const council = await councilStatus({ target, network }, env);
    const advice = await yieldAdvice(report, env, () => null);
    const message = renderFor(alertLang(env), (l) =>
      renderYield(l, report, council, { update: true, advice, ...(env.DASHBOARD_URL && { dashboardUrl: env.DASHBOARD_URL }) }),
    );
    const sent = await sendToChats(env.DB, token, alertId, message, chats);
    if (sent.sent > 0) result.alerts_sent += 1;
    result.errors.push(...sent.errors);
    // A transient failure keeps the old top, so the next run sees the same change and sends again.
    if (sent.retry) await touchYieldChecked(env.DB, target, network);
    else await saveYieldTop(env.DB, target, network, next);
  }
  return result;
}
