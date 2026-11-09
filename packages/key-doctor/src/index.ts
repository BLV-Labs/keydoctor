// Public API (docs/final-idea.md §7).
export type * from "./types.ts";
export { scanAccount, scanDao, scanTarget } from "./scan.ts";
export { resolveTarget } from "./parse.ts";
export { diffReports } from "./diff.ts";
export { toSummary } from "./summary.ts";
export { preflightUnread, preflightVerdict } from "./preflight.ts";
export { checkProposals, listProposals } from "./proposals.ts";
export { KdErrorException, isKdError } from "./errors.ts";
export { RULESET_VERSION } from "./rules/thresholds.ts";
export { MEMBER_ERROR_TEXT } from "./messages.ts";
export { budgetAlerts, guardPausedAlert, type BudgetAlertInput, type PlanRequest, type PlanStepRecord } from "./budget-alerts.ts";
export { DCA_TESTNET, dcaPrice, formatUnits } from "./dca.ts";
export { createRpc, DEFAULT_RPC_URLS, type Rpc } from "./rpc.ts";
export { scanVault, availableAmount, shouldPushYield, type ScanVaultOptions } from "./yield/vault.ts";
export { readRheaLend, filterCandidates, type RheaRow } from "./yield/rhea.ts";
export { bestSupply, parseRheaPool, supplyAprAfter, yearlyEarnings, type RheaPool } from "./yield/rate-model.ts";
export { YIELD_RULESET_VERSION, YIELD_TOKENS, YIELD_LIMITS, YIELD_ADVICE } from "./yield/thresholds.ts";
export { YIELD_TEE_MODELS, YIELD_MODEL_CHAIN, isTeeModel, type TeeModel } from "./yield/models.ts";
export {
  ADVICE_SCHEMA,
  adviceCandidates,
  adviceFresh,
  advicePrompt,
  adviceRequest,
  modelAdvice,
  orderSuggestions,
  ruleAdvice,
  validateAdvice,
  type AdviceCandidate,
} from "./yield/advice.ts";
export { NOT_ADVICE_NOTE, YIELD_REASON_TEXT, YIELD_WARNING_TEXT } from "./yield/messages.ts";
