import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type { KdReport, Member } from "key-doctor";
import { html } from "../src/html.ts";
import { renderLayout } from "../src/pages.ts";
import { renderAccount, renderCouncil } from "../src/report.ts";
import { avatarTone, cardHead, initials } from "../src/ui.ts";

const require = createRequire(import.meta.url);
const dao = (): KdReport =>
  JSON.parse(readFileSync(require.resolve("key-doctor/fixtures/reports/dao-kd-demo.report.json"), "utf8")) as KdReport;

describe("compact layout and themes", () => {
  it("monogram: first and last part of the first label, stable tone", () => {
    assert.equal(initials("kdoncall-b.testnet"), "KB");
    assert.equal(initials("a.kd-demo.testnet"), "A");
    assert.equal(initials("treasury.sputnik-dao.near"), "TR");
    assert.equal(initials("ab".repeat(32)), "AB");
    assert.equal(initials("member-08.kd-demo.testnet"), "M8");
    assert.equal(avatarTone("kdoncall-b.testnet"), avatarTone("kdoncall-b.testnet"));
  });

  it("every member row starts with a decorative monogram", () => {
    const out = renderCouncil(dao()).value;
    const rows = (out.match(/<a class="member-row/g) ?? []).length;
    assert.equal((out.match(/class="avatar av-\d" aria-hidden="true">/g) ?? []).length, rows);
  });

  it("card header: title and note together, one optional link on the right", () => {
    const plain = cardHead("x-h", "Proposals", "Newest first").value;
    assert.match(plain, /<div class="head-title"><h2 id="x-h" class="h2">Proposals<\/h2><span class="muted small">Newest first<\/span><\/div>/);
    assert.doesNotMatch(plain, /head-link/);
    assert.match(cardHead("k-h", "Every key", html`n`, { href: "?target=a.testnet&view=cleanup", label: "Cleanup plan" }).value, /class="head-link" href="\?target=a\.testnet&amp;view=cleanup" data-nav>Cleanup plan →/);
  });

  it("account page: the keys card links to the cleanup plan and the Uses column is numeric", () => {
    const r = dao();
    const out = renderAccount({ ...r, target: { type: "account", id: "a.kd-demo.testnet" }, members: [r.members[0] as Member] }, null).value;
    assert.match(out, /class="head-link"[^>]*view=cleanup[^>]*>Cleanup plan →/);
    assert.match(out, /<th scope="col" class="num">Uses<\/th>/);
    assert.match(out, /data-label="Uses" class="num"/);
  });

  it("the header has a dark-theme switch that announces its state", () => {
    const out = renderLayout(html`x`).value;
    assert.match(out, /<button type="button" class="icon-btn theme-toggle" data-action="theme" aria-label="Dark theme" aria-pressed="false">/);
  });
});

describe("theme tokens", () => {
  const css = readFileSync(new URL("../../../docs/design/dashboard/tokens.css", import.meta.url), "utf8");
  const block = (selector: string): Record<string, string> => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf("\n}", start));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  };
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const light = block(":root");
  const dark = { ...light, ...block(':root[data-theme="dark"]') };
  const pairs: [string, string][] = [
    ["kd-text", "kd-surface"], ["kd-text-2", "kd-surface"], ["kd-text-muted", "kd-surface"], ["kd-text-muted", "kd-surface-muted"],
    ["kd-primary", "kd-surface"], ["kd-on-primary", "kd-primary"], ["kd-primary", "kd-primary-tint"],
    ["kd-high", "kd-high-bg"], ["kd-high-text", "kd-high-bg"], ["kd-cleanup", "kd-cleanup-bg"], ["kd-ok", "kd-ok-bg"],
    ["kd-note", "kd-note-bg"], ["kd-info", "kd-info-bg"], ["kd-high", "kd-surface"], ["kd-cleanup", "kd-surface"],
  ];

  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    it(`${name}: every text/background pair passes WCAG AA (4.5:1)`, () => {
      for (const [fg, bg] of pairs) {
        assert.ok(theme[fg] && theme[bg], `${fg} / ${bg} defined`);
        assert.ok(ratio(theme[fg]!, theme[bg]!) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(theme[fg]!, theme[bg]!).toFixed(2)}`);
      }
    });
  }
});
