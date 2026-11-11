import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INVALID_NAME_MESSAGE, axisScale, renderHome, renderNetworkStats } from "../src/pages.ts";
import { NETWORK_STATS, type HomeStats } from "../src/network-stats.ts";

const text = (h: { value: string }) => h.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** Everything except the check card: that card keeps "DAO" and *.sputnik names because users type them there. */
const outsideCheckCard = (h: { value: string }) =>
  text({ value: h.value.replace(/<section id="check"[\s\S]*?<\/section>/, " ") });

describe("K1 home", () => {
  it("hero CTA sends a new visitor to the budget wizard and a signed-in owner to Your agents", () => {
    // WHY: the one-click promise of K1 — each visitor lands on their job, and an owner never sees "set up" again.
    const out = renderHome("", null, "testnet", false).value;
    assert.match(out, /href="\?page=budget"[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?Set up an agent budget/);
    assert.doesNotMatch(out, /Go to your agents/);
    const inn = renderHome("", null, "testnet", true).value;
    assert.match(inn, /href="\?page=my-agents"[^>]*>Go to your agents/);
    assert.doesNotMatch(inn, /class="btn btn-primary" href="\?page=budget"/);
    // The secondary CTA is the same in both states.
    assert.match(inn, /href="#check"[^>]*>[\s\S]*?Scan a DAO's keys/);
  });

  it("keeps the check form: id=check card, network switch in the form head, testnet-only Try links", () => {
    // WHY: the scan entry point and its network switch are the product's core path; the redesign must not break them.
    const t = renderHome("", null, "testnet").value;
    assert.match(t, /<section id="check"/);
    assert.match(t, /<form id="check-form"/);
    assert.match(t, /<div class="form-head">\s*<label for="target"[\s\S]*?class="segmented"/);
    assert.match(t, /data-network="testnet" aria-pressed="true"/);
    assert.match(t, /kdoncall-p\.testnet/);
    const m = renderHome("", null, "mainnet").value;
    assert.match(m, /data-network="mainnet" aria-pressed="true"/);
    assert.doesNotMatch(m, /kdoncall/);
  });

  it("shows the plain-words field error under the input and marks it invalid", () => {
    // WHY: a typo must say what a NEAR name looks like, not "invalid target".
    const out = renderHome("bad name", INVALID_NAME_MESSAGE).value;
    assert.equal(INVALID_NAME_MESSAGE, "Not a NEAR account name. Names end in .testnet or .near.");
    assert.match(out, /<p id="target-error" class="field-error" role="alert">Not a NEAR account name\. Names end in \.testnet or \.near\.<\/p>/);
    assert.match(out, /aria-invalid="true"/);
    assert.doesNotMatch(renderHome("", null).value, /target-error/);
  });

  it("preview card is decorative: aria-hidden, fixed testnet sample text", () => {
    // WHY: sample numbers read aloud would look like the visitor's own data.
    const out = renderHome("", null).value;
    assert.match(out, /<div class="card pad stack-sm home-preview" aria-hidden="true">/);
    assert.match(out, /Research bot/);
  });

  it("has the three steps, one card per Sputnik DAO pillar and three trust items", () => {
    // WHY: the home page is built around the three tools a Sputnik DAO council uses: Scan DAO, Agent Budget and Yield.
    const out = renderHome("", null).value;
    assert.equal((out.match(/class="home-step"/g) ?? []).length, 3);
    const cards = [...out.matchAll(/class="card pad stack-sm home-path pillar-card pillar-(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(cards, ["scan", "budget", "yield"]);
    assert.equal((out.match(/<li><svg[\s\S]*?<\/svg><span>/g) ?? []).length, 3);
    assert.match(text(renderHome("", null)), /Three tools for one Sputnik DAO/);
    assert.match(out, /href="\?page=yield"/);
  });

  it("links down to the check card without data-nav, so a click scrolls instead of repainting the top", () => {
    // WHY: a data-nav link runs navigate(), which scrolls to the top and repaints: the council and own-keys buttons did nothing.
    const out = renderHome("", null).value;
    const jumps = out.match(/<a [^>]*href="#check"[^>]*>/g) ?? [];
    assert.equal(jumps.length, 3);
    for (const a of jumps) {
      assert.match(a, /data-action="jump-check"/);
      assert.doesNotMatch(a, /data-nav/);
    }
    assert.match(out, /data-placeholder="kdoncall\.sputnik-v2\.testnet">Scan a council</);
    assert.match(out, /data-placeholder="kdoncall-p\.testnet" data-fill="wallet">Check my own keys</);
    assert.match(renderHome("", null, "mainnet").value, /data-placeholder="your-name\.near"/);
  });

  it("names Sputnik DAO but no other internal words outside the check card", () => {
    // WHY: the home page now speaks to Sputnik DAO councils by name (owner request 2026-11-11), so "DAO" and "Sputnik"
    // are allowed; a first-time visitor must still not meet Guard, proposal or chain jargon (handoff README "Words").
    for (const signedIn of [false, true]) {
      const t = outsideCheckCard(renderHome("", null, "testnet", signedIn));
      assert.doesNotMatch(t, /\b(proposal|policy|whitelist|yocto|nonce|Guard|Keyfence)/i);
      assert.match(t, /Sputnik DAO/);
      assert.match(t, /Key Doctor/);
    }
  });

  it("key bars share one round count axis, so the longer bar means more keys", () => {
    // WHY: two bars on separate scales would hide that app keys outnumber full-access keys almost 3 to 1.
    assert.deepEqual(axisScale(35599), { max: 40000, ticks: [0, 10000, 20000, 30000, 40000] });
    assert.deepEqual(axisScale(13686), { max: 20000, ticks: [0, 10000, 20000] });
    assert.deepEqual(axisScale(0), { max: 1, ticks: [0, 1] });
    const h = renderNetworkStats(NETWORK_STATS).value;
    const bars = [...h.matchAll(/<div class="axis-track"[^>]*><div class="seg-bar (w-\d+)">/g)].map((m) => m[1]);
    assert.deepEqual(bars, ["w-34", "w-89"]); // 13,686 and 35,599 of 40,000
  });

  it("network numbers come from the pnpm stats output, with their source block and the scans left out", () => {
    // WHY: a judge reruns `pnpm stats` and must find the same numbers; a hand-typed figure on the page would drift.
    const s: HomeStats = { ...NETWORK_STATS, scope: "all", block_height: 223787777, block_timestamp: "2026-11-09T15:49:10Z", daos_active: 716, daos_scanned: 2077, daos_failed: 35, council_size: { median: 2, one_member: 1000 }, daos_single_vote_transfer: 1307, council_members: 3489, members_unreadable: 281, members_high: 1671, function_call_keys: 35599, function_call_keys_never_used: 31214, full_access_keys: 13686, full_access_keys_never_used: 3196 };
    const t = text(renderNetworkStats(s));
    assert.match(t, /48% of Sputnik DAOs have a one-person council 1,000 of 2,077 DAOs/);
    assert.match(t, /63% of Sputnik DAOs let one account approve a payment/);
    assert.match(t, /48% of council members are at high risk 1,671 of 3,489 members/);
    assert.match(t, /88% of council members' app keys were never used 31,214 of 35,599 app keys/);
    assert.match(t, /23% of council members' full-access keys were never used 3,196 of 13,686 full-access keys/);
    // Totals: keys checked is full-access plus app keys of the members that could be read.
    assert.match(t, /2,077 Sputnik DAOs read 3,489 council members 49,285 keys checked 2 members in the median council/);
    // The members bar is one whole: high + read without a high finding + unreadable = every council member.
    assert.match(t, /High risk 1,671 Read, no high-risk finding 1,537 Could not be read 281/);
    assert.match(t, /All 2,077 readable Sputnik DAOs on mainnet \(716 active in the last 365 days\)/);
    assert.match(t, /read at block 223,787,777 \(2026-11-09\)/);
    assert.match(t, /35 DAOs could not be read and are left out/);
    assert.match(t, /Rerun with pnpm stats --block 223787777 --all/);
    assert.match(text(renderNetworkStats({ ...s, scope: "active", daos_scanned: 716, daos_failed: 0 })), /716 Sputnik DAOs on mainnet active in the last 365 days/);
    // The home page shows the committed file, not a sample.
    assert.match(text(renderHome("", null)), new RegExp(`read at block ${NETWORK_STATS.block_height.toLocaleString("en-US")}`));
  });
});
