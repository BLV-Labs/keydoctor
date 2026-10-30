// Browser-only: signs DeleteKey transactions through Meteor, Here or HOT Wallet (wallet-selector). Key Doctor never holds keys;
// the wallet shows the transaction and signs it. Sign-in carries no contractId, so no function-call key is added.
import { PublicKey } from "@near-js/crypto";
import { actionCreators, setupWalletSelector } from "@near-wallet-selector/core";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import type { Network } from "key-doctor";
import type { DeletePlan } from "./cleanup.ts";
import { walletLabel, type WalletId } from "./wallets.ts";

function makeSelector(network: Network) {
  return setupWalletSelector({
    network,
    modules: [setupMeteorWallet(), setupHereWallet(), setupHotWallet()],
    allowMultipleSelectors: true,
  });
}

async function connect(network: Network, walletId: WalletId) {
  return (await makeSelector(network)).wallet(walletId);
}

/** Name and icon each wallet module declares, for the wallet dialog. */
export async function walletMetadata(network: Network): Promise<Record<string, { name: string; iconUrl: string }>> {
  const selector = await makeSelector(network);
  return Object.fromEntries(selector.store.getState().modules.map((m) => [m.id, { name: m.metadata.name, iconUrl: m.metadata.iconUrl }]));
}

/** Signs each transaction of an accepted plan in order. Throws if the wallet account is not `accountId`. */
export async function signDeleteKeys(
  accountId: string,
  network: Network,
  plan: DeletePlan,
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const label = walletLabel(walletId);
  onStep("Step 1/3: starting the wallet SDK…");
  const wallet = await connect(network, walletId);
  // Connect Wallet already stored the session; asking again opens a second popup and the sign popup after it gets blocked.
  let accounts = await wallet.getAccounts().catch(() => []);
  if (!accounts.some((a) => a.accountId === accountId)) {
    onStep(`Step 2/3: connect your account in ${label}.`);
    accounts = await wallet.signIn({ accounts: [] });
  }
  onStep(`Step 3/3: approve the Delete Key transaction in ${label}.`);
  if (!accounts.some((a) => a.accountId === accountId)) {
    await wallet.signOut();
    throw new Error(`${label} signed in as ${accounts.map((a) => a.accountId).join(", ") || "no account"}, not ${accountId}.`);
  }
  // The plural call opens the wallet's own approval window; the singular one signs with an app key we never ask for.
  await wallet.signAndSendTransactions({
    transactions: plan.transactions.map((tx) => ({
      signerId: accountId,
      receiverId: accountId,
      actions: tx.map((a) => actionCreators.deleteKey(PublicKey.from(a.public_key))),
    })),
  });
  // No signOut here: Meteor answers it with its own "Sign Out Request" popup. The session holds no access key.
}

/** Connects the chosen wallet (no contractId, so no key is added) and returns the account ids it holds. Reuses a stored session. */
export async function openWallet(network: Network, walletId: WalletId): Promise<string[]> {
  const wallet = await connect(network, walletId);
  let accounts = await wallet.getAccounts().catch(() => []);
  if (accounts.length === 0) accounts = await wallet.signIn({ accounts: [] });
  return accounts.map((a) => a.accountId);
}

/** Ends the wallet session so the next Connect Wallet asks again. */
export async function disconnectWallet(network: Network, walletId: WalletId): Promise<void> {
  await (await connect(network, walletId)).signOut();
}
