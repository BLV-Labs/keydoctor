import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type { KdReport, ListProposalsResult, Member, ProposalInfo } from "key-doctor";
import { escape, html } from "../src/html.ts";
import { formatThreshold, formatUtc, relativeAge, truncateKey, yoctoToNear } from "../src/format.ts";
import { renderAgents, renderAlertsDrawer, renderError, renderHome, renderLayout } from "../src/pages.ts";
import { PROPOSALS_ID, renderProposals } from "../src/proposals-view.ts";
import { renderKeyDetail } from "../src/key-detail.ts";
import { BUILT, FUTURE, NEXT, REVENUE, renderRoadmap } from "../src/roadmap.ts";
import { councilGlance, renderAccount, renderCouncil } from "../src/report.ts";
import { widthClass } from "../src/bar-width.ts";
import { transferVotes } from "../src/key-verdict.ts";
import { agentGuideHref, parseRoute, resolveInput, routeHref, settledHref } from "../src/route.ts";
import { STATUS_LABEL, groupFlags, keyMix, mainReason, recentFullAccessKeys, sortMembers } from "../src/view.ts";
import { viewButton } from "../src/key-detail.ts";
import { renderWatchDialog, renderWatchLinks } from "../src/watch.ts";

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
    m.flags[0]!.messages.en.explain = '<img src=x onerror="alert(1)">';
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
      page: "check",
      target: "a.kd-demo.testnet",
      invalid: null,
      from: "kd-demo.sputnik-dao.testnet",
      dao: null,
      view: "report",
      level: "safe",
      network: "testnet",
      link: null,
      help: false,
      yieldNew: false,
    });
    assert.deepEqual(parseRoute("?target=bad name&from=x"), {
      page: "check",
      target: null,
      invalid: "bad name",
      from: null,
      dao: null,
      view: "report",
      level: "safe",
      network: null,
      link: null,
      help: false,
      yieldNew: false,
    });
    assert.equal(parseRoute("?target=a.kd-demo.testnet&from=%3Cx%3E").from, null);
    assert.equal(routeHref("a.kd-demo.testnet", "kd-demo.sputnik-dao.testnet"), "?target=a.kd-demo.testnet&from=kd-demo.sputnik-dao.testnet");
  });

  const IMPLICIT = "a".repeat(64);

  it("the name suffix decides the network; `?network=` only matters without one", () => {
    assert.equal(parseRoute("?target=x.near").network, "mainnet");
    assert.equal(parseRoute("?target=x.near&network=testnet").network, "mainnet");
    assert.equal(parseRoute(`?target=${IMPLICIT}&network=mainnet`).network, "mainnet");
    assert.equal(parseRoute(`?target=${IMPLICIT}`).network, "testnet");
    assert.equal(parseRoute("?network=mainnet").network, "mainnet");
    assert.equal(parseRoute("?network=bogus").network, null);
    assert.equal(routeHref("x.near", null, "mainnet"), "?target=x.near");
    assert.equal(routeHref(IMPLICIT, null, "mainnet"), `?target=${IMPLICIT}&network=mainnet`);
  });

  it("the home form adds the switch's suffix to a bare name, and a typed suffix wins", () => {
    assert.deepEqual(resolveInput(" My-DAO.sputnik-dao ", "mainnet"), { id: "my-dao.sputnik-dao.near", network: "mainnet" });
    assert.deepEqual(resolveInput("x.sputnik-dao", "testnet"), { id: "x.sputnik-dao.testnet", network: "testnet" });
    assert.deepEqual(resolveInput("a.kd-demo.testnet", "mainnet"), { id: "a.kd-demo.testnet", network: "testnet" });
    assert.deepEqual(resolveInput(IMPLICIT, "mainnet"), { id: IMPLICIT, network: "mainnet" });
    assert.throws(() => resolveInput("bad name", "mainnet"));
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
    assert.equal(mainReason(a!), "Too many full-access keys (+6 more issues)");
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
  it("council page shows the verdict, members linked to their profile, how money moves and limits", () => {
    const out = renderCouncil(dao());
    const t = text(out);
    assert.match(t, /3 members · 2 votes needed to move money · Worst state: Act now/);
    assert.match(out.value, /href="\?target=a\.kd-demo\.testnet&amp;from=kd-demo\.sputnik-dao\.testnet"/);
    assert.match(t, /2 votes \(Ratio 1\/2\)/);
    assert.match(t, /0\.1 NEAR/);
    assert.match(t, /Key age is estimated from the access-key nonce/);
    assert.match(t, /Read at block 182,340,111 · Nov 3, 2026, 02:00 UTC · ruleset 2026-11-03/);
    // Status is never color alone: the pill carries a text label.
    assert.match(out.value, /class="pill pill-sm pill-high"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Act now/);
  });

  it("account page shows the new-key alert, rule texts verbatim and every key", () => {
    const r = dao();
    const report: KdReport = { ...r, target: { type: "account", id: "a.kd-demo.testnet" }, members: [r.members[0] as Member] };
    const out = renderAccount(report, "kd-demo.sputnik-dao.testnet");
    const t = text(out);
    assert.match(out.value, /role="alert"/);
    assert.match(t, /A new master key was added about 3 hours ago/);
    assert.match(t, /tell your council through another channel/);
    assert.match(t, /Opened from the council of kd-demo\.sputnik-dao\.testnet/);
    // Every rule text stays reachable: the new-key flag in the banner, the rest in the tidy-up rows or "More checks".
    const firstPerRule = new Map((r.members[0] as Member).flags.map((f) => [f.rule_id, f] as const).reverse());
    for (const f of firstPerRule.values()) assert.ok(t.includes(f.messages.en.explain) || f.rule_id === "FA_RECENT" || f.rule_id === "FA_MANY", f.rule_id);
    assert.equal((out.value.match(/<tr[ >]/g) ?? []).length, 1 + (r.members[0] as Member).keys.length);
  });

  it("every key row has one Meteor action: Delete for a full-access key, Revoke for an app key", () => {
    const r = dao();
    const member = r.members[0] as Member;
    const report: KdReport = { ...r, target: { type: "account", id: "a.kd-demo.testnet" }, members: [member] };
    const out = renderAccount(report, null).value;
    const full = member.keys.filter((k) => k.permission.type === "full_access").length;
    // One per row, plus the banner's "Remove it now" for the new master key.
    assert.equal((out.match(/data-action="delete-key"/g) ?? []).length, member.keys.length + 1);
    assert.equal((out.match(/>Delete<\/button>/g) ?? []).length, full);
    assert.equal((out.match(/>Remove it now<\/button>/g) ?? []).length, 1);
    assert.equal((out.match(/>Revoke<\/button>/g) ?? []).length, member.keys.length - full);
    for (const k of member.keys) assert.ok(out.includes(`data-key="${k.public_key}"`), k.public_key);
  });

  it("key table says what each key can do in words, and every row has a View button", () => {
    const r = dao();
    const member = r.members[0] as Member;
    const report: KdReport = { ...r, target: { type: "account", id: "a.kd-demo.testnet" }, members: [member] };
    const out = renderAccount(report, null).value;
    assert.match(out, /<th scope="col">What it can do<\/th>/);
    assert.equal((out.match(/data-action="view-key"/g) ?? []).length, member.keys.length);
    for (const k of member.keys) {
      if (k.permission.type === "function_call") assert.ok(text({ value: out }).replace(/\. /g, ".").includes(`Use ${k.permission.receiver_id}`), k.permission.receiver_id);
    }
    assert.match(text({ value: out }), /Everything \(master key\)/);
  });

  it("key detail shows the dApp, methods and allowance of an app key, and says a full-access key can do anything", () => {
    const r = dao();
    const member = r.members[0] as Member;
    const report: KdReport = { ...r, target: { type: "account", id: "a.kd-demo.testnet" }, members: [member] };
    const app = member.keys.find((k) => k.permission.type === "function_call");
    const full = member.keys.find((k) => k.permission.type === "full_access");
    assert.ok(app && full);
    const a = text(renderKeyDetail(app, member, report));
    assert.ok(a.includes(app.public_key));
    assert.match(a, /Approved for \(dApp contract\)/);
    assert.ok(a.includes((app.permission as { receiver_id: string }).receiver_id));
    assert.match(a, /Allowed methods/);
    assert.match(a, /Fee allowance/);
    assert.match(text(renderKeyDetail(full, member, report)), /Full access: can do anything/);
  });

  it("account page without issues says so, and the plain account has no council line", () => {
    const r = dao();
    const report: KdReport = { ...r, target: { type: "account", id: "c.kd-demo.testnet" }, members: [r.members[2] as Member] };
    const t = text(renderAccount(report, null));
    assert.match(t, /Nothing to fix/);
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
    assert.match(home, /kdoncall-p\.testnet/);
    assert.match(home, /kdoncall\.sputnik-v2\.testnet/);
    assert.match(home, /data-network="testnet" aria-pressed="true"/);
    const main = renderHome("", null, "mainnet").value;
    assert.match(main, /data-network="mainnet" aria-pressed="true"/);
    // No example names on mainnet: testnet demo names only, and no real mainnet accounts.
    assert.doesNotMatch(main, /kdoncall/);
    assert.match(main, /placeholder="your-dao\.sputnik-dao\.near"/);
    const err = text(
      renderError("x.kd-demo.testnet", null, {
        schema_version: "kd.error.v1",
        code: "RPC_ERROR",
        message: { vi: "", en: "Could not read chain data right now." },
        retryable: true,
      }),
    );
    assert.match(err, /We could not read the chain The risk is unknown, not low\. Nothing was changed\. Try again/);
  });
});

