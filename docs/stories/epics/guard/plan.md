# Guard implementation plan: GĐ15 to GĐ24

Status: 2026-11-02. Owner accepted D1–D8 as recommended. GĐ15 spike built and passing in the sandbox; testnet run pending (owner, D7). Results: `docs/guard-spike-2026-11-02.md`.

Governing spec: `docs/final-idea.md` §4.8, §4.9, §5.3, §5.4, §11, §12, §13.6, §13.7, §16 (G-Q1 to G-Q5), and `docs/usecase.md` UC9 to UC14 plus appendices E, F, G. This plan does not change the spec. Where the spec conflicts with `CLAUDE.md`, §1 names the conflict and asks the owner.

Not in scope: `preflight` / `FA_RECENT` (PR 43, unrelated to the Guard contract).

## 0. Where things stand

| Item | State |
|---|---|
| Guard spec | Merged into `feat/agent-guard` (commit `d2d6eab`, tusoict). `origin/guard_agent_update` has no newer commits |
| Guard code | GĐ15 spike only: `contracts/guard` (spike contract + sandbox test), `scripts/guard-setup/spike.sh`. No `apps/guard-mcp`, no `demo/invoices` |
| Entry gate (§13.4) | GĐ15 starts only when GĐ0 to GĐ10 meet "done when". Backlog: GĐ0, 1, 2 done; GĐ3, 4, 6, 7, 9 live; GĐ5, 8, 10 built with owner checks still open |
| Cut dates (§13.7) | 11/11: GĐ17 not passing → Guard leaves the submission (experimental, Roadmap). 12/11: GĐ19 + GĐ20 not done → Guard leaves the video |
| Tooling on the dev machine | rustc 1.95, `wasm32-unknown-unknown`, near-cli-rs 0.30.1, cargo-near 0.22. `cargo near build` output loads in the sandbox VM, no toolchain pin needed |
| G-Q1 (answered in sandbox) | Testnet factory DAOs reject `ChangePolicyAddOrUpdateRole`; GĐ18 setup uses `ChangePolicy` with the full current policy. Threshold weight is a string (`"1"`) |

## 1. Owner decisions (block the start)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Start GĐ15 now, while GĐ5/8/10 owner checks are still open? | Yes. Those are owner-only checks; Guard does not touch core code until GĐ20 |
| D2 | Branch base | New branch `feat/guard-contract` from `feat/agent-guard` (it has the spec). Rebase on `main` after PR 43 merges |
| D3 | `CLAUDE.md` says "Never sign transactions or hold keys". Spec §11.6.2 has `apps/guard-mcp` sign with the agent's function-call key on the agent's machine | Accept as the one exception: add a line to `CLAUDE.md` Invariants ("except `apps/guard-mcp`, which runs on the agent owner's machine and signs only `request_transfer` / `sync_request` with a function-call key read from `AGENT_KEY_PATH`; the Worker never holds keys") |
| D4 | GĐ24 (emergency brake, §11.9) puts a function-call key **on the Worker**. That breaks the same invariant for the hosted product | Cut GĐ24 (it is first in the cut order). Keep it in Roadmap |
| D5 | `Member.special` and `KdReport.dao.guards` are new optional fields. Bump `kd.report.v1`? | No bump: additive optional fields, old readers ignore them. Bump `RULESET_VERSION` (new rules). Say so in the commit |
| D6 | Sputnik v2 wasm for sandbox tests (GĐ17) | Download the wasm that testnet DAOs actually run (`near contract download-wasm` from an existing `*.sputnik-v2.testnet` DAO), commit it under `contracts/guard/tests/res/` with its sha256. No download from a third-party mirror |
| D7 | Testnet accounts: `kd-guard.blvlabs.testnet`, `agent1.blvlabs.testnet`, 3 council accounts | Owner creates and funds them. Claude writes the scripts; the owner runs every command that signs with an owner key |
| D8 | Root `pnpm test` and Rust | Keep `pnpm test` JS-only (fast pre-commit). Add `pnpm test:guard` (`cargo test` in `contracts/guard`). README lists both |

## 2. Phases

