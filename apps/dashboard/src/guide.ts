// User guide: one page that walks through every built feature with "do X, see Y" steps and screenshots of the live
// testnet dashboard. Only what the README Status table and roadmap.ts BUILT list say works goes here.
// The images live in public/guide/ (webp, captured from https://key-doctor-dashboard.pages.dev on testnet accounts).
import { html, type Html } from "./html.ts";
import { BOT_USERNAME, BOT_URL, budgetHref, budgetNewHref, guardHref, pageHref, routeHref, yieldHref } from "./route.ts";

/** One screenshot. Width and height are the file's own, so the page does not jump while it loads. */
export type Shot = { file: string; w: number; h: number; alt: string; caption: string };

/** Every image the guide shows; the test checks each file exists in public/guide/. */
export const SHOTS = {
  home: { file: "home.webp", w: 1280, h: 800, alt: "The Key Doctor home page with the name field and the Check button", caption: "The home page: type a name and press Check." },
  council: { file: "check-council.webp", w: 1280, h: 1370, alt: "Council report for a testnet DAO: one member to act on now, the members table and an open transfer vote with the members who still have to vote", caption: "A council scan: the worst member first, then every member, then open votes and who still has to vote." },
  account: { file: "check-account.webp", w: 1280, h: 1000, alt: "Account report for kdoncall-b.testnet: a red alert for a new master key, two things to tidy up and the keys table", caption: "An account scan: the alert on top, then what to tidy up, then every key." },
  keyDetails: { file: "check-key-details.webp", w: 560, h: 600, alt: "Key details dialog: public key, what it can do, when it was added, uses, nonce and why it matters", caption: "Details: the facts behind one key and why it matters." },
  cleanup: { file: "check-cleanup.webp", w: 1280, h: 870, alt: "Clean up keys plan for kdoncall-p.testnet with steps in a safe order and Revoke buttons", caption: "Clean up keys: one step per key, in a safe order." },
  alerts: { file: "oncall-alerts.webp", w: 480, h: 800, alt: "Alerts drawer with the /watch command, what the chat will get and the bot commands", caption: "The Alerts drawer gives you the exact /watch line for this page." },
  telegram: { file: "oncall-telegram.webp", w: 600, h: 636, alt: "Telegram warning in Vietnamese and English: a voter has a new full-access key before the last vote on a transfer, with the members still to vote", caption: "A warning before the last vote: what the proposal does, which voter has a new key, who still has to vote." },
  mcp: { file: "mcp.webp", w: 1280, h: 1120, alt: "For developers page: the MCP endpoint, the command to add it to Claude Code and the tools", caption: "For developers (MCP): the endpoint and the tools." },
  budgetCreate: { file: "budget-create.webp", w: 1280, h: 730, alt: "Agent Budget start page: Create, Top up and Connect your agent steps, strategy cards and a field to open a Budget by name", caption: "Agent Budget: create a Budget, or open one by name." },
  budgetOverview: { file: "budget-overview.webp", w: 1280, h: 1050, alt: "Budget demohkt.sputnik-v2.testnet: balance, spent today, Needs you, and Activity with a 500 NEAR request to attacker.testnet rejected", caption: "A Budget: what is left today, what needs you, and every request the agent made." },
  budgetRules: { file: "budget-rules.webp", w: 360, h: 730, alt: "Budget side panel: the limits, who agents can pay, the agents and the Plans card", caption: "Limits, recipients and agents, each with a button to change them." },
  plans: { file: "budget-plans.webp", w: 1280, h: 720, alt: "Budget payroll-2 Activity with DCA swaps and scheduled payouts, and the Plans card with three plans and their runs", caption: "Plans: each scheduled payout and DCA plan, its runs and its state. Each run shows in Activity." },
  guard: { file: "guard.webp", w: 1280, h: 1100, alt: "Agent Guard page for kdoncall.sputnik-v2.testnet: the Guard's limits, guardians and the agent owner's setup commands", caption: "Agent Guard: a Guard's limits and the two commands the agent's owner runs." },
  yield: { file: "yield.webp", w: 1280, h: 1035, alt: "Yield page for kdoncall.sputnik-v2.testnet: idle test USDC, the rate now, a suggestion and the Propose button", caption: "Yield: idle stablecoins, the rate now, and one suggestion the council votes on." },
} satisfies Record<string, Shot>;

