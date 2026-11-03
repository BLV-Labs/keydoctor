# Per-DAO alerts on Telegram (plan)

Status: 2026-11-03, plan only. Nothing is built. Owner answers of 2026-11-03 are recorded in §1.

Goal: each chat that watches a DAO decides which alerts it gets, so a council group and an ops group can watch the same DAO without both getting everything. A council member can link their Telegram user to their NEAR account, so a pending-vote alert notifies the people who still have to vote.

## 0. Today vs this plan

| | Today | This plan |
|---|---|---|
| What a chat gets | Every alert kind for every target it watches | Per subscription: kind groups and a minimum severity (PD1–PD2), quiet hours for non-high alerts (PD4) |
| Guard alerts | Go to every chat watching the DAO | A DAO routes them with the same filter: the ops chat takes `guard`, the council chat takes `keys,governance` |
| Who changes it | `/watch` and `/unwatch`: anyone in the chat | Settings: group admins (Telegram `getChatMember`); anyone in a private chat |
| Voters in alerts | `Still to vote: a.testnet, b.testnet` (plain names) | Same line, plus a Telegram mention for every pending voter who linked their account in this chat (PD3) |
| Rules and thresholds | Global, `RULESET_VERSION` | Unchanged (P2) |
| Language | `ALERT_LANG` for all cron messages | Unchanged (P1) |
| Bot | One shared bot | Unchanged (P4) |

## 1. Decisions

| # | Question | Answer |
|---|---|---|
| P1 | Which per-DAO settings? | Owner 2026-11-03: alert filters (kinds, minimum severity, quiet hours), Guard alert routing, Telegram↔NEAR linking. **Not** language per chat: cron messages stay bilingual (`ALERT_LANG`) and the README Limitation stays. Adding it later is one column (`lang`) and one `/set` key |
| P2 | Per-DAO rule thresholds? | Owner: no. Filters only. Rules, `RULESET_VERSION` and reports stay the same for every DAO, so reports stay comparable and `diffReports` keeps its ruleset rule (§4.3) |
| P3 | Who may change a chat's settings? | Owner: group admins (`creator` or `administrator` from `getChatMember`, or an anonymous admin). Anyone in a private chat |
| P4 | Per-DAO bot or hosted Guard agent before 14 Nov? | Owner: no. Both stay Roadmap (`docs/stories/epics/guard/hosted-agent-plan.md`). No stored bot tokens, no LLM, no agent key |
| P5 | `/unwatch` in a group is also a mute. Gate it to admins too? | Recommendation: yes, in groups only, from PD2 on. Otherwise any member undoes the admins' settings with `/unwatch` + `/watch`. **Needs the owner's yes** |
| P6 | May a filter leave a high alert kind with no chat on the DAO? | Recommendation: allow it, but `/set` replies with a warning naming the kinds no chat on this DAO receives. Blocking would make a two-chat setup depend on the order of `/set` calls. **Needs the owner's yes** |

## 2. Changes

### 2.1 Kind groups and the delivery filter (PD1)

**What.** Three kind groups, so a setting does not change every time an alert kind is added:

| Group | Alert kinds |
|---|---|
| `keys` | `voter_new_full_access_key`, `daily_changes` |
| `governance` | `governance_change_proposal`, `code_upgrade_proposal` |
| `guard` | `guard_request_pending`, `guard_transfer_auto` |

A pure function decides per subscription. `deliver` calls it for each chat instead of sending to every chat from `chatsFor`.

**Why.** Today `deliver` sends one alert to every chat watching the target (`apps/worker/src/jobs/deliver.ts`). Since PR #45, a DAO with a Guard gets a `note` alert for each auto-paid transfer. A busy agent floods the council group, and the only way out is `/unwatch`, which also drops the voter-key alerts the council needs.

```ts
// apps/worker/src/alert-filter.ts (pure)
export type KindGroup = "keys" | "governance" | "guard";
export const KIND_GROUP: Record<AlertKind, KindGroup> = {
  voter_new_full_access_key: "keys", daily_changes: "keys",
  governance_change_proposal: "governance", code_upgrade_proposal: "governance",
  guard_request_pending: "guard", guard_transfer_auto: "guard",
};

export interface AlertSettings {
  kinds: KindGroup[] | null;          // null = all
  min_severity: Severity;             // default "note" = everything
  quiet_hours: { from: number; to: number } | null; // local hours, PD4
  tz: string;                         // IANA, default "UTC"
}

export function decide(s: AlertSettings, a: KdAlert, now: Date): "send" | "hold" | "skip" {
  if (s.kinds !== null && !s.kinds.includes(KIND_GROUP[a.kind])) return "skip";
  if (SEVERITY_RANK[a.severity] < SEVERITY_RANK[s.min_severity]) return "skip";
  if (a.severity !== "high" && inQuiet(s, now)) return "hold"; // high is never held
  return "send";
}
```

