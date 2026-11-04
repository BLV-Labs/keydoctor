# 0004 — LLM in the yield agent only

- **Date**: 2026-11-04
- **Status**: Accepted 2026-11-04
- **Deciders**: owner, 2026-11-04 (will use an LLM for the yield agent)
- **Story**: [yield agent plan](../stories/epics/yield/plan.md)

## Context

`CLAUDE.md` and `docs/final-idea.md` say no LLM in the product. `docs/ai-classifier-evaluation.md` records that this rule came from build time, not principle, and that a change needs an ADR plus edits to `CLAUDE.md` and the README. The yield agent weighs yield against risk and DAO holdings, and the owner chose to use a model for it.

## Decision

| # | Decision |
|---|---|
| 1 | The yield agent may call an LLM through NEAR AI Cloud. |
| 2 | Scans, rules, `diffReports`, alerts, `preflight` and bot commands other than `/yield` stay LLM-free. This limit is inferred from the request. The owner can widen it. |
| 3 | The model chooses among code-built candidates and writes reasons. Code owns numbers, proposal args and validation. |
| 4 | Any model failure falls back to the rule-ordered list. |
| 5 | The README keeps "No AI" until the feature ships. YD5 updates it and adds the Limitations entry. |
| 6 | Only TEE-tier models may be called. A failure falls back to the rule-ordered list, never to a non-TEE model. |

`docs/final-idea.md` stays unchanged as a spec file. For this one point, this ADR overrides it.

## Alternatives Rejected

- **Rules only, with the LLM on the user's side through MCP:** keeps the old rule, but the owner chose an LLM in the product.
- **LLM across the product:** a model must not decide security conclusions.

## Consequences

- A new secret, `NEAR_AI_API_KEY`, and a new outside dependency.
- `/mcp` is open (ADR 0003), so public calls serve cached output and never spend the key.
- The TEE claim is checked by a script on one real call, not on every request. Limitations must say so.
- The AI classifier idea, if it goes ahead, needs its own ADR and takes the next number.
