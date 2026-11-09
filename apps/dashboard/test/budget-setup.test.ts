import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  budgetPolicy,
  parseRecipientLines,
  planBudget,
  recipientLines,
  setupErrorText,
  stepOfField,
  unfinishedBudgetOwner,
  validateSetupStep,
} from "../src/budget-create.ts";
import { renderAgentKeyReady, renderBudget, renderBudgetSetup, renderLeaveKey } from "../src/budget-view.ts";
import type { BudgetLive } from "../src/budget-read.ts";

const FACTORY = "keydoctor-guards-v2.testnet";
const GOOD: Record<string, string> = {
  name: "payroll",
  preset: "balanced",
  maxPerTx: "5",
  maxPerDay: "20",
  maxPendingPerAgent: "3",
  minReserve: "1",
  funding: "10",
  whitelist: "vendor.testnet, Vendor, 2",
  agentLabel: "Payroll bot",
};
const getter = (over: Record<string, string> = {}) => (name: string) => ({ ...GOOD, ...over })[name] ?? "";

/** The page as a newcomer reads it: Technical details excluded. */
const shown = (page: string) => page.replace(/<details class="card tech">[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");
const jargon = /\bDAO\b|\b[Pp]roposals?\b|\bGuard\b|[Pp]olicy|[Ww]hitelist|yocto/;

describe("wizard steps render their fields", () => {
  it("step 1: name, presets, starting balance; the other steps' answers ride along hidden", () => {
    const out = renderBudgetSetup(true, GOOD, [], null, 1).value;
    assert.match(out, /Build the fence/);
    assert.match(out, /name="name"/);
    assert.match(out, /data-preset="cautious"/);
    assert.match(out, /data-preset="custom"/);
    assert.match(out, /Starting balance \(NEAR\)/);
    assert.match(out, /type="hidden" name="agentLabel"/);
    assert.doesNotMatch(out, /name="r-account"/);
  });
  it("step 2: a row per recipient with account, name and limit, and Add recipient", () => {
    const out = renderBudgetSetup(true, GOOD, [], null, 2).value;
    assert.match(out, /name="r-account"[^>]*value="vendor\.testnet"/);
    assert.match(out, /name="r-label"[^>]*value="Vendor"/);
    assert.match(out, /name="r-cap"[^>]*value="2"/);
    assert.match(out, /data-action="budget-recipient-add"/);
    assert.match(out, /data-action="budget-recipient-remove"/);
  });
  it("step 3: the agent name and the It can / It cannot cards", () => {
    const out = renderBudgetSetup(true, GOOD, [], null, 3).value;
    assert.match(out, /name="agentLabel"/);
    assert.match(out, />It can</);
    assert.match(out, />It cannot</);
  });
  it("step 4: the review rows and the first-signature button", () => {
    const out = renderBudgetSetup(true, GOOD, [], null, 4).value;
    for (const row of ["Budget", "Starting balance", "Limits", "Recipients", "Agent", "One-time cost"]) assert.match(out, new RegExp(`<dt[^>]*>${row}</dt>`));
    assert.match(out, /What happens next/);
    assert.match(out, /Create budget · sign 1 of 2/);
    assert.match(out, /Payroll bot/);
  });
  it("steps 1 to 3 end in Continue; Back appears after step 1", () => {
    assert.match(renderBudgetSetup(true, GOOD, [], null, 1).value, />Continue</);
    assert.doesNotMatch(renderBudgetSetup(true, GOOD, [], null, 1).value, /budget-setup-back/);
    assert.match(renderBudgetSetup(true, GOOD, [], null, 2).value, /budget-setup-back/);
  });
  it("the stepper marks the current step", () => {
    assert.match(renderBudgetSetup(true, GOOD, [], null, 3).value, /data-state="now" aria-current="step"/);
  });
});

describe("wizard validation", () => {
  it("name too short is caught on step 1", () => {
    const errors = validateSetupStep(1, getter({ name: "ab" }), FACTORY);
    assert.ok(errors.some((e) => e.field === "name" && e.code === "NAME_TOO_SHORT"));
    assert.match(setupErrorText(errors[0]!), /\S/);
  });
  it("an empty name is caught", () => {
    assert.ok(validateSetupStep(1, getter({ name: "" }), FACTORY).some((e) => e.code === "NAME_EMPTY"));
  });
  it("per payment above per day is caught, in plain words", () => {
    const errors = validateSetupStep(1, getter({ maxPerTx: "30", maxPerDay: "20" }), FACTORY);
    const over = errors.find((e) => e.code === "PER_TX_OVER_DAILY");
    assert.ok(over);
    assert.equal(setupErrorText(over), "Per payment cannot be more than per day.");
  });
  it("a bad starting balance is caught", () => {
    assert.ok(validateSetupStep(1, getter({ funding: "abc" }), FACTORY).some((e) => e.field === "funding"));
    assert.ok(validateSetupStep(1, getter({ funding: "0.1" }), FACTORY).some((e) => e.field === "funding"));
  });
  it("good answers pass every step", () => {
    for (const step of [1, 2, 3] as const) assert.deepEqual(validateSetupStep(step, getter(), FACTORY), []);
  });
  it("a bad recipient account is a step 2 error and shows under its row", () => {
    const errors = validateSetupStep(2, getter({ whitelist: "NOT AN ACCOUNT" }), FACTORY);
    assert.ok(errors.length > 0);
    assert.ok(errors.every((e) => stepOfField(e.field) === 2));
    assert.match(renderBudgetSetup(true, { ...GOOD, whitelist: "NOT AN ACCOUNT" }, errors, null, 2).value, /aria-invalid="true"/);
  });
  it("no agent name is a step 3 error", () => {
    assert.ok(validateSetupStep(3, getter({ agentLabel: "" }), FACTORY).some((e) => e.field === "agentLabel"));
  });
  it("shows a fence error under the field and opens the custom fields", () => {
    const errors = validateSetupStep(1, getter({ maxPerTx: "30" }), FACTORY);
    const out = renderBudgetSetup(true, { ...GOOD, maxPerTx: "30" }, errors, null, 1).value;
    assert.match(out, /class="field-error"/);
    assert.doesNotMatch(out, /id="bs-custom" class="grid-2" hidden/);
  });
  it("a valid plan still comes out of planBudget unchanged", () => {
    assert.equal(planBudget(getter(), "owner.testnet", FACTORY, "0").ok, true);
  });
});

describe("recipient rows", () => {
  it("round trip rows to lines and back, dropping empty rows and commas in names", () => {
    const rows = [
      { account: "a.testnet", label: "A, Inc", cap: "2 NEAR" },
      { account: "", label: "", cap: "" },
      { account: "b.testnet", label: "", cap: "" },
      { account: "c.testnet", label: "", cap: "1" },
    ];
    const lines = recipientLines(rows);
    assert.equal(lines, "a.testnet, A Inc, 2\nb.testnet\nc.testnet, , 1");
    assert.deepEqual(parseRecipientLines(lines), [
      { account: "a.testnet", label: "A Inc", cap: "2" },
      { account: "b.testnet", label: "", cap: "" },
      { account: "c.testnet", label: "", cap: "1" },
    ]);
  });
  it("zero recipients is allowed", () => {
    assert.deepEqual(validateSetupStep(2, getter({ whitelist: "" }), FACTORY), []);
  });
});

describe("Agent key ready and the leave confirm", () => {
  const ready = { label: "Payroll bot", account: "a1.g.testnet", budget: "payroll", guardId: "g.testnet", dao: "d.sputnik-v2.testnet", network: "testnet" as const, problem: null };
  it("names the agent, the key scope, the three steps and Done", () => {
    const out = renderAgentKeyReady(ready).value;
    assert.match(out, /Payroll bot is ready/);
    assert.match(out, /can only ask payroll for payments/);
    assert.match(out, /Download the key/);
    assert.match(out, /Connect your agent/);
    assert.match(out, /Try it/);
    assert.match(out, /data-action="budget-key"/);
    assert.match(out, /data-action="budget-key-done"[^>]*>Done</);
    assert.match(out, /data-action="budget-connect-tab"/);
  });
  it("shows a problem when the chain does not show a finished budget", () => {
    assert.match(renderAgentKeyReady({ ...ready, problem: "the role is missing" }).value, /the role is missing/);
  });
  it("the leave confirm offers Download key and Leave anyway", () => {
    const out = renderLeaveKey("Payroll bot").value;
    assert.match(out, /data-action="budget-leave-download"[^>]*>Download key</);
    assert.match(out, /data-action="budget-leave-anyway"[^>]*>Leave anyway</);
  });
  it("none of the wizard, pop-ups or confirm names the machinery", () => {
    const pages = [1, 2, 3, 4].map((n) => renderBudgetSetup(true, GOOD, [], null, n).value);
    pages.push(renderAgentKeyReady(ready).value, renderLeaveKey("Payroll bot").value);
    for (const page of pages) assert.doesNotMatch(shown(page), jargon);
  });
});

describe("Setup not finished", () => {
  it("finds the owner of an account that sign 1 made and nothing else", () => {
    assert.equal(unfinishedBudgetOwner(budgetPolicy("owner.testnet")), "owner.testnet");
    const p = budgetPolicy("owner.testnet");
    assert.equal(unfinishedBudgetOwner({ ...p, roles: [...p.roles, { name: "agents", kind: { Group: ["a.testnet"] }, permissions: [], vote_policy: {} }] }), null);
    assert.equal(unfinishedBudgetOwner({ ...p, roles: [{ ...p.roles[0]!, name: "council" }] }), null);
  });
  const bare = (): BudgetLive =>
    ({ dao: { dao: "payroll.sputnik-v2.testnet", factory: FACTORY, code_storage: "0", policy: budgetPolicy("owner.testnet"), guards: [] }, guard: null }) as unknown as BudgetLive;
  it("offers Finish setup when the answers are saved, and a refill note when not", () => {
    const can = renderBudget(bare(), "testnet", "", Date.now(), { canFinish: true }).value;
    assert.match(can, /Setup not finished/);
    assert.match(can, /data-action="budget-finish-setup"[^>]*>Finish setup · sign 2 of 2</);
    const cannot = renderBudget(bare(), "testnet", "", Date.now(), { canFinish: false }).value;
    assert.match(cannot, /Setup not finished/);
    assert.doesNotMatch(cannot, /budget-finish-setup/);
  });
});
