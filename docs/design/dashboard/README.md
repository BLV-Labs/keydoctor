# Dashboard design handoff

The approved mockup for `apps/dashboard` (GĐ7, GĐ8). Build the dashboard from this folder.

| File | What it is |
|---|---|
| `mockup/*.dc.html` | Source of each screen from the design canvas. Read the markup for layout, copy and states. The files need the canvas runtime (`support.js`) to render, so treat them as reference, not as code to ship. |
| `mockup/canvas.json` | Screen list and order. |
| `tokens.css` | Colors (light and dark), type scale, radii, focus ring. Use these variables; do not hard-code hex values or font sizes in components. |

## Themes and density

- **Two themes.** Light is `:root`; dark is `:root[data-theme="dark"]`. `public/theme-init.js` sets `data-theme` before the first paint (saved choice, else the system setting); the header switch saves the choice. Every text/background pair passes WCAG AA in both themes (`test/ui.test.ts` checks it). In the mockup, each screen has a **theme** tweak (Tweaks panel) and the page screens a header switch.
- **Type scale** (`--kd-fs-*`): 11 column heads · 12 tags · 13 meta, notes, row buttons · 14 body, tables, dialogs · 16 card titles, inputs · 18 section titles · 24 page title, tile values · 36 home hero. Inputs stay 16px so phones do not zoom.
- **Compact lists.** Card header = title + short note together, at most one link on the right. Table rows 10px × 12–20px, column heads 11px uppercase, numbers right-aligned with tabular figures, members start with a decorative two-letter monogram. Row buttons are 32px on a pointer screen and 44px on touch.

Data is the GĐ0 testnet fixture (`packages/key-doctor/fixtures/reports/dao-kd-demo.report.json`), with one change listed under "Open items".

## Principles

- **Fixed rules decide, the page explains.** Every flag shows `messages.en` (title, explain, fix) verbatim from `kd.report.v1`. The UI writes no risk text of its own.
- **Status is never color alone.** Each status has an icon, a text label and a color: High risk (triangle), Cleanup (circle-alert), Note, OK (check).
- **Key Doctor never signs.** The dashboard builds the `DeleteKey` transaction. The wallet signs it through wallet-selector. Adding an ML-DSA key always happens in Meteor, and the page shows a step-by-step guide.
- **Connect only to sign.** Never call `signIn` with `contractId`, because that creates a new function-call key. The dashboard connects the wallet only to sign the delete transaction.
- **Spec wins.** The spec is `docs/final-idea.md` §10 and `docs/usecase.md` UC8 (changed in ed127bd). Where the mockup differs, follow this README. See "Mockup deltas".
- **English UI.** `messages.vi` stays in the library for the Telegram bot.
- **Testnet names only** in examples and placeholders.

## Screens

| # | File | Route (proposed) | Purpose | Data |
|---|---|---|---|---|
| 1 | `Main.dc.html` | `/` | Enter an account or DAO; examples; "one account or a whole council"; network stats | `data/` stats (GĐ10) |
| 2 | `Council.dc.html` | `/?target=<dao>` | DAO report: status, summary tiles, members sorted by risk, voting rules, scan limits | `summary`, `members[]`, `dao`, `limitations` |
| 3 | `Account.dc.html` | `/?target=<account>` | Account profile: new-key alert, issues, every key with a tick box for batch delete | `members[0]`, `keys[]`, `flags[]` |
| 4 | `Cleanup.dc.html` | `/?target=<account>&view=cleanup` | UC8 plan: urgent action, two levels, 5 steps ticked from chain data | `keys[]`, `flags[]`, rescans |
| 5 | `Watch.dc.html` | dialog | Telegram alerts (MVP): open bot, copy `/watch <target>`; "You will get" depends on target type | `target` |
| 6 | `DeleteKey.dc.html` | dialog | Full-access confirm: blocks, three warnings and preview before the wallet signs | the ticked full-access `KeyInfo` |
| 7 | `RevokeKey.dc.html` | dialog | Batch preview and confirm for app (function-call) keys before the wallet signs | the ticked app `KeyInfo[]` |
| 8 | `WalletDialog.dc.html` | dialog | Choose the wallet that signs (Meteor, Here, HOT); logos come from each wallet's SDK at runtime | `WALLETS` |
| 9 | `KeyDetail.dc.html` | dialog | Key details from the View button: permission, dApp contract, allowance, added, uses, nonce, why it matters | one `KeyInfo` |

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
  - disconnected: "Connect a wallet as <account> to delete keys here". The page disables tick boxes and delete buttons.
  - connected as the target account: the page enables tick boxes and delete buttons.
  - connected as another account: "Only <account> can delete its own keys: switch account". The page disables tick boxes and delete buttons.
