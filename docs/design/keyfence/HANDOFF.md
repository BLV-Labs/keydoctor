# Keyfence handoff spec

The implementation spec for every screen in `mockup/`. Read `README.md` first for the principles, the word list and the build order. This file adds what a developer would otherwise guess: tokens, components, states, data sources, edge cases, accessibility and acceptance checks.

Stack today: `apps/dashboard`, plain TypeScript, string templates through `html` (`src/html.ts`), one stylesheet (`public/styles.css`), tokens in `docs/design/dashboard/tokens.css`. Nothing here needs a framework.

---

## 1. Global

### 1.1 Tokens

Load `docs/design/dashboard/tokens.css`, then `docs/design/keyfence/tokens-keyfence.css` (teal primary). Use variables only; no hex in components except the monogram tones and the wallet-logo plate, which are fixed on purpose.

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--kd-primary` | #0F5F5C | #7CD4CF | Primary buttons, links, active nav underline, selected cards, progress fill |
| `--kd-primary-hover` | #0B4A47 | #A6E4E0 | Hover of primary |
| `--kd-on-primary` | #FFFFFF | #0B1017 | Text and icons on primary and on solid red buttons |
| `--kd-primary-tint` | #E3F1F0 | #12302F | Selected chip and card background, icon plates |
| `--kd-page` / `--kd-surface` / `--kd-surface-muted` | existing | existing | Page, cards and dialogs, table heads and dialog footers |
| `--kd-border` / `--kd-border-strong` / `--kd-border-input` | existing | existing | Card borders and row dividers / secondary buttons / inputs |
| `--kd-text` / `--kd-text-2` / `--kd-text-muted` | existing | existing | Primary / body / secondary text |
| `--kd-high*`, `--kd-cleanup*`, `--kd-ok*`, `--kd-note*` | existing | existing | Status: red = lose something or act now, amber = waits for you or tidy up, green = done or fine, grey = neutral |
| `--kd-high-edge` | #F04438 | #F97066 | Border of red outline buttons |
| `--kd-backdrop`, `--kd-shadow-dialog` | existing | existing | Dialog and drawer backdrop and shadow |

Type scale (`--kd-fs-*`): 11 column heads and eyebrows (700, uppercase, 0.06em) · 12 pills, tags, field hints · 13 meta, notes, breadcrumbs, small buttons, footers · 14 body, tables, dialogs, default buttons · 16 card titles (600), inputs, lead · 18 section titles (h2, 700) · 24 page titles (h1, 700) and tile values · 36 home hero (mobile 28). Line height 1.5. Numbers in tiles, tables and amounts use `font-variant-numeric: tabular-nums`. Account ids and keys use `--kd-font-mono` at 13px.

Spacing (no tokens exist; use these values everywhere): page padding 28px top, 64px bottom; gap between page sections 20px; card padding 20px (tiles 14px 16px); gap inside cards 12px; dialog padding 20px; row dividers 10px vertical padding. Radii: buttons and inputs `--kd-radius` (8px), cards `--kd-radius-lg` (12px), dialogs `--kd-radius-xl` (16px), pills 999px.

### 1.2 Layout

- Container `--kd-container` (1200px) with `--kd-gutter` (24px, 16px under 720px). Wizards and the cleanup page use 860px; Connect uses 960px.
- Two-column pages (K3, K8, K10): main `flex: 999 1 560px`, aside `flex: 1 1 320px`, gap 20px, `flex-wrap: wrap`, so the aside drops under the main column without a breakpoint.
- Tiles: a row of up to 4 with `flex: 1 1 200px`; they wrap to 2 and then 1.
- Tables sit in an `overflow-x: auto` box with a `min-width` (560px activity, 700px keys). Under 720px the existing card layout for key and member tables still applies.
- Breakpoints: one, at 720px (existing). Under it the header puts logo and controls on row 1 and the nav on row 2, page title 20px, home hero 28px, and row buttons return to 44px (also on `pointer: coarse`).

### 1.3 Header and footer (all pages)

- Left: 32px teal tile with the mark (`logo.svg`, 20px, `--kd-on-primary`) and "Keyfence" (17px, 700). Links to Home.
- Nav: **Agents**, **Keys**, **Alerts**. Active item: `--kd-text`, 600, 2px `--kd-primary` underline, `aria-current="page"`. Agents is active on K2, K3, K4, K7, K8, K11; Keys on K6, K9, K10. Alerts opens the Telegram dialog (P2) and is never "current".
- Right: network pill (amber "Testnet"; on mainnet a grey "Mainnet"), theme switch (44px icon button, `aria-label="Dark theme"`, `aria-pressed`), wallet chip (green dot plus mono account; signed out it is a secondary button "Connect wallet").
- Footer: "Testnet. Contracts are unaudited." · "Keyfence never holds your keys. Limits are enforced on-chain." · link "For developers (MCP)" to K11 `#agents-mcp`.