`deliver` keeps its contract: send first, write `alerts_sent` after; a transient failure on any chat keeps the alert unmarked so the next run retries. A chat that skips counts like "no chat" today. A held alert (PD4) counts as delivered to that chat once its `held_alerts` row is written.

Routing needs nothing more: the council chat runs `/set <dao> kinds keys,governance`, the ops chat runs `/set <dao> kinds guard`.

### 2.2 D1 migration `0002_alert_settings.sql` (PD1)

```sql
-- Per-subscription alert settings (docs/stories/epics/per-dao/plan.md). Only the Worker writes these tables.
ALTER TABLE subscriptions ADD COLUMN kinds TEXT;                         -- JSON array of kind groups; NULL = all
ALTER TABLE subscriptions ADD COLUMN min_severity TEXT NOT NULL DEFAULT 'note';
ALTER TABLE subscriptions ADD COLUMN quiet_hours TEXT;                   -- "22-07"; NULL = none (PD4)
ALTER TABLE subscriptions ADD COLUMN tz TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE subscriptions ADD COLUMN settings_by TEXT;                   -- Telegram user id of the last admin who changed them
ALTER TABLE subscriptions ADD COLUMN settings_at TEXT;
```

Additive only. Every existing row reads as "all kinds, from `note`, no quiet hours", which is exactly today's behavior. `moveChat` (`UPDATE ... SET chat_id`) keeps the columns. `addSubscription` writes the defaults, so `/watch`, the `/start` deep link and MCP `watch` do not change. `pnpm --filter worker db:migrate:remote` is an owner step on deploy.

### 2.3 Bot commands `/settings` and `/set` (PD2)

**What.**

```
/settings <dao or account>                      show this chat's settings for the target
/set <target> kinds guard | keys,governance | all
/set <target> min high | cleanup | note
/set <target> quiet 22-07 Asia/Ho_Chi_Minh | off   (PD4)
/set <target> reset
```

A regex parses them, like every other command (no LLM). `parseCommand` captures one argument today, so it gains the rest of the line for `/set`. Unknown keys or values get a bilingual usage reply listing the valid ones. `tz` is checked with `new Intl.DateTimeFormat("en", { timeZone })`, which throws on an unknown zone. After a change the reply shows the new settings and, per P6, a warning when a kind group that can be `high` now reaches no chat on this DAO:

```
Saved. kd-ops chat gets: guard (from note).
Warning: no chat watching kdoncall.sputnik-v2.testnet gets keys alerts now.
```

`/help` and the README bot section list both commands.

**Why.** Settings need a way in, and only the Worker may write `subscriptions`. The bot runs in the Worker and already knows the chat, so it is where settings change. The dashboard never writes subscriptions (invariant).

### 2.4 Admin check (PD2)

**What.** `Incoming` gains `fromId` and `senderChatId`. In a group or supergroup, `/set` (and `/unwatch` if P5 is accepted) first asks Telegram:

```ts
async function isChatAdmin(token: string, inc: Incoming): Promise<boolean> {
  if (inc.chatType === "private") return true;
  // Anonymous admins post as the group itself (from = GroupAnonymousBot, sender_chat = this chat).
  if (inc.senderChatId === inc.chatId) return true;
  const m = await call<{ status: string }>(token, "getChatMember", { chat_id: inc.chatId, user_id: inc.fromId });
  return m.status === "creator" || m.status === "administrator";
}
```

`incomingFrom` drops every `from.is_bot` message today, which also drops anonymous admins; it must let a message through when `sender_chat.id === chat.id`. A non-admin gets "Only group admins can change alert settings." in both languages. A `getChatMember` failure refuses (fails closed) and says so.

**Why.** Without it, any group member can mute the DAO's high alerts for everyone (P3). One extra Telegram call per `/set`, well inside the free plan's subrequest limit.

### 2.5 Telegram↔NEAR linking (PD3)

**What.** A council member proves, by a NEP-413 signature from their wallet, that a NEAR account is theirs, inside one chat. Pending-vote alerts in that chat then mention them.

Flow (every code is 32 random bytes, base64url, single use, 10 minutes):

