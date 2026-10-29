import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fixture } from "./support/stub.ts";

const PKG = join(import.meta.dirname, "..");
const SCRIPT = join(PKG, "scripts", "scan.ts");
const PRELOAD = join(import.meta.dirname, "support", "script-preload.mjs");

function run(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "kd-script-"));
  const log = join(dir, "requests.log");
  const res = spawnSync(process.execPath, ["--import", PRELOAD, SCRIPT, ...args.map((a) => (a === "<dir>" ? join(dir, "raw") : a))], {
    env: { ...process.env, KD_STUB_LOG: log },
    encoding: "utf8",
  });
  const requests = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { ...res, requests, raw: join(dir, "raw") };
}

describe("S1-AC8: scripts/scan.ts", () => {
  it("prints the report as JSON (equals the b fixture except generated_at)", () => {
    const r = run(["b.kd-demo.testnet"]);
    assert.equal(r.status, 0, r.stderr);
    const { generated_at: _a, ...got } = JSON.parse(r.stdout);
    const { generated_at: _b, ...want } = fixture("reports/account-b.report.json");
    assert.deepEqual(got, want);
    assert.deepEqual(r.requests, ["block", "view_access_key_list", "view_account"]);
  });

  it("--save-raw writes <n>.<method>.json response bodies and never the URL", () => {
    const r = run(["b.kd-demo.testnet", "--save-raw", "<dir>"]);
    assert.equal(r.status, 0, r.stderr);
    const names = readdirSync(r.raw).sort();
    assert.deepEqual(names, ["1.block.json", "2.view_access_key_list.json", "3.view_account.json"]);
    assert.equal(readFileSync(join(r.raw, "1.block.json"), "utf8"), readFileSync(join(PKG, "fixtures/rpc/block.json"), "utf8"));
    assert.equal(
      readFileSync(join(r.raw, "2.view_access_key_list.json"), "utf8"),
      readFileSync(join(PKG, "fixtures/rpc/view_access_key_list.b.json"), "utf8"),
    );
    for (const n of names) {
      assert.doesNotMatch(n, /http|rpc\./);
      assert.doesNotMatch(readFileSync(join(r.raw, n), "utf8"), /https?:|rpc\.testnet/);
    }
  });

  it("scan foo.near --save-raw is refused through the suffix: exit 2, zero requests, nothing written", () => {
    const r = run(["foo.near", "--save-raw", "<dir>"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refused for mainnet/);
    assert.deepEqual(r.requests, []);
    assert.equal(existsSync(r.raw), false);
  });

  it("--network mainnet with a bare id is refused too", () => {
    const r = run(["foo", "--network", "mainnet", "--save-raw", "<dir>"]);
    assert.equal(r.status, 2);
    assert.deepEqual(r.requests, []);
    assert.equal(existsSync(r.raw), false);
  });

  it("a mainnet scan without --save-raw is allowed", () => {
    const r = run(["foo.near"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.requests.length > 0);
  });

  it("an invalid target exits 1 with the kd.error.v1 JSON and zero requests; a missing id exits 2", () => {
    const bad = run(["not valid"]);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stderr).code, "INVALID_TARGET");
    assert.deepEqual(bad.requests, []);
    assert.equal(run([]).status, 2);
    assert.equal(run(["a.testnet", "--network", "devnet"]).status, 2);
  });
});
