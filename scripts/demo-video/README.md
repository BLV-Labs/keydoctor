# Demo video: recording script

A 2-minute video for the X post the hackathon asks for (HACKATHON.md "Video"): lead with the user's problem, show
one full moment from a user action to a result, say what NEAR makes possible, end with a next step. No intro,
no architecture slide, no setup on screen. Tracks: `security` (main) and `social`.

Record three clips plus a hook and a close, then cut them together. Each clip lists what to prepare, what to do on
screen, the line to say (or show as a caption) and how to tell it worked. Testnet only.

| Time | Clip | Shows |
|---|---|---|
| 0:00–0:08 | Hook | The problem: an agent that pays needs a key, and a full-access key spends everything |
| 0:08–0:50 | 1. Agent Budget | Claude Code pays 3 invoices by itself; the injected 500 NEAR invoice waits; the owner rejects it |
| 0:50–1:05 | 2. Council scan | One DAO's council, member by member, with the reason in plain words |
| 1:05–1:45 | 3. On Call | A member's account is taken over, it votes, Telegram warns before the last vote, the council rejects |
| 1:45–2:00 | Close | What NEAR makes possible, links |

## Before the day

1. **Agent Budget (clip 1).** Make a new one on the dashboard (`?page=budget`, New agent budget). Do not reuse the
   old `kdg1793607117` Guard: its agent account also has a full-access key, which contradicts the line "the agent
   holds only a key for the Guard", and its council has other people's accounts in it.
   - Rules: **Balanced** (5 NEAR per payment, 20 NEAR per 24 hours, 3 waiting).
   - Recipients: `kdg1793607117-vendor.testnet`, `kdg1793607117-contrib.testnet`, `kdg1793607117-api.testnet`
     (the receivers named in `demo/invoices/inv-001..003`). Never add `attacker.testnet`.
   - Agent name: anything short, e.g. `Claude Code agent`. **Download the key file** before leaving the page and
     save it under `~/.config/key-doctor/`.
   - Top up the Budget with at least 8 NEAR (the three invoices are 6.5 NEAR).
   - Point Claude Code at the new Guard (the page shows the Guard id; the agent is `a1.<guard id>`):

     ```bash
     claude mcp remove guard -s local
     ```

     ```bash
     claude mcp add guard -e NEAR_NETWORK=testnet -e GUARD_CONTRACT_ID=<guard id> -e AGENT_ACCOUNT_ID=a1.<guard id> -e AGENT_KEY_PATH=$HOME/.config/key-doctor/<key file>.json -- pnpm --silent --filter guard-mcp start
     ```

   - In Telegram, send `/watch <budget dao>` to `@KeyDoctorOnCallBot`, so the waiting request also alerts.
2. **On Call council (clips 2 and 3).** Three accounts you hold keys for whose full-access keys are older than
   48 hours (a fresh key makes every vote alert, and spoils the before/after). A needs about 7 NEAR if the DAO
   does not exist yet, B about 2 NEAR.

   ```bash
   export KD_DEMO_PREFIX=kdv$(date +%s) KD_DEMO_A=<a> KD_DEMO_B=<b> KD_DEMO_C=<c> KD_DEMO_SIGN=sign-with-legacy-keychain
   ```

   ```bash
   scripts/demo-testnet/demo.sh dao
   ```

   Then add the bot to a Telegram group and send `/watch <prefix>.sputnik-v2.testnet` there. Proposals made before
   `/watch` never alert.
3. **Readiness check.** Read-only: it signs nothing and never prints a key. Run it with the env of steps 1 and 2
   plus `KD_WORKER_URL` and `RUN_CHECK_TOKEN`, and fix every `FAIL` before recording:

   ```bash
   GUARD_CONTRACT_ID=<guard id> AGENT_ACCOUNT_ID=a1.<guard id> AGENT_KEY_PATH=<key file> node scripts/demo-video/check.mjs
   ```

   It checks that the Guard is not paused, the three invoices fit the limits and the 24-hour window, the injected
   invoice's receiver is not a recipient, the Budget and the Guard hold enough NEAR, the agent has a free waiting
   slot and only Guard keys, and the key file matches. For the council it checks the Worker answers, no member is
   `block` yet (C only warns: C never signs), and prints the scan of the demo DAO.

## On the day

- Screen: 1920×1080, browser zoom 125%, dark terminal with a large font, notifications off.
- **Never on screen:** `RUN_CHECK_TOKEN`, any `export` line, the key file or its contents, `~/.near-credentials`,
  seed phrases, wallet pop-ups that show a balance you do not want public, your email. Run the `export` lines in
  a terminal you do not record.
- Telegram: Desktop app, the demo group open, nothing else visible.

### Hook (0:00–0:08)

