# Track fit plan: Agent Guard, treasury proposal alerts, counterparty pre-flight

Status: draft, 2026-11-01. Not started. Owner decides scope before any code.

> 2026-11-02: item 1 shipped as MCP tool `preflight`, contract `kd.preflight.v1`, function `preflightVerdict` (renamed from `guard` / `kd.guard.v1` / `guardVerdict`). "Guard" now means the on-chain Guard contract in `docs/final-idea.md` §11. Read `guard` below as `preflight`.

Target tracks: **AI Security & Defense** (primary: items 1 and 3), **Social Money** (secondary: item 2, Sputnik DAO).

All three items keep the invariants: no LLM (verdicts come from fixed rules), read-only RPC, never sign, testnet names only in examples and fixtures.

## What already exists (do not rebuild)

| Have | Where |
|---|---|
| `FC_UNLIMITED_ALLOWANCE`, `FC_ANY_METHOD`, `FC_DEAD_RECEIVER` key rules | `packages/key-doctor/src/rules/key.ts` |
| "Full-access key added in the last 48 h" check, voters only | `newFullAccessKey` in `src/proposals.ts`, `NEW_KEY_WINDOW_HOURS` |
| Alerts for governance and upgrade proposals | `checkProposals`, kinds `governance_change_proposal`, `code_upgrade_proposal` |
| `transfer` / `call` proposals | parsed (`groupOf` → `"money"`), but **no alert of their own**: they alert only when a voter has a new key |
| MCP tools `diagnose`, `compare`, `list_keys`, `list_proposals`, `watch` | `apps/worker/src/mcp/server.ts` |

Note: a function-call key cannot attach a deposit, so its `allowance` pays gas only. A rule on "large finite allowance" would protect little, so this plan does not add one.

---

## 1. Agent Guard: MCP tool `guard` plus rule `FA_RECENT` (~1.5 days)

**What.** A new MCP tool that an AI agent calls before it signs or pays. It returns `allow | review | block` with reasons, computed by code from the scan flags.

**Why.** The track asks for "wallet safeguards" for AI-controlled money. Today an agent gets a full `kd.report` and has to read it. A verdict lets it gate a transaction with one `if`. A full-access key added in the last hours is the clearest sign of a takeover, but today only voters get that check, inside `checkProposals`.

### 1a. New rule `FA_RECENT` (library)

- Severity `high`. Fires for a full-access key whose `created.block_height` lies within `NEW_KEY_WINDOW_HOURS` of the scan block.
- Reuses the window already used by `newFullAccessKey`. Bump `RULESET_VERSION`.
- Effect elsewhere: `diagnose`, `/check` and the dashboard show it too. The daily diff raises it, then clears it after 48 h. `diffReports` already skips flag changes across rulesets.

```ts
// rules/key.ts, inside the loop (needs the scan block height passed in)
if (fullAccess && key.created.block_height !== null &&
    scanHeight - key.created.block_height <= (NEW_KEY_WINDOW_HOURS * 3_600_000) / BLOCK_TIME_MS) {
  hits.push({ rule_id: "FA_RECENT", scope: "key", public_key: key.public_key,
              evidence: { key_added_block: key.created.block_height, scan_block: scanHeight } });
}
```

- Add to `RULE_ORDER` (right after `FA_MANY`), `RULE_SEVERITY`, and vi/en text in `messages.ts`.

### 1b. `guardVerdict` (library, pure)

```ts
// src/guard.ts
export type Verdict = "allow" | "review" | "block";
export interface GuardResult {
  schema_version: "kd.guard.v1";
  verdict: Verdict;
  account: { id: string; status: Status; flags: string[] };
  counterparty?: CounterpartyCheck; // item 3
  reasons: { code: string; severity: Severity; messages: { vi: string; en: string } }[];
  block_height: number;
}

const BLOCK_RULES = new Set(["FA_RECENT", "FA_MANY"]);
export function guardVerdict(report: KdReport, cp?: CounterpartyCheck): GuardResult {
  const flags = report.members[0]?.flags ?? [];
  const block = flags.some((f) => BLOCK_RULES.has(f.rule_id)) || cp?.verdict === "block";
  const review = flags.some((f) => f.severity !== "note") || cp?.verdict === "review";
  // ...
}
```

- `kd.guard.v1` is a **new** contract: add it to `types.ts` and `docs/final-idea.md` §4.
- Account targets only. A DAO target returns `INVALID_TARGET`: an agent pays from an account.

### 1c. MCP tool `guard` (worker)

```ts
{
  name: "guard",
  title: "Pre-flight safety check before an agent signs or pays",
  description: "Scans the agent's NEAR account (and optionally the counterparty) with fixed rules and returns kd.guard.v1 with verdict allow, review or block. Read-only; stores nothing; never signs.",
  inputSchema: { type: "object", properties: { ...targetProps, counterparty: { type: "string" }, amount_yocto: { type: "string", pattern: "^[0-9]{1,40}$" } }, required: ["target"], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: true },
}
```

- Add `guard: ["counterparty", "amount_yocto"]` to `badArgs`. Same rate limit as `diagnose`. Never writes to D1.