Timeline assumes start 2/11 and the §13.7 cuts. G0 = must ship if Guard is in the submission.

| GĐ | Dates | Who | Done when (spec) |
|---|---|---|---|
| 15 spike | 2–3/11 | Claude writes, owner signs | Real transfer tx hash on testnet |
| 16 contract | 3–5/11 | Claude | Unit tests pass |
| 17 sandbox | 5–6/11 | Claude | Integration tests pass, gas in README |
| 18 setup script | 7/11 | Claude writes, owner runs | One command builds the demo env |
| 19 Guard MCP | 7–8/11 | Claude | 3 invoices auto, invoice 4 Pending |
| 20 KD integration | 7–9/11 (parallel with 18/19) | Claude | Invoice 4 alerts on Telegram, `/check` shows Guard |
| 21 dashboard | 10/11 | Claude | Dashboard shows the demo Guard |
| 22 Trezu | 10/11 | Owner only (mainnet) | Pending proposal in Trezu queue |
| 23 NEP-141 | if time | Claude | Tests pass |
| 24 brake | cut (D4) | — | — |

### GĐ15: spike (0.5 day)

**What.** A throwaway minimal contract in `contracts/guard` with one method `request_transfer(receiver_id, amount)`: `add_proposal` with the bond attached, then `act_proposal(id, "VoteApprove", kind)` in the callback. Plus `scripts/guard-setup/spike.sh` (near-cli-rs): create a DAO through `sputnik-v2.testnet`, propose the `agent-guard` role (§11.4), approve it with 2 council votes, fund the DAO and the Guard, call the spike.