1. In the council group: `/link alice.kdoncall.testnet`. The bot stores a `pending_links` row (`chat_id`, `tg_user_id` = sender, account, stage `group`) and replies with a button `t.me/<bot>?start=ln_<code>`. The code is visible to the group, so it only moves the flow to a private chat.
2. `/start ln_<code>` in the private chat is accepted only when `from.id` equals the row's `tg_user_id`. The bot replaces the code with a new stage-`sign` code and replies (privately) with a dashboard button `DASHBOARD_URL/#/link?code=<code2>`.
3. The dashboard asks the wallet to sign (wallet-selector `signMessage`, Meteor / Here / HOT):

   ```ts
   const message = JSON.stringify({ kd: "kd.link.v1", account_id, network, chat_id, tg_user_id });
   const signed = await wallet.signMessage({ message, recipient: "key-doctor", nonce: b64url.decode(code2) });
   await fetch(`${KD_WORKER_URL}/api/link`, { method: "POST", body: JSON.stringify({ code: code2, ...signed }) });
   ```

4. `POST /api/link` (Worker, CORS for `DASHBOARD_ORIGIN` only, like `/api/watch-link`) checks, in order: the code exists, is stage `sign` and not expired; the signed message equals the row's fields; the NEP-413 signature verifies (WebCrypto Ed25519 over `sha256(borsh(2^31 + 413) ‖ borsh(payload))`); `view_access_key(account_id, public_key)` is a **full-access** key; then it deletes the code and writes `account_links`. The bot posts "Linked: <first name> = alice.kdoncall.testnet" in the group.
5. `/unlink <account>` by the linked user or an admin. `deleteChat` (bot removed or blocked) and `moveChat` (supergroup upgrade) also delete or move the chat's links.

Mentions: `Outgoing` gains `entities`. `sendMessage` still sends plain text with no `parse_mode`, so chain text can still not inject markup. For alerts with a `proposal`, `deliver` renders per chat and appends one line after truncation, so offsets stay valid:

```ts
// "🔔 Alice, Bob" — offsets in UTF-16 code units (JS string length), computed on the final text.
entities.push({ type: "text_mention", offset, length: name.length, user: { id: Number(tgUserId) } });
```

**Why.** Today the alert says `Still to vote: a.testnet, b.testnet`, which notifies nobody. The point of a pending alert (Guard `pending`, governance change) is that the right people vote before the deadline. Telegram has no way to look up a user by NEAR account, so the link must come from the member. Linking per chat (not global) keeps the Telegram↔NEAR mapping inside the group where the member made it.

**D1 migration `0003_account_links.sql`:**

```sql
CREATE TABLE pending_links (
  code TEXT PRIMARY KEY,               -- single use; stage 'sign' code is also the NEP-413 nonce
  stage TEXT NOT NULL,                 -- 'group' | 'sign'
  chat_id TEXT NOT NULL,
  tg_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  network TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE account_links (
  chat_id TEXT NOT NULL,
  network TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tg_user_id TEXT NOT NULL,
  tg_name TEXT NOT NULL,               -- first name at link time, for the mention text
  public_key TEXT NOT NULL,            -- the key that signed (public, for audit)
  linked_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, network, account_id)
);
```

One NEAR account maps to one Telegram user per chat; one Telegram user may link several accounts. Nothing secret is stored.

**Owner check before PD3 (O-P1):** on testnet, does `signMessage` work in Meteor, Here and HOT through wallet-selector, and which key type signs (Ed25519 only, or ML-DSA in Meteor)? PD3 supports Ed25519 full-access keys only; anything else is a Limitation.

### 2.6 Quiet hours and the digest (PD4)

**What.** A held alert goes to `held_alerts`. The 15-minute cron sends each chat its due alerts as one digest message when its quiet window ends, then deletes the rows (send first, delete after: a crash repeats the digest, never loses it). High alerts are never held.

```sql
-- in 0002 if PD4 ships with PD1, else 0004
CREATE TABLE held_alerts (
  chat_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  release_at TEXT NOT NULL,            -- end of the quiet window, UTC
  alert_json TEXT NOT NULL,
  PRIMARY KEY (chat_id, alert_id)
);
```

**Why.** Auto-paid Guard transfers (`note`) and cleanup-level daily changes at 03:00 local time wake people for nothing. Not urgent enough to hold back PD1–PD3: first in the cut order.

## 3. Invariants touched

| Invariant | How this plan keeps it |
|---|---|
| Only the Worker writes `subscriptions` | Settings change only through bot commands in the Worker. `account_links`, `pending_links` and `held_alerts` are Worker-only too. The dashboard link page only POSTs a signature to the Worker, like `/api/watch-link` |
| No LLM in the product | All parsing is regex; filters and mentions are table lookups. No owner decision to change it (P4) |
| The Worker never holds a key | Linking verifies a signature and reads `view_access_key`. It stores the public key only. No bot tokens stored (P4) |
| Baseline writes (daily job, first subscription) | Filters act at delivery, after the scan and diff. The daily job moves the baseline as today, even when every chat skips the alert |
| Proposal job: one scan per DAO, send first, record after | Unchanged. `decide` runs per chat inside `deliver`; the scan is still once per DAO |
| Contracts in `docs/final-idea.md` §4 | `kd.alert.v1`, `kd.watch_link.v1` and the report types do not change. Settings, kind groups and links are Worker-internal types |
| Testnet names only | Examples, fixtures and tests use `kdoncall*.testnet` and `kd-demo` names |

