# High-Risk Story: GĐ1 scan library — Validation Plan

## Contract

`scanAccount` and `scanDao` return a `kd.report.v1` that meets every AC in `overview.md` (S1-AC1 to S4-AC3). They reject a bad target before any `fetch` and pin every query to one block. They stay within the caps of `docs/design/gd1-scan.md` §9 and echo no URL or RPC text. GĐ1 is **built** when S1 to S4 pass. It is **done** only after the owner records the design §11 live-run checklist in `packages/key-doctor/fixtures/README.md` (decision 0001).

All files are under `packages/key-doctor/`. Proof runs with `npm test -w key-doctor` (`node --test "test/**/*.test.ts"`) and `npm run typecheck`. The test file names below are proposals. The test author can rename them.

## Proof Levels

### Unit Tests

Pure functions, no `fetch`.

- **Test files**: `test/parse.test.ts`, `test/age.test.ts`, `test/rules.test.ts`, `test/messages.test.ts`, `test/build-member.test.ts`, `test/thresholds.test.ts`
- **Key assertions**:
  1. S1-AC3: age per design §5. A height at `GENESIS_HEIGHT[network]`, at the head, below genesis, above the head, and `h === 0`. Unknown age on an FA key gives `FA_OLD`.
  2. S1-AC4: `resolveTarget` over the regex edges (length 1, 2, 64, 65), implicit, `0x` target, `0x` member, suffix conflict, no suffix, `blockHeight` 0, 1.5, `2**53`.
  3. S1-AC2, S2-AC1, S3-AC3: each rule at its threshold and one below. `FA_MANY` suppresses `FA_MULTIPLE`. `PQ_NONE` carries no key ids. `FC_DAO_VOTE` ignores a non-council member and a key limited to `add_proposal`.
  4. S1-AC6, S3-AC4: `buildMember` status and counts per design §7, including an errored member, a missing member and only-note flags.
  5. S3-AC2: council, `dao.roles`, `transfer_vote_policy`, `approvals_needed` (`[1,2]` on 3 members gives 2), the admin role and the three limitation lines of design §4.
  6. S3-AC6: every rule id, every member error code and every `kd.error.v1` code gives non-empty `vi` and `en`. `LIMIT_EXCEEDED` text names the cap value from `thresholds.ts`.
  7. S1-AC7: a source scan of `src/`. No `node:*` import, `fetch` only in `rpc.ts`, no threshold literal in rule and scan files, `ruleset_version === RULESET_VERSION`.

### Integration Tests

- **Boundary**: `scanAccount` and `scanDao` with a stubbed `globalThis.fetch` that answers by `method`, `params.request_type` and `params.account_id` from `fixtures/rpc/`. The stub records every request body.
- **Test files**: `test/rpc.test.ts`, `test/scan-account.test.ts`, `test/scan-dao.test.ts`, `test/corpus.test.ts`
- **Key scenarios**:
  1. S1-AC1, S3-AC1: every recorded request after `block` carries `block_id: 182340111`, `get_policy`, key lists and receivers too.
  2. S2-AC3: `scanAccount("b.kd-demo.testnet")` deep-equals `account-b.report.json` except `generated_at`.
  3. S3-AC1: `scanDao("kd-demo.sputnik-dao.testnet")` deep-equals the updated `dao-kd-demo.report.json` except `generated_at`.
  4. S1-AC4: an invalid target records zero `fetch` calls.
  5. S1-AC5: HTTP 429, HTTP 500, abort, network `TypeError`, non-JSON body, a body with neither `result` nor `error`, and each named cause map per design §3. The 15 s timeout runs with mock timers, and a stalled body read also times out. `isKdError` is true. `message`, `kd.message` and `cause` hold no URL and no body text. Use a stub URL that holds a fake API key and assert it never appears.
  6. S1-AC5: an empty key list triggers the `view_account` follow-up. `UNKNOWN_ACCOUNT` on the target throws `NOT_FOUND`. A target over `MAX_KEYS` throws `LIMIT_EXCEEDED`.
  7. S2-AC2: each distinct receiver gets one request. `UNKNOWN_ACCOUNT` gives `false`. Another failure gives `null` and a `receiver <id>: <CODE>` line. `skipReceiverCheck`, an over-budget receiver and a receiver id that fails the regex give `null`, one limitation line and no request. FA keys carry no `receiver_exists`. A receiver equal to the scanned DAO gives `true` with no request.
  8. S3-AC4: a member key-list failure, a member over `MAX_KEYS`, a missing member, the `errors[]` order, the member sort, and all members errored (`members_scanned: 0`, status `note`). The scan still returns a report.
  9. S3-AC5: `get_policy` with `UNKNOWN_ACCOUNT` (`NOT_FOUND`), `NO_CONTRACT_CODE`, `CONTRACT_EXECUTION_ERROR`, `result.error` and bad bytes (`NOT_A_DAO`), and `GARBAGE_COLLECTED_BLOCK` (`RPC_ERROR`, `retryable: false`). Roles over `MAX_ROLES` and a council of 22 throw `LIMIT_EXCEEDED` before any key-list request.
  10. S3-AC5: the stub tracks requests in flight. At most 4 at default concurrency. `concurrency` 0 and 9 clamp to 1 and 8.
  11. S3-AC5: a DAO has 21 council members, and all have empty key lists. The scan sends 44 requests or fewer (1 `block`, 1 `get_policy`, 21 key lists, 21 follow-ups). Receivers fill only `REQUEST_BUDGET - used` slots. The total never exceeds 45.
  12. S4-AC1, S4-AC2: each `fixtures/corpus/*.json` file runs through its scan. The rule's presence equals `fires`. `LIMIT_NON_GROUP_ADMIN.json` gives the "policy changes" line and no `DAO_ADMIN`. The test counts 26 rule files plus the limitation file and fails on a missing rule id.

