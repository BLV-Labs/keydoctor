# Writing rules (STE-based)

Every brief, packet, review, and report in a dev-team flow follows these rules. The reader is an agent or a busy human. Neither can ask the author what a sentence means.

The rules come from ASD-STE100 (Simplified Technical English), through `danyuchn/asd-ste100-skill` (MIT). They cover sentence shape only. They do not use the STE dictionary.

## Two modes

| Mode | Use it for |
|---|---|
| **Strict** | Builder briefs, kestrel bug relays, agent prompts, error and log strings, ACs |
| **Flavored** | Story packets (except the AC list), ADRs, PR bodies, heron and osprey reports |

Strict applies every rule below. Flavored applies the structural rules and treats rule 9 (one name per thing) as advice.

## Structural rules

1. One instruction per sentence.
2. Max 20 words for an instruction. Max 25 words for a description.
3. Active voice. Say who acts: `The processor deletes the row`, not `The row is deleted`.
4. No semicolons. Write two sentences.
5. Max 3 nouns in a stack. "The export job request budget knob" → "the knob that caps export requests".
6. Use the verb, not the noun: "check the log", not "perform a check of the log".
7. No phrasal verbs: `start`, not `spin up`. `remove`, not `take out`.
8. Use a list for 3 or more steps or conditions.
9. One name per thing. Do not mix "session", "cookie", and "account" for the same object.

## Keep the claim exact

- Keep every hedge. "May have failed" stays "may have failed". A shorter sentence that turns a hedge into a fact is a different claim.
- Add no fact the source did not state.
- Keep a number, a scope, or a condition even if the sentence gets longer.
- Stop when the sentence is clear. Shortest is not the goal.

## Scan before you send

Delete or fix these six habits:

1. Synonym rotation (rule 9).
2. Stacked hedges: "it is important to note that this may potentially help".
3. Nouns that hide an action (rule 6).
4. Sales words such as `robust`, `seamless`, `powerful`. Give the number instead.
5. Run-on sentences joined by semicolons or dashes.
6. Phrasal verbs (rule 7).

## Diagram first

A story packet opens with one mermaid diagram of the changed path. Use a `sequenceDiagram` for a request path and a `flowchart` for a data path. Mark these on the diagram:

- each network call and its endpoint,
- each failure exit (session wall, 302, 403, timeout) and where the code catches it,
- each write (table name).

The 2.7 red-team checks that the diagram matches the ACs. A path in an AC that is not on the diagram is a finding.

## Lint

`scripts/ste-lint.py` checks the structural rules. It skips fenced and inline code. It never flags hedges.

```bash
python3 .claude/skills/dev-team/scripts/ste-lint.py <file>
```

- **New packet:** 0 hard violations.
- **Amended packet:** hard violations do not go above the `origin/<integration_branch>` count. Get the count with `git show origin/<integration_branch>:<file> | python3 .claude/skills/dev-team/scripts/ste-lint.py`, then pass it as `--baseline N`.
- Passive voice and present perfect are advisory. They never fail the lint.
- **One pass.** Lint every changed file in one command (`for f in <files>; do python3 .claude/skills/dev-team/scripts/ste-lint.py "$f"; done`). Fix every flagged line of a file in one edit, then lint once more. Do not lint, fix and lint again one line at a time.
- **Big tables** (`docs.test_matrix`): change all rows in one python call. Do not make one Edit per row.
