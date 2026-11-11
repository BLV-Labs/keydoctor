# Demo video: recording script

A 90-second video for the X post the hackathon asks for (HACKATHON.md "Video"): lead with the user's problem, show
one full moment from a user action to a result, say what NEAR makes possible, end with a next step. No intro,
no architecture slide, no setup on screen. Tracks: `security` (main) and `social`.

Two scenes plus a hook and a close. Every terminal command runs off camera: on screen there is one prompt in Claude
Code, the dashboard and Telegram. Each scene lists what to prepare, what to show, the line to say (or show as a
caption) and how to tell it worked. Testnet only.

| Time | Scene | Shows |
|---|---|---|
| 0:00–0:08 | Hook | The problem: an agent that pays needs a key, and a full-access key spends everything |
| 0:08–0:45 | 1. Agent Budget | Claude Code pays 3 invoices by itself; the injected 500 NEAR invoice waits; the owner rejects it |
| 0:45–1:20 | 2. Council attack | A council member's account is taken over and votes; Telegram warns before the last vote; the scan and preflight name the account |
| 1:20–1:30 | Close | What NEAR makes possible, links |

## Before the day

1. **Agent Budget (scene 1).** Make a new one on the dashboard (`?page=budget`, New agent budget). Do not reuse the
   old `kdg1793607117` Guard: its agent account also has a full-access key, which contradicts the line "the agent
   holds only a key for the Guard", and its council has other people's accounts in it.
   - Rules: **Balanced** (5 NEAR per payment, 20 NEAR per 24 hours, 3 waiting).
   - Recipients: `kdg1793607117-vendor.testnet`, `kdg1793607117-contrib.testnet`, `kdg1793607117-api.testnet`
     (the receivers named in `demo/invoices/inv-001..003`). Never add `attacker.testnet`.
   - Agent name: anything short, e.g. `Claude Code agent`. **Download the key file** before leaving the page and
     save it under `~/.config/key-doctor/`.
   - Top up the Budget with at least 8 NEAR (the three invoices are 6.5 NEAR).
   - Point Claude Code at the new Guard (the page shows the Guard id; the agent is `a1.<guard id>`). Claude Code must
     be opened inside this repo, because the server starts with `pnpm --filter`:

     ```bash
     claude mcp remove guard -s local
     ```

     ```bash
     claude mcp add guard -e NEAR_NETWORK=testnet -e GUARD_CONTRACT_ID=<guard id> -e AGENT_ACCOUNT_ID=a1.<guard id> -e AGENT_KEY_PATH=$HOME/.config/key-doctor/<key file>.json -- pnpm --silent --filter guard-mcp start
     ```

2. **Council DAO (scene 2).** Three accounts you hold keys for whose full-access keys are older than 48 hours (a
   fresh key makes every vote alert, and spoils the before/after). A needs about 7 NEAR if the DAO does not exist
   yet, B about 2 NEAR. Owner decision 2026-11-11: use the neutral `kdoncall-*` set, so no personal account name
   shows on screen. A = `kdoncall-b.testnet` (9.99 NEAR), B = `kdoncall-c.testnet` (10 NEAR), one full-access key
   each, about 12 days old. C = `kdoncall-p.testnet` (10 NEAR) is the third member and never signs. Read
   2026-11-11. Short of NEAR: top up from `duonghb3.testnet`.

   ```bash
   export KD_DEMO_PREFIX=kdv$(date +%s) KD_DEMO_A=kdoncall-b.testnet KD_DEMO_B=kdoncall-c.testnet KD_DEMO_C=kdoncall-p.testnet KD_DEMO_SIGN=sign-with-legacy-keychain
   ```

   A and B also sit on the council of `kdoncall.sputnik-v2.testnet`, the README and dashboard example. While the
   attacker key from `compromise` is on `kdoncall-b`, that example shows a high flag and preflight on `kdoncall-b`
   says `block`, so delete the key right after recording (see "After recording").

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
- **Never on screen:** `RUN_CHECK_TOKEN`, any `export` line, any `demo.sh` command, the key file or its contents,
  `~/.near-credentials`, seed phrases, wallet pop-ups that show a balance you do not want public, your email. Run
  every command in a terminal you do not record.
