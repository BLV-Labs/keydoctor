import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INVALID_NAME_MESSAGE, renderHome } from "../src/pages.ts";

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
    assert.match(inn, /href="#check"[^>]*>[\s\S]*?Check an account's keys/);
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

  it("has the three steps, three paths and three trust items", () => {
    const out = renderHome("", null).value;
    assert.equal((out.match(/class="home-step"/g) ?? []).length, 3);
    assert.equal((out.match(/class="card pad stack-sm home-path"/g) ?? []).length, 3);
    assert.equal((out.match(/<li><svg[\s\S]*?<\/svg><span>/g) ?? []).length, 3);
    assert.match(text(renderHome("", null)), /What do you want to do\?/);
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
    assert.match(out, /data-placeholder="kdoncall\.sputnik-v2\.testnet">Check a council</);
    assert.match(out, /data-placeholder="kdoncall-p\.testnet" data-fill="wallet">Check my keys</);
    assert.match(renderHome("", null, "mainnet").value, /data-placeholder="your-name\.near"/);
  });

  it("uses no internal words outside the check card", () => {
    // WHY: handoff README "Words": a first-time visitor must not meet Guard, DAO, proposal or chain jargon.
    for (const signedIn of [false, true]) {
      const t = outsideCheckCard(renderHome("", null, "testnet", signedIn));
      assert.doesNotMatch(t, /\b(DAO|proposal|policy|whitelist|yocto|nonce|Guard|Keyfence|sputnik)/i);
      assert.match(t, /Key Doctor/);
    }
  });
});
