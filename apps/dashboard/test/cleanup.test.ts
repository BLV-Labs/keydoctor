import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type { KdReport, KeyInfo, Member } from "key-doctor";
import { appKeysToRevoke, buildDeletePlan, GUARD_TEXT, MAX_ACTIONS_PER_TX, oldFullAccessKeys, planSteps } from "../src/cleanup.ts";
import { renderCleanup } from "../src/cleanup-view.ts";
import { renderLayout } from "../src/pages.ts";
import { parseRoute } from "../src/route.ts";

const require = createRequire(import.meta.url);
const dao = (): KdReport => JSON.parse(readFileSync(require.resolve("key-doctor/fixtures/reports/dao-kd-demo.report.json"), "utf8")) as KdReport;
const member = (i: number): Member => dao().members[i] as Member;
const accountReport = (i: number): KdReport => {
  const r = dao();
  const m = r.members[i] as Member;
  return { ...r, target: { type: "account", id: m.account_id }, members: [m] };
};
const text = (h: { value: string }) => h.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const short = (keys: KeyInfo[]) => keys.map((k) => k.public_key.slice(8, 12));

const fa = (pk: string, uses: number, block: number, flags: string[] = []): KeyInfo => ({
  public_key: pk,
  curve: "ed25519",
  permission: { type: "full_access" },
  nonce: `${block}000000`,
  use_count: uses,
  created: { block_height: block, at: null, source: "nonce_estimate" },
  age_days: null,
  flag_ids: flags,
});
const withKeys = (keys: KeyInfo[]): Member => ({ ...member(1), keys, flags: [] });

describe("GĐ8 cleanup plan", () => {
  it("step 1 lists the flagged app keys", () => {
    assert.deepEqual(short(appKeysToRevoke(member(0))), ["5Fq8"]);
    assert.deepEqual(appKeysToRevoke(member(2)), []);
  });

  it("step 2 lists never-used keys first, then the oldest; a used, recent key stays", () => {
    const { remove, keep } = oldFullAccessKeys(member(0));
    assert.deepEqual(short(remove), ["XYwU", "zsNx", "9Jxo"]);
    assert.equal(keep, null);
  });

  it("step 2 never lists every full-access key: the most used one is kept", () => {
    const m = withKeys([fa("ed25519:AAAAold", 0, 100, ["FA_OLD"]), fa("ed25519:BBBBold", 9, 200, ["FA_OLD"])]);
    const { remove, keep } = oldFullAccessKeys(m);
    assert.deepEqual(short(remove), ["AAAA"]);
    assert.equal(keep?.public_key, "ed25519:BBBBold");
  });

  it("progress comes from chain data, with 4 steps (safe) or 5 (full)", () => {
    assert.deepEqual(planSteps(member(0), "safe").map((s) => [s.id, s.done]), [
      ["revoke_app_keys", false],
      ["delete_old_full_access", false],
      ["add_ml_dsa", false],
      ["test_sign", false],
    ]);
    const c = planSteps(member(2), "full");
    assert.deepEqual(c.map((s) => s.done), [true, true, true, c[3]!.done, true]);
    assert.equal(c.length, 5);
  });
});

describe("GĐ8 delete guards (UC8 safety rules)", () => {
  const m = withKeys([
    fa("ed25519:F1", 3, 100),
    fa("ed25519:F2", 3, 100),
    fa("ed25519:F3", 3, 100),
    { ...fa("ed25519:APP", 0, 100), permission: { type: "function_call", receiver_id: "x.testnet", method_names: [], allowance_yocto: null } },
  ]);

  it("never builds a DeleteKey for the last full-access key", () => {
    const p = buildDeletePlan(m, ["ed25519:F1", "ed25519:F2", "ed25519:F3"], "ed25519:other");
    assert.equal(p.ok, false);
    assert.ok(p.errors.includes("LAST_FULL_ACCESS"));
    assert.deepEqual(p.transactions, []);
  });

  it("never deletes the key the wallet signs with", () => {
    assert.deepEqual(buildDeletePlan(m, ["ed25519:F1"], "ed25519:F1").errors, ["SIGNER_KEY"]);
  });

  it("with an unknown signer key, full-access deletes need two full-access keys left", () => {
    assert.deepEqual(buildDeletePlan(m, ["ed25519:F1", "ed25519:F2"], null).errors, ["NEEDS_TWO_FULL_ACCESS_LEFT"]);
    assert.equal(buildDeletePlan(m, ["ed25519:F1"], null).ok, true);
  });

  it("app keys go in one transaction; unknown or empty selections are refused", () => {
    assert.deepEqual(buildDeletePlan(m, ["ed25519:APP"], null).transactions, [[{ type: "DeleteKey", public_key: "ed25519:APP" }]]);
    assert.deepEqual(buildDeletePlan(m, ["ed25519:NOPE"], null).errors, ["UNKNOWN_KEY"]);
    assert.deepEqual(buildDeletePlan(m, [], null).errors, ["EMPTY"]);
  });

  it("splits more than MAX_ACTIONS_PER_TX deletes across transactions", () => {
    const many = withKeys([fa("ed25519:KEEP1", 1, 1), fa("ed25519:KEEP2", 1, 1), ...Array.from({ length: 150 }, (_, i) => fa(`ed25519:K${i}`, 0, 1))]);
    const p = buildDeletePlan(many, Array.from({ length: 150 }, (_, i) => `ed25519:K${i}`), "ed25519:KEEP1");
    assert.deepEqual(p.transactions.map((t) => t.length), [MAX_ACTIONS_PER_TX, 50]);
  });
});

