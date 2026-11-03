# Agent Guard: end-to-end flow

How a DAO gets an Agent Guard and how an AI agent then spends DAO money through it. Testnet names throughout. Contract: `contracts/guard`. Agent side: `apps/guard-mcp`. Step-by-step commands: [guard-integration.md](guard-integration.md).

## Actors

| Actor | Holds | Can do |
|---|---|---|
| Council member | own wallet (Meteor, Here, HOT, near-cli) | create DAO proposals, vote |
| DAO (Sputnik v2) | the treasury | pays only through passed proposals |
| Guard contract | no keys after setup (locked) | add `Transfer` proposals; vote approve only within limits |
| Agent owner | the agent's function-call key | run the Guard MCP next to the agent |
| AI agent (e.g. Claude) | nothing | call the MCP tools |

## Phase 1: create the Guard

### Path A: setup script (works today)

`scripts/guard-setup/setup.sh all` runs every step for a demo DAO; `guard-integration.md` steps 1–5 do the same by hand on your own DAO.

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Operator (near-cli)
    participant Guard as Guard account
    participant DAO as Sputnik DAO
    actor Council
    Owner->>Guard: deploy kd_guard.wasm + new(dao_id, policy, agents, whitelist, guardians)
    Guard->>DAO: get_policy (caches bond and proposal period)
    Owner->>DAO: add_proposal ChangePolicy (role agent-guard)
    Owner->>DAO: add_proposal Transfer (fund the Guard)
    Council->>DAO: act_proposal VoteApprove (both)
    Owner->>Owner: add a function-call key to the agent account (request_transfer, sync_request)
    Owner->>Guard: delete full-access keys (lock)
```

### Path B: dashboard + Guard factory (factory on testnet)

Code, unit, render and sandbox tests are done (`contracts/guard-factory`, dashboard `?page=guard`). Factory deployed on testnet as `keydoctor-guards.testnet` (2026-11-03); no Guard created through it yet. `scripts/guard-setup/setup.sh factory` deploys your own.

![Guard setup through the dashboard and factory](images/guard-setup-flow.svg)

```mermaid
sequenceDiagram
    autonumber
    actor Member as Council member (wallet)
    participant Dash as Dashboard ?page=guard&dao=<dao>
    participant DAO as Sputnik DAO
    actor Council
    participant Factory as keydoctor-guards.testnet
    participant Guard as <name>.keydoctor-guards.testnet
    Member->>Dash: fill limits, agents, whitelist, guardians, funding
    Dash->>DAO: get_policy (bond, member permissions)
    Member->>DAO: one signature, 2 add_proposal calls
    Note over DAO: P1 FunctionCall factory.create (deposit = storage + funding)<br/>P2 ChangePolicy + role agent-guard
    Council->>DAO: vote P1 and P2 in the usual DAO UI
    DAO->>Factory: create(...) when P1 passes
    Factory->>DAO: get_policy (caller must be a DAO)
    Factory->>Guard: create_account, transfer, deploy, new(dao_id = DAO). No access key
    Factory->>Factory: registry: DAO -> Guard
    Dash->>Factory: get_guards_for_dao (shows the Guard card)
