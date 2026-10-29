# Dashboard design handoff

The approved mockup for `apps/dashboard` (GĐ7, GĐ8). Build the dashboard from this folder.

| File | What it is |
|---|---|
| `mockup/*.dc.html` | Source of each screen from the design canvas. Read the markup for layout, copy and states. The files need the canvas runtime (`support.js`) to render, so treat them as reference, not as code to ship. |
| `mockup/canvas.json` | Screen list and order. |
| `tokens.css` | Colors, type, radii, focus ring. Use these variables; do not hard-code hex values in components. |

Data is the GĐ0 testnet fixture (`packages/key-doctor/fixtures/reports/dao-kd-demo.report.json`), with one change listed under "Open items".

## Principles

- **Fixed rules decide, the page explains.** Every flag shows `messages.en` (title, explain, fix) verbatim from `kd.report.v1`. The UI writes no risk text of its own.
- **Status is never color alone.** Each status has an icon, a text label and a color: High risk (triangle), Cleanup (circle-alert), Note, OK (check).
- **Key Doctor never signs.** Delete and Revoke build a transaction; Meteor Wallet opens and the user signs there. Adding an ML-DSA key is a link to Meteor.
- **English UI.** `messages.vi` stays in the library for the Telegram bot.
- **Testnet names only** in examples and placeholders.

## Screens

| # | File | Route (proposed) | Purpose | Data |
|---|---|---|---|---|
| 1 | `Main.dc.html` | `/` | Enter an account or DAO; examples; "one account or a whole council"; network stats | `data/` stats (GĐ10) |
| 2 | `Council.dc.html` | `/?target=<dao>` | DAO report: status, summary tiles, members sorted by risk, voting rules, scan limits | `summary`, `members[]`, `dao`, `limitations` |
| 3 | `Account.dc.html` | `/?target=<account>` | Account profile: new-key alert, issues, every key with Delete / Revoke | `members[0]`, `keys[]`, `flags[]` |
| 4 | `Cleanup.dc.html` | `/?target=<account>&view=cleanup` | UC8 plan: urgent action, two levels, 5 steps ticked from chain data | `keys[]`, `flags[]`, rescans |
| 5 | `Watch.dc.html` | dialog | Telegram alerts (MVP): open bot, copy `/watch <target>`; "You will get" depends on target type | `target` |
| 6 | `DeleteKey.dc.html` | dialog | Confirm deleting a full-access key, then open Meteor to sign | one `KeyInfo` |
| 7 | `RevokeKey.dc.html` | dialog | Confirm revoking an app (function-call) key, then open Meteor to sign | one `KeyInfo` |

The `?target=` route is also the deep link the bot uses for "View on dashboard".

### 1. Main
- Input label "NEAR account or DAO", monospace, example value `kd-demo.sputnik-dao.testnet`. Network from the suffix (`.near` mainnet, `.testnet` testnet).
- Try chips (44px tall): "Personal a.kd-demo.testnet", "DAO council kd-demo.sputnik-dao.testnet".
- Submit: try `get_policy`; success means DAO (screen 2), otherwise account (screen 3).