const shot = (s: Shot, narrow = false): Html =>
  html`<figure class="guide-shot${narrow ? " guide-shot-narrow" : ""}">
    <img src="guide/${s.file}" width="${String(s.w)}" height="${String(s.h)}" alt="${s.alt}" loading="lazy" decoding="async">
    <figcaption class="small muted">${s.caption}</figcaption>
  </figure>`;

/** Numbered "do X → see Y" steps. */
const steps = (items: ReadonlyArray<readonly [doThis: Html | string, seeThis: Html | string]>): Html =>
  html`<ol class="guide-steps">${items.map(([d, s]) => html`<li><span class="strong">${d}</span> <span aria-hidden="true">→</span><span class="sr-only">then</span> ${s}</li>`)}</ol>`;

const code = (text: string): Html => html`<pre class="guide-code mono small wrap">${text}</pre>`;

const link = (href: string, text: string): Html => html`<a href="${href}" data-nav>${text}</a>`;

const DAO = "kdoncall.sputnik-v2.testnet";
const MCP_URL = "https://key-doctor.duonghb53.workers.dev/mcp";

const TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["diagnose", "The report of an account or a DAO council: status and every member's flags"],
  ["list_keys", "One row per access key: member, what it may do, age, uses, flags"],
  ["list_proposals", "The DAO's proposals, newest first, with the votes and who still has to vote"],
  ["compare", "What changed since the stored baseline. It never moves an existing baseline"],
  ["watch", "Two one-time Telegram links; opening one subscribes that chat"],
  ["preflight", "Before an agent signs or pays: allow, review or block for one account"],
  ["yield_suggestions", "Rhea Lend rates for a DAO's idle stablecoins, next to the council's key status"],
];

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["/check <name>", "Scan an account or a DAO now"],
  ["/changes <name>", "What changed since the last baseline"],
  ["/watch <name>", "Subscribe this chat to warnings and the daily key diff"],
  ["/unwatch <name>, /list", "Stop watching, or list what this chat watches"],
  ["/yield <dao>, /yield_watch <dao>", "Rates for the DAO's idle stablecoins, or a message when the suggestion changes"],
  ["/help", "Every command"],
];

const table = (headers: readonly [string, string], rows: ReadonlyArray<readonly [string, string]>): Html =>
  html`<div class="card table-scroll"><table class="info-table"><thead><tr><th>${headers[0]}</th><th>${headers[1]}</th></tr></thead>
    <tbody>${rows.map(([a, b]) => html`<tr><td><code class="mono">${a}</code></td><td>${b}</td></tr>`)}</tbody></table></div>`;

const SECTIONS: ReadonlyArray<readonly [id: string, title: string]> = [
  ["guide-check", "Check keys"],
  ["guide-oncall", "Alerts in Telegram"],
  ["guide-mcp", "For AI agents (MCP)"],
  ["guide-budget", "Agent Budget"],
  ["guide-guard", "Agent Guard"],
  ["guide-plans", "Scheduled payouts and DCA"],
  ["guide-yield", "Yield"],
];

const section = (id: string, title: string, lead: string, body: Html): Html =>
  html`<section class="card pad stack guide-section" id="${id}" aria-labelledby="${id}-h">
    <div class="stack-xs"><h2 id="${id}-h" class="h2">${title}</h2><p class="muted">${lead}</p></div>
    ${body}
  </section>`;

