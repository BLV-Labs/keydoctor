# Integrating the Agent Guard

How to put an AI agent behind the Agent Guard (`contracts/guard`) on a Sputnik v2 DAO you already run, and connect the agent through the Guard MCP (`apps/guard-mcp`). With a Guard factory, a council member can instead propose the Guard from the dashboard's Agent Guard page: the council votes P1 (create) and P2 (role), and steps 1, 2 and 5 below are done by those two proposals; fund the Guard through P1's funding and continue at step 4 ([guard-flow.md](guard-flow.md), Path B). For a throwaway demo DAO, `scripts/guard-setup/setup.sh all` does every step below (README, [Agent Guard](../README.md#agent-guard-contract)). Testnet names are used throughout.

## What you get

```
agent ──(function-call key: request_transfer, sync_request)──▶ Guard ──AddProposal (+ VoteApprove if Auto)──▶ DAO ──▶ receiver
                                                                 ▲
                                    limits, agents, whitelist: changed only by a DAO proposal
```

- The agent never holds DAO funds or a full-access key. It can only ask the Guard to pay.
- Every request becomes a Sputnik `Transfer` proposal, so the DAO keeps a full audit trail.
- The Guard votes the proposal through itself (`Auto`) only when all of these hold:
  - the receiver is whitelisted;
  - `amount <= max_per_tx` and `<=` the receiver's own `max_per_tx`, if set;
  - spent in the rolling 24 h window plus `amount <= max_per_day`.
- Anything else stays `Pending` for the council, with reason codes `NOT_WHITELISTED`, `OVER_PER_TX`, `OVER_RECIPIENT_LIMIT` or `OVER_DAILY_LIMIT`.

## Scope: one Guard per DAO

- A Guard serves exactly one DAO (`dao_id`, fixed at init) and has one `GuardPolicy` (`max_per_tx`, `max_per_day`, `max_pending_per_agent`, `min_reserve`). All its agents share that policy and the same 24 h budget.
- The only per-item rules are:
  - per receiver: an optional `max_per_tx` on each whitelist entry;
  - per agent: on or off (`set_agent_enabled`).
- Limits: up to 10 agents, 50 whitelisted receivers, 5 guardians.
- Several DAOs, or different limits for different agents, need one Guard each: one deployed account per policy. Each needs its own role in its DAO and its own MCP entry on the agent side (step 6).

## Prerequisites

- `near` (near-cli-rs), `cargo-near`, Rust with `wasm32-unknown-unknown`, node >= 22, pnpm.
- A Sputnik v2 DAO whose council can pass a `ChangePolicy` proposal and a `Transfer` proposal.
- Three accounts you control:
  - the Guard account (e.g. `acme-guard.testnet`);
  - the agent account (e.g. `acme-agent1.testnet`);
  - optionally, a guardian that may pause the Guard.

## 1. Deploy and initialise the Guard

```bash
cd contracts/guard && cargo near build non-reproducible-wasm --no-abi
```

All amounts are yoctoNEAR strings. This example pays at most 5 NEAR per request and 10 NEAR per 24 h, allows 3 open requests per agent and keeps a 1 NEAR reserve:

```bash
near contract deploy acme-guard.testnet use-file target/near/kd_guard.wasm with-init-call new json-args '{
  "dao_id": "acme.sputnik-v2.testnet",
  "policy": { "max_per_tx": "5000000000000000000000000", "max_per_day": "10000000000000000000000000",
              "max_pending_per_agent": 3, "min_reserve": "1000000000000000000000000" },
  "agents": [{ "account_id": "acme-agent1.testnet", "label": "Invoice agent" }],
  "whitelist": [{ "account_id": "vendor-a.testnet", "label": "Hosting", "max_per_tx": null }],
  "guardians": ["alice.testnet"]
}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

The Guard reads the DAO's proposal bond and period right after init. If the DAO changes its bond later, call `refresh_bond` through a DAO proposal.

## 2. Give the Guard a role in the DAO

Add this role with a `ChangePolicy` proposal:

```json
{ "name": "agent-guard", "kind": { "Group": ["acme-guard.testnet"] },
  "permissions": ["transfer:AddProposal", "transfer:VoteApprove"],
  "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" } } }
```

Notes on the policy change:
- Factory DAOs reject `ChangePolicyAddOrUpdateRole`, so send the whole current policy (from `get_policy`) with this role appended.
- `setup.sh role` shows how, and prints the diff for the council to review.
- With this vote policy, the Guard's single vote passes a transfer. It gets no other permission: no policy, members, function calls or upgrades.
- Make sure no other role lists the Guard account. Any role that does would give it more than transfers.

## 3. Fund the Guard

Each request attaches the DAO's proposal bond, and the Guard pays storage for its request records. Fund it with a DAO `Transfer` proposal to the Guard account. Size it to cover the bond times `max_pending_per_agent` plus `min_reserve`.

- The bond comes back when a proposal is finalised.
- `withdraw_excess` (by DAO proposal) returns everything above the reserve to the DAO.
- Requests fail with `INSUFFICIENT_GUARD_BALANCE` when the balance runs low.

## 4. Give the agent a limited key

```bash
near account add-key acme-agent1.testnet grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id acme-guard.testnet --function-names 'request_transfer, sync_request' \
  use-manually-provided-public-key ed25519:<agent public key> network-config testnet sign-with-keychain send