describe("GĐ8 cleanup page", () => {
  it("asks which wallet to use in a dialog, with no wallet picked up front", () => {
    const out = renderLayout(renderCleanup(accountReport(0), null, "safe")).value;
    assert.doesNotMatch(out, /<select/);
    assert.match(out, /<dialog id="wallet-dialog"/);
    for (const [id, label] of [["meteor-wallet", "Meteor Wallet"], ["here-wallet", "Here Wallet"], ["hot-wallet", "HOT Wallet"]]) {
      assert.match(out, new RegExp(`data-action="choose-wallet" data-wallet="${id}">${label}</button>`));
    }
  });

  it("shows progress, the urgent new key, ordered key lists and Meteor links", () => {
    const out = renderCleanup(accountReport(0), "kd-demo.sputnik-dao.testnet", "safe");
    const t = text(out);
    assert.match(t, /0 of 4 steps done · read at block 182,340,111/);
    assert.match(t, /Delete this key now Full-access key ed25519:zsNx…gFW3 was added about 3 hours ago/);
    assert.match(t, /1\. Revoke app keys you do not need To do 1 key, in this order:/);
    assert.match(t, /App key with unlimited allowance · App key can call any method/);
    assert.match(out.value, /<progress class="progress" aria-labelledby="progress-label" value="0" max="4">/);
    // The header (every page) carries Connect Wallet; the page itself has the owner-only wallet bar.
    assert.equal((out.value.match(/data-action="open-wallet"/g) ?? []).length, 1);
    assert.match(out.value, /data-wallet-bar/);
    const layout = renderLayout(out).value;
    assert.equal((layout.match(/data-action="open-wallet"/g) ?? []).length, 2);
    assert.match(layout, /data-action="open-wallet" data-wallet-off>Connect Wallet<\/button>/);
    assert.match(layout, /class="btn btn-danger" data-action="disconnect-wallet" data-wallet-on hidden>Disconnect<\/button>/);
    assert.doesNotMatch(out.value, /Open Meteor Wallet<\/button>/);
    // Every listed key gets a View button, and the page carries the dialog they fill.
    assert.equal((out.value.match(/data-action="view-key"/g) ?? []).length, (out.value.match(/<li class="key-/g) ?? []).length);
    assert.match(out.value, /<dialog id="key-dialog"/);
    assert.match(out.value, /aria-pressed="true">Safe cleanup/);
    assert.doesNotMatch(t, /Delete the remaining Ed25519/);
  });

  it("the full level adds step 5, blocked until steps 1 to 4 are done", () => {
    const t = text(renderCleanup(accountReport(0), null, "full"));
    assert.match(t, /0 of 5 steps done/);
    assert.match(t, /Still needed: finish steps 1 to 4 first\./);
  });

  it("a finished account shows done steps", () => {
    const t = text(renderCleanup(accountReport(2), null, "safe"));
    assert.match(t, /1\. Revoke app keys you do not need Done/);
    assert.match(t, /3\. Add an ML-DSA key Done/);
  });

  it("routes ?view=cleanup&level=full", () => {
    const r = parseRoute("?target=a.kd-demo.testnet&view=cleanup&level=full");
    assert.equal(r.view, "cleanup");
    assert.equal(r.level, "full");
    assert.equal(parseRoute("?target=a.kd-demo.testnet&view=other").view, "report");
  });
});

describe("GĐ8 sign buttons", () => {
  it("each key in a step gets its own Revoke/Delete button, and no step deletes several keys at once", () => {
    const html = renderCleanup(accountReport(0), null, "safe").value;
    assert.doesNotMatch(html, /data-action="delete-keys"/);
    assert.doesNotMatch(html, /these \d+ keys with Meteor/);
    assert.match(html, /data-action="delete-key" data-key="[^"]+" data-status="sign-status-[a-z_]+"[^>]*>Revoke<\/button>/);
    assert.match(html, /data-action="delete-key" data-key="[^"]+" data-status="sign-status-[a-z_]+"[^>]*>Delete<\/button>/);
    assert.doesNotMatch(renderCleanup(accountReport(2), null, "safe").value, /data-action="delete-key"/);
  });

  it("every guard error has a user-facing text, so a refused plan never fails silently", () => {
    const refused = buildDeletePlan(withKeys([fa("ed25519:ONLY", 5, 100)]), ["ed25519:ONLY"], null);
    assert.equal(refused.ok, false);
    for (const e of refused.errors) assert.ok(GUARD_TEXT[e].length > 0);
  });
});
