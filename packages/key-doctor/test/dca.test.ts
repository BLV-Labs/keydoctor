import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetAlerts, dcaPrice, formatUnits, type BudgetAlertInput, type Plan, type PlanRequest, type PlanStepRecord } from "../src/index.ts";
import { planCompletedText, planSkippedText, planStepText } from "../src/messages.ts";

const NEAR = 10n ** 24n;
const TENTH = (NEAR / 10n).toString(); // 0.1 NEAR per run
const SWAP = { type: "swap", pool_id: 57, token_out: "usdt.fakes.testnet", max_slippage_bps: 100 } as const;

describe("GD31 formatUnits / dcaPrice: exact bigint, never a float", () => {
  it("896500 with 6 decimals is 0.8965; whole, zero and non-numeric are not mangled", () => {
    assert.equal(formatUnits("896500", 6), "0.8965");
    assert.equal(formatUnits("1000000", 6), "1");
    assert.equal(formatUnits("5", 6), "0.000005");
    assert.equal(formatUnits("0", 6), "0");
    assert.equal(formatUnits("1.5", 6), "?");
    assert.equal(formatUnits("-1", 6), "?");
  });

  it("keeps every digit beyond 2^53: a Number() implementation would round this", () => {
    // WHY: token amounts are bigint strings; a float step would show a wrong amount of money.
    assert.equal(formatUnits("123456789012345678901234567890", 6), "123456789012345678901234.56789");
    assert.equal(formatUnits("9007199254740993", 6), "9007199254.740993");
  });

  it("0.1 NEAR sold for 0.8965 USDT is a price of 8.965 USDT per NEAR", () => {
    assert.equal(dcaPrice(TENTH, "896500"), "8.965");
  });

  it("the price is per whole NEAR, so it scales with amount_in (wrong unit would give 0.8965)", () => {
    assert.equal(dcaPrice(NEAR.toString(), "8965000"), "8.965");
    assert.equal(dcaPrice((NEAR * 3n).toString(), "26895000"), "8.965");
  });

  it("truncates at the token's 6 decimals with a remainder (1/3 NEAR for 1 unit)", () => {
    // 1 raw unit per 3 NEAR = 0.333333 raw per NEAR -> floors to 0 raw -> "0".
    assert.equal(dcaPrice((NEAR * 3n).toString(), "1"), "0");
    assert.equal(dcaPrice((NEAR * 3n).toString(), "10"), "0.000003");
  });

  it("no price from a zero or non-numeric input rather than a Division by zero or NaN", () => {
    assert.equal(dcaPrice("0", "896500"), null);
    assert.equal(dcaPrice(TENTH, "x"), null);
    assert.equal(dcaPrice("1e23", "896500"), null);
  });

  it("large values keep full precision", () => {
    const big = (10n ** 30n).toString(); // 10^6 NEAR
    assert.equal(dcaPrice(big, "8965000000000"), "8.965");
  });
});

