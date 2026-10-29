import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type { KdReport, Member } from "key-doctor";
import { escape, html } from "../src/html.ts";
import { formatThreshold, formatUtc, relativeAge, truncateKey, yoctoToNear } from "../src/format.ts";
import { renderError, renderHome } from "../src/pages.ts";
import { renderAccount, renderCouncil } from "../src/report.ts";
import { parseRoute, routeHref } from "../src/route.ts";
import { groupFlags, keyMix, mainReason, recentFullAccessKeys, sortMembers } from "../src/view.ts";
import { renderWatchDialog } from "../src/watch.ts";

const require = createRequire(import.meta.url);
const load = (name: string): KdReport =>
  JSON.parse(readFileSync(require.resolve(`key-doctor/fixtures/reports/${name}`), "utf8")) as KdReport;
const dao = () => load("dao-kd-demo.report.json");
const account = () => load("account-b.report.json");
const text = (h: { value: string }) => h.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("html escaping", () => {
  it("escapes interpolated chain text but keeps nested Html", () => {
    const out = html`<p title="${'"><x'}">${"<script>"}${html`<b>ok</b>`}</p>`.value;
    assert.equal(out, '<p title="&quot;&gt;&lt;x">&lt;script&gt;<b>ok</b></p>');
    assert.equal(escape("a&'b"), "a&amp;&#39;b");
  });

  it("a hostile account id in a report never becomes markup", () => {
    const r = account();
    const m = r.members[0] as Member;
    m.flags[0]!.messages.en.title = '<img src=x onerror="alert(1)">';
    const out = renderAccount(r, null).value;
    assert.doesNotMatch(out, /<img/);
    assert.match(out, /&lt;img src=x/);
  });
});

describe("format", () => {
  it("formats keys, NEAR amounts, times and thresholds", () => {
    assert.equal(truncateKey("ed25519:7Hq2abcdefghVd9K"), "ed25519:7Hq2…Vd9K");
    assert.equal(yoctoToNear("100000000000000000000000"), "0.1");
    assert.equal(yoctoToNear("2000000000000000000000000"), "2");
    assert.equal(formatUtc("2026-11-03T02:00:10Z"), "Nov 3, 2026, 02:00 UTC");
    assert.equal(formatThreshold([1, 2]), "Ratio 1/2");
    assert.equal(formatThreshold("3"), "Weight 3");
    assert.equal(relativeAge(3 * 3_600_000), "About 3 hours ago");
    assert.equal(relativeAge(800 * 86_400_000), "About 2 years ago");
    assert.equal(relativeAge(null), "Unknown");
  });
});

describe("route", () => {
  it("normalizes the target and drops an invalid `from`", () => {
    assert.deepEqual(parseRoute("?target=A.KD-Demo.testnet&from=kd-demo.sputnik-dao.testnet"), {
      target: "a.kd-demo.testnet",
      invalid: null,
      from: "kd-demo.sputnik-dao.testnet",
      view: "report",
      level: "safe",
    });
    assert.deepEqual(parseRoute("?target=bad name&from=x"), { target: null, invalid: "bad name", from: null, view: "report", level: "safe" });
    assert.equal(parseRoute("?target=a.kd-demo.testnet&from=%3Cx%3E").from, null);
    assert.equal(routeHref("a.kd-demo.testnet", "kd-demo.sputnik-dao.testnet"), "?target=a.kd-demo.testnet&from=kd-demo.sputnik-dao.testnet");
  });
});

