// Browser-only: signs DeleteKey, DAO add_proposal and guardian pause transactions through Meteor, Here or HOT Wallet (wallet-selector). Key Doctor never holds keys;
// the wallet shows the transaction and signs it. Sign-in carries no contractId, so no function-call key is added.
import { KeyPair, PublicKey } from "@near-js/crypto";
import { actionCreators, setupWalletSelector } from "@near-wallet-selector/core";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import type { Network } from "key-doctor";
import { outcomeFailed } from "./budget-flow.ts";
import type { DeletePlan } from "./cleanup.ts";
import type { BudgetCall } from "./budget-create.ts";
import type { AddProposalArgs } from "./guard-proposals.ts";
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

/** The wallet holding `accountId`, connecting it first if needed (steps 1–2 of 3). Throws if the wallet holds another account. */
async function walletFor(accountId: string, network: Network, walletId: WalletId, onStep: (text: string) => void) {
  const label = walletLabel(walletId);
  onStep("Step 1/3: starting the wallet SDK…");
  const wallet = await connect(network, walletId);
  // Connect Wallet already stored the session; asking again opens a second popup and the sign popup after it gets blocked.
  let accounts = await wallet.getAccounts().catch(() => []);
  if (!accounts.some((a) => a.accountId === accountId)) {
    onStep(`Step 2/3: connect your account in ${label}.`);
    accounts = await wallet.signIn({ accounts: [] });
  }
  if (!accounts.some((a) => a.accountId === accountId)) {
    // No signOut: Meteor answers it with its own "Sign Out Request" popup that nobody approves, so the promise never settles.
    throw new Error(`${label} is connected as ${accounts.map((a) => a.accountId).join(", ") || "no account"}, not ${accountId}. Switch account in ${label} and try again.`);
  }
  return wallet;
}

/** Signs each transaction of an accepted plan in order. Throws if the wallet account is not `accountId`. */
export async function signDeleteKeys(
  accountId: string,
  network: Network,
  plan: DeletePlan,
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve the Delete Key transaction in ${walletLabel(walletId)}.`);
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

/** 140 Tgas per `add_proposal`: two fit in one 300 Tgas transaction, so P1 and P2 land together or not at all. */
const ADD_PROPOSAL_GAS = 140_000_000_000_000n;

/** Signs one transaction to the DAO with one `add_proposal` per proposal, each attaching the DAO's proposal bond. */
export async function signAddProposals(
  accountId: string,
  network: Network,
  dao: string,
  bond: string,
  proposals: AddProposalArgs[],
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve the add_proposal transaction in ${walletLabel(walletId)}.`);
  await wallet.signAndSendTransactions({
    transactions: [
      {
        signerId: accountId,
        receiverId: dao,
        actions: proposals.map((p) => actionCreators.functionCall("add_proposal", p, ADD_PROPOSAL_GAS, BigInt(bond))),
      },
    ],
  });
}

/**
 * Sign 1 of an Agent Budget owner action: one `add_proposal`. Returns what the wallet returned (the transaction
 * outcome when it gives one) so the page can read the proposal id from it; a wallet that returns nothing gives none.
 */
export async function signAddProposalOutcome(
  accountId: string,
  network: Network,
  dao: string,
  bond: string,
  proposal: AddProposalArgs,
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<unknown> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve the add_proposal transaction in ${walletLabel(walletId)}.`);
  return wallet.signAndSendTransactions({
    transactions: [{ signerId: accountId, receiverId: dao, actions: [actionCreators.functionCall("add_proposal", proposal, ADD_PROPOSAL_GAS, BigInt(bond))] }],
  });
}

/** `act_proposal` runs the proposal in the same transaction, and a Guard `create` alone takes 220 Tgas: give it all. */
const ACT_PROPOSAL_GAS = 300_000_000_000_000n;

/** Approve or reject one DAO proposal: `act_proposal(id, action, proposal)`, always with `proposal`. */
export async function signActProposal(
  accountId: string,
  network: Network,
  dao: string,
  args: { id: number; action: "VoteApprove" | "VoteReject"; proposal: Record<string, unknown> },
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve the ${args.action === "VoteApprove" ? "approval" : "rejection"} of proposal ${args.id} in ${walletLabel(walletId)}.`);
  const outcome: unknown = await wallet.signAndSendTransactions({
    transactions: [{ signerId: accountId, receiverId: dao, actions: [actionCreators.functionCall("act_proposal", args, ACT_PROPOSAL_GAS, 0n)] }],
  });
  if (outcomeFailed(outcome)) throw new Error(`The transaction for proposal ${args.id} failed on the chain.`);
}

/** Top up: a plain NEAR transfer from the owner's account to the DAO. */
export async function signTopUp(
  accountId: string,
  network: Network,
  dao: string,
  yocto: string,
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve the transfer in ${walletLabel(walletId)}.`);
  await wallet.signAndSendTransactions({
    transactions: [{ signerId: accountId, receiverId: dao, actions: [actionCreators.transfer(BigInt(yocto))] }],
  });
}

/** Sputnik's `create` deploys the DAO and passes the rest of the gas on; what it leaves is refunded. */
const BUDGET_DAO_GAS = 300_000_000_000_000n;

/** Sign 1 of a new Budget: one `create` on the Sputnik factory. */
export async function signBudgetDao(
  accountId: string,
  network: Network,
  factory: string,
  args: { name: string; args: string },
  depositYocto: string,
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve creating the DAO in ${walletLabel(walletId)}.`);
  const outcome: unknown = await wallet.signAndSendTransactions({
    transactions: [{ signerId: accountId, receiverId: factory, actions: [actionCreators.functionCall("create", args, BUDGET_DAO_GAS, BigInt(depositYocto))] }],
  });
  if (outcomeFailed(outcome)) throw new Error("The transaction that creates the DAO failed on the chain.");
}

/** Sign 2 of a new Budget: its four calls as one transaction, so the wallet shows one approval. */
export async function signBudgetCalls(
  accountId: string,
  network: Network,
  dao: string,
  calls: BudgetCall[],
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve the transaction of ${calls.length} calls in ${walletLabel(walletId)}.`);
  const outcome: unknown = await wallet.signAndSendTransactions({
    transactions: [{ signerId: accountId, receiverId: dao, actions: calls.map((c) => actionCreators.functionCall(c.method, c.args, c.gas, c.deposit)) }],
  });
  if (outcomeFailed(outcome)) throw new Error("The transaction that creates the Guard failed on the chain.");
}

/** The agent's key pair, made in this browser. The private half goes only into the file the owner downloads. */
export function newAgentKey(): { publicKey: string; privateKey: string } {
  const pair = KeyPair.fromRandom("ed25519");
  return { publicKey: pair.getPublicKey().toString(), privateKey: pair.toString() };
}

/** `pause` only flips a flag; 30 Tgas leaves room to spare. */
const PAUSE_GAS = 30_000_000_000_000n;

/** A guardian's emergency stop: one direct `pause` call on the Guard, no deposit, no DAO vote. */
export async function signGuardPause(
  accountId: string,
  network: Network,
  guardId: string,
  walletId: WalletId,
  onStep: (text: string) => void = () => {},
): Promise<void> {
  const wallet = await walletFor(accountId, network, walletId, onStep);
  onStep(`Step 3/3: approve the pause transaction in ${walletLabel(walletId)}.`);
  await wallet.signAndSendTransactions({
    transactions: [{ signerId: accountId, receiverId: guardId, actions: [actionCreators.functionCall("pause", {}, PAUSE_GAS, 0n)] }],
  });
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
