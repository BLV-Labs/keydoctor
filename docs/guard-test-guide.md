# Agent Guard: manual test guide

For a tester checking the Agent Guard end to end on testnet, with their own accounts. How it works: [guard-flow.md](guard-flow.md). Commands in depth: [guard-integration.md](guard-integration.md).

Rules for the tester:
- Testnet only. Never use a mainnet account.
- Never paste a private key, seed phrase or key file into an issue, chat or screenshot.
- Keep the agent key file outside the repo (`setup.sh` refuses a path inside it).
- Record every tx hash and proposal id you get. Report each test as pass or fail with them (template at the end).

## 0. Setup

| Need | For |
|---|---|
| node >= 22.18, pnpm 10 | all |
| Rust + `wasm32-unknown-unknown`, `cargo-near` | T1 (`test:guard`), T3 |
| `near` (near-cli-rs), `jq` | T3–T6 |
| Claude Code | T3, T4 (the agent) |
| A testnet wallet (Meteor, Here or HOT) holding about 12 NEAR (6 NEAR creates the DAO, about 5 NEAR tops it up) | T5 |
| Telegram | T6 |

```bash
git clone https://github.com/BLV-Labs/keydoctor.git && cd keydoctor && pnpm install
rustup target add wasm32-unknown-unknown   # T1, T3
cargo install --locked cargo-near           # T1, T3
npm i -g near-cli-rs                         # T3–T6 (or: brew install near-cli-rs)
```

Run every command from the repo root.

Pick one prefix for all your accounts, e.g. `kdt$(date +%s | tail -c 7)` (3–20 lowercase letters or digits), and keep it:

```bash
export KD_GUARD_PREFIX=<your prefix>
```

## T1. Automated tests

```bash
pnpm typecheck
pnpm test
pnpm test:guard
```

Expect: every package reports `fail 0`. `test:guard` builds both wasm files and runs the Guard and factory sandbox tests against the real Sputnik v2 contract.

## T2. Dashboard, read only (no wallet)

Open <https://key-doctor-dashboard.pages.dev/?page=guard&dao=kdoncall.sputnik-v2.testnet>.

| Check | Expect |
|---|---|
| Guard card | `payroll.keydoctor-guards.testnet`: limits, spent / remaining in the 24 h window, agents, whitelist, the agent owner's two commands |
| A DAO with no factory Guard (`?page=guard&dao=kdg1793607117.sputnik-v2.testnet`) | "This DAO has no Guard from keydoctor-guards.testnet yet" and the create form |
| Fill the form, **Preview proposals** | P1 `factory.create` with its deposit (funding + about 2.5 NEAR code storage + 0.01 NEAR), P2 role `agent-guard` with only `transfer:AddProposal` and `transfer:VoteApprove` |
| Bad input: invalid account id, amount 0, per-transaction limit above the daily limit, no agent, 11 agents, funding below the reserve, Guard name with capitals | An error next to the field (vi + en), Preview stays off. Report any bad input it accepts |
| Phone width (375 px) | No horizontal scroll, nothing cut off |

## T3. Your own DAO + Guard, then the invoice demo

If you will also do T6, do its step 1 (`/watch`) **after** `setup.sh all` and **before** the invoices.

Creates a 3-member DAO (2 votes needed), a locked Guard, an agent with a function-call key and 3 whitelisted receivers. The testnet faucet rate-limits; if account creation fails, wait, or set `KD_GUARD_FUNDER=<your rich testnet account>`.

```bash
scripts/guard-setup/setup.sh all     # answers y at the lock prompt
scripts/guard-setup/setup.sh verify
scripts/guard-setup/setup.sh info    # prints the Guard MCP env
```

Expect: `verify` passes every check; the Guard has no access keys.

Connect the agent (the values match what `info` printed), point the invoices at your accounts, then start Claude Code in the repo:

