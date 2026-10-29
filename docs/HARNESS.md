# Harness — Operating Model

> "The app is what users touch. The harness is what agents touch."

## What This Is

The harness is the deterministic shell around non-deterministic LLM agents. It governs how AI agents (and humans) turn intent into safe, validated, shipped work. It is not production code — it is the operating system that wraps production code.

**Premise**: an LLM is a non-deterministic compute unit. A harness is the deterministic environment, constraints, and feedback loops that turn raw model output into reliable engineering workflow.

## Mental Model

```
Human Intent → Feature Intake → Story Packet → Agent Work Loop → Product Delta → Validation Proof → Harness Delta → Next Intent
```

Every task produces one of two outputs:
- **Product delta** — app code, tests, API shape, data model, product docs.
- **Harness delta** — docs, templates, validation expectations, backlog items, or decision records that make the next task easier.

## R.E.S.T Pillars

Every piece of work must declare targets across all four pillars. Work missing any pillar is incomplete.

### Reliability
Stable behavior under expected and unexpected inputs.
- **Fault recovery**: resume from checkpoints after interruption.
- **Idempotency**: critical writes safely retryable.
- **Behavioral consistency**: same inputs → predictable output.

### Efficiency
Effective use of compute, time, and attention.
- **Resource control**: token budgets per scope.
- **Low latency**: meaningful feedback fast.
- **High throughput**: batch scenarios scale.

### Security
Protect system and data from unauthorized access.
- **Least privilege**: minimum permissions per sub-task.
- **Sandboxed execution**: untrusted code in isolated env.
- **I/O filtering**: prevent prompt injection, PII leaks, harmful output.

### Traceability
Enough data to understand agent decisions and behavioral history.
- **End-to-end tracing**: clear call chain from request to result.
- **Explainable decisions**: each critical decision has attribution.
- **Auditable state**: full system state at any historical point.

## PPAF Runtime Loop

Agents run a continuous 4-stage cycle:

```
Perceive → Plan → Act → Feedback → Perceive → …
```

- **Perceive**: gather input — user prompt, tool output, memory, state.
- **Plan**: reason about next step; decompose goal.
- **Act**: call tool / generate text / write state.
- **Feedback**: capture result, update context, loop.

## Six Design Principles

Checklist for every design decision:

1. **Design for Failure** — treat exceptions as norm. Every component supports fault tolerance, retry, graceful degradation.
2. **Contract-First** — every interaction = explicit machine-readable contract.
3. **Secure by Default** — least privilege, zero trust, defense in depth enabled by default.
4. **Separation of Concerns** — decide *what* ≠ *how*.
5. **Everything is Measurable** — every behavior quantified. No measure = no optimize.
6. **Data-Driven Evolution** — each run = learning opportunity. Collect → label → feedback.

## Source-of-Truth Hierarchy

1. `README.md` — project status.
2. `docs/HARNESS.md` — this file. Operating model.
3. `docs/FEATURE_INTAKE.md` — intake gate.
4. User-provided spec or prompt.
5. `docs/ARCHITECTURE.md` — system boundaries.
6. `docs/CODING_RULES.md` — coding conventions.
7. `docs/stories/` — story packets and backlog.
8. `docs/TEST_MATRIX.md` — proof status.
9. `docs/decisions/` — why choices were made.

When documents conflict, higher number defers to lower number. Surface the conflict in `docs/HARNESS_BACKLOG.md`.

## Growth-from-Friction Rule

When an agent is confused, repeats manual reasoning, or discovers a missing rule, it must either:

1. Fix the harness directly (for routine clarifications), or
2. Add a proposal to `docs/HARNESS_BACKLOG.md` (for structural changes).

The harness must get easier with every task. Friction that isn't recorded will be repeated.

## Validation Ladder

Every story must declare expected proof before implementation begins:

| Level | What | Example |
|---|---|---|
| Unit | Isolated function/logic | `pnpm --filter key-doctor exec node --test <path>` (from GĐ0) |
| Integration | Component boundary | API route + DB, service + queue |
| E2E | Full user flow | Browser session, CLI invocation |
| Platform | Deploy + infra | Migration applies, Docker builds, smoke test |

Do not mark a story "done" without evidence at the declared levels.

## Context Rules

See `docs/CONTEXT_RULES.md` for the phase-by-lane matrix that tells agents exactly what to read and what to skip for each task phase and risk lane.

## Maturity Ladder

See `docs/HARNESS_MATURITY.md` for the H0–H5 levels with measurable criteria.

## Harness Components

See `docs/HARNESS_COMPONENTS.md` for the 11-responsibility taxonomy and current coverage.
