import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lockedNotice, viewerRole, walletBar } from "../src/session.ts";
import { renderKeyDetail } from "../src/key-detail.ts";
import { renderAccount } from "../src/report.ts";
import { renderCleanup } from "../src/cleanup-view.ts";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { KdReport, Member } from "key-doctor";

const require = createRequire(import.meta.url);
const accountReport = (i: number): KdReport => {
  const r = JSON.parse(readFileSync(require.resolve("key-doctor/fixtures/reports/dao-kd-demo.report.json"), "utf8")) as KdReport;
  const m = r.members[i] as Member;
  return { ...r, target: { type: "account", id: m.account_id }, members: [m] };
};

// Why: Revoke/Delete are owner-only. A visitor or another account must see a locked button and a reason, never a wallet popup.
describe("viewer role", () => {
  it("is visitor without a wallet, other for a different account, owner only for the account on screen", () => {
    assert.equal(viewerRole(null, "a.testnet"), "visitor");
    assert.equal(viewerRole(["b.testnet"], "a.testnet"), "other");
    assert.equal(viewerRole(["b.testnet", "a.testnet"], "a.testnet"), "owner");
  });

  it("explains each lock with the button that fixes it", () => {
    assert.deepEqual(lockedNotice("visitor", "a.testnet", null).action, "connect");
    const other = lockedNotice("other", "a.testnet", ["b.testnet"]);
    assert.equal(other.action, "switch");
    assert.match(other.text, /Connected as b\.testnet, not a\.testnet/);
  });

  it("wallet bar differs per role", () => {
    const visitor = walletBar("visitor", "a.testnet", null, "testnet").value;
    assert.match(visitor, /Connect Wallet<\/button>/);
    const other = walletBar("other", "a.testnet", ["b.testnet"], "testnet").value;
    assert.match(other, /Open my keys/);
    assert.match(other, /href="[^"]*target=b\.testnet/);
    assert.match(other, /data-action="switch-account"/);
    const owner = walletBar("owner", "a.testnet", ["a.testnet"], "testnet").value;
    assert.match(owner, /Connected as <span class="mono">a\.testnet/);
    assert.doesNotMatch(owner, /data-action/);
  });
});

describe("locked key buttons", () => {
  const report = accountReport(0);
  it("render locked by default, still clickable (aria-disabled, not disabled)", () => {
    for (const out of [renderAccount(report, null).value, renderCleanup(report, null, "safe").value]) {
      const buttons = out.match(/<button[^>]*data-action="delete-key"[^>]*>/g) ?? [];
      assert.ok(buttons.length > 0);
      for (const b of buttons) {
        assert.match(b, /btn-locked/);
        assert.match(b, /aria-disabled="true"/);
        assert.doesNotMatch(b, /\sdisabled[\s>=]/);
      }
      assert.match(out, /data-wallet-bar/);
    }
  });

  it("key details tell non-owners to connect as the account", () => {
    const m = report.members[0]!;
    assert.match(renderKeyDetail(m.keys[0]!, m, report).value, /connect your wallet as <span class="mono">/);
    assert.doesNotMatch(renderKeyDetail(m.keys[0]!, m, report, "owner").value, /To revoke this key/);
  });
});