### 1.4 Components

| Component | Variants | Spec |
|---|---|---|
| Button | primary, secondary, danger (outline), danger-solid, ghost (link look) | min-height 44px (small: 36px, rows on pointer screens: 32px), padding 0 16px (small 12px), 14px/600, icon 16px with 8px gap. Primary: `--kd-primary` bg, `--kd-on-primary` text. Danger outline: surface bg, `--kd-high` text, `--kd-high-edge` border. Danger-solid only in confirm dialogs. Hover: primary uses `--kd-primary-hover`; secondary uses `--kd-surface-muted`. Disabled: opacity .45, no pointer events. Busy: label becomes "Waiting for wallet…", button disabled, `aria-busy="true"`. |
| Signature count | 1 or 2 | 12px muted, wallet icon, "1 signature in your wallet" / "2 signatures in your wallet". Sits at the left of every dialog footer that signs, and next to page actions that sign. Reuse `signatures()` from `budget-view.ts`. |
| Pill | high, cleanup, ok, note, brand | 12px/600, padding 1px 9px, 1px border, optional 12px icon. Status is never color alone: text always says it. |
| Card | default, attention (amber border for "Needs you"), verdict banner (status bg) | `--kd-surface`, 1px `--kd-border`, 12px radius. |
| Card head | title, note, link | Title 16px/600, note 13px muted beside it (baseline), optional right link "Label →" 13px/600. Existing `cardHead()` in `ui.ts`. |
| Tile | value with optional progress | Label 12px muted, value 22–24px/700 tabular, sub 12px muted; progress bar 6px, `--kd-note-bg` track, `--kd-primary` fill. |
| Activity / data table | — | Head 11px uppercase muted; rows 14px, 10px vertical padding, `--kd-border` dividers; amounts right-aligned; result as a pill. |
| Field | text, amount (suffix), select | Label 13px/600 `--kd-text-2`; hint 12px muted under the label; input min-height 44px, 16px text, `--kd-border-input`; amount fields show the unit as a suffix inside the box. Error: border `--kd-high`, message 13px `--kd-high` under the input, `aria-invalid="true"`, `aria-describedby` to the message. |
| Chips (single choice) | — | 36px pills, `aria-pressed`; selected = `--kd-primary` border, `--kd-primary-tint` bg, `--kd-primary` text. Used for presets of amounts, filters, intervals, connection tabs. |
| Choice card | preset, option, disabled "Later" | Whole card is a `<button aria-pressed>`; selected = 2px `--kd-primary` border plus tint. Disabled: dashed border, opacity .7, `aria-disabled="true"`, grey "Later" pill. |
| Stepper | 4 or 5 steps | Pills: 24px number dot plus label. Current: tint bg, primary text, filled dot. Done: filled dot. Future: outlined dot, muted text. Use `<ol>` with `aria-current="step"` on the current item. |
| Switch | on, off | `<button role="switch" aria-checked>`, 44×26 track, 20px knob; on = primary track. Label in `aria-label` ("Research bot can spend"). |
| Note | brand, ok, cleanup, high, neutral | 13px, 16px icon, 10px 12px padding, 8px radius, status bg plus border. |
| Monogram | 6 tones | Existing `avatar()` in `ui.ts`, 28px, decorative (`aria-hidden`). |
| Dialog (modal) | info, confirm | Native `<dialog>` with `showModal()`, max-width 440–560px, 16px radius, header (40px icon plate, title 17px/700, sub 13px muted, 40px close button), body gap 14px, footer actions right-aligned with the signature count on the left, optional muted footnote strip. |
| Drawer | form | Same parts as a dialog, pinned to the right edge, full height, 460px wide (100% under 720px), radius only on the left. Body scrolls; header and footer stay. |