describe("view model", () => {
  it("sorts members high → cleanup → note → ok, unreadable members last", () => {
    const r = dao();
    const broken: Member = { ...(r.members[2] as Member), account_id: "z.kd-demo.testnet", status: "note", error: "RPC_ERROR" };
    const ids = sortMembers([broken, ...[...r.members].reverse()]).map((m) => m.account_id);
    assert.deepEqual(ids, ["a.kd-demo.testnet", "b.kd-demo.testnet", "c.kd-demo.testnet", "z.kd-demo.testnet"]);
  });

  it("main reason is the most severe flag title from messages.en", () => {
    const [a, , c] = dao().members as Member[];
    assert.equal(mainReason(a!), "Too many full-access keys (+5 more issues)");
    assert.equal(mainReason(c!), "No issues found.");
    assert.match(mainReason({ ...c!, error: "RPC_ERROR" }), /risk is unknown, not low/);
  });

  it("key mix and grouped flag cards", () => {
    const [a, , c] = dao().members as Member[];
    assert.equal(keyMix(a!), "5 Ed25519 / 1");
    assert.equal(keyMix(c!), "1 ML-DSA / 0");
    const groups = groupFlags(a!.flags);
    assert.equal(groups[0]?.rule_id, "FA_MANY");
    assert.equal(groups.find((g) => g.rule_id === "KEY_UNUSED")?.count, 2);
    assert.equal(groups.at(-1)?.severity, "note");
  });

  it("flags full-access keys added within 48 hours of the scanned block", () => {
    const r = dao();
    const recent = recentFullAccessKeys(r.members[0] as Member, r.chain.block_timestamp);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.key.public_key, "ed25519:zsNxJRqtpFdNtZhWDw2v1nNT419ozWMtpKi24cxgFW3");
    assert.equal(recentFullAccessKeys(account().members[0] as Member, account().chain.block_timestamp).length, 0);
  });
});

describe("pages", () => {
  it("council page shows summary tiles, members linked to their profile, voting rules and limits", () => {
    const out = renderCouncil(dao());
    const t = text(out);
    assert.match(t, /3 members Transfers need 2 of 3 votes/);
    assert.match(t, /Quantum-ready 1 \/ 3/);
    assert.match(out.value, /href="\?target=a\.kd-demo\.testnet&amp;from=kd-demo\.sputnik-dao\.testnet"/);
    assert.match(t, /Ratio 1\/2 → 2 votes/);
    assert.match(t, /0\.1 NEAR/);
    assert.match(t, /Key age is estimated from the access-key nonce/);
    assert.match(t, /Scanned at block 182,340,111 · Nov 3, 2026, 02:00 UTC · ruleset 2026-11-01/);
    // Status is never color alone: the pill carries a text label.
    assert.match(out.value, /class="pill pill-high[^"]*"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>High risk/);
  });

  it("account page shows the new-key alert, rule texts verbatim and every key", () => {
    const r = dao();
    const report: KdReport = { ...r, target: { type: "account", id: "a.kd-demo.testnet" }, members: [r.members[0] as Member] };
    const out = renderAccount(report, "kd-demo.sputnik-dao.testnet");
    const t = text(out);
    assert.match(out.value, /role="alert"/);
    assert.match(t, /A full-access key was added about 3 hours ago/);
    assert.match(t, /tell your council through another channel/);
    assert.match(t, /Opened from the council of kd-demo\.sputnik-dao\.testnet/);
    for (const f of (r.members[0] as Member).flags) assert.ok(t.includes(f.messages.en.explain), f.rule_id);
    assert.match(t, /KEY_UNUSED × 2/);
    assert.equal((out.value.match(/<tr>/g) ?? []).length, 1 + (r.members[0] as Member).keys.length);
  });

  it("account page without issues says so, and the plain account has no council line", () => {
    const r = dao();
    const report: KdReport = { ...r, target: { type: "account", id: "c.kd-demo.testnet" }, members: [r.members[2] as Member] };
    const t = text(renderAccount(report, null));
    assert.match(t, /No issues found for this account/);
    assert.doesNotMatch(t, /Opened from the council/);
  });

  it("watch dialog: command per target and DAO-only proposal warnings", () => {
    const d = text(renderWatchDialog("kd-demo.sputnik-dao.testnet", "dao"));
    assert.match(d, /\/watch kd-demo\.sputnik-dao\.testnet/);
    assert.match(d, /before the final vote/);
    const a = text(renderWatchDialog("a.kd-demo.testnet", "account"));
    assert.doesNotMatch(a, /before the final vote/);
    assert.match(a, /also send \/watch with the DAO name/);
  });

  it("home and error pages", () => {
    const home = renderHome("", "Invalid target.").value;
    assert.match(home, /aria-invalid="true"/);
    assert.match(home, /a\.kd-demo\.testnet/);
    const err = text(
      renderError("x.kd-demo.testnet", null, {
        schema_version: "kd.error.v1",
        code: "RPC_ERROR",
        message: { vi: "", en: "Could not read chain data right now." },
        retryable: true,
      }),
    );
    assert.match(err, /Scan failed Could not read chain data right now\. Try again/);
  });
});
