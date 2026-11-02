// preflightVerdict (§4.10): pure. Turns an account report into one verdict an agent can gate a transaction on.
import type { PreflightReason, PreflightVerdict, KdPreflight, KdReport, Network } from "./types.ts";
import { MEMBER_ERROR_TEXT, type MemberErrorCode } from "./messages.ts";
import { RULESET_VERSION } from "./rules/thresholds.ts";

// A full-access key added in the last 48 h is the clearest sign of a takeover: stop before signing.
const BLOCK_RULES = new Set(["FA_RECENT"]);

function unreadReason(code: string): PreflightReason {
  const text = MEMBER_ERROR_TEXT[code as MemberErrorCode] ?? MEMBER_ERROR_TEXT.RPC_ERROR;
  return { code, severity: "high", messages: { ...text } };
}

/** review for an account whose keys could not be read at all (the scan threw): the risk is unknown, not low. */
export function preflightUnread(accountId: string, network: Network, code: string): KdPreflight {
  return {
    schema_version: "kd.preflight.v1",
    ruleset_version: RULESET_VERSION,
    network,
    block_height: null,
    verdict: "review",
    account: { id: accountId, status: "note", flags: [], error: code },
    reasons: [unreadReason(code)],
  };
}

/**
 * block: a BLOCK_RULES flag. review: any high or cleanup flag, or keys that could not be read
 * (risk unknown, not low). allow: notes only or no flags.
 */
export function preflightVerdict(report: KdReport): KdPreflight {
  const member = report.members[0];
  if (report.target.type !== "account" || member === undefined) {
    throw new Error("preflightVerdict: the report must be for one account");
  }

  const reasons: PreflightReason[] = member.flags
    .filter((f) => f.severity !== "note")
    .map((f) => ({
      code: f.rule_id,
      severity: f.severity,
      ...(f.public_key !== undefined && { public_key: f.public_key }),
      messages: { vi: `${f.messages.vi.title}. ${f.messages.vi.explain}`, en: `${f.messages.en.title}. ${f.messages.en.explain}` },
    }));
  if (member.error !== null) reasons.unshift(unreadReason(member.error));

  const verdict: PreflightVerdict = member.flags.some((f) => BLOCK_RULES.has(f.rule_id))
    ? "block"
    : reasons.length > 0
      ? "review"
      : "allow";

  return {
    schema_version: "kd.preflight.v1",
    ruleset_version: report.ruleset_version,
    network: report.chain.network,
    block_height: report.chain.block_height,
    verdict,
    account: { id: member.account_id, status: member.status, flags: member.flags.map((f) => f.rule_id), error: member.error },
    reasons,
  };
}