```

What makes it safe:
- `dao_id` is the caller of `create`, so only the DAO itself can register a Guard for itself.
- The Guard is born without access keys: nobody can redeploy or drain it.
- P2 gives the Guard only `transfer:AddProposal` and `transfer:VoteApprove`. The council sees the policy diff before signing.

## Phase 2: use the Guard

![Agent payment request: Auto or Pending](images/guard-request-flow.svg)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent as AI agent
    participant MCP as Guard MCP (agent owner's machine)
    participant Guard
    participant DAO as Sputnik DAO
    actor Council
    User->>Agent: "pay 3 NEAR to vendor-a.testnet for hosting"
    Agent->>MCP: guard_request_transfer(receiver_id, amount_near, memo)
    MCP->>Guard: request_transfer (function-call key, 200 Tgas, 0 deposit)
    Note over Guard: hard checks fail the tx: PAUSED, UNKNOWN_AGENT,<br/>AGENT_DISABLED, DUPLICATE_REQUEST, TOO_MANY_PENDING,<br/>INSUFFICIENT_GUARD_BALANCE
    Guard->>DAO: add_proposal Transfer (bond, "[KD-GUARD] request=… decision=…")
    alt Auto: whitelisted, <= max_per_tx and receiver cap, within 24 h max_per_day
        Guard->>DAO: act_proposal VoteApprove
        DAO->>DAO: proposal passes, NEAR sent to receiver
        MCP-->>Agent: auto_approved (paid)
    else Pending: NOT_WHITELISTED, OVER_PER_TX, OVER_RECIPIENT_LIMIT, OVER_DAILY_LIMIT
        MCP-->>Agent: pending + reasons (do not resend or split)
        Council->>DAO: approve or reject in the DAO UI
        Agent->>MCP: guard_get_request_status(request_id)
        MCP->>Guard: sync_request
        Guard->>DAO: get_proposal
        MCP-->>Agent: executed / rejected / expired
    end
```

## Phase 3: run it

| Need | Who | How |
|---|---|---|
| Change limits, agents, whitelist, guardians | DAO | `FunctionCall` proposal DAO → Guard (`set_policy`, `add_whitelist`, …) |
| Emergency stop | guardian or DAO | `pause`; only the DAO can `unpause` |
| Get money back | DAO | `withdraw_excess` by proposal |
| Watch | council | Key Doctor `/watch`: proposals and new full-access keys of voters |

### Guardians

A guardian is an account the DAO trusts to hit the emergency brake, usually a council member or a monitoring bot.

- Only right: call `pause()` directly, no vote, effective in the same transaction. A guardian cannot unpause, move money or change the policy, agents or whitelist.
- Set at create (`guardians` in `factory.create`, the "guardians" field of the dashboard form), later by DAO proposal `add_guardian` / `remove_guardian`. At most 5.
- The demo (`setup.sh`) makes council member C the guardian.
- Why: a DAO proposal takes hours or days to pass. If an agent key leaks or the agent misbehaves, a guardian stops the Guard at once. Restarting needs the whole council (`unpause`), so a bad guardian can only cause downtime, not take money.
- Dashboard: the Guard card shows **Pause now (guardian)** when the Guard has guardians. The connected wallet must hold a guardian account (checked before the wallet opens) and signs `pause` on the Guard directly, no deposit. near-cli works too.

### Enable / disable

| Level | Turn off | Turn back on | Who |
|---|---|---|---|
| Whole Guard | `pause()`: every `request_transfer` fails with `PAUSED` | `unpause()` | off: guardian or DAO; on: DAO proposal only |
| One agent | `set_agent_enabled(id, false)` (fails with `AGENT_DISABLED`) or `remove_agent` | `set_agent_enabled(id, true)` | DAO proposal only |

Pausing does not touch proposals already in the DAO: the council still approves or rejects those.

### Retire a Guard (no delete)

A Guard cannot be deleted: it has no keys and no delete method, and the factory keeps its registry record. Its code storage (about 2.5 NEAR, paid by the DAO's create deposit) and state stay locked. To take one out of service, all by DAO proposal:

1. `ChangePolicy` removing the Guard from role `agent-guard`. This is the real cut-off: without the role the Guard cannot add any transfer proposal. Dashboard: **Propose retire** on the Guard card builds it (other Guards stay in the role; the role is dropped when this was its last Guard).
2. `pause`.
3. `withdraw_excess`: everything above the Guard's storage (or `min_reserve`) goes back to the DAO.

## Demo (invoice scene)

Four invoices in `demo/invoices/`, asked to the agent as "Submit every invoice in demo/invoices/ to the guard tool. The Guard and the DAO council decide what gets paid." Dry run on testnet (`kdg1793607117`, 2026-11-02): inv-001 to inv-003 `auto_approved`, inv-004 (500 NEAR to `attacker.testnet`, with a prompt injection) `pending`, then rejected by the council.
