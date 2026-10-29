// UC7 daily key diff (§8.6): scan each watched target, diff with its baseline, move the baseline, alert on changes.
import { diffReports, isKdError, scanTarget, type KdAlert, type KdDiff, type KdReport, type Network } from "key-doctor";
import type { Env } from "../env.ts";
import { latestSnapshot, pruneSnapshots, saveSnapshot } from "../store/snapshots.ts";
import { alertMessage, deliver } from "./deliver.ts";
import type { JobResult } from "./proposals.ts";

const MAX_LINES = 10;

/** kd.alert.v1 daily_changes. The id carries the day and the scanned block, so a second run on the same day with new changes is not taken for a duplicate. */
export function dailyAlert(diff: KdDiff, createdAt: string): KdAlert {
  const target = diff.target.id;
  const day = createdAt.slice(0, 10);
  const lines = (lang: "vi" | "en") => {
    const shown = diff.changes.slice(0, MAX_LINES).map((c) => `- ${c.messages[lang]}`);
    const rest = diff.changes.length - MAX_LINES;
    if (rest > 0) shown.push(lang === "vi" ? `… và ${rest} thay đổi nữa` : `… and ${rest} more changes`);
    return shown.join("\n");
  };
  return {
    schema_version: "kd.alert.v1",
    alert_id: `${diff.network}:${target}:daily_changes:${day}@${diff.to.block_height}:-`,
    created_at: createdAt,
    network: diff.network,
    target,
    severity: diff.summary.highest_severity ?? "note",
    kind: "daily_changes",
    after_the_fact: false,
    diff,
    messages: {
      vi: {
        title: `Thay đổi khóa trong ngày: ${target}`,
        body: lines("vi"),
        action:
          diff.summary.highest_severity === "high"
            ? "Nếu không phải chủ account tự làm, hãy xác minh qua kênh khác ngay."
            : "Xem chi tiết trên dashboard.",
      },
      en: {
        title: `Key changes today: ${target}`,
        body: lines("en"),
        action:
          diff.summary.highest_severity === "high"
            ? "If the account owner did not do this, verify through another channel now."
            : "See the details on the dashboard.",
      },
    },
  };
}

export async function runDailyJob(env: Env, only?: string): Promise<JobResult> {
  const result: JobResult = { job: "daily", targets_checked: 0, alerts_sent: 0, alerts: [], errors: [] };
  const { results } = await env.DB.prepare("SELECT DISTINCT target, network FROM subscriptions ORDER BY target, network").all<{
    target: string;
    network: Network;
  }>();
  const targets = only === undefined ? results : results.filter((r) => r.target === only.trim().toLowerCase());

  for (const { target, network } of targets) {
    const rpcUrl = network === "mainnet" ? env.RPC_URL_MAINNET : env.RPC_URL_TESTNET;
    let diff: KdDiff;
    let curr: KdReport;
    try {
      const baseline = await latestSnapshot(env.DB, target, network);
      curr = await scanTarget(target, { network, ...(rpcUrl && { rpcUrl }) });
      diff = diffReports(baseline, curr);
    } catch (e) {
      result.errors.push(`${target}: ${isKdError(e) ? e.kd.code : "ERROR"}`);
      continue;
    }
    result.targets_checked += 1;
    if (!diff.is_baseline && diff.summary.has_changes) {
      const alert = dailyAlert({ ...diff, baseline_updated: true }, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
      result.alerts.push(alert.alert_id);
      const d = await deliver(env, alert, alertMessage(env, alert), target, network);
      if (d.delivered) result.alerts_sent += 1;
      result.errors.push(...d.errors);
      // Send first: a failed send keeps the old baseline, so the next run reports the same changes again.
      if (d.errors.length > 0) continue;
    }
    // The daily job is one of the two baseline writers.
    await saveSnapshot(env.DB, curr);
    await pruneSnapshots(env.DB, target, network);
  }
  return result;
}
