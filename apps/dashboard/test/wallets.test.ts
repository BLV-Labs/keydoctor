import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWalletId, walletLabel, WALLETS } from "../src/wallets.ts";

// Why: the ids are looked up in the wallet-selector, so a typo turns Revoke/Delete into a runtime throw.
describe("wallet list", () => {
  it("offers Meteor, Here and HOT under the wallet-selector module ids", () => {
    assert.deepEqual(WALLETS.map((w) => w.id), ["meteor-wallet", "here-wallet", "hot-wallet"]);
    assert.equal(walletLabel("hot-wallet"), "HOT Wallet");
  });

  it("accepts only listed ids, so a tampered data attribute cannot pick a module", () => {
    assert.equal(isWalletId("here-wallet"), true);
    assert.equal(isWalletId("evil-wallet"), false);
    assert.equal(isWalletId(undefined), false);
  });
});
