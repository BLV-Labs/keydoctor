import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bestSupply, parseRheaPool, supplyAprAfter, yearlyEarnings, type RheaPool } from "../src/index.ts";
import { fixture } from "./support/stub.ts";

// get_asset for USDC on the testnet Rhea Lend contract (block 276952485), after the demo DAO supplied 1,800,020 USDC.
const ASSET = fixture<Record<string, unknown> & { supply_apr: string; borrow_apr: string }>("yield/rhea-lend.usdc-asset.json");
const POOL = parseRheaPool(ASSET) as RheaPool;
const USDC = 10n ** 6n;
const OWN = 1_800_020_040_558n; // the DAO's supply, token raw units
/** The same pool before the DAO's deposits: the case the suggestion card faced. */
const BEFORE: RheaPool = { ...POOL, supplied: (BigInt(POOL.supplied) - OWN * 10n ** 12n).toString() };

describe("rate model", () => {
  it("reproduces the supply APR the contract reports, so a projection starts from the real rate", () => {
    assert.ok(POOL);
    const got = supplyAprAfter(POOL, 0n);
    const want = Number(ASSET.supply_apr);
    assert.ok(Math.abs(got - want) / want < 1e-6, `${got} vs ${want}`);
  });

  it("a deposit lowers the rate and a withdrawal raises it: borrowers pay the same interest over more or less money", () => {
    const now = supplyAprAfter(POOL, 0n);
    assert.ok(supplyAprAfter(POOL, 200_000n * USDC) < now);
    assert.ok(supplyAprAfter(POOL, -1_000_000n * USDC) > now);
  });

  it("before the deposits, the best amount was far below the 2M the DAO put in, and earned half as much again", () => {
    const max = 2_000_020n * USDC;
    const best = bestSupply(BEFORE, 0n, max, 6);
    assert.ok(best >= 400_000n * USDC && best <= 600_000n * USDC, String(best));
    assert.equal(best % (10_000n * USDC), 0n, "rounded to two significant whole tokens");
    // About 7.2k a year at the best amount against 4.6k for all of it (the rate falls from 10.6% to 0.2%).
    assert.ok(2n * yearlyEarnings(BEFORE, 0n, best) > 3n * yearlyEarnings(BEFORE, 0n, max));
  });

  it("returns 0 when the treasury is already past the best amount: more money would earn it less", () => {
    assert.equal(bestSupply(POOL, OWN, 200_000n * USDC, 6), 0n);
  });

  it("returns all of it when the pool is short of money, so the rate barely moves", () => {
    const tiny = 1_000n * USDC;
    assert.equal(bestSupply(BEFORE, 0n, tiny, 6), tiny);
  });

  it("returns all of it when nobody borrows: the rate is 0 whatever the amount", () => {
    const idle = { ...POOL, borrowed: "0" };
    assert.equal(supplyAprAfter(idle, 0n), 0);
    assert.equal(bestSupply(idle, 0n, 5_000n * USDC, 6), 5_000n * USDC);
  });

  it("refuses an asset without the rate config, so the page shows no projection rather than a wrong one", () => {
    const legacy = fixture<unknown[]>("yield/rhea-lend.assets.json")[1];
    assert.equal(parseRheaPool(legacy), null);
    assert.equal(parseRheaPool({ ...ASSET, config: { ...(ASSET.config as object), target_utilization: 10_000 } }), null);
    assert.equal(parseRheaPool(null), null);
  });
});
