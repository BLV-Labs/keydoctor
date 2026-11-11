import { html, type Html } from "./html.ts";

/** One line on the Roadmap page: a short title and one plain sentence. Mirrors the README Status and Roadmap. */
type Item = readonly [title: string, text: string];

/** Built and running on testnet (README "Status"). Only what is deployed or run live goes here. */
export const BUILT: ReadonlyArray<Item> = [
  ["Key checks", "Scan an account or a DAO council with 14 fixed rules and get the reason in plain words. Revoke or delete a key from your own wallet."],
  ["Preflight for agents", "Before an agent signs or pays, one call says whether the account looks safe. It says block when a full-access key is newer than 48 hours."],
  ["On Call in Telegram", "Watch a DAO: the group is warned before the last vote on a risky proposal, and a daily diff reports new and removed keys."],
  ["MCP for AI agents", "Seven tools on a public endpoint run the same checks as the bot and this site. They never sign or hold a key."],
  ["Agent Budget", "An agent holds a key that can only ask a Guard for money. Payments within the limits go out at once, the rest wait for the council."],
  ["Scheduled payouts and DCA", "Plans the council approved run on time, including selling NEAR for USDT on Rhea, and each run is reported in Telegram."],
  ["Yield agent", "Reads Rhea Lend rates for a DAO's idle stablecoins and suggests a move the council votes on. An optional TEE model on NEAR AI Cloud orders the choices."],
  ["Network stats", "One mainnet pass over every Sputnik DAO, published with the numbers behind it."],
];

/** Open work that finishes what exists (README "Roadmap", Next). */
export const NEXT: ReadonlyArray<Item> = [
  ["Exact key dates", "The time each key was added, from an indexer, next to today's estimate from the key's nonce."],
  ["More rules, tested on history", "Run the proposal rules over 12 months of past proposals before adding new ones."],
  ["Guard in the council check", "Show a DAO's Guard and its limits in the council report."],
  ["Strategies for a whole council", "Set up scheduled payouts and DCA from a many-member DAO, so every member votes on the plan."],
  ["Cheaper Guard updates", "Update a Guard by global code hash, so an update does not copy the contract."],
  ["Alerts per chat", "Each chat picks which alerts it gets, and a pending vote names the members who still have to vote. Discord and email."],
  ["Yield on mainnet", "A tiny mainnet run of the yield proposals, then supplying within limits the council set."],
];

/** Where Key Doctor goes after the hackathon (README "Roadmap", Future direction). None of it is built. */
export const FUTURE: ReadonlyArray<Item> = [
  ["NEAR AI", "A hosted agent per DAO: members ask in Telegram, a model on NEAR AI Cloud turns it into a Guard request, and the Guard limits and the council still decide every payment."],
  ["NEAR Intents", "Swap steps through Intents once a DAO can sign an intent, with the quote checked against an outside price."],
  ["Farming on other chains", "Supply stablecoins on another chain while every move stays a council vote: Chain Signatures signs from the DAO, Intents moves the tokens. Research says conditional go for Aave, Compound and Morpho on Base."],
];

/** Revenue is an open question, so the page lists candidates and says nothing is chosen. */
export const REVENUE: ReadonlyArray<string> = [
  "A monthly fee for the hosted agent, paid by the DAO through a proposal the council votes on.",
  "A small fee on plans the keeper runs, written into the Guard and shown before the council approves.",
  "A paid API tier for wallets and agent platforms that call preflight at high volume.",
];

const items = (list: ReadonlyArray<Item>) =>
  html`<ul class="list">${list.map(([title, text]) => html`<li><span class="strong">${title}.</span> ${text}</li>`)}</ul>`;

export function renderRoadmap(): Html {
  return html`<section class="page-head"><div class="stack-sm grow">
      <p class="eyebrow">Roadmap</p>
      <h1 class="h1">What is built, and what comes next</h1>
      <p class="lead">Key Doctor never holds your keys, and fixed rules make every verdict. Every step below keeps that.</p>
    </div></section>
    <section class="card pad stack-sm" aria-labelledby="rm-built">
      <div class="head-title"><h2 id="rm-built" class="h2">Built</h2><span class="pill pill-ok">Live on testnet</span></div>
      ${items(BUILT)}
    </section>
    <section class="card pad stack-sm" aria-labelledby="rm-next">
      <div class="head-title"><h2 id="rm-next" class="h2">Next</h2><span class="pill pill-info">Planned</span></div>
      ${items(NEXT)}
    </section>
    <section class="card pad stack-sm" aria-labelledby="rm-future">
      <div class="head-title"><h2 id="rm-future" class="h2">Future direction</h2><span class="pill pill-note">Not built</span></div>
      ${items(FUTURE)}
      <div class="stack-sm">
        <p class="strong">Revenue <span class="pill pill-note pill-sm">Not decided</span></p>
        <p class="small muted">The checks stay free: scans, preflight, alerts and the public MCP are safety tools. Options after the hackathon:</p>
        <ul class="list">${REVENUE.map((r) => html`<li>${r}</li>`)}</ul>
      </div>
    </section>`;
}