- Each key row has a tick box. The user ticks app keys and presses "Delete selected app keys". Screen 7 shows the preview, then the wallet signs one transaction with several `DeleteKey` actions.
- Old Ed25519 full-access keys use the same tick-and-delete flow only if the wallet signs it (test first, `docs/final-idea.md` §13.5). Screen 6 is the confirm step. If the wallet does not sign it, the row shows "Delete in Meteor" and links to the Meteor steps.
- The dashboard disables the tick box for the last full-access key and for the key the wallet signs with. See "Safety rules".
- After the account signs with ML-DSA, the dashboard cannot ask the wallet to sign through wallet-selector. The delete controls then become links to the Meteor steps.

### 4. Cleanup plan (UC8)
- Progress "N of 5 steps done", bar, block height it was read at.
- Urgent box first when a suspicious new full-access key exists: "Delete this key now" (opens 6). The safety rules apply to this key too.
- Level toggle (`aria-pressed`): Safe cleanup (steps 1, 2, 3) / Go fully post-quantum (adds step 4).
- Steps in the UC8 order. Key deletes come before the user turns on ML-DSA, because after that the wallet signs with ML-DSA and the dashboard cannot ask it to sign.

| Step | Task | Where | Done when a rescan finds |
|---|---|---|---|
| 1 | Delete unneeded app keys (never used, dead contract, too wide a permission). The user ticks several keys and signs once. | Dashboard, the wallet signs. If the wallet does not sign it, a guide to Meteor "Select Keys to Revoke". | The selected keys are gone |
| 2 | Delete old or never-used Ed25519 full-access keys. Keep the key the wallet uses. Order: never used first, then oldest first. | Dashboard if the wallet signs it. Otherwise a Meteor guide. | The selected keys are gone, and at least one full-access key is left |
| 3 | Add an ML-DSA key (PQ screen, the account needs NEAR for the fee), sign a test transaction, wait for finality. | Meteor, step-by-step guide on the page, "I did it, rescan" | At least one full-access ML-DSA key, and that key has at least 1 use |
| 4 | (Go fully post-quantum only) Delete the remaining Ed25519 full-access keys. | Meteor guide. The wallet now signs with ML-DSA. | No Ed25519 full-access key |
| 5 | Rescan | Dashboard | |

### Safety rules (the dashboard checks these before it builds the transaction)
1. Never build a transaction that deletes the last full-access key of the account.
2. Never delete the key the wallet signs with, if the wallet reports its public key. If the wallet does not report it, show a clear warning. Then allow a full-access delete only when at least 2 full-access keys are left after the delete.
3. Always show a preview of the keys to delete, with the reason for each key.
4. Show three warnings before any full-access delete:
   - Each full-access key usually belongs to a seed phrase or a device. Deleting the key means that seed phrase or device loses access.
   - The new ML-DSA key must be backed up.
   - Check that the wallets, hardware wallets and dApps you use every day still work with an ML-DSA-only account.
5. Connect the wallet without `signIn` + `contractId` (see Principles).
6. Put at most about 100 actions in one transaction. Split a larger batch into several transactions.

### 5. Telegram alerts
- One dialog for every target. Steps: open `@KeyDoctorOnCallBot`, copy `/watch <target>` (button turns into "Copied"), group hint.
- "You will get": every target gets the daily key comparison (02:00 UTC). A DAO also gets the pre-vote warning (every 15 minutes) and governance / upgrade proposal warnings. An account gets a hint to also watch its DAO.
- The page stores nothing; `/list` and `/unwatch` live in the bot.

### 6. Confirm a full-access delete
- Opens from screen 3 or from step 2 (and the urgent box) of screen 4, only when the wallet signs a full-access `DeleteKey`.
- `alertdialog`: preview of the ticked full-access keys (key, added, uses, reason), "Left after this: N full-access keys".
- The dashboard runs safety rules 1 and 2 before the dialog opens. A blocked key cannot be ticked, so the dialog never shows it.
- Three checkboxes with the three warnings from safety rule 4, and "type the last 4 characters of the key" for each key.
- The page enables "Sign in wallet" only when the user ticks all boxes and the characters match. After the transaction lands: rescan, the keys leave the list.

### 7. Confirm an app-key batch
- Lighter `alertdialog`: preview of every ticked app key (key, app contract, permission, uses, reason). "The app will ask you to connect again". No typing step.
- "Sign in wallet" sends one transaction with one `DeleteKey` action per key (split above about 100 actions).

## Interaction and accessibility rules

