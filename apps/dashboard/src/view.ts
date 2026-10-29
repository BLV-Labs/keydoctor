// Pure view data derived from kd.report.v1. Risk text always comes from `messages.en`; nothing here invents a verdict.
import { MEMBER_ERROR_TEXT, type Flag, type KdReport, type KeyInfo, type Member, type Severity, type Status } from "key-doctor";
import { keyAgeMs, plural } from "./format.ts";

/** Same window as the pre-vote warning (`newKeyWindowHours` default, docs/final-idea.md §4.5). */
export const NEW_KEY_WINDOW_HOURS = 48;

const RANK: Record<Status, number> = { ok: 0, note: 1, cleanup: 2, high: 3 };

export const STATUS_LABEL: Record<Status, string> = {
  high: "High risk",
  cleanup: "Cleanup",
  note: "Note",
  ok: "OK",
};

export const bySeverity = <T extends { severity: Severity }>(items: readonly T[]): T[] =>
  items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => RANK[b.item.severity] - RANK[a.item.severity] || a.i - b.i)
    .map((x) => x.item);

/** high → cleanup → note → ok; members that could not be read go last (they carry status "note"). */
export function sortMembers(members: readonly Member[]): Member[] {
  return members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ea = a.m.error !== null;
      const eb = b.m.error !== null;
      if (ea !== eb) return ea ? 1 : -1;
      return RANK[b.m.status] - RANK[a.m.status] || a.i - b.i;
    })
    .map((x) => x.m);
}

export function memberErrorText(code: string): string {
  return (MEMBER_ERROR_TEXT as Record<string, { en: string } | undefined>)[code]?.en ?? MEMBER_ERROR_TEXT.RPC_ERROR.en;
}

export function mainReason(member: Member): string {
  if (member.error !== null) return memberErrorText(member.error);
  const [first, ...rest] = bySeverity(member.flags);
  if (first === undefined) return "No issues found.";
  const others = new Set(rest.map((f) => f.rule_id).filter((id) => id !== first.rule_id)).size;
  return others > 0 ? `${first.messages.en.title} (+${plural(others, "more issue")})` : first.messages.en.title;
}

const isFullAccess = (k: KeyInfo) => k.permission.type === "full_access";

/** "5 Ed25519 / 1", "1 ML-DSA / 0", "2 Ed25519 + 1 ML-DSA / 3". */
export function keyMix(member: Member): string {
  const fa = member.keys.filter(isFullAccess);
  const ed = fa.filter((k) => k.curve === "ed25519").length;
  const ml = fa.filter((k) => k.curve === "ml_dsa").length;
  const other = fa.length - ed - ml;
  const parts = [ed > 0 && `${ed} Ed25519`, ml > 0 && `${ml} ML-DSA`, other > 0 && `${other} other`].filter(Boolean);
  return `${parts.length > 0 ? parts.join(" + ") : "0"} / ${member.counts.function_call}`;
}

/** "5 full-access keys · 1 app key · 0 ML-DSA · 2 keys never used" */
export function countsLine(member: Member): string {
  const c = member.counts;
  return [
    plural(c.full_access, "full-access key"),
    plural(c.function_call, "app key"),
    `${c.ml_dsa} ML-DSA`,
    `${plural(c.unused, "key")} never used`,
  ].join(" · ");
}

export interface FlagGroup {
  rule_id: string;
  severity: Severity;
  count: number;
  title: string;
  explains: string[];
  fixes: string[];
}

/** One card per rule. A rule that fires on several keys becomes one card with each distinct explanation. */
export function groupFlags(flags: readonly Flag[]): FlagGroup[] {
  const groups = new Map<string, FlagGroup>();
  for (const f of bySeverity(flags)) {
    const g = groups.get(f.rule_id);
    if (g === undefined) {
      groups.set(f.rule_id, {
        rule_id: f.rule_id,
        severity: f.severity,
        count: 1,
        title: f.messages.en.title,
        explains: [f.messages.en.explain],
        fixes: [f.messages.en.fix],
      });
    } else {
      g.count += 1;
      if (!g.explains.includes(f.messages.en.explain)) g.explains.push(f.messages.en.explain);
      if (!g.fixes.includes(f.messages.en.fix)) g.fixes.push(f.messages.en.fix);
    }
  }
  return [...groups.values()];
}

/** Titles of the flags that name this key, or the account-level flags its `flag_ids` point to. */
export function keyReasons(key: KeyInfo, member: Member): string[] {
  const titles: string[] = [];
  for (const id of key.flag_ids) {
    const flag =
      member.flags.find((f) => f.rule_id === id && f.public_key === key.public_key) ??
      member.flags.find((f) => f.rule_id === id && f.public_key === undefined);
    const title = flag?.messages.en.title;
    if (title !== undefined && !titles.includes(title)) titles.push(title);
  }
  return titles;
}

export function keyType(key: KeyInfo): { label: string; detail: string | null } {
  const curve = key.curve === "ml_dsa" ? "ML-DSA" : key.curve === "ed25519" ? "Ed25519" : "Unknown curve";
  if (key.permission.type === "full_access") return { label: "Full access", detail: curve };
  return { label: "App key", detail: key.permission.receiver_id };
}

/** Full-access keys added within NEW_KEY_WINDOW_HOURS of the scanned block, newest first. */
export function recentFullAccessKeys(member: Member, blockTimestamp: string): { key: KeyInfo; ageMs: number }[] {
  const windowMs = NEW_KEY_WINDOW_HOURS * 3_600_000;
  return member.keys
    .filter(isFullAccess)
    .map((key) => ({ key, ageMs: keyAgeMs(key, blockTimestamp) }))
    .filter((x): x is { key: KeyInfo; ageMs: number } => x.ageMs !== null && x.ageMs <= windowMs)
    .sort((a, b) => a.ageMs - b.ageMs);
}

/** Council members whose flags include DAO_ADMIN. */
export function adminMembers(report: KdReport): string[] {
  return report.members.filter((m) => m.flags.some((f) => f.rule_id === "DAO_ADMIN")).map((m) => m.account_id);
}

export function keyTotals(report: KdReport): string {
  const s = report.summary;
  const app = report.members.reduce((n, m) => n + m.counts.function_call, 0);
  return [
    plural(s.keys_total, "key"),
    `${formatCount(s.keys_full_access)} full-access`,
    plural(app, "app key"),
    `${formatCount(s.keys_unused)} never used`,
  ].join(", ");
}

const formatCount = (n: number) => n.toLocaleString("en-US");
