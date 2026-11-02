# Guard spike (GĐ15), 2026-11-02

Question: can a contract member of a Sputnik v2 DAO create a NEAR transfer proposal and approve it alone, with the money leaving the DAO in the same transaction? (`docs/final-idea.md` §11.3, §13.6; plan: `docs/stories/epics/guard/plan.md`)

Code: `contracts/guard/src/lib.rs` (spike contract), `contracts/guard/tests/spike.rs` (sandbox run), `scripts/guard-setup/spike.sh` (testnet run).

## Status

| Check | Where | Result |
|---|---|---|
| Wasm builds and the NEAR VM accepts it (Rust 1.95) | `cargo near build` (cargo-near 0.22, wasm-opt post-step) + sandbox deploy | Pass. 128.6 KB. Plain `cargo build` output was not tried on chain; use cargo-near |
| Guard self-approves, money moves in the same tx | sandbox, real testnet Sputnik wasm (`tests/res`) | Pass. Proposal `Approved`, proposer = Guard, receiver +0.1 NEAR exactly |
| Same on testnet (GĐ15 "done when") | `scripts/guard-setup/spike.sh`, run by the owner (plan D7) | **Pass.** Tx `AgkVkFuJhs9GijiPQ4xZGbPVmQcN3qq41tRzSU1cZAza`: proposal 1 `Approved`, proposer = Guard, DAO → receiver 0.1 NEAR in the same tx, 0 failed receipts |

GĐ15 is done: the testnet tx hash is recorded below.

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
- Confirmed on testnet: the `ChangePolicy` proposal passed with 2 of 3 council votes and `get_policy` then showed the role exactly as above.

## G-Q2: gas

| Measure | Sandbox | Testnet |
|---|---|---|
| `request_transfer` total gas burnt (whole tx, all receipts) | 12 Tgas | 12.82 Tgas |
| Guard's own receipts (`request_transfer`, `on_added`, `on_voted`) | about 0.26–0.29 Tgas each | 0.266 / 0.288 / 0.263 Tgas (contract logs) |
| Prepaid / static split used | 300 Tgas prepaid; add_proposal 20, on_added 120 (act_proposal 80, on_voted 10) | same |

Testnet matches the sandbox. The static split is far above need; GĐ16 can keep it (unused gas is refunded) or lower it.

The proposal bond came back in the same tx: the DAO sent 1 NEAR back to the Guard once the transfer was `Approved`.

## Testnet run (2026-11-02, owner)

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
| Prefix | `kdg1793591704` |
| DAO | `kdg1793591704.sputnik-v2.testnet` (council `kdg1793591704-{a,b,c}.testnet`, 2 of 3) |
| Guard account | `kdg1793591704-guard.testnet`, agent `kdg1793591704-a.testnet` |
| Guard wasm | sha256 `0431b9bb44fa737ff0bf1f3215697b9606535f002b3af3e1242bdbda34e5c0b9`; on-chain code hash `HNcHHBvFuq91S4NhgikLCLsDrsUWHAfAjpkWB2Q7MqA` matches the local build |
| Role proposal | id 0 (`ChangePolicy`), votes `Gn4JXzyX7gETp4KbX4BkeS2vR22oNkSPTEZVQ8zFQrco` (a), `9PVP5pxZ9j4P94X7YxQBwUu4aXmBTeJddANERAoUWTE5` (b), status `Approved` |
| `request_transfer` tx hash | `AgkVkFuJhs9GijiPQ4xZGbPVmQcN3qq41tRzSU1cZAza` (signed by a) |
| Transfer proposal id / status | 1 / `Approved`, `Transfer` 0.1 NEAR to `kdg1793591704-c.testnet` |
| Gas burnt | 12.82 Tgas (sum over the tx and all receipts, `EXPERIMENTAL_tx_status`) |
