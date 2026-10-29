// Public API. Implementations land in later phases (docs/final-idea.md §13.3):
// checkProposals (GĐ5).
export type * from "./types.ts";
export { scanAccount, scanDao } from "./scan.ts";
export { resolveTarget } from "./parse.ts";
export { diffReports } from "./diff.ts";
export { toSummary } from "./summary.ts";
export { KdErrorException, isKdError } from "./errors.ts";
export { RULESET_VERSION } from "./rules/thresholds.ts";
export { MEMBER_ERROR_TEXT } from "./messages.ts";
