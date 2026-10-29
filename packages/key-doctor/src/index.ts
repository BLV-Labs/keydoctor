// Public API. Implementations land in later phases (docs/final-idea.md §13.3):
// scanDao (GĐ1 S3), diffReports / toSummary (GĐ2), checkProposals (GĐ5).
export type * from "./types.ts";
export { scanAccount } from "./scan.ts";
export { resolveTarget } from "./parse.ts";
export { KdErrorException, isKdError } from "./errors.ts";
export { RULESET_VERSION } from "./rules/thresholds.ts";
