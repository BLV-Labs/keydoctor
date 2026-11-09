import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import type { KdError, KdReport, Member, ProposalInfo } from "key-doctor";
import { renderCleanup } from "../src/cleanup-view.ts";
import { loadKnown, markKnown } from "../src/known-keys.ts";
import { accountVerdict, councilMembers, councilVerdict, voterKeysLine } from "../src/key-verdict.ts";
import { renderError, renderScanning } from "../src/pages.ts";
import { renderProposals } from "../src/proposals-view.ts";
import { renderAccount, renderCouncil } from "../src/report.ts";
import { recentFullAccessKeys } from "../src/view.ts";

const require = createRequire(import.meta.url);
const dao = (): KdReport => JSON.parse(readFileSync(require.resolve("key-doctor/fixtures/reports/dao-kd-demo.report.json"), "utf8")) as KdReport;
const accountReport = (i: number): KdReport => {
  const r = dao();
  const m = r.members[i] as Member;
  return { ...r, target: { type: "account", id: m.account_id }, members: [m] };
};
const text = (h: { value: string }) => h.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** The page as a reader sees it before opening anything: `<details>` bodies removed. */
const visible = (h: { value: string }) => text({ value: h.value.replace(/<details[\s\S]*?<\/details>/g, " ") });
const newKey = (r: KdReport): string => recentFullAccessKeys(r.members[0] as Member, r.chain.block_timestamp)[0]!.key.public_key;

