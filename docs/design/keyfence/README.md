# Keyfence: dashboard redesign handoff

Keyfence is the new name for the dashboard: spending limits for AI agents on NEAR (hackathon track `security`), with the key check kept as the second job. This folder is the user-first redesign of every screen, pop-up and state. Build `apps/dashboard` from it.

| File | What it is |
|---|---|
| `HANDOFF.md` | Implementation spec: tokens, components, states, motion, accessibility, per-screen data sources, pop-up table, edge cases, files to change. |
| `mockup/K-*.dc.html` | Source of each screen from the design canvas: layout, copy and states. They need the canvas runtime (`support.js`) to render, so read them as reference, not as code to ship. |
| `mockup/canvas.json` | Screen list and order. |
| `tokens-keyfence.css` | Brand layer: load after `../dashboard/tokens.css`. It swaps navy for Keyfence teal in both themes; nothing else changes. |
| `logo.svg` | The mark used in the header: the Key Doctor cross key (a key whose bow is a medical cross), from `docs/design/icon/` on `design/key-doctor-icon`. The owner chose it over the `K-Logo` options on 2026-11-09. |

The mockups use their own `--k-*` variables so the canvas can switch themes. In code use the existing `--kd-*` tokens: the names map one to one (`--k-primary` is `--kd-primary`, `--k-text-muted` is `--kd-text-muted`, and so on).

## Principles

- **One job per screen, the job first.** Every page opens with a one-line verdict or summary in plain words ("2 agents can spend up to 5 NEAR a day and 1 NEAR per payment, only to 4 recipients."), then the one thing that needs the user, then the detail.
- **"Needs you" is the inbox.** Waiting payments and yield suggestions sit at the top of Agents and of each budget, never below activity.
- **No internal words in the UI.** Guard, DAO, proposal, policy, whitelist, bond, yoctoNEAR, rule ids (`FA_RECENT`), method names and schema ids go under a folded "Technical details" or nowhere. Budget pages already test this (`budget-view.test.ts`); extend that test to every drawer, dialog and status line.
- **Say the cost before the click.** Every action that signs shows "N signatures in your wallet" next to its button.
- **Red is only for losing something:** removing a key, removing an agent, pausing. Removing a master key and pausing use a confirm dialog.
- **Modal for one decision, side drawer for a form.** Modals: Top up, Withdraw, Pause, Approve, Choose a wallet, Key details, Remove key, Telegram alerts, New agent, Agent key ready. Drawers: Edit the fence, Recipients, Scheduled payout, One agent.
- Both themes, the compact type scale and the 44px touch rule from `../dashboard/README.md` still apply.

## Words (use exactly these)

| Say | Instead of |
|---|---|
| Budget | Agent Budget, Guard, DAO (for a personal budget) |
| Fence | Policy, spending rules |
| Per payment / Per day | Per request, Per transfer, max_per_tx, max_per_day |
| Requests that can wait per agent | Pending requests, Waiting items |
| Always keep in budget | Reserve, min_reserve |
| Recipients, Who agents can pay | Whitelist, Receivers, Allowed receivers |
| Needs you, Waiting for you | Pending, Proposals |
| Paid automatically | Auto, auto_approved |
| Master key / App key | Full-access key / Function-call key (keep the technical name in Key details) |
| Check again | Rescan, Reload |
| Treasury agent | Agent Guard for a DAO |

## Screens

