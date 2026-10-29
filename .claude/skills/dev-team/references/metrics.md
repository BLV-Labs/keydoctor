# Feature metrics — what to record, how to score

Two measurements. Both cheap, both written by an agent already holding the packet.

## 1. Per-feature ledger (Phase 5, the PO appends one row)

File: `docs/FEATURE_METRICS.md`. Append-only — never rewrite a past row.

| Field | Where it comes from |
|---|---|
| feature / story id | the packet |
| lane | the packet |
| `bounce_2x3` | the backward-loops counter (b): defects crossing the Phase 2 ⇄ Phase 3 boundary. **This is the signal.** A spec that asked the right questions up front crosses that boundary less. |
| `bounce_3to3` | the same gate rejecting for a *code* root cause. **This is the control.** Sharper upfront questions should not move it. If both counters fall together, something other than the spec changed — model, scope, or luck — and the drop proves nothing. |
| `open_at_2_exit` | questions still unanswered when Phase 2 crossed the approve gate, counted off the Feature Decision |
| `assumed_at_2_exit` | of those, how many the plan commits to an answer for anyway (level 1 below) |
| `callers_missed` | consumers of a changed contract that the Phase 4 blast-radius check found and no earlier phase had listed |
| `notes` | one line; anything that makes the row un-comparable — scope changed mid-flight, a phase was skipped |

Read it as a trend, never as a score. Rows differ in size and lane, and the sample is small for a long time. `bounce_3to3` exists to tell you whether a fall in `bounce_2x3` is real.

## 2. Scoring a Phase-1 question (the Lead Dev, in Phase 2)

The PO is **not** required to answer Who-affected / When / Where. Answering some of them takes investigation a requirements doc cannot do. The PO's job is to turn a silent assumption into a stated blocker. Score each row on that, not on whether it produced an answer.

| Score | State |
|---|---|
| **2** | Surfaced as an open question, and nothing else in the document commits to an answer |
| **1** | Surfaced, but elsewhere the plan is built on one particular answer to it |
| **0** | Not surfaced |
| **−1** | Stated as settled fact, and wrong |

**Level 1 is the dangerous one, not level 0.** A blank row gets caught at the Phase 2 gate on sight. A row that asks "which license tier holds this capability?" on page one and then designs against "the free tier has it" on page three reads as diligence and ships the guess regardless. Treat it as a Phase 2 bounce, exactly like a blank.

**What counts as a real blocker:** answering it differently changes the shape of the plan — a slice appears or disappears, a boundary moves, a dependency is added. If every answer leads to the same slices, it is a Phase 3 question, not a gate. Count the false ones too: a process that scores well by asking about everything has bought nothing and costs a phase.
