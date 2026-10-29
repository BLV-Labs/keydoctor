# New requirement — Phase 1 and Phase 2 detail

Read this file when the request is a new requirement or a fresh feature idea, not an existing story with a current packet.

## Phase 1: the PO writes the requirements first

The PO produces the requirements write-up before the Lead Dev weighs in. Phase 2 starts with the PO's case and the Lead Dev's challenge. The Lead Dev needs a written case to challenge.

Source order:

1. **A PRD or spec exists.** The user supplies one, or a `docs.stories` packet or `docs/proposals/` write-up holds it. The PO works from it and does not derive it again. The PO mines it for what is missing: unstated edge cases, situations the spec skips, and contradictions between goals.
2. **No spec exists.** The PO derives one: feature name (kebab-case), problem statement, target users and key user stories. It also lists the cases and situations the feature must survive, not only the happy path. The PO skips what memory or the prompt already answers. The PO stores new answers in memory.

In both cases, the PO returns each open gap as a question with 2–4 concrete options and a recommendation. The PO does not call AskUserQuestion. The orchestrator asks the user. A vague spec is the first cause of rework. Options converge faster than open questions.

### The requirements packet

The PO lands the write-up as a story packet in `docs.stories`, or in `docs/proposals/` for a larger design. The packet holds:

- the problem,
- a **5W2H table**,
- goals and non-goals,
- measurable success criteria,
- user stories,
- cases and situations, listed from When × Who,
- constraints,
- open questions.

5W2H rows:

| Row | Content |
|---|---|
| Who | who acts, who is affected |
| What | the change and its anti-goal |
| Why | the reason and its metric |
| When | the trigger and the compatibility window |
| Where | the surface, the data owner, the boundaries the change crosses |
| How much | the scale |
| How | blank. The Lead Dev fills it. |

The PO fills every W row before Phase 2. An empty row is a finding that becomes an open question, not a skip. A tiny lane can write `n/a`, but it still writes the row.

The Lead Dev's analysis answers the engineering side of the same table: who builds, where in the code, when in the deploy sequence, and how.

## Phase 2: the PO opens, the Lead Dev challenges

The order is deliberate. If the Lead Dev proposes and the PO only reacts, the debate is about how to build what the engineer already wants. Product intent then arrives too late to change the answer. When the PO states the case first, "we should not do this" stays a possible result.

1. **The PO opens.** The PO presents the problem, the users affected and the cases from Phase 1. It also states why it matters now, the PRD issue it serves, and its priority against the queue.
2. **The Lead Dev rebuts.** The Lead Dev argues against the write-up and finds where it breaks. It asks these questions:
   - What does it cost: build time, complexity kept forever, the work it displaces?
   - What breaks: compatibility with live data, enums, queued job payloads or RPC contracts? A hot query with no index? Cross-tenant isolation? The API auth surface? The blast radius on prod?
   - Is the problem real?
   - Is there a cheaper way: smaller scope, an existing utility, or no change?
   - Where is the spec ambiguous enough that the team builds the wrong thing?
3. **The Lead Dev scores every 5W2H row** with the scale in `references/metrics.md` § 2. These rows bounce:
   - a blank row,
   - a row stated as settled and wrong,
   - a row that is open in one place and answered silently elsewhere in the same document. The plan then rests on a guess that the document itself flagged.
4. **Both discuss.** The goal is a shared, written verdict, not a winner. For each disputed point, write **ưu điểm / nhược điểm** (what we gain, what we pay) and **được mất** (the net, against not doing it). Some proposals die here, and that is a success. If the Lead Dev's objection is fatal and has no fix, say so and stop.
5. **The Lead Dev refines what survives:** scope, approach, the BE/FE split, parallel or sequential.

The Feature Decision records each disagreement and how it closed. A decision with no tension usually means step 2 did not happen. Report that. Do not invent objections.

### Design write-up

For a new requirement, the Lead Dev writes a design section in the story packet or in `docs/proposals/feature-<name>.md`. The Lead Dev searches memory for conventions first. The section holds a mermaid architecture diagram, components, tech choices, data models, API contracts (RPC, GraphQL or REST), trade-offs and NFRs.

The PO then checks the design against the requirements. Every goal, story and constraint needs design coverage. The PO flags each gap.

Both agents then run a clarify-and-explore loop:

1. Ask a specific question for each gap or contradiction.
2. List alternatives with their pros and cons.
3. Challenge the first answer.
4. Repeat until the two agents agree.

## Prototype lane (optional, for high-uncertainty UI)

Use it when the design space is wide and a prototype is cheap. Build 2–3 throwaway prototypes instead of more spec. Pick the winner, then write its spec. Prototypes are spikes. They have no gate, nobody merges them, and the team discards them after the decision.
