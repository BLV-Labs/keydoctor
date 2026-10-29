import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import { RULESET_VERSION, scanAccount } from "../src/index.ts";
import * as T from "../src/rules/thresholds.ts";
import { installFetch, world, ed } from "./support/stub.ts";

const SRC = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const ALL = files(SRC);
const rel = (f: string) => relative(SRC, f);

describe("S1-AC7: source invariants", () => {
  it("found the source files", () => assert.ok(ALL.length >= 10));

  it("no file under src/ imports node:*", () => {
    for (const f of ALL) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /["'`]node:/, rel(f));
      assert.doesNotMatch(src, /\brequire\s*\(/, rel(f));
    }
  });

  it("only rpc.ts references fetch", () => {
    for (const f of ALL) {
      const has = /\bfetch\b/.test(readFileSync(f, "utf8"));
      assert.equal(has, rel(f) === "rpc.ts", rel(f));
    }
  });

  it("rpc.ts reads fetch from globalThis at call time (a stub installed after import is used)", async (t) => {
    assert.match(readFileSync(join(SRC, "rpc.ts"), "utf8"), /globalThis\.fetch\(/);
    const calls = installFetch(t, world({ keys: { "a.testnet": [ed(1)] } }));
    await scanAccount("a.testnet");
    assert.ok(calls.length >= 2);
  });

  it("no threshold or cap value appears as a numeric literal outside thresholds.ts", () => {
    const values = new Set<number>();
    for (const v of Object.values(T)) {
      if (typeof v === "number" && v >= 3) values.add(v);
    }
    for (const x of Object.values(T.GENESIS_HEIGHT)) values.add(x);
    assert.ok(values.has(730) && values.has(45) && values.has(15_000) && values.has(9_820_210));
    for (const f of ALL.filter((x) => rel(x) !== "rules/thresholds.ts")) {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (!ts.isNumericLiteral(n)) return void ts.forEachChild(n, visit);
        // `x / 1000` and `x * 1000` convert between ms and s: a unit conversion, not FA_BOT_LIKE_USES.
        const unit =
          n.getText() === "1000" && ts.isBinaryExpression(n.parent) && [ts.SyntaxKind.SlashToken, ts.SyntaxKind.AsteriskToken].includes(n.parent.operatorToken.kind);
        // HTTP status codes in rpc.ts (`res.status >= 500`) share values with caps by coincidence.
        const http = ts.isBinaryExpression(n.parent) && n.parent.left.getText() === "res.status";
        if (!unit && !http) assert.ok(!values.has(Number(n.text.replaceAll("_", ""))), `${rel(f)}: literal ${n.text}`);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  });

  it("every threshold and cap is a named export of thresholds.ts", () => {
    for (const name of [
      "FA_MANY_MIN", "FA_MULTIPLE_MIN", "FA_OLD_DAYS", "FA_BOT_LIKE_USES", "COUNCIL_SMALL_MAX", "ADMIN_APPROVALS",
      "BLOCK_TIME_MS", "GENESIS_HEIGHT", "REQUEST_BUDGET", "MAX_MEMBERS", "MAX_ROLES", "MAX_KEYS",
      "CONCURRENCY_DEFAULT", "CONCURRENCY_MIN", "CONCURRENCY_MAX", "RPC_TIMEOUT_MS", "RULESET_VERSION",
    ]) {
      assert.ok(name in T, name);
    }
    assert.deepEqual(
      [T.FA_MANY_MIN, T.FA_MULTIPLE_MIN, T.FA_OLD_DAYS, T.FA_BOT_LIKE_USES, T.REQUEST_BUDGET, T.MAX_KEYS, T.MAX_MEMBERS, T.MAX_ROLES, T.RPC_TIMEOUT_MS],
      [5, 2, 730, 1000, 45, 100, 21, 50, 15000],
    );
  });

  it("report.ruleset_version === RULESET_VERSION", async (t) => {
    installFetch(t, world({ keys: { "a.testnet": [ed(1)] } }));
    const r = await scanAccount("a.testnet");
    assert.equal(r.ruleset_version, RULESET_VERSION);
    assert.equal(RULESET_VERSION, T.RULESET_VERSION);
  });
});