**Why.** Every later phase rests on three facts that are not verified on chain yet: a contract member can self-approve, the money moves in the same tx (§11.3 #4), and the exact JSON for `threshold` plus whether `ChangePolicyAddOrUpdateRole` exists on testnet factory DAOs (G-Q1). It also measures real gas (G-Q2).

**Toolchain risk.** Rust ≥ 1.82 emits wasm features that the NEAR VM has rejected in the past. Install `cargo-near` and build with `cargo near build`; if it still fails, pin a `rust-toolchain.toml`. Settle this in GĐ15, not later.

```rust
// spike only: the chain the real contract (GĐ16) keeps
pub fn request_transfer(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
    let kind = json!({ "Transfer": { "token_id": "", "receiver_id": receiver_id, "amount": amount, "msg": null } });
    ext_dao::ext(self.dao_id.clone())
        .with_attached_deposit(self.proposal_bond)
        .add_proposal(json!({ "description": "[KD-GUARD] spike", "kind": kind }))
        .then(Self::ext(env::current_account_id()).on_added(kind))
}
```

Output: `docs/guard-spike-2026-11-0X.md` with tx hashes, gas, threshold JSON, policy proposal kind used. Answers G-Q1, G-Q2.

### GĐ16: full contract (1.5–2 days)

**What.** `contracts/guard` per §11.5: state (§11.5.2), every method in §11.5.3, the check order and error codes in §11.5.4, Auto/Pending reasons, the cross-contract flow (§11.5.5), the description format (§11.5.6), the rolling 24 h window with refunds (§11.5.7), bond handling (§11.5.8), NEP-297 events (§11.5.9), size limits (§11.5.10). `kd_guard_info()` view.

**Why.** It holds the power to approve spending up to `max_per_day`. §11.8: it must have the densest tests in the repo.

Layout:

```
contracts/guard/
  Cargo.toml            # near-sdk 5.x, pinned
  src/lib.rs            # Guard, #[near] impl, DAO-only config methods
  src/policy.rs         # pure decide(): checks 1–7 and Auto/Pending reasons (unit-testable without a chain)
  src/dao.rs            # #[ext_contract] for add_proposal, act_proposal, get_proposal, get_policy
  src/events.rs         # NEP-297 kd_guard 1.0.0
  src/types.rs          # GuardPolicy, AgentInfo, WhitelistEntry, RequestRecord, Decision, RequestStatus
```

Keep the decision pure so most tests run without callbacks:

```rust
pub fn decide(p: &GuardPolicy, wl: Option<&WhitelistEntry>, spent: u128, amount: u128) -> (Decision, Vec<&'static str>) {
    let mut r = vec![];
    if wl.is_none() { r.push("NOT_WHITELISTED"); }
    if amount > p.max_per_tx.0 { r.push("OVER_PER_TX"); }
    if let Some(cap) = wl.and_then(|w| w.max_per_tx) { if amount > cap.0 { r.push("OVER_RECIPIENT_LIMIT"); } }
    if spent + amount > p.max_per_day.0 { r.push("OVER_DAILY_LIMIT"); }
    (if r.is_empty() { Decision::Auto } else { Decision::Pending }, r)
}
```

Unit tests (each must fail if its rule is removed): each of the 7 error codes, each of the 4 reasons alone and combined, window reset at exactly 24 h, refund on `add_proposal` failure / `act_proposal` failure / sync `Failed` within the same window and **no** refund after the window rolled, `pending` counter up/down, DAO-only config (stranger panics), guardian `pause` but not `unpause`, size limits, `request_id` length 8 and 64 pass, 7 and 65 fail.

### GĐ17: sandbox integration (1 day)

**What.** `contracts/guard/tests/` with `near-workspaces` and the real Sputnik v2 wasm (D6). Cases from §13.6: Auto pays the receiver (balance check), Pending does not pay and the proposal stays InProgress, duplicate `request_id`, over `max_pending_per_agent`, stranger calls, only DAO changes config, pause blocks requests. Plus: council Reject refunds the bond to the Guard.

**Why.** Callbacks and same-tx execution only show up against the real DAO wasm. This phase is the 11/11 go/no-go for Guard.

Record gas per `request_transfer` (Auto and Pending) and the agent key allowance needed; put both in README "Guard".

### GĐ18: testnet setup script (0.5 day)

**What.** `scripts/guard-setup/setup.sh` (near-cli-rs, idempotent where it can be, `set -euo pipefail`): create DAO (3 members, 2 votes), deploy + `new(...)` the Guard, add-role proposal + 2 approvals, fund-Guard proposal + approvals, create `agent1` account + function-call key (`receiver_id = guard`, methods `request_transfer`, `sync_request`, allowance 1 NEAR), register the agent, whitelist the 3 demo receivers, then **lock** the Guard (delete its full-access key) behind an explicit `y/N` prompt. Writes the agent key to a file path the owner chooses, never to stdout. Answers G-Q4 (near-cli for `AddKey`).

**Why.** UC9/UC10 must be one command so the demo and the judges can rebuild it.

### GĐ19: Guard MCP + demo invoices (0.5–1 day)

**What.** `apps/guard-mcp` (Node, stdio, workspace package): tools `guard_get_policy`, `guard_request_transfer`, `guard_get_request_status` (§11.6.2, appendix F), result `kd.guard_result.v1` (§4.8). Env config per §11.6.2. `request_id = crypto.randomUUID()`. Exact decimal NEAR → yocto (string math, no floats). Tool descriptions and `message` tell the agent not to resend Pending and not to split. `demo/invoices/inv-001..004.md` per appendix G (inv-004 carries the prompt-injection text, receiver `attacker.testnet`).

**Why.** UC11/UC12 demo: Claude Code pays 3 invoices, the 4th becomes a council proposal.

```ts
// exact decimal → yoctoNEAR; rejects more than 24 decimals, negatives, exponents
export function nearToYocto(s: string): string {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(s);
  if (!m) throw new Error("amount_near must be a decimal like 2.5");
  return (BigInt(m[1]) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0"))).toString();
}
```

Tests (vitest, mocked RPC): amount parsing edge cases, mapping of each contract error code to `status: "rejected"` + `error_code`, Pending mapping with reasons, `remaining_today` from `get_window`.

### GĐ20: Key Doctor integration (1 day)

**What.**
- `types.ts`: `Member.special`, `KdReport.dao.guards`, `GuardInfo`, `AlertKind` `guard_request_pending` (§4.9). D5: no schema bump.
- Scanner (`scan.ts`): for each DAO member with code (`view_account.code_hash` not all-ones), call `kd_guard_info`; on `standard = "kd_guard"` read `get_config` / `get_window` / `get_agents` / `get_whitelist` + the Guard's key list; fill `dao.guards`, set `special`. Failures go into `GuardInfo.config = null`, never fail the scan. Count the extra calls against `REQUEST_BUDGET`.
- `src/rules/guard.ts`: `GUARD_PRESENT` (note), `GUARD_ROLE_TOO_BROAD` (high), `GUARD_NOT_LOCKED` (high), `GUARD_PAUSED` (note). Guard members skip `FA_*`, `PQ_*`, `KEY_UNUSED`. Bump `RULESET_VERSION`. vi/en messages; add the "move it to Guard" sentence to `FA_BOT_LIKE` and `FC_DAO_VOTE` fixes.
- `checkProposals`: new proposal whose proposer is in `dao.guards` and whose description parses `decision=pending` → `guard_request_pending` (high) with evidence `agent`, `reasons`, `memo`. `decision=auto` never alerts. `voter_new_full_access_key` skips Guard votes.
- Worker: Telegram template for the new alert; Guard block in `/check`. `diagnose` picks it up with no change.

**Why.** UC12/UC14: the council gets the risk reason on Telegram, and Key Doctor audits the Guard itself.

```ts
// proposals.ts: parse the fixed description (§11.5.6); null when it is not a Guard proposal
const KD_GUARD = /^\[KD-GUARD\] request=(\S+) agent=(\S+) decision=(auto|pending) reasons=(\S+) memo=(.*)$/s;
```

Tests: fixtures for a locked Guard (only `GUARD_PRESENT`), unlocked (`GUARD_NOT_LOCKED`), role with `policy:VoteApprove` (`GUARD_ROLE_TOO_BROAD`), paused; `checkProposals` with a pending Guard proposal (alert), an auto one (none), a Guard vote with a new key (skipped); render tests for the alert and the `/check` block.

### GĐ21: dashboard Guard card + setup guide (0.5 day, G1)

Card per `GuardInfo`: limits, spent / remaining, reset time, agents, whitelist size, lock state, flags. A static guide page that mirrors README "Guard" (role JSON, setup script, MCP config). Dashboard still never writes.

### GĐ22: Trezu (owner only, G1)

Mainnet, small treasury. Claude writes a checklist (G-Q3: does Trezu show the custom role, does editing members overwrite the policy, is the Pending proposal in the queue). Owner runs it and records the result; README states what was and was not checked.

### GĐ23: NEP-141 (G1, only if GĐ20 is done before 10/11)

`Transfer { token_id: <ft contract> }`; receivers need storage deposit. Unit + sandbox test with a test FT contract.

### GĐ24: emergency brake

Cut per D4. Roadmap entry only.

## 3. Cross-cutting

- **README** (GĐ14, but written as each phase lands): "Guard" section per §14 (problem, role setup, MCP plug-in, invoice scenario, security model §11.8, measured gas, lock state, Trezu status, "works with any MCP agent"). Anything not passing by 11/11 goes under Roadmap, per the "README must match the repo" rule.
- **Backlog**: add GĐ15–24 rows to `docs/stories/backlog.md` and mark each per phase.
- **Invariants kept**: testnet names only in fixtures and examples; no LLM in Guard or Key Doctor decisions; baseline / subscription write rules untouched; the Worker never holds a key (D4).
- **Security review**: run the `security-review` skill on `contracts/guard` before GĐ18 deploys it.

## 4. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Rust 1.95 wasm rejected by the NEAR VM | GĐ15 blocked | `cargo near build`, pinned toolchain |
| Testnet factory DAOs lack `ChangePolicyAddOrUpdateRole` | Role setup differs | Fall back to full `ChangePolicy` (spec §11.3) |
| Gas of the 2-hop chain + execution exceeds 300 Tgas | Auto path fails | Measure in GĐ15; split gas explicitly per hop |
| GĐ17 slips past 11/11 | Guard leaves the submission | Spike first; GĐ20 work can still ship as "detects Guard" only if GĐ17 passes |
| Trezu overwrites the policy | Guard silently loses its role | Document in README; `GUARD_*` scan shows a missing role as no Guard |
