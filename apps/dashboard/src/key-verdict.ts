// Plain-words verdicts for the Key check (K6), Clean up (K9) and Council check (K10) pages.
// Pure: every conclusion comes from the report's flags and counts; this file only picks which one to say first
// and in which words. No rule logic lives here.
import type { KdReport, KeyInfo, Member, Status } from "key-doctor";
import { plural } from "./format.ts";
import { groupFlags, keyReasons, keySeverity, mainReason, recentFullAccessKeys, sortMembers, type FlagGroup } from "./view.ts";

/** One thing to tidy up: a flag group in plain words. The new-key flag is not one: the banner owns it. */
export interface Issue {
  id: string;
  severity: "high" | "cleanup";
  title: string;
  why: string;
}

function plainTitle(g: FlagGroup, m: Member): string {
  const n = g.count;
  switch (g.rule_id) {
    case "FA_MANY":
    case "FA_MULTIPLE":
      return `You have ${plural(m.counts.full_access, "master key")}`;
    case "KEY_UNUSED":
      return n === 1 ? "1 key was never used" : `${plural(n, "key")} were never used`;
    case "FA_OLD":
      return `${plural(n, "master key")} ${n === 1 ? "is" : "are"} very old`;
    case "FC_ANY_METHOD":
      return `${plural(n, "app key")} can call any method`;
    case "FC_UNLIMITED_ALLOWANCE":
      return `${plural(n, "app key")} ${n === 1 ? "has" : "have"} no fee limit`;
    case "FC_DEAD_RECEIVER":
      return `${plural(n, "app key")} ${n === 1 ? "points" : "point"} to an app that is gone`;
    default:
      return g.title;
  }
}

/** Worst first. Notes (for example "no post-quantum key") are not things to tidy up; they live under "More checks". */
export function tidyIssues(m: Member): Issue[] {
  return groupFlags(m.flags)
    .filter((g) => g.rule_id !== "FA_RECENT" && (g.severity === "high" || g.severity === "cleanup"))
    .map((g) => ({ id: g.rule_id, severity: g.severity as "high" | "cleanup", title: plainTitle(g, m), why: g.explains[0] ?? "" }));
}

/** Full-access keys added in the last 48 hours that the viewer has not marked as theirs. */
export function freshKeys(m: Member, report: KdReport, known: ReadonlySet<string>): { key: KeyInfo; ageMs: number }[] {
  return recentFullAccessKeys(m, report.chain.block_timestamp).filter((r) => !known.has(r.key.public_key));
}

export type Verdict =
  | { kind: "new-key"; tone: "high"; key: KeyInfo; ageMs: number; more: number }
  | { kind: "issue"; tone: "high"; issue: Issue }
  | { kind: "tidy"; tone: "cleanup"; count: number }
  | { kind: "ok"; tone: "ok" };

/** What the banner says first: an unconfirmed new master key, else the worst high issue, else the tidy-up count, else all clear. */
export function accountVerdict(m: Member, report: KdReport, known: ReadonlySet<string>): Verdict {
  const fresh = freshKeys(m, report, known);
  const newest = fresh[0];
  if (newest !== undefined) return { kind: "new-key", tone: "high", key: newest.key, ageMs: newest.ageMs, more: fresh.length - 1 };
  const issues = tidyIssues(m);
  const top = issues[0];
  if (top?.severity === "high") return { kind: "issue", tone: "high", issue: top };
  if (issues.length > 0) return { kind: "tidy", tone: "cleanup", count: issues.length };
  return { kind: "ok", tone: "ok" };
}

/** The issues listed under the banner: all of them, except the one the banner already shows. */
export const moreIssues = (v: Verdict, issues: readonly Issue[]): Issue[] => (v.kind === "issue" ? issues.slice(1) : [...issues]);

const BROAD = new Set(["FC_ANY_METHOD", "FC_UNLIMITED_ALLOWANCE"]);