describe("GD31 swap messages (S3)", () => {
  const step = (swap?: Parameters<typeof planStepText>[7]) => planStepText("dca-near", SWAP, TENTH, 1, 3, TENTH, null, swap);

  it("tells what was sold and what came back, in both languages, with the average and the total", () => {
    const t = step({ amount_out: "896500", price: "8.965", received: "896500", avg_price: "8.965" });
    assert.match(t.en.body, /^Sold 0\.1 NEAR for 0\.8965 USDT · price 8\.965\n/);
    assert.match(t.en.body, /Average price: 8\.965 · Received in total: 0\.8965 USDT/);
    assert.match(t.vi.body, /^Đã bán 0\.1 NEAR lấy 0\.8965 USDT · giá 8\.965\n/);
    assert.match(t.vi.body, /Giá bán trung bình: 8\.965 · Đã nhận tổng: 0\.8965 USDT/);
  });

  it("without amount_out the text states no number it does not know (never a guessed 0 USDT)", () => {
    const t = step();
    assert.equal(t.en.body.split("\n")[0], "Sold 0.1 NEAR for USDT.");
    assert.equal(t.vi.body.split("\n")[0], "Đã bán 0.1 NEAR lấy USDT.");
    assert.doesNotMatch(t.en.body, /USDT.*\d|price|Average|Received/);
    // falls back to the NEAR sold, which the plan does know
    assert.match(t.en.body, /Total sold: 0\.1 NEAR/);
    assert.match(t.vi.body, /Tổng đã bán: 0\.1 NEAR/);
  });

  it("has no NEAR-balance line: the owner's balance is not the keeper's to report", () => {
    const t = step({ amount_out: "896500", price: "8.965", received: "896500", avg_price: "8.965" });
    assert.doesNotMatch(t.en.body + t.vi.body, /balance|số dư/i);
    assert.doesNotMatch(t.en.body, /Total spent/);
  });

  it("the completed message carries the same swap figures plus the plan summary", () => {
    const t = planCompletedText("dca-near", SWAP, TENTH, 3, (NEAR * 3n / 10n).toString(), { amount_out: "900000", price: "9", received: "2700000", avg_price: "9" });
    assert.match(t.en.body, /Sold 0\.1 NEAR for 0\.9 USDT/);
    assert.match(t.en.body, /Received in total: 2\.7 USDT/);
    assert.match(t.en.body, /Plan complete: 3\/3 runs, 0\.3 NEAR spent in total\./);
  });

  for (const reason of ["SLIPPAGE", "SWAP_FAILED"]) {
    it(`a ${reason} skip says the NEAR stays as wrapped NEAR, not "no money moved" (ADR 0007)`, () => {
      const t = planSkippedText("dca-near", 1, 3, reason, null, TENTH);
      assert.match(t.en.body, /0\.1 NEAR stays in your Budget as wrapped NEAR\./);
      assert.match(t.vi.body, /0\.1 NEAR vẫn ở trong Budget \(dạng wrapped NEAR\)\./);
      assert.doesNotMatch(t.en.body, /No money moved/);
      assert.doesNotMatch(t.vi.body, /Không có tiền nào được chi/);
    });
  }

  it("SLIPPAGE and SWAP_FAILED give different reasons", () => {
    assert.match(planSkippedText("dca-near", 1, 3, "SLIPPAGE", null, TENTH).en.body, /price moved more than you allow/);
    assert.match(planSkippedText("dca-near", 1, 3, "SWAP_FAILED", null, TENTH).en.body, /exchange refused the swap/);
  });

  it("other skips keep 'No money moved' (OVER_DAILY_LIMIT is a Guard skip, nothing was sold)", () => {
    assert.match(planSkippedText("dca-near", 1, 3, "OVER_DAILY_LIMIT", null, TENTH).en.body, /over the 24 h limit\. No money moved\./);
  });
});

