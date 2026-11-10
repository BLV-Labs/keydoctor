# Glossary — Key Doctor

Shared terms used across the harness and codebase.

| Term | Definition |
|---|---|
| **Harness** | The deterministic shell around LLM agents — docs, templates, rules, workflows. |
| **Product delta** | Changes to app code, tests, API, data model, or product docs. |
| **Harness delta** | Changes to docs, templates, validation expectations, or process. |
| **Story packet** | The atomic unit of work: contract, acceptance criteria, design notes, validation expectations. |
| **Risk lane** | Classification (tiny / normal / high-risk) that determines process rigor. |
| **Test matrix** | Living map of behavior to proof — every story has a row. |
| **Decision record** | Durable explanation of why a choice was made. |
| **PPAF** | Perceive → Plan → Act → Feedback — the agent runtime loop. |
| **R.E.S.T** | Reliability, Efficiency, Security, Traceability — the four pillars. |
| **Proof** | Evidence that a behavior works: test output, screenshots, commands. |
| **Agent Guard** | A Rust contract (`contracts/guard`) that joins a Sputnik DAO as a member. It turns an agent's payment request into a DAO transfer proposal and approves it only within the DAO's limits; anything else waits for the council. |
| **Agent Budget** | A Sputnik DAO with one owner, its own Guard and an agent, created in two signatures from the dashboard (`?page=budget`). |
| **Guard factory** | The contract that creates Budgets and serves the Guard code: `keydoctor-guards-v2.testnet` (v1 `keydoctor-guards.testnet` backs `?page=guard`). |
| **Global code** | A contract published once by hash (NEP-591); a Guard points at it with `use_global_contract` and locks 32 bytes instead of a code copy. |
| **Keeper (key)** | The Worker job and its unprivileged testnet key. It signs only `execute_plan_step` and `sync_request`, so it can only trigger due plan steps (ADR 0005). |
| **Plan** | A Guard schedule a DAO proposal starts: Scheduled payout (same amount on a schedule) or DCA swap (NEAR to USDT on Rhea in small steps). The keeper runs the due steps. |
| **Yield suggestion** | Data for the council, not advice: a Rhea Lend supply rate for a DAO stablecoin, capped at the free balance. Code builds it; the council decides and signs. |
| **TEE model** | The LLM that orders yield suggestions and writes their reasons. It runs in a trusted execution environment on NEAR AI Cloud; code validates every number it returns (ADR 0004). |

_(Add project-specific terms as they emerge.)_