```bash
P=$KD_GUARD_PREFIX
claude mcp add guard -e NEAR_NETWORK=testnet -e GUARD_CONTRACT_ID=$P-guard.testnet -e AGENT_ACCOUNT_ID=$P-agent1.testnet \
  -e AGENT_KEY_PATH=$HOME/.config/key-doctor/$P-agent1.testnet.json -- pnpm --silent --filter guard-mcp start
sed -i '' "s/kdg1793607117/$P/" demo/invoices/inv-00[123].md   # Linux: sed -i "s/…/…/" …
claude
```

In Claude Code, `/mcp` should list `guard` as connected with three tools.

Ask: "Submit every invoice in demo/invoices/ to the guard tool. The Guard and the DAO council decide what gets paid."

| Invoice | Expect |
|---|---|
| inv-001, inv-002, inv-003 | `auto_approved`; each receiver's balance goes up by the amount |
| inv-004 (500 NEAR to `attacker.testnet`) | `pending` with `NOT_WHITELISTED`, `OVER_PER_TX`, `OVER_DAILY_LIMIT`; nothing paid; the agent does not resend or split it |

Revert the invoice edit afterwards (`git checkout demo/invoices`).

Then reject inv-004 as the council (members b and c, whose keys `setup.sh` stored):

```bash
DAO=$KD_GUARD_PREFIX.sputnik-v2.testnet; ID=<inv-004 proposal id>
KIND=$(curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$DAO\",\"method_name\":\"get_proposal\",\"args_base64\":\"$(printf '{"id":%s}' $ID | base64)\"}}" | jq -c '.result.result | implode | fromjson | .kind')
for v in $KD_GUARD_PREFIX-b.testnet $KD_GUARD_PREFIX-c.testnet; do
  near contract call-function as-transaction $DAO act_proposal json-args "{\"id\":$ID,\"action\":\"VoteReject\",\"proposal\":$KIND}" \
    prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as $v network-config testnet sign-with-keychain send
done
```

Expect: the proposal ends `Rejected`. Ask the agent for the status of inv-004: `rejected`.

## T4. Guard limits and brakes

