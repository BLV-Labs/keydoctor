# Feature Intake — Classification Gate

Every prompt enters through this gate before any code is written.

A prompt that names a design handoff, mockup, or spec artifact is **still a prompt**. The
artifact is an input to this gate, not a bypass around it — search `docs/stories/` for an existing
packet before deriving one from the artifact.

## Step 0: PRD Gate

Before classifying, locate the governing requirement per
[`docs/PRD.md` § PRD Gate](PRD.md). File a missing task; stop and ask if the parent epic is also
missing; comment (don't rewrite) on a malformed human-authored entry. Harness improvements need
no PRD entry and skip straight to Step 1.

## Step 1: Classify Input Type

| Type | Description | Example |
|---|---|---|
| **New spec** | Full feature or system from scratch | "Build a notification system" |
| **Spec slice** | Subset of a larger spec | "Just the email channel for notifications" |
| **Change request** | Modify existing behavior | "Make the notification API async" |
| **New initiative** | Non-feature work (perf, infra, tooling) | "Add APM to the API" |
| **Maintenance** | Bug fix, dependency update, refactor | "Fix the broken migration" |
| **Harness improvement** | Change to docs, templates, or process | "Add a template for API routes" |

## Step 2: Risk Lane

Classify into one of three lanes. Use the checklist below.

### Tiny Lane
- Single file change
- No schema/enum/status changes
- No auth/authorization impact
- No external API calls
- No queue/job changes
- No state machine changes
- Reversible without migration
- No product doc updates needed
- No TEST_MATRIX row changes
- No decision record needed

**Process**: implement → verify → done. No story packet needed.

### Normal Lane
- Fewer than 5 files
- Schema changes with migration
- New or modified API routes
- New queue jobs
- Changes to existing product behavior
- Needs TEST_MATRIX updates

**Process**: story packet → implement → test → review → done.

### High-Risk Lane
- Cross-cutting (auth, payments, data model)
- Irreversible (data migration, enum change, public API)
- Security-sensitive (user input, external calls, PII)
- Multiple teams or systems affected
- New state machine or status enum
- Touches a surface listed in the profile's `high_risk` (`.claude/dev-team.md`)

**Process**: story packet (4-file folder) → design review → implement → security review → test → review → done.

## Risk Checklist

Score each item. 3+ checks in high-risk = high-risk lane.

| # | Check | Tiny | Normal | High-Risk |
|---|---|---|---|---|
| 1 | Schema/enum/status change? | No | Maybe | Yes |
| 2 | Auth or authorization impact? | No | No | Yes |
| 3 | External API or service call? | No | Maybe | Yes |
| 4 | Queue or background job? | No | Maybe | Yes |
| 5 | State machine change? | No | No | Yes |
| 6 | Irreversible without migration? | Yes | Maybe | No |
| 7 | Security-sensitive surface? | No | No | Yes |
| 8 | Multiple systems affected? | No | Maybe | Yes |
| 9 | Public API contract change? | No | Maybe | Yes |
| 10 | Needs decision record? | No | Maybe | Yes |

## Step 3: Locate Artifacts

| What | Where |
|---|---|
| Governing PRD entry (vision / epic / task) | `docs/final-idea.md` (then `docs/usecase.md`) — see `docs/PRD.md` |
| Story packet | `docs/stories/epics/<epic>/<story>.md` |
| Product docs | `docs/product/<contract>.md` |
| Test matrix rows | `docs/TEST_MATRIX.md` |
| Decision records | `docs/decisions/` |
| Architecture rules | `docs/ARCHITECTURE.md` |

## Step 4: Produce Work Plan

For **tiny lane**: state the change, verify, done.

For **normal lane**: fill in or create a story packet with:
- Product contract (what behavior must be true)
- Acceptance criteria
- Design notes
- Validation expectations (which TEST_MATRIX columns)

For **high-risk lane**: fill in the 4-file story folder:
- `overview.md` — what and why
- `design.md` — how (architecture, data, API)
- `execplan.md` — step-by-step implementation plan
- `validation.md` — proof expectations at every level