describe("GĐ12 one-tap watch links (dashboard P1)", () => {
  it("the dialog offers links only when the build sets a Worker URL", () => {
    assert.doesNotMatch(renderWatchDialog("a.kd-demo.testnet", "account").value, /data-action="watch-links"/);
    assert.match(renderWatchDialog("a.kd-demo.testnet", "account", "https://kd.example").value, /data-action="watch-links" data-target="a\.kd-demo\.testnet"/);
  });

  it("renders only t.me start links; anything else falls back to the command", () => {
    const ok = renderWatchLinks({
      link_private: "https://t.me/KeyDoctorOnCallBot?start=Ab12Cd34Ef56Gh78",
      link_group: "https://t.me/KeyDoctorOnCallBot?startgroup=Ab12Cd34Ef56Gh78",
      expires_at: "2026-11-03T03:45:00Z",
    }).value;
    assert.match(ok, /href="https:\/\/t\.me\/KeyDoctorOnCallBot\?start=Ab12Cd34Ef56Gh78" target="_blank" rel="noopener"/);
    assert.match(ok, /expire at 2026-11-03 03:45:00 UTC/);
    const bad = renderWatchLinks({ link_private: "javascript:alert(1)", link_group: "https://evil.example", expires_at: "x" }).value;
    assert.doesNotMatch(bad, /href/);
    assert.match(bad, /Use the command above/);
  });
});