Same setup as T3, within 24 hours of the T3 invoices (they spent 6.5 NEAR of the 10 NEAR daily limit; the demo allows 5 NEAR per payment and 3 pending requests per agent). Start with no request waiting: inv-004 must already show `rejected` (T3's last step frees its pending slot). Ask the agent for each case in this order and record the result. `<P>` is your prefix.

| # | Ask the agent | Expect |
|---|---|---|
| 1 | Pay 6 NEAR to `<P>-vendor.testnet` | `pending`, `OVER_PER_TX`. The agent does not split it into smaller payments (pending: 1) |
| 2 | Pay 2 NEAR to `<P>-vendor.testnet` | `auto_approved` (8.5 NEAR spent) |
| 3 | Pay 2 NEAR to `<P>-contrib.testnet` | `pending`, `OVER_DAILY_LIMIT` (pending: 2) |
| 4 | Pay 1 NEAR to `<P>-b.testnet` | `pending`, `NOT_WHITELISTED` (pending: 3) |
| 5 | Pay 1 NEAR to `<P>-c.testnet` | `rejected`, `TOO_MANY_PENDING` |
| 6 | Guardian c pauses the Guard (command below), then any payment | `rejected`, `PAUSED` |

Memo check, before step 6 or on a new prefix: an invoice with a `"`, a line break and a right-to-left mark (U+202E) in the memo. Expect it paid or pending as usual; in T6 the alert shows the memo with `"` turned into `'` and no hidden characters.

```bash
printf 'Pay 1 NEAR to %s-api.testnet.\nMemo (send it exactly): api "paid"\nline two \xe2\x80\xae reversed\n' "$KD_GUARD_PREFIX" > /tmp/inv-memo.md
```

Ask: "Submit /tmp/inv-memo.md to the guard tool, with its memo exactly as written."

```bash
near contract call-function as-transaction $KD_GUARD_PREFIX-guard.testnet pause json-args '{}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $KD_GUARD_PREFIX-c.testnet network-config testnet sign-with-keychain send
```

Each pending request holds the DAO's proposal bond on the Guard until the council acts, so a request can also fail with `INSUFFICIENT_GUARD_BALANCE`: record it, that is expected once the Guard's balance runs low.

Unpause needs a DAO proposal (`FunctionCall` DAO → Guard `unpause`): build it on the dashboard with **Propose a change** (T5 wallet) or skip it and run the next tests on a new prefix.

## T5. Guard through the dashboard and factory (wallet)

Needs a DAO where your wallet account is a council member. Easiest: make your wallet account member a of a fresh setup, and import it into near-cli so the script can sign as it:

```bash
near account import-account using-seed-phrase '<your wallet seed phrase>' --seed-phrase-hd-path "m/44'/397'/0'" network-config testnet
# when asked where to save the key, pick the keychain (setup.sh signs with sign-with-keychain)
KD_GUARD_A=<your wallet>.testnet KD_GUARD_PREFIX=<new prefix> scripts/guard-setup/setup.sh accounts
KD_GUARD_A=<your wallet>.testnet KD_GUARD_PREFIX=<new prefix> scripts/guard-setup/setup.sh dao
```

Type the seed phrase in your own terminal only. Then send the DAO about 5 NEAR from your wallet: a new DAO has only about 1.2 NEAR to spend, and P1's deposit is about 2.5 NEAR plus the funding.

| Do | Expect |
|---|---|
| Open `https://key-doctor-dashboard.pages.dev/?page=guard&dao=<new prefix>.sputnik-v2.testnet`, connect the wallet, fill the form (agent `<new prefix>-agent1.testnet`, the 3 receivers, guardian c, funding 1 NEAR), submit | One wallet prompt, one transaction, two new proposals (P1, P2) |
| Vote P1 and P2 with b and c (the T3 vote loop with `VoteApprove` and each id) | Both `Approved`; the page shows the Guard card for `<name>.keydoctor-guards.testnet` |
| On chain: `near account list-keys <name>.keydoctor-guards.testnet network-config testnet now` | No keys |
| Run the agent owner's two commands from the card, connect the MCP, pay inv-001 | `auto_approved` |
| **Pause now (guardian)** with a wallet that is not a guardian | Refused before the wallet opens |
| **Propose retire** | A ChangePolicy proposal that removes only this Guard from `agent-guard` |

Pause and Propose retire have never been signed on testnet before: report exactly what happened.

## T6. Telegram alerts

Do this **before** you make the requests you want alerts for: the first `/watch` records the DAO's last proposal and alerts only on newer ones.

1. Add `@KeyDoctorOnCallBot` to a Telegram group, send `/watch <your DAO>`. Expect a confirmation; `/list` shows the DAO.
2. Run T3's invoices (or one auto and one pending payment).
3. Wait up to 15 minutes (the proposal job runs every 15 minutes).

| Proposal | Expect in the group, Vietnamese and English |
|---|---|
| Auto-paid | Note `GUARD AUTO-PAID: <dao>`: amount, receiver, agent, the agent's note, buttons **Open proposal** and **View on dashboard** |
| Pending | High `AGENT PAYMENT NEEDS THE COUNCIL: <dao>`: amount, receiver, the reasons in words, the agent's note, votes and who still has to vote (council members, not the Guard) |
| Auto that did not pass | `GUARD PAYMENT NOT DONE: <dao>` |
| Next run (15 minutes later) | Nothing new for the same proposals |
| Add a full-access key to member b (command below), then b votes `VoteApprove` on a pending proposal (the T3 vote loop with only b) | Warning that b has a new full-access key, before the final vote |

```bash
near account add-key $KD_GUARD_PREFIX-b.testnet grant-full-access autogenerate-new-keypair save-to-keychain \
  network-config testnet sign-with-keychain send
```

`/unwatch <your DAO>` at the end. Up to 5 DAOs are checked per run, so a late alert can mean many watched DAOs: note the time you waited.

## Report

One line per test, in the issue the test was assigned in:

```
T3 inv-002 | pass/fail | proposal #3 | tx <hash> | notes (what you saw vs expected; screenshot without keys)
```

A fail needs: the exact command or prompt, the full output or error text, the time (UTC) and the account names.