## 4. Phases and cut order

Today is 2026-11-03; the deadline is 23:59 UTC 14 Nov. This epic is after the critical path: the Guard demo video, README pass (C6) and submission (O7) come first. **Freeze: anything not merged and deployed by 12 Nov 23:59 UTC goes to Roadmap**, so the README only describes what runs.

| Phase | Work | Size | Done when |
|---|---|---|---|
| PD1 | Migration 0002, `alert-filter.ts`, `deliver` per chat | 0.5 day | Tests in §5 pass; an existing D1 with rows migrates and behaves as before |
| PD2 | `/settings`, `/set`, admin check, P5/P6 if accepted, `/help`, README bot section | 1 day | Telegram tests pass; live: council group on `kdoncall.sputnik-v2.testnet` takes `keys,governance`, a second group takes `guard`; a Guard auto-transfer reaches only the second |
| PD3 | O-P1, migration 0003, `/link`, `/unlink`, dashboard link page, `POST /api/link`, mentions | 1.5–2 days | Tests pass; live: a council member links in the testnet group and is mentioned on a Guard `pending` alert |
| PD4 | `held_alerts`, `quiet` key, digest in the 15-minute cron | 0.5–1 day | Tests pass; live: a `note` held in a quiet window arrives as one digest at its end |
| PD5 | README Limitations, `docs/TEST_MATRIX.md` rows, backlog, owner deploy | 0.5 day | Every README claim about settings runs on the deployed Worker |

PD1 ships only together with PD2 (PD1 alone changes nothing a user sees). **Cut order if late: PD4 → PD3 → P6 warning.** PD1+PD2 is the smallest useful cut: it fixes the Guard auto-alert flood. A cut phase goes to README Roadmap with a link to this plan.

## 5. Tests

`pnpm test` must pass before each commit. The Worker tests use the real migrations on `node:sqlite` (`apps/worker/test/support/d1.ts`), so every migration is exercised by every test.

| Area | Cases (and why each matters) |
|---|---|
| `decide` (unit) | Default settings send every kind and severity (a migrated row must behave exactly like today); each kind group alone; `min high` skips `cleanup` and `note` but sends `high`; quiet window wrapping midnight (`22-07`) in `Asia/Ho_Chi_Minh`; a `high` alert inside quiet hours is sent, not held (a held voter-key alert would arrive after the vote) |
| `KIND_GROUP` | Typed as `Record<AlertKind, KindGroup>`, so a new alert kind does not compile until it has a group (otherwise it would be silently skipped by every filtered chat) |
| Migration | A D1 with 0001 rows, then 0002: rows read as all / `note` / no quiet hours; `moveChat` keeps settings |
| `deliver` | Two chats with different filters on one DAO: each gets only its kinds; all chats skip → not marked sent, proposal state still saved; one chat transient-fails → alert unmarked, next run sends it only where it was not filtered out |
| Proposal / daily jobs | Baseline still moves when every chat skips `daily_changes`; one `checkProposals` per DAO whatever the number of chats |
| Commands | `/set` parse: every key, bad values, unknown zone, `reset`; non-admin refused; anonymous admin (sender_chat = chat) accepted; `getChatMember` failure refuses; private chat always allowed; P6 warning when no chat gets `keys`; `/unwatch` gate (P5) |
| Linking | Valid NEP-413 fixture (key generated in the test) links; wrong message field, wrong nonce, expired code, reused code, function-call key, unknown key all refused; `/start ln_` from another Telegram user refused; `deleteChat` removes links |
| Rendering | Mention entities have correct UTF-16 offsets with Vietnamese text and emoji; no `parse_mode` is ever sent; a message truncated at 4096 keeps valid entities; voters without a link are listed by name only |
| Digest (PD4) | Held alerts flushed once at window end; send failure keeps the rows; crash between send and delete repeats, never drops |

## 6. Out of scope

- Language per chat (P1), per-DAO thresholds (P2), per-DAO bot or branding and the hosted Guard agent (P4): README Roadmap.
- Settings from the dashboard or MCP `watch`: possible later by putting settings into `pending_subscriptions`; not needed for the demo.
- Removing a link when the member leaves the group: the bot does not receive `chat_member` updates today. A mention of a user no longer in the group notifies nobody (Limitation).
- The hosted agent could later reuse `account_links` as its council-verified user list instead of a hand-typed `allowed_tg_users`. Noted only.