### 2. Council report
- Header: "DAO · testnet" tag, status pill, target in mono, "Scanned at block N · <UTC time> · ruleset <ruleset_version>".
- Actions: Rescan (secondary), Get Telegram alerts (primary, opens 5).
- Tiles: Council size + "Transfers need X of Y votes" (`transfer_vote_policy.approvals_needed`), High risk, Needs cleanup, Quantum-ready.
- Members list, sorted high → cleanup → note → ok. Columns: member, status pill, "full-access / app keys", main reason (first flag's `messages.en.title` or a short summary), View →. The whole row links to screen 3.
- Voting rules card (role, threshold, bond in NEAR, Admin in policy) and "Limits of this scan" (from `limitations`).

### 3. Account profile
- Same header pattern; counts line "N full-access keys · N app keys · N ML-DSA · N never used".
- When opened from a DAO: "Opened from the council of <dao>". The checks are the same for any account.
- Red alert box when a full-access key was added in the last 48 hours (`created.block_height` vs chain head).
- "Issues found": one card per rule (grouped when a rule fires on several keys), severity pill, rule id in mono, title, explain, "Fix:".
- "Every key" table: public key (truncated `ed25519:7Hq2…Vd9K`), type (Full access / App key), added (relative age), uses, why it matters (one sentence), action.
- Wallet bar above the table, three states:
  - disconnected: "Connect Meteor Wallet as <account> to delete keys here"; actions disabled.
  - connected as the target account: actions enabled.
  - connected as another account: "Only <account> can delete its own keys: switch account"; actions disabled.
- Action per key: **Delete** for full-access (filled red for the urgent new key, outlined red otherwise), **Revoke** for app keys (outlined navy). Never enabled for the last full-access key.

### 4. Cleanup plan (UC8)
- Progress "N of 5 steps done", bar, block height it was read at.
- Urgent box first when a suspicious new full-access key exists: "Delete this key now" (opens 6).
- Level toggle (`aria-pressed`): Safe cleanup / Go fully post-quantum. It changes the step-4 key list.
- Steps, with the "done when" rule from `docs/usecase.md` UC8:
  1. Revoke unneeded app keys: list with Revoke buttons; "Revoke all" for several (one transaction).
  2. Add an ML-DSA key: link to Meteor; "I did it, rescan".
  3. Test-sign with ML-DSA.
  4. Delete old Ed25519 full-access keys: ordered list (never used first, oldest first), "Keep:" line, three confirmations, then "Delete N keys (one transaction)". The button stays disabled with "Still needed: …" until step 3 is done and all boxes are ticked.
  5. Rescan.

### 5. Telegram alerts
- One dialog for every target. Steps: open `@KeyDoctorOnCallBot`, copy `/watch <target>` (button turns into "Copied"), group hint.
- "You will get": every target gets the daily key comparison (02:00 UTC). A DAO also gets the pre-vote warning (every 15 minutes) and governance / upgrade proposal warnings. An account gets a hint to also watch its DAO.
- The page stores nothing; `/list` and `/unwatch` live in the bot.

### 6. Delete a full-access key
- `alertdialog`: key, added, uses, "Left after this: N full-access keys".
- Two checkboxes (seed phrase or device loses access; not the key Meteor uses now) and "type the last 4 characters of the key".
- "Open Meteor to sign" enabled only when all three are done. After the transaction lands: rescan, key leaves the list.

### 7. Revoke an app key
- Lighter `alertdialog`: key, app contract, permission, uses; "the app will ask you to connect again". No typing step.

## Interaction and accessibility rules

- Focus ring on every link, button and input (`tokens.css`). Dialogs: real `<button>` for close, focus trap, Esc closes, focus returns to the trigger.
- Controls at least 44px tall. Real `<button>`, `<a href>`, `<input>` + `<label>`; `aria-label` on icon-only buttons; decorative SVG `aria-hidden`.
- Links that leave the site (`t.me`, Meteor) open a new tab with `rel="noopener"`.
- Respect `prefers-reduced-motion`.
- Wide tables sit in an `overflow-x: auto` box at desktop width; on phones, switch to one card per member or key.

## Not in the mockup yet (build these states too)

- **Scanning:** members appear one by one as their keys load (§10); skeleton rows with `aria-busy`.
- **Errors:** invalid name, not found, not a DAO, RPC error (`kd.error.v1` messages); a member row "Couldn't read this account. Retry" (`members[].error`).
- **DAO flags** section (`dao_flags`: `DAO_ADMIN`, `COUNCIL_SMALL`).
- **Network stats** page (GĐ10 numbers and how to reproduce them).
- **Phone layouts** for the tables.
- P1: watch-link dialog with `link_private` / `link_group`.

## Open items

- **Fixture drift:** the mockup gives `a.kd-demo.testnet` one app key (`game.kd-demo.testnet`, any method, unlimited allowance) and `FA_OLD` on its two keys older than 2 years. Update `dao-kd-demo.report.json` to match in GĐ1.
- **Spec change pending:** in-app Delete / Revoke through Meteor is not yet in `docs/final-idea.md` (it lists "cleanup in app" under Roadmap §15; UC8 says every step happens in Meteor). Needs the human owner's go-ahead to update UC8, §10, §14.2, §15 and close T6.
- **Verify on testnet first (#14):** Meteor via wallet-selector signs `DeleteKey` for a full-access key, and accepts several `DeleteKey` actions in one transaction.
- The Meteor link `https://wallet.meteorwallet.app` is unverified.
