# Harness Maturity — H0 to H5

Six levels of harness maturity. Each level has measurable criteria. Target: reach H2, then grow from friction.

## Levels

### H0 — Bare Environment
- Agent has access to the codebase.
- No docs, no templates, no constraints.
- Every task starts from scratch.

### H1 — Documented Intent
- `README.md` exists with project overview.
- `CLAUDE.md` exists with basic instructions.
- No structured intake or validation.

### H2 — Durable State *(current target)*
- Operating model documented (`HARNESS.md`).
- Feature intake gate exists (`FEATURE_INTAKE.md`).
- Story packets with acceptance criteria.
- Decision records for key choices.
- Context rules tell agents what to read.

### H3 — Observability
- Agent work is recorded (traces, logs).
- TEST_MATRIX tracks proof per story.
- Harness backlog captures friction.
- Agent memory persists across sessions.

### H4 — Self-Correction
- Agents update harness docs after every task.
- Friction → backlog → fix cycle is working.
- Maturity ladder is reviewed and updated.
- Component taxonomy shows all "covered" or "partial".

### H5 — Self-Improving
- Harness proposes improvements proactively.
- Patterns are extracted from repeated friction.
- Metrics track harness effectiveness.
- New team members can onboard from docs alone.

## Current Status

- **Level**: H1
- **Next milestone**: H2 — add story packets, decision records, context rules
- **Blocking gaps**: _(list what's missing to reach next level)_
