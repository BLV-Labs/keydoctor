# Testnet demo run, 2026-10-30 (O2)

Live run of `scripts/demo-testnet/demo.sh` against the deployed Worker, using existing testnet accounts
(`KD_DEMO_A/B/C`, `KD_DEMO_SIGN=sign-with-legacy-keychain`, see PR #14). Testnet only. State read from RPC at block 275391744.

- DAO: `kdd1793327513.sputnik-v2.testnet` (council: `bot1`, `bot2`, `test1`, all `*.duonghb3.testnet`; transfers need 2 votes)
- Worker: `https://key-doctor.duonghb53.workers.dev`

## Steps

| # | Step | Result | Tx |
|---|---|---|---|
| 1 | `demo.sh dao` | DAO created, council policy read back with `get_policy` | `7jpmjAJmwbSJqGKzZkEdxdbij3VWZt68asKgGYHYiRDT` |
| 2 | `/watch <dao>` in a Telegram group | Bot confirmed the watch (baseline written) | none |
| 3 | `demo.sh transfer` | `bot2` proposed "transfer 1 NEAR to `test1`", proposal id 0 | `AcaWkss6eYPRRtD4GMSEdKcxVLWnd5VDGHsw7YHKfT3W` |
| 4 | `demo.sh compromise` | `bot1` got a new full-access key `ed25519:Ga9KfYiuCzc44cGKBuJH7tN4WcDz3GRtmwHz8WCQG8XQ` | `urTBeETaGFZxRxKMJoALZHBu4LhhLWzkLw7FZULpwdV` |
| 5 | function-call key (for the revoke test) | `test1` got `ed25519:8B6kfHb8r5MddweEkJwp3XWv19tS6o4U5mLUJ8QWsCVw`, `act_proposal` on the DAO only, allowance 0.25 NEAR | `CJy3hMp4hUb2Svoj99qrMUpD4to5Ko8YrWmS2jor4oJg` |
| 6 | `demo.sh vote` | `bot1` approved proposal 0 | `AfmWM28BphdLrLyf8Wzzapys1HU8J1ZPsnagC4zgYtzh` |
| 7 | `demo.sh run-check` | `targets_checked: 1`, `alerts_sent: 1`, `errors: []` | none (Worker call) |
| 8 | `demo.sh governance` | `bot2` proposed adding `kdd1793327513-newcomer.testnet` to the council, proposal id 1 | `F2nSKdZ71Qv8CUhdmjzuHxsnCSBBfuhEGE2rFcRj4pq4` |
| 9 | `demo.sh run-check` (second) | `alerts_sent: 1`, only the new governance alert; the voter alert for proposal 0 was not sent again; `errors: []` | none (Worker call) |

Second alert: `testnet:kdd1793327513.sputnik-v2.testnet:governance_change_proposal:1:-`. Telegram text for it: _pending._

Alert sent: `testnet:kdd1793327513.sputnik-v2.testnet:voter_new_full_access_key:0:bot1.duonghb3.testnet`.

Telegram message received in the group (Vietnamese and English in one message, as the bot sends it):

```text
Key Doctor On Call
CẢNH BÁO: kdd1793327513.sputnik-v2.testnet

Đề xuất 0: chuyển 1 NEAR cho test1.duonghb3.testnet. bot1.duonghb3.testnet có khóa toàn quyền mới thêm chưa tới 1 giờ trước khi bỏ phiếu. Tài khoản có thể đã bị chiếm.
Phiếu: 1/2 đã duyệt. Còn chờ: test1.duonghb3.testnet, bot2.duonghb3.testnet

Trước khi bỏ phiếu: xác minh với bot1.duonghb3.testnet qua kênh khác (gọi điện, gặp trực tiếp).

— English —
ALERT: kdd1793327513.sputnik-v2.testnet

Proposal 0: transfer 1 NEAR to test1.duonghb3.testnet. bot1.duonghb3.testnet has a new full-access key added less than an hour before voting. The account may be compromised.
Votes: 1/2 approved. Still to vote: test1.duonghb3.testnet, bot2.duonghb3.testnet

Before you vote: verify with bot1.duonghb3.testnet through another channel (call or meet in person).
```

Checked against the chain: the message names the right proposal, the right voter and the right pending voters; "1/2" matches the 2-vote threshold.

## Account state after step 7

| Account | NEAR | Keys |
|---|---|---|
| `bot1.duonghb3.testnet` | 25 (was 31) | full access `99Qe…` (block 91420058), full access `Ga9K…` (block 275391116, new) |
| `bot2.duonghb3.testnet` | 19 (was 20) | full access `65ud…` (block 92550301) |
| `test1.duonghb3.testnet` | 99 | full access `916N…` (block 107455695), function call `8B6k…` (block 275391266, new) |
| `kdd1793327513.sputnik-v2.testnet` | 7 | none (DAO contract; 6 NEAR create deposit + 1 NEAR proposal bond) |

State below was read after step 7, before steps 8 and 9 (`bot2` paid another 1 NEAR bond, the DAO now holds 8 NEAR).

Proposal 0: `InProgress`, `vote_counts` `{"council":[1,0,0]}`, votes `{"bot1.duonghb3.testnet":"Approve"}`, proposer `bot2.duonghb3.testnet`. One more approval passes it.

## What this shows

- The voter-key rule fired once, for the voter with the fresh full-access key (`bot1`). `bot2` and `test1` have old keys and raised nothing.
- The key ages are far outside the 48-hour window, so no 48-hour wait was needed.

## Not done yet

- `/changes` after the daily job.
- Revoke test in Meteor Wallet: the dashboard has no Revoke or Delete buttons yet (blocked on O5, then C4).

## Cleanup after the demo

- Delete `Ga9K…` from `bot1.duonghb3.testnet`.
- Delete `8B6k…` from `test1.duonghb3.testnet` after the revoke test.