```

- Keep the private key in a near-cli key file (`{account_id, public_key, private_key}`), mode 600, on the agent owner's machine only. Never commit it.
- The Guard MCP refuses a full-access key.
- Allowance sizing: each call attaches 200 Tgas, and NEAR checks the allowance at a pessimistic gas price.
  - 1 NEAR lasts about 600 Auto requests.
  - 0.25 NEAR lasts about 35.
  - 0.2 NEAR is refused.

## 5. Lock the Guard

Delete the Guard account's full-access keys. Once locked, only the DAO can change it, by proposal. `setup.sh lock` runs `verify` first, then asks before it deletes anything.

## 6. Connect the agent (Guard MCP)

`apps/guard-mcp` is a stdio MCP server. Run it on the agent owner's machine. Config, all from the environment:

| Variable | Value |
| --- | --- |
| `NEAR_NETWORK` | `testnet` (default) or `mainnet` |
| `GUARD_CONTRACT_ID` | the Guard account |
| `AGENT_ACCOUNT_ID` | the agent account; must match the key file |
| `AGENT_KEY_PATH` | path to the agent's key file |
| `NEAR_RPC_URL` | optional; default `rpc.<network>.fastnear.com` |

Claude Code:

```bash
claude mcp add guard -e NEAR_NETWORK=testnet -e GUARD_CONTRACT_ID=acme-guard.testnet -e AGENT_ACCOUNT_ID=acme-agent1.testnet -e AGENT_KEY_PATH=$HOME/.config/key-doctor/acme-agent1.testnet.json -- pnpm --silent --filter guard-mcp start
```

Any other MCP client (Claude Desktop, Cursor, an agent SDK):
- Start the same command (`pnpm --silent --filter guard-mcp start`, run from the repo) as a stdio server, with the variables above.
- Several Guards: add one server entry per Guard, each under its own name, `GUARD_CONTRACT_ID` and key.

Tools (the three `guard_*` ones return `kd.guard_result.v1`):

| Tool | Use |
| --- | --- |
| `guard_get_policy` | Read limits, what is left in the 24 h window, whitelist, paused |
| `guard_request_transfer` | `receiver_id`, `amount_near` (decimal string), optional `memo`. Returns `auto_approved`, `pending` (with reasons) or `rejected` (a Guard error such as `PAUSED`) |
| `guard_get_request_status` | `request_id`; refreshes a non-final request from the DAO |
| `strategies_list` | Read the strategy catalog; send the owner the `setup_url` (the agent cannot create a plan) |
| `plans_status` | Read each plan's progress, status and next run, with a dashboard link |

Prompt tip: tell the agent to submit payments to the guard tool and let the Guard and council decide. The tool descriptions already say: never resend or split a `pending` payment, and follow up with `guard_get_request_status`.

Without MCP, any program can call the Guard directly. It signs `request_transfer` with the agent's function-call key:
- arguments `{request_id, receiver_id, amount, memo}`; `request_id` is 8–64 chars of `[A-Za-z0-9_-]` and unique;
- 0 deposit, 200 Tgas.

`apps/guard-mcp/src/near.ts` is a dependency-free reference implementation.

## 7. Run it day to day

The council changes the Guard through `FunctionCall` proposals from the DAO to the Guard account:

| Method | Args | Deposit |
| --- | --- | --- |
| `set_policy` | `{policy}` | |
| `add_agent` / `remove_agent` / `set_agent_enabled` | | `add_*` needs a storage deposit; the unused part is refunded |
| `add_whitelist` / `remove_whitelist` | | storage deposit for `add_*` |
| `add_guardian` / `remove_guardian` | | storage deposit for `add_*` |
| `unpause` | | |
| `refresh_bond` | | |
| `withdraw_excess` | | |

Other parts of daily operation:
- **Emergency stop:** a guardian or the DAO calls `pause`. Every new request then fails with `PAUSED`. Only the DAO can unpause.
- **Pending requests:** they are ordinary DAO proposals. The council approves or rejects them in its usual DAO UI.
- **Auditing:** `list_requests`, `get_request` and `get_request_by_proposal` are view methods. The Guard also emits events: `request_submitted`, `policy_updated`, `paused`, and others.
- **Monitoring:** Key Doctor checks the council's keys and watches the DAO's proposals (Telegram `/watch`), so Guard proposals appear there like any other.
- **Before the agent signs or pays from its own account:** the MCP `preflight` tool returns `block` if a full-access key was added in the last 48 h.

## Limitations

- The 24 h window restarts at the first request after it ends, so across a reset an agent can spend up to twice `max_per_day` without the council.
- Request records are stored at the Guard's cost and never deleted.
- NEAR only. No fungible tokens.
