import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { councilCandidates, pickerCandidates } from "../src/agents-read.ts";
import { NO_DAO_HINT, openedDaos, pickedValue, rememberOpenedDao, renderDaoPicker } from "../src/dao-picker.ts";

const A = "a.sputnikv2.testnet";
const B = "b.sputnikv2.testnet";
const ME = "me.testnet";
const policy = (members: string[]) => ({ roles: [{ name: "council", kind: { Group: members }, permissions: [], vote_policy: {} }], proposal_bond: "0" });

describe("DAO picker markup", () => {
  // The select only fills the text input, so every DAO plus the escape hatch must be there.
  it("lists each DAO and ends with Other DAO…", () => {
    const out = renderDaoPicker([A, B], "", "x-pick", null).value;
    assert.match(out, /<label for="x-pick"[^>]*>Your DAOs<\/label>/);
    assert.deepEqual([...out.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]), [A, B, ""]);
    assert.match(out, /Other DAO…/);
    assert.doesNotMatch(out, /name=/, "the select must not be submitted: the input keeps name=dao");
  });

  it("keeps the form's error tied to the select", () => {
    assert.match(renderDaoPicker([A], "", "x", "x-error").value, /aria-describedby="x-error"/);
  });

  // A URL or an error re-render already holds a DAO: the picker must not replace it with the first one.
  it("preselects by the input value", () => {
    assert.equal(pickedValue([A, B], ""), A);
    assert.equal(pickedValue([A, B], B), B);
    assert.equal(pickedValue([A, B], "  b.sputnikv2.testnet "), B);
    assert.equal(pickedValue([A, B], "other.testnet"), "");
    assert.equal(pickedValue([], ""), "");
    assert.match(renderDaoPicker([A, B], "other.testnet", "x", null).value, /<option value="" selected>Other DAO…/);
  });

  it("has a hint for the empty list, worded for typing", () => {
    assert.equal(NO_DAO_HINT, "No DAO found for this wallet. Type its account name.");
  });
});

describe("DAO candidates", () => {
  // Testnet has ~5,500 DAOs; offering a mainnet id on a testnet form would only produce an error page.
  it("keeps only the current network, deduped, without empty ids", () => {
    assert.deepEqual(pickerCandidates([[A, ""], [B, A, "x.near"]], "testnet"), [A, B]);
    assert.deepEqual(pickerCandidates([[A, "x.near"]], "mainnet"), ["x.near"]);
  });

  it("drops DAOs where the wallet is not on the council and DAOs whose policy cannot be read", async () => {
    const policies: Record<string, unknown> = { [A]: policy([ME]), [B]: policy(["someone.testnet"]) };
    const kept = await councilCandidates([A, B, "gone.sputnikv2.testnet", "bad.sputnikv2.testnet"], [ME], async (d) => {
      if (d.startsWith("gone")) throw new Error("rpc");
      return policies[d] ?? { nonsense: true };
    });
    assert.deepEqual(kept, [A]);
  });

  // The budget form lists budgets only: its candidates come from the budget factory alone, never the seen lists.
  it("a budget-only candidate list excludes non-budget DAOs", async () => {
    const budgetOnly = pickerCandidates([[A]], "testnet");
    const guardForm = pickerCandidates([[A], [B]], "testnet");
    assert.deepEqual(budgetOnly, [A]);
    assert.ok(guardForm.includes(B) && !budgetOnly.includes(B));
  });
});

describe("opened DAOs store", () => {
  const g = globalThis as { localStorage?: unknown };
  afterEach(() => {
    delete g.localStorage;
  });
  const fake = (): Map<string, string> => {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    return m;
  };

  it("keeps the 10 newest, newest first, no duplicates", () => {
    fake();
    for (let i = 0; i < 12; i += 1) rememberOpenedDao(`d${i}.sputnikv2.testnet`);
    rememberOpenedDao("d5.sputnikv2.testnet");
    const seen = openedDaos();
    assert.equal(seen.length, 10);
    assert.equal(seen[0], "d5.sputnikv2.testnet");
    assert.equal(new Set(seen).size, 10);
  });

  it("survives blocked or corrupt storage", () => {
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    assert.deepEqual(openedDaos(), []);
    assert.doesNotThrow(() => rememberOpenedDao(A));
    g.localStorage = { getItem: () => "{not json", setItem: () => {} };
    assert.deepEqual(openedDaos(), []);
  });
});
