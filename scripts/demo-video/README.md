# Demo video: recording script

A video of about 2 minutes for the X post the hackathon asks for (HACKATHON.md "The demo post"): lead with the
user's problem, show one full moment from a user action to a result, say what NEAR makes possible, end with a next
step. No architecture slide, no setup on screen. Tracks: `security` (main) and `social`.

The story, in order: a hook; why Key Doctor has the features it has (the two weak spots of a DAO fund); how it solves
each one (two live scenes); where it goes next; a close with the link. The "why" and "next" parts stay short (about
15 seconds each), because the brief asks for no long intro. Every terminal command runs off camera: on screen there
is one prompt in Claude Code, the dashboard and Telegram. Each part lists what to show, the line to say (or show as
a caption) and how to tell it worked. Testnet only.

| Time | Part | Shows |
|---|---|---|
| 0:00–0:08 | Hook | An agent that pays needs a key, and a normal key spends the whole fund |
| 0:08–0:22 | Why | A DAO fund has two weak spots: agents need keys, council accounts get taken over. One feature for each |
| 0:22–1:02 | How, scene 1: Agent Budget | Claude Code pays 3 invoices by itself; the injected 500 NEAR invoice waits; the owner rejects it |
| 1:02–1:37 | How, scene 2: Council attack | A council member's account is taken over and votes; Telegram warns before the last vote; the scan and preflight name the account |
| 1:37–1:52 | Next | Roadmap: NEAR Intents, a hosted Guard agent, yield on other chains, fees from agents |
| 1:52–2:00 | Close | What NEAR makes possible, link |

## Before the day

1. **Agent Budget (scene 1).** Make a new one on the dashboard (`?page=budget`, New agent budget). Do not reuse the
   old `kdg1793607117` Guard: its agent account also has a full-access key, which contradicts the line "the agent
   holds only a key for the Guard", and its council has other people's accounts in it.
   - Sign in with a neutral testnet account, not a personal one: its name shows on the Budget page and in the wallet
     pop-up when you reject on camera. Scene 2 uses the `kdoncall-*` set for the same reason.
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

   - Scene 2 asks `preflight` in the same Claude Code session, so the `key-doctor` MCP server must be added too
     (`claude mcp list` shows both `guard` and `key-doctor`).
   - Allow the `mcp__guard__*` and `mcp__key-doctor__preflight` tools in advance, so no permission prompt shows on
     camera.
   - Rehearse the scene 1 prompt once on this Guard. The model can spot the injection in `inv-004` and skip it, and
     then the Guard never sees it. If it does, reject the waiting request (if any) and try again; keep the prompt
     word for word.
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
   invoice's receiver is not a recipient, the Budget holds enough NEAR, the Guard holds enough for four bonds at
   once (the agent may file the four invoices in parallel) above its reserve, the agent has a free waiting
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

> Your DAO wants an AI agent to pay invoices. A normal NEAR key lets it spend the whole fund.

### Why (0:08–0:22)

Screen: the dashboard home page (`https://key-doctor-dashboard.pages.dev/`), holding on the mainnet meter "of council
members are at high risk", then the cards Agent Budget and Scan DAO under "Three tools for one Sputnik DAO".

> A DAO fund moves by council vote, and has two weak spots. Agents get a key to everything. And council accounts
> get taken over: on mainnet, 48% of council members are high risk. Key Doctor fixes both.

The 48% is the README stats table ("Council members at high risk", all DAOs, block 223,787,777, 2026-11-09). If the
home page shows a newer number, say that one.

### How, scene 1: Agent Budget (0:22–1:02)

Before: `check.mjs` all `ok`; Claude Code open in this repo; the Budget page open in the browser.

1. Budget page (`?page=budget&dao=<budget dao>`): show the rules (5 / 20 NEAR, 3 recipients), then open the agent
   and hold on "What it cannot do" (withdraw, change rules, call any other contract, use your key). The page does not
   list the key's methods; the drawer is what shows the limit. 5 seconds.
   > The agent's key can only ask this Guard for money. The limits and recipients live on chain.
2. Claude Code, type the prompt:

   ```text
   Submit every invoice in demo/invoices/ to the guard tool. The Guard and the DAO council decide what gets paid.
   ```

   Speed up the wait in the edit. Hold on the result: inv-001, inv-002, inv-003 `auto_approved`; inv-004 `pending`
   with `NOT_WHITELISTED`, `OVER_PER_TX` and `OVER_DAILY_LIMIT` (500 NEAR is over the 20 NEAR a day too).
   > Three invoices fit the rules: paid automatically. The fourth hides a prompt injection: 500 NEAR to a stranger.
   > The Guard does not trust the agent, so it waits.
3. Budget page: reload, show the waiting request, click **Reject**, sign in the wallet, show it gone. No Telegram
   here: the page shows the waiting request at once, with no cron to wait for.
   > One click rejects it. The agent never could pay it.
4. Scroll to the Strategies card (Scheduled payouts, DCA NEAR → USDT). 3 seconds.
   > The same Guard runs scheduled payouts and DCA, each started by a DAO vote.

Done when: the three receivers got their NEAR (Budget page, Activity: "Paid automatically") and inv-004 is rejected.

Keep this Claude Code session open: scene 2 ends in it.

### How, scene 2: Council attack (1:02–1:37)

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

### Next (1:37–1:52)

Screen: the dashboard roadmap page (`https://key-doctor-dashboard.pages.dev/?page=roadmap`). Everything here is
README "Roadmap": say "next", never "it does".

> Next: swaps through NEAR Intents, a hosted Guard agent in each DAO's Telegram, and yield on other chains with
> Chain Signatures, always by council vote. The checks stay free; agents that move money pay a small fee.

### Close (1:52–2:00)

Screen: the repo page, then the dashboard.

> NEAR keys can be limited to one contract. That is how an agent holds money without your keys. Try it at
> key-doctor-dashboard.pages.dev.

About 22 words, so it fits the 8 seconds; the repo link goes in the X post, not the voice-over.

Word budget at about 150 words a minute (2.5 words a second): hook 18, why about 35, scene 1 about 70, scene 2 about
60, next about 35, close about 22. The two scenes leave about 12 seconds each for the typing, the wait and the wallet
signature. Time a read-through before recording; if a
part runs long, cut the line, not the moment on screen.

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