- Focus ring on every link, button and input (`tokens.css`). Dialogs: real `<button>` for close, focus trap, Esc closes, focus returns to the trigger.
- Controls at least 44px tall. Real `<button>`, `<a href>`, `<input>` + `<label>`; `aria-label` on icon-only buttons; decorative SVG `aria-hidden`.
- Links that leave the site (`t.me`, Meteor) open a new tab with `rel="noopener"`.
- Respect `prefers-reduced-motion`.
- Wide tables sit in an `overflow-x: auto` box at desktop width; on phones, switch to one card per member or key.

## Not in the mockup yet (build these states too)

- **Scanning:** members appear one by one as their keys load (§10); skeleton rows with `aria-busy`.
- **Errors:** invalid name, not found, not a DAO, RPC error (`kd.error.v1` messages); a member row "Couldn't read this account. Retry" (`members[].error`).
- **DAO flags** section. It shows both sources: `DAO_ADMIN` sits in `members[].flags` with `scope: "dao"`, and `dao_flags` holds `COUNCIL_SMALL` (GĐ1 design decision).
- **Network stats** page (GĐ10 numbers and how to reproduce them).
- **Phone layouts** for the tables.
- P1: watch-link dialog with `link_private` / `link_group`.

## Mockup deltas

The mockup predates ed127bd. Follow this README where the two differ.

| File:line | Mockup | README (new spec) |
|---|---|---|
| `Account.dc.html:39`, `:145`, `:213`-`:215` | "Connect Meteor Wallet", "a transaction you approve in Meteor" | Connect a wallet through wallet-selector, without `signIn` + `contractId` |
| `Account.dc.html:176`, `:205`-`:207` | One Delete or Revoke button per key, which opens a dialog for one key | A tick box per key and one batch delete button |
| `Cleanup.dc.html:76`, `:83`, `:85` | Step 1 "Revoke unneeded app keys", a Revoke link per key, "Revoke all" | Tick app keys, preview, one signed transaction |
| `Cleanup.dc.html:92`, `:105`, `:115` | Step 2 adds ML-DSA, step 3 test-signs, step 4 deletes old full-access keys | Step 2 deletes old full-access keys, step 3 adds ML-DSA and test-signs, step 4 deletes the rest in Meteor |
| `Cleanup.dc.html:141`, `:187` | The full-access delete waits for "finish step 3 (test signature with the ML-DSA key)" | The full-access delete (step 2) comes before ML-DSA. It does not wait for step 3. |
| `Cleanup.dc.html:64`, `:68` | Safe level includes "Add ML-DSA, delete full-access keys that were never used". The full level deletes every Ed25519 full-access key. | Safe level is steps 1, 2, 3. The full level adds step 4, done in Meteor. |
| `Cleanup.dc.html:45` | "you approve it in Meteor Wallet" | The wallet signs through wallet-selector. Only ML-DSA happens in Meteor. |
| `DeleteKey.dc.html:43`-`:44` | Two checkboxes: seed phrase, "This is not the key Meteor uses right now" | Three warnings (seed phrase, ML-DSA backup, apps still work). The dashboard blocks the signing key itself (safety rule 2). |
| `DeleteKey.dc.html:56`, `:59`, `:65`, `RevokeKey.dc.html:44`, `:49` | "Open Meteor to sign", "Meteor Wallet opens" | "Sign in wallet" through wallet-selector |
| `DeleteKey.dc.html:38` | Confirm for one key | Preview of every ticked full-access key |

## Open items

- **DAO suffix on testnet:** the testnet Sputnik factory is `sputnik-v2.testnet`, so testnet DAOs are `<name>.sputnik-v2.testnet` (seen in the GĐ1 live run). `kd-demo.sputnik-dao.testnet` in the mockup, the fixtures and the dashboard example chip does not exist on chain. Point the example at the GĐ6 demo DAO once `scripts/demo-testnet` creates it. The library does not depend on the suffix.

- **Fixture drift (in progress in GĐ1):** the mockup gives `a.kd-demo.testnet` one app key (`game.kd-demo.testnet`, any method, unlimited allowance). It also gives `FA_OLD` to its two keys older than 2 years. Update `dao-kd-demo.report.json` to match.
- **Test-sign first (`docs/final-idea.md` §13.5):** through wallet-selector and Meteor, sign one transaction with several `DeleteKey` actions for app keys. Sign one `DeleteKey` for a full-access key on a testnet account with at least 2 full-access keys. Connect the wallet without a new function-call key. Also check if the wallet reports the public key it signs with (safety rule 2). The result sets the GĐ8 scope and closes T6.
- **Q2 (`docs/final-idea.md` §16):** does Meteor sign `DeleteKey` (app key, full-access key) through wallet-selector? If not, step 1 and step 2 become Meteor guides.
- Meteor link: the owner confirmed `https://wallet.meteorwallet.app/wallet` on 2026-10-29. Use it for "Open Meteor" (GĐ8). Not yet checked: whether a deep link can open the wallet on testnet or go straight to a key-management page.