export function renderGuide(): Html {
  return html`<section class="page-head"><div class="stack-sm grow">
      <h1 class="h1">User guide</h1>
      <p class="lead">Every Key Doctor tool, step by step: what to do and what you will see. The pictures are from this site on testnet.</p>
      <p class="small muted">Key Doctor never signs a transaction and never holds your keys. Every change is signed by you, in your own wallet.</p>
    </div></section>
    <nav class="card pad guide-toc" aria-label="On this page">
      <h2 class="h3">On this page</h2>
      <ol class="list small">${SECTIONS.map(([id, title]) => html`<li><a href="#${id}">${title}</a></li>`)}</ol>
    </nav>

    ${section("guide-check", "Check keys", "Find out who can move an account's money, and remove the keys you do not need.", html`
      ${steps([
        ["Type an account or a DAO name on the home page and press Check.", html`The scan runs in your browser against public NEAR RPC. Try ${link(routeHref(DAO), DAO)}.`],
        ["Scan a DAO.", "You get the council: its status, how many votes a transfer needs, every member sorted by risk, and the open votes with who still has to vote."],
        ["Scan an account.", "The worst finding is on top in plain words, then the things to tidy up, then every key: what it can do, when it was added, how often it was used."],
        ["Press Details on a key.", "You see the public key, its permission, when it was added (read from its nonce), its uses and why it matters."],
        ["Press Connect Wallet (Meteor, Here or HOT) with the account the scan is about.", "Revoke and Delete unlock. Each removes one key, and you approve it in your wallet."],
        ["Press Clean up keys.", html`You get a plan in a safe order. Scan again after each step and it is ticked from chain data. Try ${link(routeHref("kdoncall-p.testnet"), "kdoncall-p.testnet")}.`],
      ])}
      ${shot(SHOTS.home)}
      <div class="guide-pair">${shot(SHOTS.council)}${shot(SHOTS.account)}</div>
      <div class="guide-pair">${shot(SHOTS.keyDetails, true)}${shot(SHOTS.cleanup)}</div>
    `)}

    ${section("guide-oncall", "Alerts in Telegram", "Get warned in your group before the last vote on a risky proposal, and see new keys every day.", html`
      ${steps([
        ["Press Alerts in the header.", "The drawer shows the exact /watch line for the name on screen and what the chat will get."],
        [html`Add <a href="${BOT_URL}" rel="noopener" target="_blank">@${BOT_USERNAME}</a> to your group and send <code class="mono">/watch ${DAO}</code>.`, "The chat is subscribed. /list shows what it watches, /unwatch stops."],
        ["Wait for a risky vote.", "Every 15 minutes the bot reads open proposals. When a voter has a new full-access key, or a proposal changes members, policy or contract code, the group is warned before the last vote, with the members who still have to vote."],
        ["Wait a day.", "A daily message lists the keys added and removed on each watched name since the last check."],
      ])}
      <div class="guide-pair">${shot(SHOTS.alerts, true)}${shot(SHOTS.telegram, true)}</div>
      ${table(["Command", "What it does"], COMMANDS)}
    `)}

    ${section("guide-mcp", "For AI agents (MCP)", "Seven read-only tools on a public endpoint run the same checks as this site and the bot.", html`
      ${steps([
        [html`Open ${link(pageHref("mcp"), "For developers (MCP)")} in the footer.`, "You see the endpoint, the tools and the line to add them to Claude Code."],
        ["Add the server to Claude Code, then ask “check the keys of kdoncall.sputnik-v2.testnet”.", "The agent calls diagnose and answers with the same status as this site."],
        ["Before an agent signs or pays from an account, call preflight on it.", html`<span class="strong">block</span> means a full-access key was added in the last 48 hours: do not sign. <span class="strong">review</span> means other flags. <span class="strong">allow</span> means notes only.`],
      ])}
      ${code(`claude mcp add --transport http key-doctor ${MCP_URL}`)}
      ${code(`curl -s ${MCP_URL} -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preflight","arguments":{"target":"kdoncall-a.testnet"}}}'`)}
      ${table(["Tool", "What it returns"], TOOLS)}
      ${shot(SHOTS.mcp)}
    `)}

    ${section("guide-budget", "Agent Budget", "Give an AI agent its own money with limits. Payments inside the limits go out at once; the rest wait for you.", html`
      ${steps([
        [html`Open ${link(budgetNewHref(), "Agent Budget")} and pick Cautious (1 NEAR a payment, 5 NEAR a day), Balanced (5 / 20) or Custom.`, "Two signatures in your wallet create the Budget, its spending contract and the agent. The agent's key is made in your browser and downloaded as a file."],
        ["Press Top up.", "The Budget has money the agent can ask for. Withdraw takes it back."],
        [html`Open ${link(budgetHref("demohkt.sputnik-v2.testnet"), "a Budget")} by name.`, "You see the balance, what was spent in the last 24 hours, what needs you, and every request the agent made."],
        ["Look at Needs you.", "A payment over a limit, or to someone not on your list, waits here. Approve or Reject it; it expires after 72 hours."],
        ["Look at Activity.", "Every request with its outcome: paid automatically, waited for you, or rejected with the reason."],
        ["Use the side panel.", "Change the limits, Manage who agents can pay, Add agent, or Pause every agent at once. Each button says how many signatures it takes."],
        [html`Open ${link("?page=budget&help=agent", "How your agent works")}.`, "The agent's owner gets the two steps to connect it: the key file and the claude mcp add guard line."],
        [html`Open ${link(pageHref("my-agents"), "My agents")} and connect your wallet.`, "You see every agent of the DAOs where your account sits on the council."],
      ])}
      ${shot(SHOTS.budgetCreate)}
      <div class="guide-pair guide-pair-wide">${shot(SHOTS.budgetOverview)}${shot(SHOTS.budgetRules, true)}</div>
    `)}

    ${section("guide-guard", "Agent Guard", "The same limits for a DAO that already has a council of several members.", html`
      ${steps([
        [html`Open ${link(guardHref(DAO), "Agent Guard")} for your DAO.`, "You see each Guard: its limits, what is left of the 24-hour window, its guardians, and the agent owner's two setup commands."],
        ["Fill the create form as a council member.", "Your wallet signs one transaction with two proposals: create the Guard, then give it its role. The council votes in its usual DAO UI."],
        ["Press Propose a change.", "A proposal to change limits, add an agent or a recipient, or unpause."],
      ])}
      ${shot(SHOTS.guard)}
    `)}

    ${section("guide-plans", "Scheduled payouts and DCA", "Plans the owner approved run on time. A keeper with no power over the money only starts each due step.", html`
      ${steps([
        ["On a Budget, press New payout.", "Pick a recipient from your list, an amount, how often and how many runs. A review step shows the total before the two signatures."],
        ["Press New DCA.", "A checklist first (update the Budget, allow swaps, enable USDT, each one signature), then NEAR per run, how often, how many runs and the lowest price you accept."],
        ["Look at Plans.", "Each plan with its runs and state. Pause, Resume or Cancel it there."],
        ["Watch the Budget in Telegram.", "Each run is reported: the payout, or the USDT received and the average price. A run under your lowest price is skipped."],
      ])}
      ${shot(SHOTS.plans)}
    `)}

    ${section("guide-yield", "Yield", "See what a DAO's idle stablecoins could earn on Rhea Lend. It is data for the council, not financial advice: the council decides and signs.", html`
      ${steps([
        [html`Open ${link(yieldHref(DAO), "Yield")} for a DAO.`, "You see the idle stablecoins (balance minus open transfer proposals), the rate now, and one suggestion capped at the amount that earns the most."],
        ["Press Propose.", "Your wallet signs one proposal (register with Rhea Lend, supply, or withdraw). The council votes on it like any other proposal."],
        ["Press Take money back.", "A proposal to withdraw part or all of it."],
        [html`Send <code class="mono">/yield_watch ${DAO}</code> to the bot.`, "The chat gets a message when the top suggestion changes or its rate moves by half a point."],
      ])}
      ${shot(SHOTS.yield)}
    `)}

    <section class="card pad stack-xs" aria-labelledby="guide-next">
      <h2 id="guide-next" class="h2">What comes next</h2>
      <p class="small">Exact key dates, more rules, yield on mainnet and more: see the ${link(pageHref("roadmap"), "Roadmap")}.</p>
    </section>`;
}
