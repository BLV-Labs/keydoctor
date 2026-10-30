// Browser-only: signs DeleteKey transactions through Meteor Wallet (wallet-selector). Key Doctor never holds keys;
// the wallet shows the transaction and signs it. Sign-in carries no contractId, so no function-call key is added.
import { PublicKey } from "@near-js/crypto";
import { actionCreators, setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import type { Network } from "key-doctor";
import type { DeletePlan } from "./cleanup.ts";

/** Signs each transaction of an accepted plan in order. Throws if the wallet account is not `accountId`. */
export async function signDeleteKeys(
  accountId: string,
  network: Network,
  plan: DeletePlan,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  onStep("Step 1/3: starting the wallet SDK…");
  const selector = await setupWalletSelector({ network, modules: [setupMeteorWallet()], allowMultipleSelectors: true });
  const wallet = await selector.wallet("meteor-wallet");
  onStep("Step 2/3: connect your account in the Meteor window.");
  const accounts = await wallet.signIn({ accounts: [] });
  onStep("Step 3/3: approve the Delete Key transaction in the Meteor window.");
  if (!accounts.some((a) => a.accountId === accountId)) {
    await wallet.signOut();
    throw new Error(`Meteor signed in as ${accounts.map((a) => a.accountId).join(", ") || "no account"}, not ${accountId}.`);
  }
  // The plural call opens Meteor's own approval window; the singular one signs with an app key we never ask for.
  await wallet.signAndSendTransactions({
    transactions: plan.transactions.map((tx) => ({
      signerId: accountId,
      receiverId: accountId,
      actions: tx.map((a) => actionCreators.deleteKey(PublicKey.from(a.public_key))),
    })),
  });
  await wallet.signOut();
}

/** Opens the installed Meteor extension with a read-only connect request (no contractId, so no key is added). */
export async function openWallet(network: Network): Promise<void> {
  const selector = await setupWalletSelector({ network, modules: [setupMeteorWallet()], allowMultipleSelectors: true });
  const wallet = await selector.wallet("meteor-wallet");
  await wallet.signIn({ accounts: [] });
  await wallet.signOut();
}
