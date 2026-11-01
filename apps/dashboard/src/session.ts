// Display state only: who the viewer says they are, remembered per network. Signing still checks the real account in the wallet.
import type { Network } from "key-doctor";
import { html, type Html } from "./html.ts";
import { routeHref } from "./route.ts";
import { isWalletId, type WalletId } from "./wallets.ts";

export type Role = "visitor" | "other" | "owner";
export type Connected = { walletId: WalletId; accounts: string[] };

/** visitor = no wallet connected; other = connected, but not as `target`; owner = the wallet holds `target`. */
export function viewerRole(accounts: string[] | null, target: string): Role {
  if (accounts === null) return "visitor";
  return accounts.includes(target) ? "owner" : "other";
}

const storageKey = (network: Network): string => `kd.wallet.${network}`;

export function connectedAccount(network: Network): Connected | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey(network)) ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const { walletId, accounts } = raw as { walletId?: unknown; accounts?: unknown };
    if (!isWalletId(walletId) || !Array.isArray(accounts) || !accounts.every((a) => typeof a === "string")) return null;
    return { walletId, accounts: accounts as string[] };
  } catch {
    return null;
  }
}

export function rememberConnected(network: Network, c: Connected): void {
  try {
    localStorage.setItem(storageKey(network), JSON.stringify({ walletId: c.walletId, accounts: c.accounts }));
  } catch {
    // Not remembered across visits; this page still works.
  }
}

export function forgetConnected(network: Network): void {
  try {
    localStorage.removeItem(storageKey(network));
  } catch {
    // Nothing stored that we could remove.
  }
}

/** What a click on a locked Revoke/Delete explains, and which button fixes it. */
export function lockedNotice(role: Role, id: string, accounts: string[] | null): { text: string; action: "connect" | "switch" } {
  return role === "other"
    ? { text: `Connected as ${(accounts ?? []).join(", ") || "another account"}, not ${id}.`, action: "switch" }
    : { text: `Only the owner can remove keys. Connect your wallet as ${id} to unlock this.`, action: "connect" };
}

/** The line above the key list: who is connected and what that unlocks. app.ts swaps it when the wallet changes. */
export function walletBar(role: Role, id: string, accounts: string[] | null, network: Network): Html {
  if (role === "owner") {
    return html`<p class="small wallet-bar" data-wallet-bar>✓ Connected as <span class="mono">${id}</span>. Revoke and Delete open your wallet for your approval.</p>`;
  }
  if (role === "other") {
    const mine = accounts?.[0];
    return html`<div class="actions wallet-bar" data-wallet-bar>
      <p class="small">Connected as <span class="mono">${(accounts ?? []).join(", ")}</span>, not the owner of <span class="mono">${id}</span>.</p>
      ${mine === undefined ? "" : html`<a class="btn btn-secondary" href="${routeHref(mine, null, network)}" data-nav>Open my keys</a>`}
      <button type="button" class="btn btn-tint" data-action="switch-account">Switch account</button>
    </div>`;
  }
  return html`<div class="actions wallet-bar" data-wallet-bar>
    <p class="small">Do you own <span class="mono">${id}</span>? Connect your wallet to revoke or delete its keys.</p>
    <button type="button" class="btn btn-tint" data-action="open-wallet">Connect Wallet</button>
  </div>`;
}
