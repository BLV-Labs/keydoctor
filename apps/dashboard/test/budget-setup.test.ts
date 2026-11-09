import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAutoFunding,
  budgetPolicy,
  createCost,
  fundingMinYocto,
  parseRecipientLines,
  planBudget,
  recipientLines,
  setupErrorText,
  stepOfField,
  unfinishedBudgetOwner,
  validateSetupStep,
} from "../src/budget-create.ts";
import { BALANCED_RULES, CAUTIOUS_RULES, renderAgentKeyReady, renderBudget, renderBudgetSetup, renderLeaveKey, setupCostText } from "../src/budget-view.ts";
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
  it("step 1: name, presets, the fee set-aside under Advanced; the other steps' answers ride along hidden", () => {
    const out = renderBudgetSetup(true, GOOD, [], null, 1).value;
    assert.match(out, /Build the fence/);
    assert.match(out, /name="name"/);
    assert.match(out, /data-preset="cautious"/);
    assert.match(out, /data-preset="custom"/);
    assert.match(out, /<details id="bs-advanced" class="setup-advanced"><summary/);
    assert.match(out, /Set aside for fees \(NEAR\)/);
    assert.doesNotMatch(out, /Starting balance|Kept in reserve/);
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
    for (const row of ["Budget", "Set aside for fees", "Limits", "Recipients", "Agent", "One-time cost"]) assert.match(out, new RegExp(`<dt[^>]*>${row}</dt>`));
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

describe("step 1 explains every number and fills in the fees", () => {
  // WHY: the owner could not tell what to type, and "Starting balance" and "Kept in reserve" were not budget money.
  it("every rule field has a line under it that says what it is", () => {
    const out = renderBudgetSetup(true, { ...GOOD, preset: "custom" }, [], null, 1).value;
    for (const name of ["maxPerTx", "maxPerDay", "maxPendingPerAgent", "funding", "minReserve"]) assert.match(out, new RegExp(`id="bs-${name}-hint"`));
    assert.match(out, /Not spending money/);
    assert.match(out, /never budget money/);
  });
  it("presets keep no reserve, set no fee amount, and name every number", () => {
    for (const r of [BALANCED_RULES, CAUTIOUS_RULES]) {
      assert.equal(r.minReserve, "0");
      assert.equal(r.funding, undefined);
    }
    assert.match(renderBudgetSetup(true, {}, [], null, 1).value, /1 NEAR per payment · 5 NEAR a day · 2 can wait for you/);
  });
  it("the fee set-aside follows the rules until the owner types their own", () => {
    // 3 waiting × 0.1 + 0.5 agent fees + 0 reserve + 0.5 contract floor.
    assert.equal(fundingMinYocto("3", "0"), 13n * 10n ** 23n);
    assert.equal(applyAutoFunding({ maxPendingPerAgent: "3", minReserve: "0", funding: "0.1" }).funding, "1.3");
    assert.equal(applyAutoFunding({ maxPendingPerAgent: "3", minReserve: "0", funding: "4", fundingAuto: "0" }).funding, "4");
    const out = renderBudgetSetup(true, { ...GOOD, minReserve: "0", funding: "0.1" }, [], null, 1).value;
    assert.match(out, /name="funding"[^>]*value="1\.3"|value="1\.3"[^>]*name="funding"/);
    assert.match(out, /name="fundingAuto" value="1"/);
    assert.match(renderBudgetSetup(true, { ...GOOD, fundingAuto: "0" }, [], null, 1).value, /<details id="bs-advanced" class="setup-advanced" open>/);
  });
  it("a fee set-aside below the minimum names the number", () => {
    const e = validateSetupStep(1, getter({ funding: "0.6", minReserve: "0", fundingAuto: "0" }), FACTORY).find((x) => x.field === "funding");
    assert.ok(e);
    assert.match(setupErrorText(e), /^Set aside at least 1\.3 NEAR for these rules/);
  });
  it("the cost line counts the account, the contract code and the fees, and says so when the code cost is unread", () => {
    const code = "3334590000000000000000000";
    const cost = createCost("1.3", code);
    assert.ok(cost);
    assert.equal(cost.total, (6n * 10n ** 24n + BigInt(code) + 10n ** 22n + 13n * 10n ** 23n).toString());
    assert.match(setupCostText({ funding: "1.3" }, code), /^Creating this budget costs about 10\.64459 NEAR in signature 1: 6 NEAR for the budget account's storage, 3\.34459 NEAR for the spending contract and 1\.3 NEAR set aside for fees\./);
    assert.match(setupCostText({ funding: "1.3" }, null), /exact amount shows once it is read/);
    assert.match(renderBudgetSetup(true, GOOD, [], null, 4, code).value, /About 1\d\.\d+ NEAR in signature 1/);
    assert.match(renderBudgetSetup(true, GOOD, [], null, 4, null).value, /Not read from the chain yet/);
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
