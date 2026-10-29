# HTML reports (answer-me-with-html)

Some dev-team output is easier to read as a one-page HTML report than as terminal text. `scripts/am.sh` renders a Markdown draft into one local page. It runs a pinned copy of `QingYunA/answer-me-with-html` (MIT, v0.4.7). The script checks the sha256 of the bundle and turns off the update check.

## When to render a page

Render a page when the content has one of these shapes:

- 3 or more related concepts that the reader must see together,
- a flow with branches or more than one actor,
- a comparison across 3 or more dimensions,
- a hierarchy or a sequence of phases.

Use plain text for a short answer, a command, or a code change. Use plain text when the user asks for it.

Always render these four outputs:

| Output | Who renders | Main components |
|---|---|---|
| heron retro report | heron | `callout` verdict, score table with `ok`/`warn`/`no` |
| osprey cost report | osprey | `callout` verdict, flow table, `limits` for tokens and time against the median |
| Phase 6 delivery summary | orchestrator | `kv` for PR, story and PRD issue, proof table, `flow` of the slices |
| Debug timeline of a failure | orchestrator | `sequence` of the requests, `callout err` for the failure point |

## How to render

1. Put the verdict first, in a `callout`. Put the evidence in the next panels.
2. Use one panel per question. Use no more than 8 panels.
3. Use real numbers only. Do not use `limits` without measured values.
4. Render with `--no-open`:

````bash
.claude/skills/dev-team/scripts/am.sh render --no-open - <<'AM_EOF'
---
title: orders-export retro
---
## Verdict
```callout warn Kestrel needed 3 rounds
One builder defect repeated across 2 flows.
```
AM_EOF
````

5. Read the output. `✓ <path>` is a success. `✗ L<line>` names the line to fix. Fix it and render again, at most 2 times.
6. The orchestrator sends the page with SendUserFile, `display: render`. A subagent returns the path in its text report.

Run `.claude/skills/dev-team/scripts/am.sh help <component>` for the syntax of one component.

## Limits

- The page is an addition. The terse text report stays, because the orchestrator relays it.
- Pages stay local in `~/.answer-me-with-html/pages/`. Do not publish them as an Artifact. They can hold internal data.
- Do not use the always-on mode or `am video`.
- The STE check in `am` applies to pages only. Packets and briefs still use `scripts/ste-lint.py`.
- Never put a secret, a cookie, or an env value on a page.