- Telegram: Desktop app set to English (command replies follow the app language), the demo group open, nothing
  else visible. Cron alerts carry Vietnamese then English (`ALERT_LANG = "both"`, kept): hold the frame on the
  English half.

### Hook (0:00–0:08)

Screen: a plain title card, or the Budget page.

> Your AI agent needs to pay invoices. Give it a normal NEAR key and it can spend everything you have.

### Scene 1: Agent Budget (0:08–0:45)

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
3. Budget page: reload, show the waiting request, click **Reject**, sign in the wallet, show it gone. No Telegram
   here: the page shows the waiting request at once, with no cron to wait for.
   > The owner rejects it with one click. The agent never had the power to pay it.

Done when: the three receivers got their NEAR (Budget page, Activity: "Paid automatically") and inv-004 is rejected.

Keep this Claude Code session open: scene 2 ends in it.

### Scene 2: Council attack (0:45–1:20)

Before: the DAO from step 2 exists and the group watches it. Telegram, the dashboard and Claude Code are open.

Off camera, in the terminal with the step 2 env and `RUN_CHECK_TOKEN`, run the whole attack in one line. B proposes
a 1 NEAR transfer, A's account gets a new full-access key (the attacker's), A votes yes, then the check runs instead
of waiting up to 15 minutes for the cron:

```bash
scripts/demo-testnet/demo.sh transfer && scripts/demo-testnet/demo.sh compromise && scripts/demo-testnet/demo.sh vote && scripts/demo-testnet/demo.sh run-check
```

Do not reject before the warning has arrived: a proposal already closed when Key Doctor reads it carries an
"already closed" note instead of the warning you want on screen.

1. Telegram: the warning arrives. Hold on the English half: who voted with a fresh key, one vote left, who has not
   voted yet.
   > Someone took over a council member's account, added their own key, and voted. Key Doctor warns the group
   > before the last vote, and names who still has to vote.
2. Dashboard `https://key-doctor-dashboard.pages.dev/?target=<prefix>.sputnik-v2.testnet`: the summary, then open A
   (`kdoncall-b`), flagged high. Hold on the reason ("New full-access key… the account may be compromised.").
   > On NEAR every key is public. Key Doctor reads every council member's keys, with fixed rules, no AI guessing.
3. Claude Code, the session from scene 1: ask `preflight kdoncall-b.testnet`. Hold on `verdict: block` with
   `FA_RECENT`.
   > Any agent can ask the same question before it trusts an account: block.

Done when: the Telegram warning, A's high flag and preflight `block` are each on screen.

Optional caption between 2 and 3, from the README stats table:

> On mainnet, 48% of Sputnik council members are high risk.

### Close (1:20–1:30)

Screen: the repo page, then the dashboard.

> NEAR keys can be limited to one contract and a few methods. That is how an agent holds money without the keys to
> everything. And the Guard is just a member of a Sputnik DAO, so every payment is a normal DAO proposal. Try it:
> key-doctor-dashboard.pages.dev, and the code is on GitHub.

## After recording

- B rejects the open transfer proposal, so A's vote never passes it:

  ```bash
  scripts/demo-testnet/demo.sh reject
  ```

- Delete A's attacker key (the one `compromise` added): `near account delete-keys kdoncall-b.testnet public-keys <key> network-config testnet sign-with-legacy-keychain send`.
- Delete the old demo key `ed25519:5ECiGvMnr7EqyA64Fo4cydTwK2aPYpXnNeMRQUAL1wgC` on `bot2.duonghb3.testnet` if it is
  still there.
- Leave the hosted demo up until at least 2026-11-18 (ideally 2026-11-25).

## Post on X (owner)

Post the video with "built at NEAR HACKATHON", `@NEARProtocol` and `#NEARHackathon` (optionally `@NearLegion`,
`@NearBuilders`), one line on the problem, the dashboard link and the repo link. The X link goes into the
submission form, which Claude prints for review before anything is sent.