### 1.5 Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Dialog | open / close | fade + scale from 0.98 | 150ms / 100ms | ease-out / ease-in |
| Drawer | open / close | slide from right 24px + fade | 200ms / 150ms | ease-out / ease-in |
| Backdrop | open | fade | 150ms | linear |
| Progress bars, switch knob | value change | width / translate | 200ms | ease-out |
| Everything | `prefers-reduced-motion: reduce` | no motion (existing rule) | 0 | — |

### 1.6 Accessibility (all screens)

- Native `<dialog>` gives the focus trap and Esc; return focus to the trigger on close (existing `dialogTrigger`). First focus: the first field in forms, the safe button ("Cancel") in confirm dialogs, never the destructive one.
- Status text after a wallet action goes into an `aria-live="polite"` region next to the button; errors use `role="alert"`.
- Every icon next to text is `aria-hidden`; icon-only buttons have `aria-label` (Close, Copy, Remove <name>, Dark theme).
- Touch targets 44px; focus ring 3px `--kd-focus` with 2px offset (existing).
- Contrast is AA in both themes for every token pair (`test/ui.test.ts` checks it; add the teal layer to that test).

---

## 2. Screens

Each screen lists data sources in today's code so the rewrite reuses the reads.

### K1 · Home (`K-Home`, route `/`)

**Purpose:** say what Keyfence does and send each visitor to their job in one click.

**Layout:** hero (two columns: text 520px+, preview card 360px+) · "How it works" card with 3 steps · "What do you want to do?" 3 path cards · "Check any NEAR account or DAO" card (`id="check"`) · trust line (3 items).

**Content:** eyebrow "Spending limits for AI agents on NEAR"; h1 "Give your AI agent money, not your keys." (36px); lead 16px. Primary "Set up an agent budget" → K4; secondary "Check an account's keys" → `#check`. The preview card is decorative (`aria-hidden`) and uses fixed sample text.

**Check form:** keeps today's behavior (`renderHome`, `resolveInput`, Testnet/Mainnet switch). The Testnet/Mainnet switch moves into the form row on the right of the label. "Try" links stay testnet-only.

**States:** invalid name → field error under the input ("Not a NEAR account name. Names end in .testnet or .near."). Signed in → the hero CTA reads "Go to your agents" and links to K2.

**Accept:** a first-time visitor reaches K4 or K6 in one click; no technical word appears on the page.

### K2 · Your agents (`K-Agents`, route `?page=my-agents`)

**Purpose:** one inbox for everything that needs the owner, then every budget and yield agent.

**Data:** today's `agents-read.ts` (DAOs where the wallet is a member) and `readBudget()` per budget; yield from `readYield()`. New: read the waiting requests of every budget in parallel and merge them, newest first.

**Sections:**
1. Head: h1 "Your agents", sub "N budgets · N agents · everything they did in the last 24 hours", primary "New agent" (opens P2 New agent).
2. **Needs you** (h2 + amber pill "N waiting"): one row per waiting item across budgets and yield agents. Row: clock icon, "<Agent> wants to pay <amount> NEAR to <account>", meta "<reason> · <budget> · expires in <time>", buttons Reject (small secondary, 1 signature) and Review (small primary → K5). Yield rows read "<Yield agent> suggests putting <amount> <token> on Rhea Lend" and Review opens K8.
3. **Budgets and yield agents:** cards (`flex: 1 1 340px`): mark plate, name, status pill, balance, "Spent today x of y NEAR" with bar, meta line "N agents · N recipients · last payment <time>"; whole card links to K3 (or K8). Last card: dashed "New agent".
4. **Recent activity:** last 5 events across budgets (icon by result, text, amount, time).
5. **Alerts** card (`id="alerts"`): on/off sentence and "Manage alerts" (P2 Telegram).

