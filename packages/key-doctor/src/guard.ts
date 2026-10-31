// guardVerdict (§4.8): pure. Turns an account report into one verdict an agent can gate a transaction on.
import type { GuardReason, GuardVerdict, KdGuard, KdReport } from "./types.ts";
import { MEMBER_ERROR_TEXT, type MemberErrorCode } from "./messages.ts";

// A full-access key added in the last 48 h is the clearest sign of a takeover: stop before signing.
const BLOCK_RULES = new Set(["FA_RECENT"]);

/**
 * block: a BLOCK_RULES flag. review: any high or cleanup flag, or keys that could not be read
 * (risk unknown, not low). allow: notes only or no flags.
 */
export function guardVerdict(report: KdReport): KdGuard {
  const member = report.members[0];
  if (report.target.type !== "account" || member === undefined) {
    throw new Error("guardVerdict: the report must be for one account");
  }

  const reasons: GuardReason[] = member.flags
    .filter((f) => f.severity !== "note")
    .map((f) => ({
      code: f.rule_id,
      severity: f.severity,
      ...(f.public_key !== undefined && { public_key: f.public_key }),
      messages: { vi: `${f.messages.vi.title}. ${f.messages.vi.explain}`, en: `${f.messages.en.title}. ${f.messages.en.explain}` },
    }));
  if (member.error !== null) {
    const text = MEMBER_ERROR_TEXT[member.error as MemberErrorCode] ?? MEMBER_ERROR_TEXT.RPC_ERROR;
    reasons.unshift({ code: member.error, severity: "high", messages: { ...text } });
  }

  const verdict: GuardVerdict = member.flags.some((f) => BLOCK_RULES.has(f.rule_id))
    ? "block"
    : reasons.length > 0
      ? "review"
      : "allow";

  return {
    schema_version: "kd.guard.v1",
    ruleset_version: report.ruleset_version,
    network: report.chain.network,
    block_height: report.chain.block_height,
    verdict,
    account: { id: member.account_id, status: member.status, flags: member.flags.map((f) => f.rule_id), error: member.error },
    reasons,
  };
}
