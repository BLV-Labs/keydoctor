# 0001 — GĐ1 done-when: fixture corpus plus one owner live run

- **Date**: 2026-10-29
- **Status**: Accepted 2026-10-29
- **Decider**: owner, 2026-10-29
- **Story**: `docs/stories/epics/library/gd1-scan/`

## Context

The GĐ1 row of `docs/final-idea.md` §13.3 (`docs/final-idea.md:874`) says GĐ1 is done when the scanner "scans the 20 prototype accounts correctly" ("Quét đúng 20 account của prototype"). The repo holds no list of those 20 accounts. `CLAUDE.md` also forbids real mainnet DAO and account names in fixtures and the demo. The scanner relies on recalled facts: RPC cause names, genesis heights, the ML-DSA key prefix and Sputnik `policy.rs` rules. Only a live run can check them.

## Decision

1. A fixture corpus replaces "scan the 20 prototype accounts". It holds one positive and one negative case per rule, under `packages/key-doctor/fixtures/corpus/` (design `docs/design/gd1-scan.md` §10, slice S4).
2. The owner runs one live testnet scan with `packages/key-doctor/scripts/scan.ts --save-raw` and checks items 1 to 7 of design §11.
3. GĐ1 is **built** when slices S1 to S4 meet their ACs. GĐ1 is **done** only after the owner records the §11 run in `packages/key-doctor/fixtures/README.md`, with the testnet DAO name and block height.

## Alternatives Rejected

- **Scan the 20 prototype accounts**: no list exists in the repo, and the names could be mainnet accounts, which `CLAUDE.md` forbids.
- **Fixtures only, no live run**: the recalled RPC and Sputnik facts would stay unchecked before GĐ3 and GĐ4 build on them.
- **An automated live run in `npm test`**: it depends on the network and a public RPC rate limit, so the suite would not be deterministic.

## Consequences

**Positive**:
- Each rule has a reproducible proof at its threshold.
- The live run checks the facts that fixtures cannot check.

**Tradeoffs**:
- GĐ1 stays "built" until the owner finds time for the run. Status reports must use "built" until then.
- The text at `docs/final-idea.md:874` no longer matches. The spec is human-authored, so this record does not edit it. The owner can update the row.

**Revisit trigger**: a `differs` item in the §11 checklist, or a public list of the prototype accounts on testnet.
