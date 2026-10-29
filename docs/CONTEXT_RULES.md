# Context Rules — Phase-by-Lane Matrix

For each task phase, this matrix tells agents exactly what to read and what to skip depending on the risk lane.

**Legend**: ✅ Must read | ⚡ Should read | ⏭️ Skip

## Intake Phase

| Document | Tiny | Normal | High-Risk |
|---|---|---|---|
| `docs/PRD.md` (§ PRD Gate) | ✅ | ✅ | ✅ |
| `docs/FEATURE_INTAKE.md` | ✅ | ✅ | ✅ |
| `docs/stories/backlog.md` | ⏭️ | ⚡ | ✅ |
| `docs/ARCHITECTURE.md` | ⏭️ | ⚡ | ✅ |
| `docs/TEST_MATRIX.md` | ⏭️ | ⚡ | ✅ |

The PRD gate is ✅ in every lane, including tiny: a one-line behavior change still has to be a
behavior the PRD describes. Only harness improvements skip it.

## Planning Phase

| Document | Tiny | Normal | High-Risk |
|---|---|---|---|
| `docs/ARCHITECTURE.md` | ⏭️ | ✅ | ✅ |
| `docs/CODING_RULES.md` | ⏭️ | ✅ | ✅ |
| Story packet | ⏭️ | ✅ | ✅ (4-file) |
| `docs/decisions/` (related) | ⏭️ | ⚡ | ✅ |
| `docs/product/` (related) | ⏭️ | ⚡ | ✅ |

## Implementation Phase

| Document | Tiny | Normal | High-Risk |
|---|---|---|---|
| `docs/CODING_RULES.md` | ⚡ | ✅ | ✅ |
| `docs/ARCHITECTURE.md` | ⏭️ | ⚡ | ✅ |
| Story packet | ⏭️ | ✅ | ✅ |
| `AGENTS.md` task loop | ⏭️ | ⚡ | ✅ |

## Validation Phase

| Document | Tiny | Normal | High-Risk |
|---|---|---|---|
| `docs/TEST_MATRIX.md` | ⏭️ | ✅ | ✅ |
| Story packet (validation section) | ⏭️ | ✅ | ✅ |
| `docs/templates/validation-report.md` | ⏭️ | ⏭️ | ✅ |

## Trace Phase

| Document | Tiny | Normal | High-Risk |
|---|---|---|---|
| Story packet (evidence section) | ⏭️ | ✅ | ✅ |
| `docs/TEST_MATRIX.md` (update rows) | ⏭️ | ✅ | ✅ |
| `docs/HARNESS_BACKLOG.md` (if friction) | ⚡ | ⚡ | ⚡ |
| Decision record (if choice made) | ⏭️ | ⚡ | ✅ |
