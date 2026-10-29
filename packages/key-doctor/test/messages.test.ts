import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fail } from "../src/errors.ts";
import { MEMBER_ERROR_TEXT, ruleMessages, type MemberErrorCode, type MessageRuleId } from "../src/messages.ts";
import { FA_OLD_DAYS, MAX_GROUP_ENTRIES, MAX_KEYS, MAX_MEMBERS, MAX_ROLES, RULE_ORDER } from "../src/rules/thresholds.ts";
import type { KdErrorCode } from "../src/index.ts";

const BAD = /\b(null|undefined|NaN)\b|\[object/;
const nonEmpty = (s: unknown): void => {
  assert.equal(typeof s, "string");
  assert.notEqual((s as string).trim(), "");
};

// The evidence each rule really emits (see src/rules/*.ts).
const EVIDENCE: Record<MessageRuleId, Record<string, unknown>> = {
  FA_MANY: { full_access_ed25519: 5 },
  DAO_ADMIN: { approvals_needed: 1 },
  FC_DAO_VOTE: { any_method: false },
  FA_MULTIPLE: { full_access_ed25519: 2 },
  PQ_PARTIAL: { ml_dsa: 1, full_access_ed25519: 2 },
  FA_OLD: { age_days: 900 },
  KEY_UNUSED: { use_count: 0 },
  FC_UNLIMITED_ALLOWANCE: { allowance_yocto: null },
  FC_ANY_METHOD: { method_names: [] },
  FC_DEAD_RECEIVER: { receiver_id: "dead.kd-test.testnet" },
  FA_BOT_LIKE: { use_count: 1500 },
  PQ_NONE: { ml_dsa: 0 },
  COUNCIL_SMALL: { council_size: 2 },
};

describe("S3-AC6 rule texts", () => {
  it("the 13 rule ids in RULE_ORDER and in the message table are the same set", () => {
    assert.deepEqual(Object.keys(EVIDENCE).sort(), [...RULE_ORDER].sort());
    assert.equal(RULE_ORDER.length, 13);
  });

  for (const id of RULE_ORDER) {
    it(`${id}: non-empty vi and en title, explain and fix, from evidence only`, () => {
      const msg = ruleMessages(id, EVIDENCE[id]);
      for (const lang of ["vi", "en"] as const) for (const part of ["title", "explain", "fix"] as const) {
        nonEmpty(msg[lang][part]);
        assert.doesNotMatch(msg[lang][part], BAD, `${id} ${lang}.${part}`);
      }
    });
  }

  it("evidence numbers appear in the text", () => {
    const has = (id: MessageRuleId, ev: Record<string, unknown>, n: string) => {
      const m = ruleMessages(id, ev);
      assert.ok(m.vi.explain.includes(n) && m.en.explain.includes(n), `${id} ${n}`);
    };
    has("FA_MANY", { full_access_ed25519: 7 }, "7");
    has("FA_MULTIPLE", { full_access_ed25519: 3 }, "3");
    has("PQ_PARTIAL", { ml_dsa: 4, full_access_ed25519: 6 }, "4");
    has("PQ_PARTIAL", { ml_dsa: 4, full_access_ed25519: 6 }, "6");
    has("FA_OLD", { age_days: 912 }, "912");
    has("FA_BOT_LIKE", { use_count: 4321 }, "4321");
    has("DAO_ADMIN", { approvals_needed: 1 }, "1");
    has("COUNCIL_SMALL", { council_size: 2 }, "2");
  });

  it("FA_OLD without an age says the age is unknown instead of printing null; thresholds come from thresholds.ts", () => {
    const unknown = ruleMessages("FA_OLD", { age_days: null });
    assert.doesNotMatch(unknown.en.explain + unknown.vi.explain, BAD);
    assert.match(ruleMessages("FA_OLD", { age_days: 800 }).en.explain, new RegExp(String(FA_OLD_DAYS)));
  });

  it("receiver-bearing rules name the receiver only when it is passed, and fall back to fixed text otherwise", () => {
    for (const id of ["FC_ANY_METHOD", "FC_DEAD_RECEIVER", "FC_DAO_VOTE"] as const) {
      const named = ruleMessages(id, EVIDENCE[id], { receiverId: "x.kd-test.testnet" });
      assert.match(named.en.explain, /x\.kd-test\.testnet/);
      assert.match(named.vi.explain, /x\.kd-test\.testnet/);
      const anon = ruleMessages(id, EVIDENCE[id], { receiverId: null });
      assert.doesNotMatch(anon.en.explain + anon.vi.explain, BAD);
    }
  });
});

describe("S3-AC6 member error and kd.error.v1 texts", () => {
  const memberCodes: MemberErrorCode[] = ["RPC_ERROR", "RATE_LIMITED", "INVALID_ACCOUNT_ID", "LIMIT_EXCEEDED"];
  for (const code of memberCodes) {
    it(`member error ${code}: non-empty vi and en, says risk is unknown, not low`, () => {
      const t = MEMBER_ERROR_TEXT[code];
      nonEmpty(t.vi);
      nonEmpty(t.en);
      assert.match(t.en, /unknown, not low/);
      assert.match(t.vi, /không phải là thấp/);
    });
  }
  it("member LIMIT_EXCEEDED names the key cap", () => {
    assert.match(MEMBER_ERROR_TEXT.LIMIT_EXCEEDED.en, new RegExp(`${MAX_KEYS}`));
    assert.match(MEMBER_ERROR_TEXT.LIMIT_EXCEEDED.vi, new RegExp(`${MAX_KEYS}`));
  });
  it("the member error code set is closed at four codes", () => {
    assert.deepEqual(Object.keys(MEMBER_ERROR_TEXT).sort(), [...memberCodes].sort());
  });

  const codes: KdErrorCode[] = ["INVALID_TARGET", "NOT_FOUND", "NOT_A_DAO", "RPC_ERROR", "RATE_LIMITED", "LIMIT_EXCEEDED", "UNAUTHORIZED", "EXPIRED"];
  for (const code of codes) {
    it(`kd.error.v1 ${code}: non-empty vi and en, schema and retryable set`, () => {
      const e = fail(code).kd;
      assert.equal(e.schema_version, "kd.error.v1");
      assert.equal(e.code, code);
      nonEmpty(e.message.vi);
      nonEmpty(e.message.en);
      assert.equal(typeof e.retryable, "boolean");
      assert.doesNotMatch(e.message.en + e.message.vi, BAD);
    });
  }
  it("errors that mean 'could not read' say the risk is unknown, not low", () => {
    for (const code of ["RPC_ERROR", "RATE_LIMITED"] as const) {
      assert.match(fail(code).kd.message.en, /unknown, not low/);
      assert.match(fail(code).kd.message.vi, /không phải là thấp/);
    }
  });
  it("LIMIT_EXCEEDED texts name the cap values from thresholds.ts", () => {
    const base = fail("LIMIT_EXCEEDED").kd.message;
    for (const n of [MAX_KEYS, MAX_MEMBERS, MAX_ROLES]) {
      assert.match(base.en, new RegExp(`\\b${n}\\b`));
      assert.match(base.vi, new RegExp(`\\b${n}\\b`));
    }
    const by = (variant: "keys" | "members" | "roles") => fail("LIMIT_EXCEEDED", { variant }).kd.message;
    assert.match(by("keys").en, new RegExp(`\\b${MAX_KEYS}\\b`));
    assert.match(by("members").en, new RegExp(`\\b${MAX_MEMBERS}\\b`));
    assert.match(by("members").vi, new RegExp(`\\b${MAX_MEMBERS}\\b`));
    for (const lang of ["en", "vi"] as const) {
      assert.match(by("roles")[lang], new RegExp(`\\b${MAX_ROLES}\\b`));
      assert.match(by("roles")[lang], new RegExp(`\\b${MAX_GROUP_ENTRIES}\\b`));
      assert.notEqual(by("keys")[lang], by("members")[lang]);
    }
  });
});
