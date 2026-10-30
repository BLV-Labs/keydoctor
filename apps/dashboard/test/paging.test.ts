import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type { KdReport, KeyInfo, Member, ProposalInfo } from "key-doctor";
import { renderCleanup } from "../src/cleanup-view.ts";
import { pageHref, pager, pageWindow, parsePaging, slicePage } from "../src/paging.ts";
import { renderProposals } from "../src/proposals-view.ts";
import { keySeverity, recentFullAccessKeys } from "../src/view.ts";
import { renderAccount, renderCouncil } from "../src/report.ts";

const require = createRequire(import.meta.url);
const dao = (): KdReport =>
  JSON.parse(readFileSync(require.resolve("key-doctor/fixtures/reports/dao-kd-demo.report.json"), "utf8")) as KdReport;
const text = (h: { value: string }) => h.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The demo DAO with `n` council members, copies of the first member under new names. */
function bigDao(n: number): KdReport {
  const r = dao();
  const m = r.members[0] as Member;
  return { ...r, members: Array.from({ length: n }, (_, i) => ({ ...m, account_id: `m${String(i).padStart(2, "0")}.kd-demo.testnet` })) };
}

/** An account report whose only member has `n` app keys. */
function manyKeys(n: number): KdReport {
  const r = dao();
  const m = r.members[0] as Member;
  const app = m.keys.find((k) => k.permission.type !== "full_access") as KeyInfo;
  const keys = [...m.keys.filter((k) => k.permission.type === "full_access"), ...Array.from({ length: n }, (_, i) => ({ ...app, public_key: `ed25519:APP${i}` }))];
  return { ...r, target: { type: "account", id: m.account_id }, members: [{ ...m, keys }] };
}

describe("paging helpers", () => {
  it("reads only well-formed `<list>_page` values from the URL", () => {
    assert.deepEqual(parsePaging("?target=x.testnet&members_page=3&keys_page=0&proposals_page=abc&step1_page=2").pages, { members: 3, step1: 2 });
  });

  it("builds the page link and drops the parameter on page 1", () => {
    assert.equal(pageHref("?target=x.testnet", "members", 2), "?target=x.testnet&members_page=2");
    assert.equal(pageHref("?target=x.testnet&members_page=2", "members", 1), "?target=x.testnet");
    assert.equal(pageHref("", "keys", 1), "./");
  });

  it("clamps the page and reports the rows shown", () => {
    assert.deepEqual(pageWindow(23, 3), { page: 3, pages: 3, total: 23, first: 21, last: 23 });
    assert.deepEqual(pageWindow(23, 99), { page: 3, pages: 3, total: 23, first: 21, last: 23 });
    assert.deepEqual(pageWindow(0, 2), { page: 1, pages: 1, total: 0, first: 0, last: 0 });
    assert.deepEqual(slicePage([1, 2, 3, 4, 5], 2, 2).items, [3, 4]);
  });

  it("shows nothing for a list that fits on one page, and no Previous link on page 1", () => {
    const paging = parsePaging("?target=x.testnet");
    assert.equal(pager("members", "Council members", pageWindow(10, 1), paging).value, "");
    const out = pager("members", "Council members", pageWindow(11, 1), paging).value;
    assert.match(text({ value: out }), /Showing 1–10 of 11 .*Page 1 of 2/);
    assert.match(out, /aria-disabled="true">← Previous/);
    assert.match(out, /href="\?target=x\.testnet&amp;members_page=2" rel="next" data-page-list="members"/);
  });
});

