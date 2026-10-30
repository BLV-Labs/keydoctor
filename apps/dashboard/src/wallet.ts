// Browser-only: signs DeleteKey transactions through Meteor Wallet (wallet-selector). Key Doctor never holds keys;
// the wallet shows the transaction and signs it. Sign-in carries no contractId, so no function-call key is added.
import { PublicKey } from "@near-js/crypto";
import { actionCreators, setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import type { Network } from "key-doctor";
import type { DeletePlan } from "./cleanup.ts";

/** Signs each transaction of an accepted plan in order. Throws if the wallet account is not `accountId`. */
export async function signDeleteKeys(accountId: string, network: Network, plan: DeletePlan): Promise<void> {
  const selector = await setupWalletSelector({ network, modules: [setupMeteorWallet()], allowMultipleSelectors: true });
  const wallet = await selector.wallet("meteor-wallet");
  const accounts = await wallet.signIn({ accounts: [] });
  if (!accounts.some((a) => a.accountId === accountId)) {
    await wallet.signOut();
    throw new Error(`Meteor signed in as ${accounts.map((a) => a.accountId).join(", ") || "no account"}, not ${accountId}.`);
  }
  for (const tx of plan.transactions) {
    await wallet.signAndSendTransaction({ signerId: accountId, receiverId: accountId, actions: tx.map((a) => actionCreators.deleteKey(PublicKey.from(a.public_key))) });
  }
  await wallet.signOut();
}