**Tests.** `FA_RECENT` fires inside the window and stays silent outside it (fixture nonces). `guardVerdict` gives block / review / allow, one case each. MCP arg validation. Ruleset bump keeps `diff.test.ts` green.

**README.** "Ask Claude Code: *guard kdoncall-p.testnet before paying kdoncall-a.testnet* → see `verdict`" plus one `curl` example.

---

## 2. Treasury transfer alerts in proposal-watch (~1.5 days)

**What.** A new alert kind `treasury_transfer_proposal` for a new `Transfer` proposal that moves a large share of the DAO's balance or pays an account that does not exist.

**Why.** Draining the treasury is the main loss in a DAO. Today a `Transfer` proposal alerts only when a voter has a new key, so a council of honest-looking keys can pass "send 90% of funds" with no alert at all. Social Money names Sputnik DAO treasuries.

**How.**
- In `checkProposals`, for a **new** proposal with `label === "transfer"`:
  - NEAR (`token_id === ""`): `viewAccount(dao, head.height).amount` gives the balance. FT: `callFunction(token, head.height, "ft_balance_of", { account_id: dao })`.
  - Share = amount / balance, in BigInt.
  - `viewAccount(receiver)` checks that the receiver exists.
- Thresholds (new, in `thresholds.ts`, bump ruleset): `TREASURY_HIGH_PCT = 25` → `high`, `TREASURY_NOTE_PCT = 5` → `cleanup`; missing receiver → `high`. Below 5% and the receiver exists → no alert.
- RPC budget: at most 2 extra calls per transfer proposal, counted inside `MAX_PROPOSALS_PER_CHECK`. Failures go into `errors` and never throw.

```ts
if (isNew && p.label === "transfer") {
  const t = await treasuryShare(rpc, dao, head.height, p.body); // { pct, receiverExists } | null
  const sev = t === null ? null
    : !t.receiverExists || t.pct >= TREASURY_HIGH_PCT ? "high"
    : t.pct >= TREASURY_NOTE_PCT ? "cleanup" : null;
  if (sev) alerts.push(alert(base, "treasury_transfer_proposal", info, "-", treasuryAlertText(...), undefined, sev));
}
```

- Telegram rendering: check `apps/worker/src/telegram` renders the new kind; add a render test.

**Contract change (owner decides).** Adding `"treasury_transfer_proposal"` to `AlertKind` and a `treasury?: { balance: string; share_pct: number; receiver_exists: boolean }` evidence field changes `kd.alert.v1`. CLAUDE.md says to bump `schema_version`. Options:
- (a) bump to `kd.alert.v2` everywhere: safe, but touches D1 rows and tests.
- (b) keep `v1` as an additive change and record it in §4.4 plus the commit message. Recommended, since no consumer outside this repo exists yet.

**Tests.** `get_proposal` fixture plus `view_account` / `ft_balance_of` fixtures: 30% → high, 10% → cleanup, 1% → none, missing receiver → high, balance call fails → `errors` and no throw. The dedup `alert_id` stays stable across two calls.

**Demo.** Add a step to `scripts/demo-testnet/demo.sh`: propose a transfer of 30% of the DAO balance → `/run-check` → alert in the group.

---

## 3. Counterparty pre-flight (part of `guard`, ~1 day, optional)

**What.** `guard` with `counterparty` set also checks who the agent is paying.

**Why.** An agent that pays a contract also trusts whoever controls that contract. A contract that still has a full-access key can be redeployed by its owner at any time ("rug" risk). A receiver that got a full-access key minutes ago may have been taken over.

**Checks (one `viewAccount` plus one `viewAccessKeyList`, pinned to the same block):**

| Check | Verdict |
|---|---|
| Account does not exist | `block` |
| Has a full-access key added within 48 h (`FA_RECENT`) | `block` |
| Has contract code (`code_hash` is not all `1`s) **and** at least one full-access key → `CP_UPGRADABLE` | `review` |
| `amount_yocto` > 50% of the agent's own balance → `CP_LARGE_SHARE` | `review` |
| None of the above | `allow` |

```ts
export interface CounterpartyCheck {
  account_id: string;
  exists: boolean;
  has_contract: boolean;
  full_access_keys: number;
  recent_full_access: boolean;
  verdict: Verdict;
  reasons: string[]; // codes; text in messages.ts
}
```

- Reuses `scanAccount` with `skipReceiverCheck: true` to keep the RPC count low.
- Stays out of `kd.report` (it is not a key-hygiene rule); it lives only in `kd.guard.v1`.

**Tests.** One fixture per row of the table.

---

## Order and cut line

1. Item 1 (rule + `guard`): needed by item 3, and it carries the AI-security pitch.
2. Item 2: independent of 1 and 3, can run in parallel (library `proposals.ts` vs new `guard.ts`).
3. Item 3: only if 1 is done by about 2026-11-07.

Cut order if late: 3 → 2. Neither may push GĐ14 (README, video, submission) or the open owner tasks O2, O4 and O7.

## Open questions for the owner

- Which track goes in the submission form? (AI Security & Defense recommended.)
- `kd.alert.v1` change for item 2: (a) bump to v2 or (b) additive v1?
- `FA_MANY` as a `block` reason in `guard`: too strict for normal user accounts? Alternative: block only on `FA_RECENT`.
