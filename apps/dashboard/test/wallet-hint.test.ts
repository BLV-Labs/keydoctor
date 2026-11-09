import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { whenSlow } from "../src/wallet-hint.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("whenSlow", () => {
  it("says nothing when the wallet answers in time, and passes the answer through", async () => {
    let slow = 0;
    const out = await whenSlow(wait(5).then(() => "signed"), 50, () => {
      slow++;
    });
    assert.equal(out, "signed");
    assert.equal(slow, 0);
  });

  it("shows the hint once a silent wallet passes the limit, and clears it when the wallet answers", async () => {
    // WHY: a wallet extension restarted under an open tab never answers; the owner saw a dead Withdraw button.
    const events: string[] = [];
    const out = await whenSlow(wait(40).then(() => "late"), 10, () => {
      events.push("shown");
      return () => events.push("cleared");
    });
    assert.equal(out, "late");
    assert.deepEqual(events, ["shown", "cleared"]);
  });

  it("keeps the wallet's error and still clears the hint", async () => {
    const events: string[] = [];
    await assert.rejects(
      whenSlow(wait(30).then(() => Promise.reject(new Error("User rejected"))), 5, () => () => events.push("cleared")),
      /User rejected/,
    );
    assert.deepEqual(events, ["cleared"]);
  });
});