describe("paged lists", () => {
  it("council members: 10 per page, sorted by risk before paging", () => {
    const r = bigDao(23);
    const p2 = renderCouncil(r, parsePaging(`?target=${r.target.id}&members_page=2`));
    assert.equal((p2.value.match(/<a class="member-row/g) ?? []).length, 10);
    assert.match(text(p2), /m10\.kd-demo\.testnet .* m19\.kd-demo\.testnet/);
    assert.doesNotMatch(text(p2), /m09\.kd-demo|m20\.kd-demo/);
    assert.match(text(p2), /Showing 11–20 of 23/);
    assert.equal((renderCouncil(dao()).value.match(/class="pager"/g) ?? []).length, 0);
  });

  it("every key: the table pages, the action stays on each row", () => {
    const r = manyKeys(14);
    const total = (r.members[0] as Member).keys.length;
    const out = renderAccount(r, null, parsePaging(`?target=${r.target.id}&keys_page=2`));
    assert.equal((out.value.match(/data-action="delete-key"/g) ?? []).length, total - 10);
    assert.match(text(out), new RegExp(`Showing 11–${total} of ${total}`));
  });

  it("cleanup: a long step pages its keys and numbers continue across pages", () => {
    const r = manyKeys(13);
    const out = renderCleanup(r, null, "safe", parsePaging(`?target=${r.target.id}&view=cleanup&step1_page=2`)).value;
    assert.match(out, /<ol class="key-list" start="11">/);
    assert.match(text({ value: out }), /Showing 11–13 of 13/);
  });

  it("proposals: the pager counts every proposal the DAO has", () => {
    const p: ProposalInfo = {
      id: 12, kind_label: "policy", description: "x", proposer: "a.kd-demo.testnet", status: "Rejected",
      votes: { "a.kd-demo.testnet": "Approve", "b.kd-demo.testnet": "Reject" }, approvals_needed: 2, approvals_have: 1,
      pending_voters: [], executed: false, ui_url: null,
    };
    const out = renderProposals({ proposals: [p], total: 23, errors: [] }, 2, parsePaging("?target=d.sputnik-dao.testnet&proposals_page=2"));
    assert.match(text(out), /Showing 11–20 of 23 .*Page 2 of 3/);
    assert.match(out.value, /href="\?target=d\.sputnik-dao\.testnet" rel="prev"/);
  });
});

describe("risk colors and long text", () => {
  it("Delete is red, Revoke is amber; a risky account makes the cleanup plan the one primary action", () => {
    const out = renderAccount(manyKeys(1), null).value;
    assert.match(out, /class="btn btn-danger self-start"[^>]*>Delete</);
    assert.match(out, /class="btn btn-warn self-start"[^>]*>Revoke</);
    assert.match(out, /class="btn btn-primary" href="[^"]*view=cleanup"/);
    assert.equal((out.match(/btn-primary/g) ?? []).length, 1);
  });

  it("only the newly added full-access key row is tinted and labelled", () => {
    const out = renderAccount(manyKeys(1), null).value;
    assert.equal((out.match(/class="row-new"/g) ?? []).length, 1);
    assert.match(out, /New key<\/span>/);
  });

  it("the new key's row tint and its New key pill follow the key's worst flag, so they agree with the reason pill", () => {
    const r = manyKeys(1);
    const m = r.members[0] as Member;
    const { key } = recentFullAccessKeys(m, r.chain.block_timestamp)[0]!;
    const tone = keySeverity(key, m) ?? "high";
    const out = renderAccount(r, null).value;
    const row = out.match(/<tr class="row-new"[^>]*>[\s\S]*?<\/tr>/)![0];
    assert.equal(row.match(/data-tone="(\w+)"/)?.[1] ?? "high", tone);
    assert.match(row, new RegExp(`pill pill-sm pill-${tone}">[^]*?New key`));
  });

  it("risk explanations and cleanup instructions are never cut", () => {
    const r = manyKeys(1);
    const account = renderAccount(r, null).value;
    for (const f of (r.members[0] as Member).flags) assert.ok(!account.includes(`<div class="clamp-body"><span class="muted">${f.messages.en.explain}`), f.rule_id);
    assert.doesNotMatch(renderCleanup(r, null, "safe").value, /clamp-body">Before you delete/);
  });

  it("proposal status, governance kinds and votes are colored; a reject reads 'rejected'", () => {
    const base = { id: 1, description: "", proposer: "a.kd-demo.testnet", approvals_needed: 2, approvals_have: 1, pending_voters: [], executed: false, ui_url: null };
    const out = renderProposals({
      proposals: [
        { ...base, kind_label: "upgrade_self", status: "InProgress", votes: { "b.kd-demo.testnet": "Reject" } },
        { ...base, kind_label: "transfer", status: "Approved", votes: {} },
      ],
      total: 2,
      errors: [],
    }).value;
    assert.match(out, /pill-info">In progress/);
    assert.match(out, /pill-ok">Approved/);
    assert.match(out, /tag tag-warn"[^>]*>.*Upgrade DAO<span class="sr-only"> \(governance change\)/);
    assert.match(out, /vote-high">rejected</);
    assert.doesNotMatch(out, /rejectd/);
  });

  it("long descriptions sit in a clamp with a hidden Show more toggle", () => {
    const p = { id: 1, kind_label: "transfer", description: "word ".repeat(200), proposer: "a.kd-demo.testnet", status: "Approved", votes: {}, approvals_needed: 2, approvals_have: 0, pending_voters: [], executed: false, ui_url: null } as ProposalInfo;
    const out = renderProposals({ proposals: [p], total: 1, errors: [] }).value;
    assert.match(out, /class="clamp clamp-3" data-clamp>\s*<div class="clamp-body">word word/);
    assert.match(out, /data-action="toggle-more" aria-expanded="false" hidden>Show more/);
  });
});
