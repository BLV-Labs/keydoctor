// Wallets the dashboard can ask to sign Revoke and Delete. Ids are the wallet-selector module ids.
// No SDK import here: the wallet dialog and the tests stay light, the SDKs load on demand in wallet.ts.
export const WALLETS = [
  { id: "meteor-wallet", label: "Meteor Wallet" },
  { id: "here-wallet", label: "Here Wallet" },
  { id: "hot-wallet", label: "HOT Wallet" },
] as const;

export type WalletId = (typeof WALLETS)[number]["id"];

export function isWalletId(value: unknown): value is WalletId {
  return WALLETS.some((w) => w.id === value);
}

export function walletLabel(id: WalletId): string {
  return WALLETS.find((w) => w.id === id)?.label ?? id;
}