### Fixture invariant change (S3)

S3 changes `test/fixtures.test.ts:60-63`. The invariant "member status is not above its highest flag severity" skips members with `error !== null` or `account_kind === "missing"`. Such members have status `note` and no flags. This is a test-side change, so it is not in the builder file lists.

### E2E Tests

- **User flow**: the owner's live testnet run (design §11). It is not an automated test.
- **Steps**:
  1. Run `node packages/key-doctor/scripts/scan.ts <testnet DAO> --dao --save-raw <dir>`, plus the missing-account, future-block, non-contract and non-DAO cases of checklist item 1.
  2. Record each of items 1 to 7 in `packages/key-doctor/fixtures/README.md` as `confirmed` or `differs: <value>`, with the account or DAO name and block height.
  3. Expected outcome: GĐ1 moves from "built" to "done". A `differs` item opens a fix before GĐ3 relies on it.
- **S1-AC8 script checks** (integration level, spawn the script with a stubbed RPC or run by hand): `--save-raw` writes `<n>.<method>.json` bodies and never the URL. `scan foo.near --save-raw d` is refused with no `--network` flag.

### Platform Checks

- [ ] `npm run typecheck` passes. `tsconfig.src.json` (`"types": []`) rejects `Buffer`, `process` and `require` in `src/`.
- [ ] `npm test` passes at the root.
- [ ] Diff coverage above 90% on `packages/key-doctor/src/` (`node --test --experimental-test-coverage`).
- Migration, container build and deploy checks do not apply. GĐ1 has no schema and no deploy.

## Security Validation

- [ ] Input validation covers all external inputs (scenarios 4, 7, unit 2). These are the target id, `opts.network`, `opts.blockHeight`, and member and receiver ids from chain data.
- [ ] No URL, response body, `error.data` or `error.message` in any thrown error or `errors[]` line (scenario 5).
- [ ] `KdErrorException` never sets `cause` (scenario 5).
- [ ] Caps apply before the work they bound (scenarios 9, 11).
- [ ] `--save-raw` refuses mainnet (S1-AC8).
- Auth checks, SQL injection and rate limiting do not apply. The library has no route and no database.

## Evidence Template

```
[YYYY-MM-DD] <command>: <result>
```

(Filled in after each proof level is run.)

## Sign-Off

- [ ] All proof levels pass
- [ ] No critical findings unresolved
- [ ] `docs/TEST_MATRIX.md` rows for gd1-scan updated
- [ ] Security review complete (high-risk)
- [ ] Lead dev approved
- [ ] Owner live run recorded (GĐ1 done, not only built)