**Reasons, in words** (map from Guard reason codes):

| Code | Text |
|---|---|
| `NOT_WHITELISTED` | Not on your recipient list |
| `OVER_PER_TX` | More than the <x> NEAR limit per payment |
| `OVER_RECIPIENT_LIMIT` | More than <recipient>'s <x> NEAR limit |
| `OVER_DAILY_LIMIT` | Over today's <x> NEAR limit |

**States:** signed out, no budget yet, nothing waiting (K12). One budget failed to load → its card shows "Could not read this budget" with "Try again"; the other cards still show.

**Edge cases:** more than 5 waiting → show 5 and "Show all N". Expired requests are not shown in Needs you; they appear in Activity as "Expired".

**Accept:** with 2 budgets and 1 waiting request each, both rows show at the top and Reject works without opening the budget.

### K3 · One budget (`K-Budget`, route `?page=budget&dao=<id>`)

**Purpose:** see and steer one budget.

**Data:** `readBudget()` → `BudgetLive` (balance, policy, agents, whitelist, requests, plans); actions from `budget-flow.ts`.

**Head:** breadcrumb "Your agents / <name>"; h1 name + status pill (Active / Agents paused / Setup not finished / Status unknown, reuse today's states). Summary sentence built from policy: "<N> agents can spend up to <max_per_day> a day and <max_per_tx> per payment, only to <N> recipients. Anything else waits for you." Actions: "Pause all agents" (danger outline; when paused it becomes primary "Resume agents", 2 signatures), "Withdraw", "Top up" (primary).

**Tiles:** Balance (sub: runway "enough for N days at today's pace" when spent today > 0, else "Top up any time"); Spent today "x / y NEAR" + bar + "resets <local time>"; Waiting for you (count + soonest expiry); Next scheduled payout (or "None · Set one up" link). Tiles are also filters for Activity (today's behavior).

**Main:** Needs you card (hidden when empty; empty state from K12 inside Activity instead). Activity: chips All / Paid automatically / Waited for you / Rejected with counts; table When, Agent, To, Amount, Result. Paged 10 per page (`paging.ts`). Today only the last 10 requests are read: read more pages when the user pages.

**Aside:** Fence (4 rows: Per payment, Per day, Requests that can wait per agent, Always kept in budget; link "Edit" → P1 Edit the fence) · Who agents can pay (name, mono account, "any amount" or "up to x NEAR"; "Manage" → P1 Recipients; line "Payments to anyone else always wait for you.") · Agents (bot icon, name, "last paid <time>", switch; link "Add agent"; row click → P2 One agent; link "How your agent connects" → K11) · Scheduled payouts (row "0.5 NEAR to Ops lead, every day", "Run 3 of 12 · next in 3 h", Pause; "New" → P1 Scheduled payout; hidden on branches where plans are not deployed) · Technical details (`<details>`: budget account, spending contract, network).

**Edge cases:** no recipients → the Fence sentence says "only to accounts you approve each time". Policy unreadable → sentence "We could not read the limits. Nothing was changed." with "Check again". Balance below reserve → amber note under tiles "Agents cannot pay until you top up above 0.5 NEAR."

**Accept:** the summary sentence matches the on-chain policy; every action shows its signature count; no "Guard", "DAO" or "proposal" outside Technical details.

### K4 · New agent budget (`K-Create`, route `?page=budget`)

**Purpose:** create a budget and its first agent in 2 signatures.

**Flow:** 4 steps, state in memory (and in the URL as `&step=n` so Back works). Nothing is signed before step 4.
1. **Fence:** Budget name (required, 3–40 chars, becomes the account prefix; show the derived account in the hint), presets Cautious (1 / 5) and Balanced (5 / 20) from `CAUTIOUS_RULES` and `BALANCED_RULES`, Custom reveals the 4 fence fields inline, Starting balance (≥ 0, NEAR).
2. **Recipients:** rows Account (mono, checked as you type: "Account exists" green or "No such account" red, debounced 400ms), Name, Limit (optional). "Add recipient" adds a row; × removes it. 0 rows is allowed (everything waits).
3. **Agent:** Agent name; can / cannot cards (static copy).
4. **Review:** summary sentence, rows (Budget, Starting balance, Limits, Recipients, Agent, One-time cost), "What happens next" (3 lines), primary "Create budget · sign 1 of 2".

**After signing:** Signature 1 (create) → button turns into "Sign 2 of 2"; Signature 2 (Guard + agent + role) → P2 "Agent key ready". Reuse `budget-create.ts`; the steps map to today's `renderBudgetSetup` fields. If the user leaves between the signatures, K3 shows "Setup not finished" with "Finish setup · sign 2 of 2".

**Validation:** Continue is enabled when the step is valid; errors show under the field on Continue, and focus moves to the first error.

**Accept:** a user creates a budget without typing "account, label, cap" in a textarea and without seeing the words DAO, Guard or proposal.

### K5 · Approve a payment (`K-Approve`, dialog)

**Trigger:** Review on a waiting row (K2, K3) or `&approve=<id>`.

**Content:** title "Approve this payment?", sub "<Agent> · <Budget> · expires in <time>"; amount block (30px) with recipient name and mono account and the agent's note; "Why it waited" in words (table in K2); checks: recipient on your list (or "Not on your list"), balance after (and reserve kept), today's spending so far vs the daily limit. Footer: Reject (secondary), "Approve and sign" (primary), footnote "Approve and Reject each ask your wallet for one signature."

**Rule kept from today:** if the recipient is not on the list, the user types the amount back before Approve is enabled (field "Type 4.5 to confirm").

**States:** expired → body shows "This request expired" and only Close. Already decided elsewhere → "Already approved by you on Telegram" and Close.

### K6 · Key check (`K-Keys`, route `?target=<account>`)

**Data:** `scanTarget()` report; flags, `recentFullAccessKeys()`, `keyReasons()`, `keySeverity()`.

**Order:** verdict banner (worst issue in words; high = red banner with "Remove it now" + "That was me"; cleanup = amber "N things to tidy up"; ok = green "Nothing to fix") · "N more things to tidy up" (one row per flag group with Review → K9 step) · All keys table (Key, What it can do, Added, Uses, Status, action) · two cross-link cards (alerts, agent budget) · "More checks and how this works" (`<details>`: post-quantum, nonce estimate, ruleset, block).

**Words:** "Everything (master key)" for full access; "Use <contract>" for app keys; status pills "New, not you?", "Never used", "Too broad", "In use".

**"That was me":** stores the key as known in `localStorage` per account; the banner then shows the next issue. It changes nothing on chain; the key stays in the table.

### K7 · New yield agent (`K-YieldCreate`, route `?page=yield&new=1`)

**Purpose:** let a treasury put idle stablecoins to work, with every move approved.

**Steps:** Funds (treasuries the wallet signs for, with total and idle USDC from `readYield()`; disabled when idle is 0) · Where (Rhea Lend supply USDC with today's APR; Auto-stake and Swap as disabled "Later" cards) · Limits (Most it may put to work ≤ idle; Always keep ready ≥ 0; Only act above X% a year) · How it acts ("Suggest, I approve each move" selected; "Move on its own" disabled with reason; Check rates 15 min / 1 h / 1 day; note about the optional AI ranking) · Review.

**Storage (new):** the agent settings live off chain for now (Worker D1 keyed by DAO, or `localStorage` as a stopgap); creating costs nothing on chain. The first supply needs Rhea registration, shown as the first suggestion.

**Accept:** no step signs anything; the Review sentence matches the limits; disabled options say why.

### K8 · Yield agent (`K-Yield`, route `?page=yield&dao=<id>`)

**Data:** `readYield()` (positions, rates, council, proposals), `yieldActions()`.

**Head:** name + "Watching"/"Paused" pill, summary sentence, Pause, Edit limits. Tiles: Working on Rhea Lend, Earned so far, Idle now (with "kept ready"), Rate today. Main: Suggestion card (title, reason in numbers, council votes "x of y needed", Reject / Approve and sign) · History. Aside: Rates now (+ "Data for the council, not financial advice."), Limits, Take money back (Propose withdraw → yield drawer).

**States:** no suggestion → card "Nothing to do: <reason>" (rate below floor, nothing idle, limit reached). Mainnet → page says "Yield works on testnet only for now".

### K9 · Clean up keys (`K-Cleanup`, `&view=cleanup`)

Progress bar and "x of y steps done · Checked <time> · Check again". One step open at a time (the first not done); done steps collapse to one line with a green check; later steps show only their title and one line. Keys inside a step use the K6 row with Revoke / Remove. Post-quantum (today's level "full") moves into a `<details>` "Going further". Reuse `planSteps()`, `buildDeletePlan()` guards.

### K10 · Council check (`K-Council`, `?target=<dao>`)

Verdict banner (members, votes needed, worst member state in words) with "Warn me before votes" (P2 Telegram) and "Check again". Main: Members (monogram, account, pill, reason, chevron → K6 with `from`), Open votes (proposal, status, votes, who still has to vote, voter key status). Aside: How money moves (role, votes needed, deposit, admins), "Let an agent pay from this treasury" → K4 with owner = council (open item).

### K11 · Connect an agent (`K-Connect`, `?page=budget&help=agent` and `?page=mcp`)

Connect it (chips Claude Code / Other MCP app / Script, one command with Copy) · What happens when it asks to pay (Paid at once / Waits for you / Refused) · Tools your agent gets (`guard_get_policy`, `guard_request_transfer`, `guard_get_request_status`) · If you stop trusting it · For developers (`id="agents-mcp"`, read-only MCP command and tool list). Merges `agent-guide.ts` and the MCP page.

### K12 · States (`K-States`)

| State | Where | Title / text | Action |
|---|---|---|---|
| Checking | K6, K10 | "Reading keys from NEAR…" + 3 skeleton bars, "Usually 2–5 seconds." | — |
| Not found | K6 | "No account called <name>" / "Check the spelling, and whether it ends in .testnet or .near." | Try another name |
| Chain error | any read | "We could not read the chain" / "The risk is unknown, not low. Nothing was changed." | Try again |
| Signed out | K2, K3 | "Connect your wallet to see your agents" | Connect wallet |
| No agents | K2 | "No agents yet" / "Give your first agent a budget in about 2 minutes." | New agent |
| Nothing waiting | K3 | "Nothing needs you" | See activity |

Skeletons appear after 300ms only (no flash on fast reads).

---

## 3. Pop-ups

All pop-ups follow §1.4 Dialog / Drawer. "Sig" is the signature count shown in the footer.

| Pop-up | Type | Fields and content | Primary action | Sig | Errors and edge cases |
|---|---|---|---|---|---|
| Top up | modal | Amount (NEAR, chips 1/5/10/20), From (wallet), Balance now, Balance after | Top up | 1 | Only the sole owner can top up directly (`topUpBlocks()`); otherwise show the reason and offer "Copy budget account". Amount > wallet balance → field error. |
| Withdraw | modal | Amount (max = balance − reserve, "Use everything I can"), To (default wallet), what stays for agents | Withdraw | 2 | To ≠ wallet → amber note "This sends to another account." |
| Pause all agents | confirm | 3 bullets (no payments, schedules stop, waiting stays) + note "Resuming takes 2" | Pause now (danger-solid) | 1 | — |
| Edit the fence | drawer | Most per payment, Most per day, Requests that can wait per agent, Always keep in budget; "was x" hints on changed fields; live summary sentence | Save changes | 2 | Per payment > per day → error on Per payment. No change → button disabled. |
| Recipients | drawer | List (name, mono account, limit, Remove) + Add form (Account with live check, Name, Limit optional) | Save N changes | 2 | Duplicate account → error. Batch adds and removes into one change set; the count is in the button. |
| Scheduled payout | drawer | Pay to (select from recipients), Amount each time, How many times, How often (chips + Custom), First / Last / Total, fit note (green fits, amber over daily limit or balance short) | Start schedule | 2 | No recipients → empty state "Add a recipient first" with link. |
| New agent | modal | Two choice cards: Pay for things (→ K4), Earn on idle funds (→ K7); hint "Add to an existing budget" | Continue | 0 | — |
| Agent key ready | modal | Note (key scope), 1 Download, 2 Connect (chips + command + Copy), 3 Try it | Done | 0 | Done before download → opens "Leaving without the key". |
| Leaving without the key | confirm | Why it matters | Download key (primary), Leave anyway | 0 | Replaces `window.confirm` and `beforeunload` text in `app.ts`. |
| One agent | drawer | Can spend switch, Spent today, Waiting, Last payment, Its key (mono), lost-key note | See its activity; Remove agent (danger) | switch 2, remove 2 | Removing the last agent → note "The budget stays; add an agent any time." |
| Choose a wallet | modal | Meteor (Tested pill), Here, HOT; logo on white plate | (row click) | 0 | Meteor without extension → row shows "Install Meteor" link (today's behavior). |
| Key details | modal | Plain sentence of power (red note for master keys), Used, Why it matters, Key; Technical details (full key, block, nonce) | Remove this key / Revoke | 0 | — |
| Remove a master key | confirm | Consequence, "You keep N master keys", type last 4 characters | Remove key (danger-solid) | 1 | Last master key or wallet's own key → refuse with today's `GUARD_TEXT`. |
| Telegram alerts | modal | One-tap links (to me / to a group), or the `/watch` command with Copy, You will get | (links) | 0 | No Worker URL → hide one-tap links, keep the command. |

---

## 4. Edge cases (all screens)

- **Long names:** budget and agent names cut at 40 characters with an ellipsis and a `title`; account ids wrap anywhere (mono) and never ellipsize, because the user must see which account.
- **Large amounts:** format with thousands separators (`formatInt`, `yoctoToNear`); never show yocto.
- **Slow reads:** each section loads on its own; a failed section shows its own error with "Try again" and never hides the rest.
- **Wallet closed mid-way:** the button returns to normal; status line "Wallet window closed. Nothing was signed." For 2-signature actions after signature 1: "Step 1 of 2 is done. Finish it under Needs you." (today's flow).
- **Network mismatch:** if the wallet network differs from the page, show a top banner "Your wallet is on <network>. Switch to <network> to sign." and disable signing buttons.
- **Mainnet:** budgets and yield are testnet-only; their pages say so in one line instead of a broken form.

---

## 5. Files to change

| Area | Files |
|---|---|
| Tokens, header, footer, rename | `public/index.html` (title, favicon), `public/styles.css`, `src/pages.ts`, `src/icons.ts` (mark) |
| K2 | `src/agents-view.ts`, `src/agents-read.ts` (merge waiting requests) |
| K3, P1, One agent | `src/budget-view.ts`, `src/budget-read.ts` (paged requests), `src/budget-flow.ts` (unchanged logic) |
| K4, Agent key ready | `src/budget-view.ts` (`renderBudgetSetup` → wizard), `src/budget-create.ts`, `src/app.ts` (step state, leave dialog) |
| K5 | `src/budget-view.ts` (`renderBudgetApprove`) |
| K6, K9, K10, Key details, Remove key | `src/report.ts`, `src/cleanup-view.ts`, `src/key-detail.ts` |
| K7, K8 | `src/yield-view.ts`, `src/yield-read.ts`, new settings store |
| K11 | `src/agent-guide.ts`, `src/pages.ts` (`renderAgents`) |
| Dialogs and drawers | `src/app.ts` (open/close, focus), `public/styles.css` (drawer) |
| Tests | extend the no-jargon test to every drawer, dialog and status line; contrast test for the teal layer; reason-code text table |

Words for every label are in `README.md` → "Words". If a label is not in the mockups, write it in the same plain style and add it to that table.
