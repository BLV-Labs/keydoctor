import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scanAccount, scanDao, type KdReport } from "../src/index.ts";
import { rolePolicyLimitation } from "../src/messages.ts";
import { RULE_ORDER } from "../src/rules/thresholds.ts";
import { FIXTURES, installStub, type Answer } from "./stub-rpc.ts";

interface Case {
  target: string;
  scan: "account" | "dao";
  network: "testnet";
  rule?: string;
  limitation?: string;
  fires: boolean;
  responses: Record<string, Answer>;
}

const CORPUS = join(FIXTURES, "corpus");
const files = readdirSync(CORPUS).filter((f) => f.endsWith(".json")).sort();
const load = (f: string): Case => JSON.parse(readFileSync(join(CORPUS, f), "utf8")) as Case;

const reports = new Map<string, KdReport>();
async function scan(file: string): Promise<KdReport> {
  const cached = reports.get(file);
  if (cached) return cached;
  const c = load(file);
  const stub = installStub(c.responses);
  try {
    const report = c.scan === "dao" ? await scanDao(c.target) : await scanAccount(c.target);
    assert.deepEqual(stub.unmatched, [], `${file}: the scan asked for something the case does not hold`);
    assert.ok(stub.requests.length <= 45);
    reports.set(file, report);
    return report;
  } finally {
    stub.restore();
  }
}
const present = (r: KdReport, rule: string): boolean =>
  [...r.members.flatMap((m) => m.flags), ...r.dao_flags].some((f) => f.rule_id === rule);

describe("S4 corpus layout", () => {
  it("holds exactly 26 rule files and LIMIT_NON_GROUP_ADMIN.json, one pos and one neg per rule id", () => {
    const expected = [...RULE_ORDER.flatMap((r) => [`${r}.pos.json`, `${r}.neg.json`]), "LIMIT_NON_GROUP_ADMIN.json"].sort();
    assert.equal(RULE_ORDER.length, 13);
    assert.deepEqual(files, expected);
    assert.equal(files.length, 27);
  });

  it("every case is testnet, under kd-corpus names, and its fires flag matches its file name", () => {
    for (const f of files) {
      const c = load(f);
      assert.equal(c.network, "testnet", f);
      assert.ok(c.scan === "account" || c.scan === "dao", f);
      const suffix = c.scan === "dao" ? ".kd-corpus.sputnik-dao.testnet" : ".kd-corpus.testnet";
      assert.ok(c.target.endsWith(suffix), `${f}: ${c.target}`);
      if (f.endsWith(".pos.json")) assert.equal(c.fires, true, f);
      if (f.endsWith(".neg.json")) assert.equal(c.fires, false, f);
      if (f !== "LIMIT_NON_GROUP_ADMIN.json") assert.equal(c.rule, f.split(".")[0], f);
      for (const key of Object.keys(c.responses)) {
        assert.match(key, /^block$|^query\/(view_access_key_list|view_account|call_function)\/[^/]+$/, f);
        if (key.startsWith("query/")) assert.match(key, /\.kd-corpus\.(sputnik-dao\.)?testnet$/, `${f}: ${key}`);
      }
    }
  });
});

describe("S4-AC1 rule corpus: the rule's presence in the report equals fires", () => {
  for (const f of files.filter((x) => x !== "LIMIT_NON_GROUP_ADMIN.json")) {
    it(f, async () => {
      const c = load(f);
      const r = await scan(f);
      assert.equal(present(r, c.rule!), c.fires, `${f}: ${c.rule} flags ${JSON.stringify([...r.members.flatMap((m) => m.flags), ...r.dao_flags].map((x) => x.rule_id))}`);
    });
  }
});

describe("S4-AC1 negatives sit just under the threshold", () => {
  const faEd = (r: KdReport) => r.members[0]!.keys.filter((k) => k.curve === "ed25519" && k.permission.type === "full_access").length;
  it("FA_MANY neg has 4 Ed25519 FA keys (FA_MULTIPLE fires), pos has 5", async () => {
    assert.equal(faEd(await scan("FA_MANY.neg.json")), 4);
    assert.ok(present(await scan("FA_MANY.neg.json"), "FA_MULTIPLE"));
    assert.equal(faEd(await scan("FA_MANY.pos.json")), 5);
  });
  it("FA_MULTIPLE neg has 1 Ed25519 FA key, pos has 2", async () => {
    assert.equal(faEd(await scan("FA_MULTIPLE.neg.json")), 1);
    assert.equal(faEd(await scan("FA_MULTIPLE.pos.json")), 2);
  });
  it("FA_OLD neg is aged 730 days, pos 731", async () => {
    assert.equal((await scan("FA_OLD.neg.json")).members[0]!.keys[0]!.age_days, 730);
    assert.equal((await scan("FA_OLD.pos.json")).members[0]!.keys[0]!.age_days, 731);
  });
  it("FA_BOT_LIKE neg has 999 uses, pos 1000", async () => {
    assert.equal((await scan("FA_BOT_LIKE.neg.json")).members[0]!.keys[0]!.use_count, 999);
    assert.equal((await scan("FA_BOT_LIKE.pos.json")).members[0]!.keys[0]!.use_count, 1000);
  });
  it("COUNCIL_SMALL neg has 3 members, pos 2", async () => {
    assert.equal((await scan("COUNCIL_SMALL.neg.json")).summary.council_size, 3);
    assert.equal((await scan("COUNCIL_SMALL.pos.json")).summary.council_size, 2);
  });
  it("DAO_ADMIN neg needs 2 votes for policy changes, pos 1; the neg is not a 1-member or token-weight escape", async () => {
    for (const [f, n] of [["DAO_ADMIN.neg.json", "2"], ["DAO_ADMIN.pos.json", "1"]] as const) {
      const c = load(f);
      const bytes = (c.responses[`query/call_function/${c.target}`] as any).result.result as number[];
      const policy = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
      assert.equal(policy.roles[0].vote_policy.policy.threshold, n);
      assert.equal(policy.roles[0].vote_policy.policy.weight_kind, "RoleWeight");
      assert.equal((await scan(f)).summary.council_size, 3);
    }
  });
  it("FC_DAO_VOTE neg has a DAO FC key limited to add_proposal, pos adds act_proposal", async () => {
    for (const [f, methods] of [["FC_DAO_VOTE.neg.json", ["add_proposal"]], ["FC_DAO_VOTE.pos.json", ["act_proposal"]]] as const) {
      const r = await scan(f);
      const fc = r.members.flatMap((m) => m.keys).filter((k) => k.permission.type === "function_call");
      assert.equal(fc.length, 1, f);
      const p = fc[0]!.permission;
      assert.ok(p.type === "function_call" && p.receiver_id === r.target.id);
      assert.deepEqual(p.type === "function_call" ? p.method_names : null, methods);
    }
  });
});

describe("S4-AC2 LIMIT_NON_GROUP_ADMIN", () => {
  it("gives the policy-changes limitation line and no DAO_ADMIN", async () => {
    const c = load("LIMIT_NON_GROUP_ADMIN.json");
    const r = await scan("LIMIT_NON_GROUP_ADMIN.json");
    assert.equal(c.limitation, rolePolicyLimitation("anyone"));
    assert.ok(r.limitations.includes(c.limitation!));
    assert.ok(!present(r, "DAO_ADMIN"));
    assert.equal(r.dao?.roles[0]?.kind, "everyone");
    assert.equal(r.summary.council_size, 3);
  });
});
