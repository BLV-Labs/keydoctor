# AI classifier for alerts: evaluation notes

Status: **research, nothing implemented.** Written 2026-10-31. To be extended once a NEAR AI Cloud API key is available.

## Why this exists

Idea: after the rules decide an alert, a decision model labels the activity (what kind of proposal, how unusual) so the alert is more precise. The "no LLM in the product" rule was set because of build time, not as a principle, so it can change if the evidence says the model adds value. A change needs an ADR and edits to `CLAUDE.md` and the README.

## Candidate models

Both use the same endpoint and request body, so one client serves both.

| | JEV 1.13 | Sage 1.4 |
|---|---|---|
| Model id | `typesafe/jev-1.13` | `levanto/sage-1.4` |
| Endpoint | `POST https://cloud-api.near.ai/v1/systemone` | same |
| TEE + attestation | No (partner provider, "Incognito") | Yes (NEAR AI enclave) |
| End-to-end encryption | No | No (System One has none) |
| Price | $0.042 / 1M input, $0 output | $0.07 / 1M input, $2 / 1M output |
| Context | 32K, no streaming | 32K, no streaming |

- Auth: `Authorization: Bearer <NEAR AI Cloud API key>`. The key would be a Worker secret (`NEAR_AI_API_KEY`), never committed.
- Request: `{ model, state, questions: { <name>: { type: "noul" | "choice" | "score", instructions } } }`.
- Response: typed answers plus token usage; `choice` and `score` distributions sum to 1. **The full response schema is not documented on the model pages; a live call is needed to confirm it.**
- Receipts: the `X-Generation-Id` header, then `GET /v1/signature/{id}`; `signature_kind` is `gateway` or `provider_tee`.
- Sources: `https://near.ai/models/typesafe/jev-1.13`, `https://near.ai/models/levanto/sage-1.4`.

## Data check: what a proposal already tells the code

Method: read-only RPC against mainnet. 118 recent proposals from 32 randomly picked Sputnik DAOs (of 2043 in the factory). Local analysis only; no mainnet DAO or account names are stored in the repo.

| `kind` | Count | Where the risk signal is |
|---|---|---|
| Transfer | 45 | receiver, amount relative to the DAO balance |
| FunctionCall | 28 | receiver plus method name |
| ChangePolicy | 16 | new policy compared with the current one |
| AddMemberToRole | 15 | role granted, account added |
| Other (Vote, RemoveMemberFromRole, AddBounty, UpgradeSelf, ...) | 14 | the kind itself |

Findings:
- The proposal type is in `kind` for 118 of 118. A model is not needed to classify the type.
- Dangerous FunctionCalls are recognisable by method name: chain-signature `sign` (the most common in the sample, 11), adding a public key to an intents contract, `accept_owner`, `store_contract_self`, `remove_contract_self`. This is a lookup table.
- "Send all funds" transfers appear (one receiver, four proposals). The ratio of amount to DAO balance finds them.
- `description` is short: median 44 characters, maximum 425, one empty; many are only a forum link. Little text for a model to classify.

## Where a model could still add value

One narrow slice: does the free-text `description` match the action in `kind`? Example: the text says "payroll" but the kind adds an admin role. Risks:
- `description` is written by others, so it can carry prompt injection aimed at the model.
- It enriches an alert only; it must not decide whether an alert is sent or its severity.

## Proposed order

1. **Rules first** (deterministic, tested, keeps the no-LLM invariant): a `receiver:method` danger list, transfer-to-balance ratio, admin role grants, ChangePolicy diff. First re-read what `checkProposals` flags today, so nothing is duplicated.
2. **Measure the model** once a key exists: run the same 118 proposals through Sage 1.4 and compare with the rules. Questions: does it catch anything the rules miss? Does it ever disagree with a clear rule result? How often does a hostile `description` change the answer?
3. **Only if step 2 shows value**, integrate behind a flag with these constraints:
   - the model only adds a label and a short reason to an alert; code decides send/no-send and severity;
   - any error, timeout, schema mismatch or detected injection drops the label and sends the rule-based alert;
   - the alert marks the label as AI-assisted; cache results in D1 per proposal; keep the generation id and `signature_kind`;
   - Sage is primary because it has a TEE; JEV is an optional fallback and its labels must say "no TEE".
4. Then write ADR 0004 and update `CLAUDE.md` and the README (Limitations: partner or enclave processing, no E2E; AI-written code list).

## Open items

- A NEAR AI Cloud API key to confirm the response schema and run step 2.
- Exact error and rate-limit behaviour of `/v1/systemone` (not documented on the model pages).
- A decision on whether labels may also appear for key changes in the daily diff (same constraints as above).