| # | File | Route (proposed) | Replaces today | Purpose |
|---|---|---|---|---|
| K1 | `K-Home` | `/` | Home | Promise, how it works in 3 steps, 3 paths by role, the free account check |
| K2 | `K-Agents` | `?page=my-agents` | My Agents | Inbox of everything waiting across budgets and yield agents, budget cards, recent activity, alerts status |
| K3 | `K-Budget` | `?page=budget&dao=` | Agent Budget (live) | One budget: summary sentence, Top up / Withdraw / Pause, tiles, Needs you, Activity, Fence, Recipients, Agents, Scheduled payouts, Technical details |
| K4 | `K-Create` | `?page=budget` | Budget setup form | 4-step wizard: Fence (presets), Recipients (one row each), Agent (can / cannot), Review (what happens next) |
| K5 | `K-Approve` | dialog | Approve drawer | Amount large, why it waited, three checks, Reject / Approve and sign |
| K6 | `K-Keys` | `?target=<account>` | Account report | Verdict banner first, "things to tidy up", all keys in plain words, alerts and agent-budget cross-links |
| K7 | `K-YieldCreate` | `?page=yield&new=1` | none (new) | 5-step wizard: Funds, Where (Rhea Lend), Limits, How it acts, Review |
| K8 | `K-Yield` | `?page=yield&dao=` | Yield page | Summary sentence, tiles, the suggestion with council votes, history, rates, limits, take money back |
| K9 | `K-Cleanup` | `&view=cleanup` | Cleanup plan | One open step at a time, progress, post-quantum folded as optional |
| K10 | `K-Council` | `?target=<dao>` | Council report | Verdict, members riskiest first (monograms), open votes, how money moves, treasury-agent cross-link |
| K11 | `K-Connect` | `?page=budget&help=agent` and `?page=mcp` | Agent guide + MCP page | One page: connect command, what happens when it asks, tools, how to stop it, developer MCP |
| K12 | `K-States` | n/a | scattered | Checking, not found, chain error, signed out, no agents, nothing waiting |
| P1 | `K-Popups-Money` | dialogs | Budget drawer panels | Top up, Withdraw, Pause, Edit the fence, Recipients, Scheduled payout |
| P2 | `K-Popups-Agents` | dialogs | wallet, key, watch, alerts dialogs | New agent, Agent key ready, Leaving without the key, One agent, Choose a wallet, Key details, Remove a master key, Telegram alerts |

Navigation: **Agents** (K2, K3, K4, K7, K8, K11), **Keys** (K6, K9, K10), **Alerts** (Telegram dialog), plus the network pill, theme switch and wallet chip. `?page=guard` folds into K4: "Who owns this budget: just me / my DAO council" (not drawn yet; see open items).

## What already exists and what is new

Exists today, needs the new layout and words only:
- Budget create, Top up (1 signature), Withdraw, Edit fence, Recipients, Add / turn off / remove agent, Pause (1) / Resume (2), Approve / Reject, scheduled payouts (Guard 1.2.0 plans; plan page on `feat/gd29-plan-page`).
- Key check, cleanup with Revoke / Delete one key at a time, Choose a wallet (Meteor tested; Here and HOT not yet signed a delete), Key details, Telegram `/watch` and one-tap links.
- Council report with proposals; yield rates, suggestion, register / supply / withdraw proposals and votes.

New work the design assumes:
1. **Cross-budget inbox and activity** (K2). Today each budget is read alone and only its last 10 requests (`budget-read.ts`).
2. **Agent key without shell commands** (P2 "Agent key ready"). Today the user runs `mkdir`/`mv` and must clone the repo. The design assumes a published package, shown as `npx keyfence-agent --key <file>`: the package name is a placeholder.
3. **Account check on Recipients** ("Account exists" as you type, backlog C12).
4. **"That was me"** on a new master key (K6): mark it as known so the banner goes away. Store per browser.
5. **Runway estimate** ("enough for 3 days at today's pace") on K3.
6. **Yield agent settings** (K7, K8): most to put to work, keep ready, minimum rate, check interval, and a Pause. Today suggestions are capped at the free balance only and are not stored per agent. "Move on its own" stays disabled: there is no token spending fence on chain.
7. **Leaving without the key** dialog replaces `window.confirm` (`app.ts`).
8. **Rename**: header, titles, footer and bot name. On-chain names (`keydoctor-guards-v2.testnet`, `keydoctor-keeper.testnet`), schema ids `kd.*` and the Worker URL stay; show them only in Technical details.

## Suggested order before the deadline

1. Tokens and rename (`tokens-keyfence.css`, header, words table): small, touches every screen.
2. K3 Budget, K5 Approve, P1 money pop-ups: the security demo.
3. K2 Agents inbox (start with one budget if the cross-budget read is not ready).
4. K4 Create wizard and P2 "Agent key ready".
5. K6, K9, K10 key screens; K7, K8 yield last (outside the security story).

## Open items

- Logo: three options on `K-Logo` (A key with fence teeth, B fence with keyhole, C key in a ring fence). The owner chose the Key Doctor cross key instead (2026-11-09); the header and favicon use it.
- K4 does not yet draw the DAO-council owner path (today's `?page=guard`).
- Mockup numbers are sample data, not testnet values.