/** The pill in the All keys table. One word per key, the most urgent that applies. */
export function keyStatus(key: KeyInfo, m: Member, isNew: boolean): { tone: Status; label: string } {
  if (isNew) return { tone: "high", label: "New, not you?" };
  if (key.use_count === 0) return { tone: "cleanup", label: "Never used" };
  if (key.flag_ids.some((id) => BROAD.has(id))) return { tone: "cleanup", label: "Too broad" };
  const severity = keySeverity(key, m);
  if (severity === "high" || severity === "cleanup") return { tone: severity, label: keyReasons(key, m)[0] ?? "Needs a look" };
  return { tone: "ok", label: "In use" };
}

/** Members' own state in words; an unreadable member is "unknown", never "fine". A member with only notes (for
 *  example no post-quantum key) is OK: notes are not things to fix and live under "More checks". */
export function memberState(m: Member): { tone: Status; label: string; reason: string } {
  if (m.error !== null) return { tone: "note", label: "Could not read", reason: mainReason(m) };
  if (m.status === "high") return { tone: "high", label: "Act now", reason: mainReason(m) };
  if (m.status === "cleanup") return { tone: "cleanup", label: "Tidy up", reason: mainReason(m) };
  return { tone: "ok", label: "OK", reason: "Nothing to fix" };
}

export interface CouncilVerdict {
  tone: "high" | "cleanup" | "ok";
  title: string;
  text: string;
  /** Votes that move money, from the transfer policy; null when the rules are not one simple role. */
  votesNeeded: number | null;
}

export function transferVotes(report: KdReport): number | null {
  const policy = report.dao?.transfer_vote_policy ?? [];
  const first = policy[0];
  return policy.length === 1 && first !== undefined ? first.approvals_needed : null;
}

export function councilVerdict(report: KdReport): CouncilVerdict {
  const members = report.members;
  const high = members.filter((m) => m.error === null && m.status === "high").length;
  const tidy = members.filter((m) => m.error === null && m.status === "cleanup").length;
  const unread = members.filter((m) => m.error !== null).length;
  const votesNeeded = transferVotes(report);
  const base = { votesNeeded };
  if (high > 0) {
    return {
      ...base,
      tone: "high",
      title: high === 1 ? "1 council member needs action now" : `${high} council members need action now`,
      text: "Open the member below. If their account is taken over, they can vote on the treasury.",
    };
  }
  if (tidy > 0) {
    return {
      ...base,
      tone: "cleanup",
      title: `No account is taken over, ${tidy === 1 ? "1 member should" : `${tidy} members should`} tidy up`,
      text: "Nothing here is urgent. Each member can fix their own keys.",
    };
  }
  if (unread > 0) {
    return {
      ...base,
      tone: "cleanup",
      title: unread === 1 ? "1 member could not be read" : `${unread} members could not be read`,
      text: "The risk is unknown, not low. Check again in a moment.",
    };
  }
  if (report.summary.status === "high" || report.summary.status === "cleanup") {
    return { ...base, tone: report.summary.status, title: "The voting rules need a look", text: "Every member's keys look fine, but the rules for this treasury have something to review." };
  }
  return { ...base, tone: "ok", title: "Every member's keys look fine", text: "Nothing to fix right now." };
}

/** Members riskiest first, unreadable ones last (the existing order). */
export const councilMembers = (report: KdReport): Member[] => sortMembers(report.members);

/** One line about the keys of the people who still have to vote. Empty when none of them is a council member we scanned. */
export function voterKeysLine(pending: readonly string[], members: readonly Member[]): string {
  const found = pending.map((p) => members.find((m) => m.account_id === p)).filter((m): m is Member => m !== undefined);
  if (found.length === 0) return "";
  const worry = found.filter((m) => m.error !== null || m.status === "high" || m.status === "cleanup");
  if (worry.length === 0) return "every voter's keys look fine";
  const urgent = worry.some((m) => m.error === null && m.status === "high");
  return `${plural(worry.length, "voter")} ${urgent ? "should check" : "could tidy up"} their keys`;
}