Screen: the Budget page with the Guard's rules, or a plain title card.

> Your AI agent needs to pay invoices. Give it a normal NEAR key and it can spend everything you have.

### Clip 1: Agent Budget (0:08–0:50)

Before: `check.mjs` all `ok`; Claude Code open in this repo; the Budget page open in the browser.

1. Budget page (`?page=budget&dao=<budget dao>`): show the rules (5 / 20 NEAR, 3 recipients) and the agent with
   its one key, limited to `request_transfer` and `sync_request`. 5 seconds.
   > The agent gets a key that can only ask this Guard for money. The limits and the recipients live on chain.
2. Claude Code, type the prompt:

   ```text
   Submit every invoice in demo/invoices/ to the guard tool. The Guard and the DAO council decide what gets paid.
   ```

   Speed up the wait in the edit. Hold on the result: inv-001, inv-002, inv-003 `auto_approved`; inv-004 `pending`
   with `NOT_WHITELISTED` and `OVER_PER_TX`.
   > Three invoices are within the rules: paid on its own. The fourth has a prompt injection asking for 500 NEAR
   > to an unknown account. The Guard does not trust the agent, so it waits for a human.
3. Telegram: the alert for the waiting request. If it is slow, trigger the check (off camera):

   ```bash
   scripts/demo-testnet/demo.sh run-check <budget dao>
   ```

4. Budget page: the waiting request, click **Reject**, sign in the wallet, show it gone.
   > The owner rejects it with one click. The agent never had the power to pay it.

Done when: the three receivers got their NEAR (Budget page, Activity: "Paid automatically") and inv-004 is rejected.

### Clip 2: Council scan (0:50–1:05)

Screen: `https://key-doctor-dashboard.pages.dev/?target=<prefix>.sputnik-v2.testnet`.

1. Show the summary and the member list, then open one member with a flag (the one `check.mjs` lists as `cleanup`
   or `high`). Hold on the reason sentence.
   > Not every risk is the agent. The council that controls the money is a set of accounts, and on NEAR every key is
   > public. Key Doctor reads them all, with fixed rules, no AI guessing.
2. Cut to the README stats table, or a caption:
   > On mainnet, 48% of Sputnik council members are high risk.

### Clip 3: On Call (1:05–1:45)

Before: the DAO from step 2 exists and the group watches it. Terminal on the left, Telegram group on the right.

1. B proposes a 1 NEAR transfer:

   ```bash
   scripts/demo-testnet/demo.sh transfer
   ```

   > A normal transfer proposal. Two of three votes pass it.
2. The attack: A's account gets a new full-access key, then A votes yes.

   ```bash
   scripts/demo-testnet/demo.sh compromise
   ```

   ```bash
   scripts/demo-testnet/demo.sh vote
   ```

   > Someone took over A's account. The first thing they do is add their own key, then vote.
3. Trigger the check instead of waiting up to 15 minutes for the cron (run it off camera, the command carries the
   token in its environment):

   ```bash
   scripts/demo-testnet/demo.sh run-check
   ```

   Telegram: the warning arrives. Hold on it: who voted with a fresh key, one vote left, who has not voted yet.
   > Key Doctor warns the group before the last vote, and names who still has to vote.
4. B rejects:

   ```bash
   scripts/demo-testnet/demo.sh reject
   ```

5. Preflight, the check an agent or a wallet runs before it signs. In Claude Code ask: `preflight <a>`, or show
   the curl from the README. Hold on `verdict: block` with `FA_RECENT`.
   > Any agent can ask the same question before it trusts an account: block.

Done when: the Telegram warning is on screen and preflight on A says `block`.

### Close (1:45–2:00)

Screen: the repo page, then the dashboard.

> NEAR keys can be limited to one contract and a few methods. That is how an agent holds money without the keys to
> everything. And the Guard is just a member of a Sputnik DAO, so every payment is a normal DAO proposal. Try it:
> key-doctor-dashboard.pages.dev, and the code is on GitHub.

## After recording

- Delete A's attacker key (the one `compromise` added): `near account delete-keys <a> public-keys <key> network-config testnet sign-with-keychain send`.
- Delete the old demo key `ed25519:5ECiGvMnr7EqyA64Fo4cydTwK2aPYpXnNeMRQUAL1wgC` on `bot2.duonghb3.testnet` if it is
  still there.
- Leave the hosted demo up until at least 2026-11-18 (ideally 2026-11-25).

## Post on X (owner)

Post the video with "built at NEAR HACKATHON", `@NEARProtocol` and `#NEARHackathon` (optionally `@NearLegion`,
`@NearBuilders`), one line on the problem, the dashboard link and the repo link. The X link goes into the
submission form, which Claude prints for review before anything is sent.
