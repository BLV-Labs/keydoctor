# Harness Backlog — Growth from Friction

Proposed harness improvements discovered during work. Each item records what happened, what hurt, and what to do about it.

**Rule**: When an agent is confused, repeats manual reasoning, or discovers a missing rule, add a proposal here.

## Template

```markdown
### [Title]

- **Discovered**: [date, story/context]
- **Current pain**: [what's hard or confusing right now]
- **Suggested fix**: [what to add/change/remove]
- **Risk**: low / medium / high
- **Status**: proposed / accepted / implemented / rejected
```

## Proposals

### GĐ2 `diffReports`: an unknown receiver is not a resolved flag

- **Discovered**: 2026-10-29, gd1-scan Lead review
- **Current pain**: the scan sets `receiver_exists` to `null` when it skips or fails a receiver check (`packages/key-doctor/src/scan.ts:122`, `:137`). A diff that reads a missing `FC_DEAD_RECEIVER` as "resolved" is wrong in that case.
- **Suggested fix**: the GĐ2 brief states: a `FC_DEAD_RECEIVER` change on a key with `receiver_exists === null` on either side is unknown, not resolved.
- **Risk**: medium
- **Status**: proposed

### GĐ4 and GĐ7 render: do not trust chain text

- **Discovered**: 2026-10-29, gd1-scan 3.7 security review
- **Current pain**: `dao.roles[].name`, `dao.roles[].members`, `transfer_vote_policy[].role` and `members[].roles` carry text from the DAO policy. A hostile policy controls it.
- **Suggested fix**: the GĐ4 and GĐ7 render briefs require escaping this text on render (Telegram HTML or Markdown, dashboard DOM). Check before filing: check the GĐ4 message format.
- **Risk**: high
- **Status**: proposed

### GĐ4 and GĐ7: show the missing-member limitation prominently

- **Discovered**: 2026-10-29, gd1-scan Lead review
- **Current pain**: a missing council member gets status `note` (decision 0002 item 4). A missing admin therefore does not raise the council status. A user who reads only the status misses it.
- **Suggested fix**: the GĐ4 and GĐ7 briefs show the missing-member limitation line next to the status, not only in the limitations list. Check before filing.
- **Risk**: medium
- **Status**: proposed

### GĐ3 and GĐ4: `rpcUrl` source and scan abort

- **Discovered**: 2026-10-29, gd1-scan design §9 item 3 and Lead review
- **Current pain**: `opts.rpcUrl` from user input is a server-side request forgery path. `ScanOptions` has no abort `signal`, so a slow scan cannot stop inside the `waitUntil` window.
- **Suggested fix**: the GĐ3 and GĐ4 briefs state that `rpcUrl` never comes from user input. Decide in GĐ4 whether `ScanOptions` gains a `signal` after GĐ4 measures the worst-case time (design §9 item 7). Check before filing.
- **Risk**: medium
- **Status**: proposed

### Library: low findings with no real input yet

- **Discovered**: 2026-10-29, gd1-scan 3.7 security review and Lead review
- **Current pain**: four items have no real input that triggers them yet. An unknown key permission in a key list throws a retryable `RPC_ERROR` (`packages/key-doctor/src/rpc.ts:105`). `res.json()` reads a body of any size. A `__proto__` vote-policy label reaches `votePolicy` (`packages/key-doctor/src/parse.ts:160`). A non-2xx response body is not cancelled (`packages/key-doctor/src/rpc.ts:72-74`).
- **Suggested fix**: fix each item when a real input or the §11 live run shows it. Check before filing: re-read each line, because later commits can move it.
- **Risk**: low
- **Status**: proposed

### Harness: two RPC stub helpers

- **Discovered**: 2026-10-29, gd1-scan Phase 3 (two test authors in parallel)
- **Current pain**: each test author wrote a stub helper: `packages/key-doctor/test/support/stub.ts` and `packages/key-doctor/test/stub-rpc.ts`. Later tests have to pick one.
- **Suggested fix**: merge them into one helper in a later cleanup. Name the helper in the test-author brief when two authors run in parallel.
- **Risk**: low
- **Status**: proposed