describe("K6 Key check verdict", () => {
  it("high: an unconfirmed new master key leads, with Remove it now and That was me", () => {
    const out = renderAccount(accountReport(0), null);
    const t = text(out);
    assert.match(out.value, /class="verdict verdict-high/);
    assert.match(t, /A new master key was added about 3 hours ago/);
    assert.match(t, /Remove it now/);
    assert.match(t, /That was me/);
    assert.match(t, /5 more things to tidy up/);
  });

  it("cleanup: only things to tidy up gives an amber count and no Remove button", () => {
    const out = renderAccount(accountReport(1), null);
    assert.match(out.value, /class="verdict verdict-cleanup/);
    assert.match(text(out), /\d+ things? to tidy up/);
    assert.doesNotMatch(text(out), /Remove it now/);
  });

  it("ok: a clean account says Nothing to fix in green", () => {
    const out = renderAccount(accountReport(2), null);
    assert.match(out.value, /class="verdict verdict-ok/);
    assert.match(text(out), /Nothing to fix/);
  });

  it("verdict logic: new key > high issue > tidy > ok", () => {
    const r = accountReport(0);
    const m = r.members[0] as Member;
    assert.equal(accountVerdict(m, r, new Set()).kind, "new-key");
    assert.equal(accountVerdict(m, r, new Set([newKey(r)])).kind, "issue");
    assert.equal(accountVerdict(accountReport(1).members[0] as Member, accountReport(1), new Set()).kind, "tidy");
    assert.equal(accountVerdict(accountReport(2).members[0] as Member, accountReport(2), new Set()).kind, "ok");
  });

  it("an account that could not be read is unknown, never fine", () => {
    const r = accountReport(0);
    const m = { ...(r.members[0] as Member), error: { code: "RPC_ERROR", message: "boom" } } as unknown as Member;
    const t = text(renderAccount({ ...r, members: [m] }, null));
    assert.match(t, /The risk is unknown, not low/);
    assert.doesNotMatch(t, /Nothing to fix/);
  });

  it("That was me hides that key's banner and shows the next issue; the key stays in the table", () => {
    const r = accountReport(0);
    const pk = newKey(r);
    const out = renderAccount(r, null, undefined, new Set([pk]));
    const t = text(out);
    assert.doesNotMatch(t, /A new master key was added/);
    assert.doesNotMatch(t, /That was me/);
    assert.match(t, /You have 5 master keys/);
    assert.ok(out.value.includes(`data-key="${pk}"`), "key still has its row");
    assert.doesNotMatch(out.value, /New, not you\?/);
  });

  it("the table words and pills: master key, Use <contract>, Never used, Too broad", () => {
    const t = text(renderAccount(accountReport(0), null)).replace(/\. /g, ".");
    assert.match(t, /Everything \(master key\)/);
    assert.match(t, /Use game\.kd-demo\.testnet/);
    assert.match(t, /New, not you\?/);
    assert.match(t, /Never used/);
    assert.match(t, /Too broad/);
  });

  it("two cross-link cards: Telegram alerts and the agent budget", () => {
    const out = renderAccount(accountReport(0), null).value;
    assert.match(out, /data-action="watch"[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?Get Telegram alerts/);
    assert.match(out, /href="[^"]*page=budget[^"]*"/);
  });
});

describe("That was me storage", () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  afterEach(() => {
    delete g.localStorage;
    store.clear();
  });

  it("remembers per account in this browser", () => {
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    assert.equal(loadKnown("a.testnet").size, 0);
    markKnown("a.testnet", "ed25519:K1");
    assert.deepEqual([...loadKnown("a.testnet")], ["ed25519:K1"]);
    assert.equal(loadKnown("b.testnet").size, 0);
    assert.ok(store.has("kd.keys.known.a.testnet"));
  });

  it("blocked storage turns the feature off without throwing", () => {
    const boom = (): never => {
      throw new Error("SecurityError");
    };
    g.localStorage = { getItem: boom, setItem: boom };
    assert.equal(loadKnown("a.testnet").size, 0);
    assert.equal(markKnown("a.testnet", "ed25519:K1").size, 0);
  });
});

describe("K9 Clean up keys", () => {
  it("only the first step that is not done is a full card; later steps are title plus one line", () => {
    const out = renderCleanup(accountReport(0), null, "safe");
    const t = text(out);
    assert.match(t, /0 of 2 steps done/);
    assert.match(t, /1\. Revoke app keys you do not use To do/);
    assert.match(t, /2\. Remove old or unused master keys Remove master keys nobody uses/);
    const main = out.value.slice(0, out.value.indexOf("Going further"));
    assert.equal((main.match(/class="card pad stack-sm step-card/g) ?? []).length, 1);
    assert.equal((main.match(/class="step-line/g) ?? []).length >= 1, true);
  });

  it("a done step collapses to one line with a check, and the next step opens", () => {
    const r = accountReport(0);
    const m = r.members[0] as Member;
    const noApps = { ...r, members: [{ ...m, keys: m.keys.filter((k) => k.permission.type === "full_access") }] };
    const out = renderCleanup(noApps, null, "safe");
    const t = text(out);
    assert.match(t, /1 of 2 steps done/);
    assert.match(t, /1\. Revoke app keys you do not use Done/);
    assert.match(out.value, /class="step-line step-line-done/);
    assert.match(out.value, />Remove<\/button>/);
  });

  it("post-quantum steps live in the closed Going further section", () => {
    const out = renderCleanup(accountReport(0), null, "safe").value;
    const further = out.indexOf("Going further");
    assert.ok(further > 0);
    assert.ok(out.indexOf("ML-DSA") > further, "no ML-DSA wording before Going further");
  });
});

describe("K10 Council check", () => {

  it("a member with only notes reads OK, not Could not read: only a failed read is unknown", () => {
    const r = dao();
    const noteOnly = r.members.map((m) => ({ ...m, error: null, status: "note" as const, flags: m.flags.filter((f) => f.severity === "note") }));
    const out = renderCouncil({ ...r, members: noteOnly, summary: { ...r.summary, status: "note" } });
    const t = text(out);
    assert.doesNotMatch(t, /Could not read/);
    assert.match(t, /Worst state: OK/);
    assert.match(out.value, /pill-ok/);
  });
  const info = (over: Partial<ProposalInfo>): ProposalInfo => ({
    id: 3, kind_label: "transfer", description: "Pay the designer", proposer: "b.kd-demo.testnet", status: "InProgress",
    votes: {}, approvals_needed: 2, approvals_have: 0, pending_voters: ["a.kd-demo.testnet", "c.kd-demo.testnet"], executed: false, ui_url: null, ...over,
  });

  it("verdict names members, votes needed and the worst member state, with the two actions", () => {
    const out = renderCouncil(dao());
    const t = text(out);
    assert.match(t, /1 council member needs action now/);
    assert.match(t, /3 members · 2 votes needed to move money · Worst state: Act now/);
    assert.match(out.value, /data-action="watch"[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?Warn me before votes/);
    assert.match(out.value, /data-action="rescan"/);
    assert.equal(councilVerdict(dao()).votesNeeded, 2);
  });

  it("members come riskiest first", () => {
    const order = councilMembers(dao()).map((m) => m.account_id);
    assert.deepEqual(order, ["a.kd-demo.testnet", "b.kd-demo.testnet", "c.kd-demo.testnet"]);
    const t = text(renderCouncil(dao()));
    assert.ok(t.indexOf("a.kd-demo.testnet") < t.indexOf("b.kd-demo.testnet"));
    assert.ok(t.indexOf("b.kd-demo.testnet") < t.indexOf("c.kd-demo.testnet"));
  });

  it("two columns: a wide main and a narrow aside with the agent budget card", () => {
    const out = renderCouncil(dao()).value;
    assert.match(out, /class="council-main/);
    assert.match(out, /class="council-aside/);
    assert.match(text({ value: out }), /Let an agent pay from this treasury/);
    assert.match(out, /href="[^"]*page=budget[^"]*"/);
  });

  it("votes list who still has to vote and what that means for their keys", () => {
    const r = dao();
    const t = text(renderProposals({ proposals: [info({})], total: 1, errors: [] }, 1, undefined, r.members));
    assert.match(t, /Still to vote/);
    assert.match(t, /a\.kd-demo\.testnet/);
    assert.match(t, /should check their keys/);
    assert.equal(voterKeysLine(["a.kd-demo.testnet"], r.members), "1 voter should check their keys");
    assert.equal(voterKeysLine(["c.kd-demo.testnet"], r.members), "every voter's keys look fine");
    assert.equal(voterKeysLine(["nobody.testnet"], r.members), "");
  });
});

describe("K12 states", () => {
  const err = (code: KdError["code"], retryable: boolean): KdError => ({ schema_version: "kd.error.v1", code, message: { vi: "", en: "Raw message." }, retryable });

  it("checking: reads keys from NEAR, three skeleton bars, usual time", () => {
    const out = renderScanning("a.kd-demo.testnet", null);
    assert.match(text(out), /Reading keys from NEAR… Usually 2–5 seconds\./);
    assert.equal((out.value.match(/class="skeleton-row"/g) ?? []).length, 3);
    assert.match(out.value, /skeleton-late/);
  });

  it("not found: names the account and how to fix the spelling, no retry", () => {
    const out = renderError("nope.testnet", null, err("NOT_FOUND", false));
    const t = text(out);
    assert.match(t, /No account called nope\.testnet/);
    assert.match(t, /Check the spelling, and whether it ends in \.testnet or \.near\./);
    assert.match(t, /Try another name/);
    assert.doesNotMatch(t, /Try again/);
  });

  it("chain error: the risk is unknown, not low, and nothing was changed", () => {
    const t = text(renderError("a.kd-demo.testnet", null, err("RPC_ERROR", true)));
    assert.match(t, /We could not read the chain/);
    assert.match(t, /The risk is unknown, not low\. Nothing was changed\./);
    assert.match(t, /Try again/);
    assert.match(t, /Try another name/);
  });
});

describe("plain words on K6, K9 and K10", () => {
  // Rule texts come from the library verbatim, so they are removed before looking for jargon.
  const ruleTexts = (r: KdReport): string[] => r.members.flatMap((m) => m.flags.flatMap((f) => [f.messages.en.title, f.messages.en.explain, f.messages.en.fix]));
  const strip = (r: KdReport, h: { value: string }): string => ruleTexts(r).reduce((acc, s) => acc.split(s).join(" "), visible(h));
  const JARGON = /\b(DAO|proposals?|policy|whitelist|yocto\w*|nonce|ed25519|ml-dsa)\b/i;

  it("nothing outside the details sections uses the internal vocabulary", () => {
    const r = dao();
    const pages: [string, { value: string }][] = [
      ["K6 high", renderAccount(accountReport(0), null)],
      ["K6 cleanup", renderAccount(accountReport(1), null)],
      ["K6 ok", renderAccount(accountReport(2), null)],
      ["K9", renderCleanup(accountReport(0), null, "safe")],
      ["K10", renderCouncil(r)],
      ["K10 votes", renderProposals({ proposals: [{ id: 1, kind_label: "policy", description: "x", proposer: "a.kd-demo.testnet", status: "InProgress", votes: {}, approvals_needed: 2, approvals_have: 0, pending_voters: ["a.kd-demo.testnet"], executed: false, ui_url: null }], total: 1, errors: [] }, 1, undefined, r.members)],
    ];
    for (const [name, page] of pages) {
      const seen = strip(r, page).replace(/(ed25519|ml-dsa[\w-]*):\w+…\w+/g, " ").replace(/[\w.-]+\.(testnet|near)\b/g, " ");
      assert.doesNotMatch(seen, JARGON, `${name}: ${seen.match(JARGON)?.[0]}`);
    }
  });
});