describe("GD31 budgetAlerts for a swap plan (S3)", () => {
  const T0 = 1_793_000_000_000_000_000n;
  const HOUR = 3_600_000_000_000n;
  const slot = (n: number) => (T0 + BigInt(n) * HOUR).toString();
  const plan = (over: Partial<Plan> = {}): Plan => ({
    plan_id: 0,
    action: SWAP,
    strategy_id: "dca-near",
    token_in: "",
    amount_per_run: TENTH,
    interval_sec: 3600,
    runs_total: 3,
    runs_done: 2,
    start_at: slot(0),
    next_run_at: slot(2),
    status: "active",
    pause_reason: null,
    ...over,
  });
  const request = (run: number): PlanRequest => ({ request_id: `plan-0-${slot(run - 1)}`, memo: `plan 0 run ${run}`, proposal_id: run + 10, status: "AutoApproved", plan_id: 0, updated_at: slot(run - 1) });
  const row = (run: number, over: Partial<PlanStepRecord> = {}): PlanStepRecord => ({
    plan_id: 0,
    run,
    status: "executed",
    amount_in: TENTH,
    tx_hash: `hash${run}`,
    executed_at: "2026-11-06T00:00:00.000Z",
    due: slot(run - 1),
    ...over,
  });
  const alerts = (over: Partial<BudgetAlertInput>) =>
    budgetAlerts({ network: "testnet", budget: { dao_id: "d.sputnik-v2.testnet", guard_id: "g.testnet" }, plans: [plan()], requests: [], steps: [], now: "2026-11-06T00:00:00.000Z", ...over });

  it("totals.received and avg_price sum the executed runs; run 2 shows its own amount and a running average", () => {
    const got = alerts({
      requests: [request(2), request(1)],
      steps: [row(1, { amount_out: "896500", price: "8.965" }), row(2, { amount_out: "1000000", price: "10" })],
    });
    assert.equal(got.length, 2);
    assert.deepEqual(got[0]!.totals, { spent: TENTH, received: "896500", avg_price: "8.965" });
    // run 2: 1896500 raw for 0.2 NEAR = 9.4825 per NEAR
    assert.deepEqual(got[1]!.totals, { spent: (NEAR / 5n).toString(), received: "1896500", avg_price: "9.4825" });
    assert.match(got[1]!.messages.en.body, /^Sold 0\.1 NEAR for 1 USDT · price 10\n/);
    assert.match(got[1]!.messages.en.body, /Average price: 9\.4825 · Received in total: 1\.8965 USDT/);
  });

  it("the average ignores a run with no amount_out (the keeper missed its receipt), in NEAR and in USDT", () => {
    // WHY: dividing 0.8965 USDT by 0.2 NEAR would understate the price at 4.4825.
    const got = alerts({ requests: [request(2), request(1)], steps: [row(1), row(2, { amount_out: "896500", price: "8.965" })] });
    assert.equal(got[0]!.totals!.received, null);
    assert.equal(got[0]!.totals!.avg_price, null);
    assert.equal(got[1]!.totals!.received, "896500");
    assert.equal(got[1]!.totals!.avg_price, "8.965");
  });

  it("a run the chain shows but the keeper never saw has null figures and no number in the text", () => {
    const [a] = alerts({ requests: [request(1)] });
    assert.deepEqual(a!.totals, { spent: TENTH, received: null, avg_price: null });
    assert.match(a!.messages.en.body, /^Sold 0\.1 NEAR for USDT\.\nTotal sold: 0\.1 NEAR/);
  });

  it("a plan of another id or a skipped run does not leak into this plan's totals", () => {
    const got = alerts({
      requests: [request(2)],
      steps: [row(1, { amount_out: "999999999" , plan_id: 7 }), row(1, { status: "skipped", reason: "SLIPPAGE", amount_out: "5" }), row(2, { amount_out: "896500" })],
    });
    assert.equal(got.length, 2);
    const done = got.find((a) => a.kind === "plan_step_executed")!;
    assert.equal(done.totals!.received, "896500");
  });

  it("a skipped step for a due gives exactly ONE message, the skip, not a second 'done' (the vote still passed)", () => {
    const got = alerts({ plans: [plan({ runs_done: 1 })], requests: [request(1)], steps: [row(1, { status: "skipped", reason: "SLIPPAGE" })] });
    assert.equal(got.length, 1);
    assert.equal(got[0]!.kind, "plan_step_skipped");
    assert.match(got[0]!.messages.en.body, /stays in your Budget as wrapped NEAR/);
  });

  it("without the skip row the same request is a done message: the skip is what suppresses it", () => {
    const got = alerts({ plans: [plan({ runs_done: 1 })], requests: [request(1)], steps: [] });
    assert.deepEqual(got.map((a) => a.kind), ["plan_step_executed"]);
  });

  it("the skip only hides its own due: the next run's done message still goes out", () => {
    const got = alerts({ requests: [request(2), request(1)], steps: [row(1, { status: "skipped", reason: "SWAP_FAILED" }), row(2, { amount_out: "896500" })] });
    assert.deepEqual(got.map((a) => a.kind).sort(), ["plan_step_executed", "plan_step_skipped"]);
  });

  it("the last run is one plan_completed message with the received total", () => {
    const got = alerts({
      plans: [plan({ runs_done: 3, status: "completed", next_run_at: null })],
      requests: [request(3), request(2), request(1)],
      steps: [1, 2, 3].map((n) => row(n, { amount_out: "896500" })),
    });
    assert.deepEqual(got.map((a) => a.kind), ["plan_step_executed", "plan_step_executed", "plan_completed"]);
    assert.equal(got[2]!.totals!.received, "2689500");
    assert.match(got[2]!.messages.en.body, /Received in total: 2\.6895 USDT/);
  });

  it("a non-swap plan keeps null received/avg_price and 'Total spent'", () => {
    const [a] = alerts({ plans: [plan({ action: { type: "transfer", receiver_id: "bob.kd-demo.testnet" }, strategy_id: "scheduled-payouts" })], requests: [request(1)] });
    assert.equal(a!.totals!.received, null);
    assert.equal(a!.totals!.avg_price, null);
    assert.match(a!.messages.en.body, /Total spent: 0\.1 NEAR/);
  });
});
