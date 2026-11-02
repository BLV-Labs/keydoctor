# Guard spike (GĐ15), 2026-11-02

Question: can a contract member of a Sputnik v2 DAO create a NEAR transfer proposal and approve it alone, with the money leaving the DAO in the same transaction? (`docs/final-idea.md` §11.3, §13.6; plan: `docs/stories/epics/guard/plan.md`)

Code: `contracts/guard/src/lib.rs` (spike contract), `contracts/guard/tests/spike.rs` (sandbox run), `scripts/guard-setup/spike.sh` (testnet run).

## Status

| Check | Where | Result |
|---|---|---|
| Wasm builds and the NEAR VM accepts it (Rust 1.95) | `cargo near build` (cargo-near 0.22, wasm-opt post-step) + sandbox deploy | Pass. 128.6 KB. Plain `cargo build` output was not tried on chain; use cargo-near |
| Guard self-approves, money moves in the same tx | sandbox, real testnet Sputnik wasm (`tests/res`) | Pass. Proposal `Approved`, proposer = Guard, receiver +0.1 NEAR exactly |
| Same on testnet (GĐ15 "done when") | `scripts/guard-setup/spike.sh` | **Not run yet.** Owner runs it (plan D7) and fills the table below |

GĐ15 is not done until the testnet tx hash is recorded.

## G-Q1: role JSON and policy proposal kind

- DAOs created by `sputnik-v2.testnet` (code hash `ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq`) reject `ChangePolicyAddOrUpdateRole`: `unknown variant ChangePolicyAddOrUpdateRole, expected one of ChangeConfig, ChangePolicy, AddMemberToRole, RemoveMemberFromRole, FunctionCall, UpgradeSelf, UpgradeRemote, Transfer, SetStakingContract, AddBounty, BountyDone, Vote`.
- So the role goes in with `ChangePolicy`, carrying the whole current policy plus the new role. GĐ18 setup must read `get_policy` right before proposing, and the council must not pass another policy change in between (the later one overwrites the earlier one).
- Accepted role JSON (`threshold` weight is a string; a ratio would be `[a, b]`):

```json
{ "name": "agent-guard", "kind": { "Group": ["<guard>"] },
  "permissions": ["transfer:AddProposal", "transfer:VoteApprove"],
  "vote_policy": { "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "1" } } }
```

- `act_proposal` with the extra `proposal` field is accepted by this DAO version (unknown fields are ignored), so the Guard can always send it.

## G-Q2: gas

| Measure | Sandbox | Testnet |
|---|---|---|
| `request_transfer` total gas burnt (whole tx, all receipts) | 12 Tgas | |
| Guard's own receipts (`request_transfer`, `on_added`, `on_voted`) | about 0.26–0.29 Tgas each | |
| Prepaid / static split used | 300 Tgas prepaid; add_proposal 20, on_added 120 (act_proposal 80, on_voted 10) | |

The static split is far above need; GĐ16 can keep it (unused gas is refunded) or lower it once testnet numbers are in.

## Testnet run (owner fills this in)

```bash
export KD_SPIKE_PREFIX=kdg$(date +%s)
scripts/guard-setup/spike.sh accounts
scripts/guard-setup/spike.sh dao
scripts/guard-setup/spike.sh deploy
scripts/guard-setup/spike.sh add-role
scripts/guard-setup/spike.sh approve-role
scripts/guard-setup/spike.sh transfer
```

| Item | Value |
|---|---|
| DAO | |
| Guard account | |
| Guard wasm sha256 | |
| Role proposal id / tx | |
| `request_transfer` tx hash | |
| Transfer proposal id / status | |
| Gas burnt (nearblocks) | |
