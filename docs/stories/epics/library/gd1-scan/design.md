# High-Risk Story: GĐ1 scan library — Design

The design is `docs/design/gd1-scan.md`. This file points to it by section and holds no copy. Read only the section a slice needs.

## Architecture

| Topic | Section | Lines |
|---|---|---|
| Flow and error edges | §1 Flow | 5-48 |
| Files and what each owns | §2 Modules | 49-65 |
| RPC calls, error mapping, `errors[]`, member errors, limitation lines | §3 Errors | 66-99 |
| Council, vote policy, admin role, `dao` block | §4 Council | 100-125 |
| Key parsing and age from the nonce | §5 Age | 126-136 |
| The 13 rules, flag order, evidence, error text | §6 Rules | 137-172 |
| Status, summary, counts, member sort | §7 Summary | 173-188 |
| `resolveTarget`, id regex, network | §8 Targets | 189-198 |
| Security, caps, request count, worst-case time | §9 Security | 199-219 |
| Slices, files, fixtures, ACs, build order | §10 Slices | 220-260 |
| Owner live-run checklist | §11 Live-run | 261-273 |

## Builder notes (round 3 fixes, these win over the design text)

1. Design line 64 says "The package imports no `node:*` module". Read it as: no file under `packages/key-doctor/src/` imports `node:*`. The script `packages/key-doctor/scripts/scan.ts` may import `node:fs`.
2. `packages/key-doctor/tsconfig.src.json` typechecks `src/` with `"types": []`. So `Buffer`, `process` and `require` in `src/` fail the typecheck. Adding `scripts` to the `include` of `packages/key-doctor/tsconfig.json` does not change that. Use `TextDecoder`, `atob` and `globalThis` in `src/`.

## Data Model

### Schema Changes

None. No D1 table and no migration. `packages/key-doctor/src/types.ts` does not change. `Flag.rule_id` stays `string` and `ScanOptions` stays as it is (design line 3).

### Migration Strategy

Not applicable.

### Rollback Plan

Revert the slice commits. The library has no consumer on `main` yet.

## API Contract

### New / Modified Exports (`packages/key-doctor/src/index.ts`)

- S1: `scanAccount`, `resolveTarget`, `KdErrorException`, `isKdError`, `RULESET_VERSION` (design line 259).
- S3: `scanDao`.
- The output is `kd.report.v1`. Thrown errors carry `kd: KdError` (`kd.error.v1`).

### Breaking Changes

None. The existing `export type * from "./types.ts"` line stays.

## Domain Rules

- Rules and thresholds: design §6 and §9 item 4. Every number lives in `rules/thresholds.ts`.
- Council and admin role: design §4.
- Status and counts: design §7. `members_ok` counts `ok` plus `note` (decision 0002).
- A missing council member: design §3 and §6. Status `note`, no flag, one limitation line.

## Security Considerations

- **Auth**: none in the library. Callers own auth.
- **Input validation**: design §8 and §9 item 1. Validation runs before any `fetch`. Member and receiver ids from chain data pass the same regex.
- **Data sensitivity**: an `rpcUrl` can hold a provider API key. Error text is fixed per code and echoes no URL and no body (design §9 item 2).
- **Attack surface**: server-side request forgery through `opts.rpcUrl` (design §9 item 3). Unbounded work from large policies or key lists (design §9 item 4).

## R.E.S.T Targets

| Pillar | Target |
|---|---|
| Reliability | A per-member failure never fails the scan. Same block and same RPC answers give the same report apart from `generated_at` (design §7). |
| Efficiency | At most 45 requests per scan and at most `concurrency` in flight (default 4, clamped to 1..8) (design §9). |
| Security | Zero `fetch` calls for an invalid target. No URL, body or `cause` in any error (design §9). |
| Traceability | Every query after `block` carries one `block_id`. `ruleset_version` is `RULESET_VERSION` (design §3, §10). |