describe("proposal list (C7)", () => {
  const info = (over: Partial<ProposalInfo>): ProposalInfo => ({
    id: 2,
    kind_label: "transfer",
    description: "pay the auditor",
    proposer: "a.kd-demo.testnet",
    transfer: { token_id: "", receiver_id: "auditor.testnet", amount: "2000000000000000000000000" },
    status: "InProgress",
    votes: { "a.kd-demo.testnet": "Approve" },
    approvals_needed: 2,
    approvals_have: 1,
    pending_voters: ["b.kd-demo.testnet"],
    executed: false,
    ui_url: null,
    ...over,
  });
  const result = (proposals: ProposalInfo[], total = proposals.length, errors: string[] = []): ListProposalsResult => ({ proposals, total, errors });

  it("the council page holds a placeholder the list later fills", () => {
    assert.match(renderCouncil(dao()).value, new RegExp(`id="${PROPOSALS_ID}"`));
  });

  it("shows what a voter needs to decide: amount, receiver, votes so far and who still has to vote", () => {
    const t = text(renderProposals(result([info({})], 4)));
    assert.match(t, /Newest first · 4 in total/);
    assert.match(t, /#2 Transfer In progress/);
    assert.match(t, /Send 2 NEAR to auditor\.testnet/);
    assert.match(t, /1 approve of 2 needed/);
    assert.match(t, /Still to vote: b\.kd-demo\.testnet/);
  });

  it("a token transfer is never shown as NEAR", () => {
    const t = text(renderProposals(result([info({ transfer: { token_id: "usdt.testnet", receiver_id: "auditor.testnet", amount: "5000000" } })])));
    assert.match(t, /5000000 units of token usdt\.testnet to auditor\.testnet/);
    assert.doesNotMatch(t, /NEAR to/);
  });

  it("hides pending voters once the proposal is no longer open", () => {
    const t = text(renderProposals(result([info({ status: "Approved", pending_voters: ["b.kd-demo.testnet"] })])));
    assert.doesNotMatch(t, /Still to vote/);
  });

  it("says plainly when there are no proposals, when the read failed, and when some were unreadable", () => {
    assert.match(text(renderProposals(result([], 0))), /no votes yet/);
    assert.match(text(renderProposals(null)), /Could not read votes/);
    assert.match(text(renderProposals(result([], 3, ["proposal 2: RPC_ERROR"]))), /No vote on this page could be read/);
    assert.match(text(renderProposals(result([info({})], 3, ["proposal 1: NOT_A_DAO"]))), /1 vote\(s\) on this page could not be read/);
  });

  it("an open proposal offers Reject and Approve, so a council member who got the alert can act from here", () => {
    const out = renderProposals(result([info({})])).value;
    assert.match(out, /data-action="council-vote" data-id="2" data-vote="VoteReject">Reject</);
    assert.match(out, /data-action="council-vote" data-id="2" data-vote="VoteApprove">Approve</);
    assert.match(out, /id="vote-status-2" role="status"/);
  });

  it("a closed proposal offers no vote: the chain would refuse it", () => {
    for (const status of ["Approved", "Rejected", "Expired", "Failed"]) {
      assert.doesNotMatch(renderProposals(result([info({ status })])).value, /council-vote/);
    }
  });

  it("hostile chain text in a description never becomes markup", () => {
    const out = renderProposals(result([info({ description: "<img src=x onerror=alert(1)>" })])).value;
    assert.doesNotMatch(out, /<img/);
  });
});

describe("nav and the alerts / MCP pages", () => {
  const nav = (page: "check" | "budget" | "my-agents" | "yield" | "mcp") => renderLayout(html`<p>x</p>`, "testnet", page).value.match(/<nav[\s\S]*?<\/nav>/)![0];

  it("has one link per Sputnik DAO pillar and an Alerts button; marks one item, so every budget page stays under Agent Budget", () => {
    for (const [page, label] of [["check", "Scan DAO"], ["my-agents", "Agent Budget"], ["budget", "Agent Budget"], ["yield", "Yield"]] as const) {
      const n = nav(page);
      assert.deepEqual([...n.matchAll(/<a [^>]*class="nav-(\w+)"/g)].map((m) => m[1]), ["scan", "budget", "yield"]);
      assert.equal((n.match(/aria-current="page"/g) ?? []).length, 1);
      assert.match(n, new RegExp(`aria-current="page"><span class="pillar-dot" aria-hidden="true"></span>${label}<`));
      assert.match(n, /<button type="button" class="nav-btn" data-action="alerts-open">Alerts<\/button>/);
      assert.ok(!n.includes("t.me"));
    }
    // The MCP page serves all three pillars, so no nav item claims it.
    assert.doesNotMatch(nav("mcp"), /aria-current/);
  });

  it("shows the network in the header, so a mainnet page never passes for testnet", () => {
    assert.match(renderLayout(html`x`, "testnet").value, /class="pill pill-cleanup net-pill">Testnet</);
    assert.match(renderLayout(html`x`, "mainnet").value, /class="pill pill-note net-pill">Mainnet</);
  });

  it("names the product Key Doctor and keeps the MCP page reachable from the footer of every page", () => {
    const layout = renderLayout(html`<p>x</p>`, "testnet", "check").value;
    assert.match(layout, /class="brand">[\s\S]*<span>Key Doctor<\/span><\/a>/);
    assert.ok(!layout.includes("Keyfence"));
    const footer = layout.match(/<footer[\s\S]*?<\/footer>/)![0];
    assert.ok(footer.includes("page=mcp"));
    assert.ok(footer.includes("For developers (MCP)"));
    assert.ok(footer.includes("page=roadmap"));
    assert.ok(footer.includes("Key Doctor never holds your keys. Limits are enforced on-chain."));
  });

  it("the old pages stay valid links: what is published must not land on an empty page (§10.1)", () => {
    assert.deepEqual([parseRoute("?page=oncall").page, parseRoute("?page=oncall").link], ["check", { kind: "alerts" }]);
    assert.deepEqual([parseRoute("?page=agents").page, parseRoute("?page=agents").link], ["budget", { kind: "add-agent" }]);
    assert.equal(parseRoute("?page=agents&dao=d.testnet").dao, "d.testnet");
    assert.equal(parseRoute("?page=guard").page, "budget");
  });

  it("?page=guard&dao= stays the council page: the README documents it and a many-member DAO has no other", () => {
    assert.equal(parseRoute("?page=guard&dao=d.testnet").page, "guard");
  });

  it("?page= picks the page without a target, and ?target= wins, with nothing left to open", () => {
    assert.equal(parseRoute("?page=mcp").page, "mcp");
    assert.equal(parseRoute("?page=roadmap").page, "roadmap");
    assert.equal(parseRoute("?page=nope").page, "check");
    assert.equal(parseRoute("").page, "check");
    const target = parseRoute("?page=agents&target=kdoncall-p.testnet");
    assert.equal(target.page, "check");
    assert.equal(target.link, null);
    assert.equal(parseRoute("?page=budget&help=agent&target=kdoncall-p.testnet").help, false);
  });

  it("the deep links of §10.5 carry what the bot's message asked for", () => {
    assert.deepEqual(parseRoute("?page=budget&approve=12").link, { kind: "approve", id: 12 });
    assert.deepEqual(parseRoute("?page=budget&topup=NEAR&amount=2.5").link, { kind: "topup", token: "near", amount: "2.5" });
    assert.equal(parseRoute("?page=budget&help=agent").help, true);
    assert.deepEqual(parseRoute("?page=budget&strategy=scheduled-payouts").link, { kind: "strategy", id: "scheduled-payouts" });
    assert.deepEqual(parseRoute("?page=budget&plan=7").link, { kind: "plan", id: 7 });
  });

  it("a malformed deep link opens nothing rather than the wrong thing", () => {
    assert.equal(parseRoute("?page=budget&approve=abc").link, null);
    assert.equal(parseRoute("?page=budget&approve=-1").link, null);
    assert.equal(parseRoute("?page=budget&plan=x").link, null);
    assert.equal(parseRoute("?page=budget&strategy=<b>").link, null);
    assert.equal(parseRoute("?page=check&plan=1").link, null);
    assert.equal(parseRoute("?page=budget&topup=").link, null);
    assert.deepEqual(parseRoute("?page=budget&topup=near&amount=1e9").link, { kind: "topup", token: "near", amount: null });
    assert.equal(parseRoute("?page=check&approve=12").link, null);
    assert.equal(parseRoute("?page=budget&help=other").help, false);
  });

  it("a one-shot link settles on a URL that does not open its drawer again on reload", () => {
    assert.equal(settledHref(parseRoute("?page=oncall")), "./");
    assert.equal(settledHref(parseRoute("?page=oncall&network=mainnet")), "?network=mainnet");
    assert.equal(settledHref(parseRoute("?page=agents")), "?page=budget");
    assert.equal(settledHref(parseRoute("?page=budget&dao=d.testnet&approve=3")), "?page=budget&dao=d.testnet");
    assert.equal(parseRoute(settledHref(parseRoute("?page=budget&dao=d.testnet&approve=3"))).link, null);
  });

  it("the agent guide link keeps the Budget it came from", () => {
    assert.equal(agentGuideHref("d.testnet"), "?page=budget&dao=d.testnet&help=agent");
    assert.equal(agentGuideHref(null), "?page=budget&help=agent");
  });

  it("the bell drawer keeps what the On Call page taught: every bot command and the bot link", () => {
    const out = renderAlertsDrawer(null);
    for (const c of ["/check", "/changes", "/watch", "/unwatch", "/list", "/help"]) assert.ok(text(out).includes(c), c);
    assert.match(out.value, /href="https:\/\/t\.me\/KeyDoctorOnCallBot"/);
  });

  it("Agents shows the endpoint with copy commands, all seven tools the hosted server lists, and falls back to self-host without a Worker URL", () => {
    const withUrl = renderAgents("https://kd.example.workers.dev").value;
    assert.match(withUrl, /data-command="claude mcp add --transport http key-doctor https:\/\/kd\.example\.workers\.dev\/mcp"/);
    assert.match(withUrl, /data-command="https:\/\/kd\.example\.workers\.dev\/mcp"/);
    // Same seven names as the Worker's tools/list: an agent reading this page must see every tool it can call.
    for (const tool of ["diagnose", "list_keys", "list_proposals", "compare", "watch", "preflight", "yield_suggestions"]) {
      assert.ok(withUrl.includes(`<code class="mono">${tool}</code>`), tool);
    }
    const none = text(renderAgents(""));
    assert.match(none, /Self-host: see the README/);
    assert.ok(!none.includes("claude mcp add"));
  });

  it("Roadmap keeps built, planned and future work apart, so a judge never reads a plan as a feature", () => {
    const page = text(renderRoadmap());
    const built = page.indexOf("Built Live on testnet");
    const next = page.indexOf("Next Planned");
    const future = page.indexOf("Future direction Not built");
    assert.ok(built >= 0 && next > built && future > next, "lanes in order: Built, Next, Future direction");
    // NEAR AI, Intents and cross-chain farming are direction only: they must sit under "Not built", never under "Built".
    for (const [title] of FUTURE) assert.ok(page.indexOf(title, future) > future, title);
    assert.ok(!page.slice(built, next).includes("NEAR Intents"));
    // Revenue is the owner's chosen model (fees from agents) but not built: it sits in the future lane, the checks stay free,
    // and the yield fee is a share of the yield, never the members' deposit.
    const revenue = page.indexOf("Revenue: fees from agents Chosen, not built");
    assert.ok(revenue > future);
    assert.ok(page.includes("The checks stay free"));
    for (const [title] of REVENUE) assert.ok(page.indexOf(title, revenue) > revenue, title);
    assert.match(page.slice(revenue), /APR minus the fee\. Never taken from the deposit/);
  });

  it("every Roadmap point opens its own detail: a point with no panel or no CSS rule would be a dead click", () => {
    const out = renderRoadmap().value;
    const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    const ids = [...out.matchAll(/<input type="radio" name="rm-point" id="([^"]+)"/g)].map((m) => m[1]!);
    assert.equal(ids.length, BUILT.length + NEXT.length + FUTURE.length + 1, "one point per item, plus Revenue");
    for (const id of ids) {
      assert.ok(out.includes(`<label for="${id}"`), `label for ${id}`);
      assert.equal(out.split(`data-for="${id}"`).length - 1, 1, `one panel for ${id}`);
      assert.ok(css.includes(`.rm-lane:has(#${id}:checked) [data-for="${id}"]`), `CSS rule for ${id}`);
    }
    // One detail is open on load, so the page never starts as bare dots.
    assert.equal(out.split(" checked>").length - 1, 1);
  });

  it("draws each lane as a road with numbered pins, text alternating above and below", () => {
    // WHY: the winding-road layout only lines up when the grid has one column per point; a lane with no matching
    // .rm-n-N rule would fall back to 4 columns and wrap the road.
    const out = renderRoadmap().value;
    const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    const lanes = [...out.matchAll(/<ol class="rm-line rm-n-(\d+)"[\s\S]*?<\/ol>/g)];
    assert.deepEqual(lanes.map((l) => Number(l[1])), [BUILT.length, NEXT.length, FUTURE.length + 1]);
    for (const [lane, n] of lanes) {
      assert.ok(css.includes(`.rm-n-${n} { grid-template-columns: repeat(${n}, minmax(0, 1fr)); }`), `CSS for rm-n-${n}`);
      const pins = [...lane.matchAll(/class="rm-pin" aria-hidden="true"><span>(\d+)</g)].map((m) => m[1]);
      assert.deepEqual(pins, Array.from({ length: Number(n) }, (_, i) => String(i + 1).padStart(2, "0")));
      const sides = [...lane.matchAll(/class="rm-point (rm-up|rm-down)"/g)].map((m) => m[1]);
      assert.deepEqual(sides, sides.map((_, i) => (i % 2 === 0 ? "rm-up" : "rm-down")));
      assert.equal((lane.match(/<svg class="rm-road"/g) ?? []).length, Number(n), "one road segment per point");
    }
  });

});

describe("labels and key table wording", () => {
  it("uses Needs cleanup / Info for the status labels, Details for the key button, and one-tap links", () => {
    assert.equal(STATUS_LABEL.cleanup, "Needs cleanup");
    assert.equal(STATUS_LABEL.note, "Info");
    assert.match(viewButton({ public_key: "ed25519:abc" } as never).value, />Details</);
    assert.match(renderWatchDialog("a.testnet", "account", "https://w").value, />Create one-tap links</);
  });

  it("home page says checking needs no sign-in and a wallet is only for removing your own keys", () => {
    assert.match(text(renderHome("", null)), /No sign-in needed to check\. Connecting a wallet is only for removing your own keys\./);
  });
});

describe("charts", () => {
  it("never uses a style attribute: the CSP has no 'unsafe-inline' for styles, so the browser would drop it", () => {
    // WHY: public/_headers sets style-src 'self'. A bar sized by style="" renders empty on the live site, while a
    // local preview without the header looks fine.
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    assert.match(headers, /style-src 'self'/);
    assert.doesNotMatch(headers, /style-src[^;]*unsafe-inline/);
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /\sstyle="/, f);
    }
  });

  it("sizes bars by class, never hiding a non-zero share or filling a partial one", () => {
    // WHY: 1 member in 400 must still show on the bar, and 399 of 400 must not look like all of them.
    assert.equal(widthClass(0, 10), "w-0");
    assert.equal(widthClass(3, 0), "w-0");
    assert.equal(widthClass(1, 400), "w-1");
    assert.equal(widthClass(399, 400), "w-99");
    assert.equal(widthClass(400, 400), "w-100");
    assert.equal(widthClass(1000, 2077), "w-48");
    const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    for (let i = 0; i <= 100; i++) assert.ok(css.includes(`.w-${i} { width: ${i}%; }`), `.w-${i}`);
  });

  it("council at a glance counts every member once and says how many votes move money", () => {
    // WHY: the chart is a summary of the member list below it; a count that drifts from the list would mislead a council.
    const r = dao();
    const out = councilGlance(r).value;
    const counts = [...out.matchAll(/<span class="legend-n">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    const states = (out.match(/<figure[\s\S]*?<\/figure>/)![0].match(/class="legend-n"/g) ?? []).length;
    assert.equal(counts.slice(0, states).reduce((a, b) => a + b, 0), r.members.length);
    // The state bar fills the row: every segment but the last has a width class, the last takes the rest.
    const segs = [...out.matchAll(/class="bar-seg seg-(high|cleanup|ok|note) ([\w-]+)"/g)].map((m) => m[2]);
    assert.equal(segs.length, states);
    assert.equal(segs.at(-1), "bar-seg-rest");
    const votes = transferVotes(r);
    assert.ok(votes !== null, "the demo DAO has one transfer rule");
    assert.match(text(councilGlance(r)), new RegExp(`${votes} of ${r.members.length} members must approve a payment`));
    // Rules that are not one simple vote get a pointer, not a made-up number.
    const odd = { ...r, dao: { ...r.dao!, transfer_vote_policy: [] } } as KdReport;
    assert.match(text(councilGlance(odd)), /not one simple vote/);
    assert.doesNotMatch(councilGlance(odd).value, /meter-votes/);
  });
});
