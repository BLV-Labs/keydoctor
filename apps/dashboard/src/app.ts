// Browser entry: routing, scanning and DOM events. Rendering lives in pure modules that tests run in Node.
import { isKdError, listProposals, scanAccount, scanTarget, type KdError, type KdReport, type ListProposalsResult, type Network } from "key-doctor";
import { revealClampToggles, toggleClamp } from "./clamp.ts";
import type { Html } from "./html.ts";
import { renderError, renderHome, renderLayout, renderScanning } from "./pages.ts";
import { buildDeletePlan, GUARD_TEXT, METEOR_INSTALL_URL, type DeletePlan } from "./cleanup.ts";
import { renderCleanup } from "./cleanup-view.ts";
import { PAGE_SIZE, pageOf, parsePaging, type Paging } from "./paging.ts";
import { renderKeyDetail } from "./key-detail.ts";
import { PROPOSALS_ID, PROPOSALS_LIST, renderProposals } from "./proposals-view.ts";
import { renderAccount, renderCouncil } from "./report.ts";
import { homeHref, parseRoute, resolveInput, routeHref, type Route } from "./route.ts";
import { renderWatchDialog, renderWatchLinks } from "./watch.ts";
import { isWalletId, walletLabel, type WalletId } from "./wallets.ts";

declare const __KD_WORKER_URL__: string;
/** Set at build time (KD_WORKER_URL); empty means the MVP dialog with no Worker call. */
const WORKER_URL = typeof __KD_WORKER_URL__ === "string" ? __KD_WORKER_URL__.replace(/\/+$/, "") : "";

const root = document.getElementById("app") as HTMLElement;
let scanSeq = 0;
let dialogTrigger: HTMLElement | null = null;
let lastReport: KdReport | null = null;
/** What the last scan was for: a page change on the same report re-renders from it instead of rescanning. */
let lastScanKey = "";
/** Proposal pages already read for the last scan, by page number (null = the read failed). */
const proposalPages = new Map<number, ListProposalsResult | null>();

const NETWORK_KEY = "kd.network";

/** The home switch's last choice. Storage can be blocked; testnet (the demo network) is the fallback. */
function storedNetwork(): Network {
  try {
    return localStorage.getItem(NETWORK_KEY) === "mainnet" ? "mainnet" : "testnet";
  } catch {
    return "testnet";
  }
}

function storeNetwork(network: Network): void {
  try {
    localStorage.setItem(NETWORK_KEY, network);
  } catch {
    // Not remembered across visits; the URL still carries it.
  }
}

const UNKNOWN_ERROR: KdError = {
  schema_version: "kd.error.v1",
  code: "RPC_ERROR",
  message: { vi: "", en: "Could not read chain data right now. The risk is unknown, not low." },
  retryable: true,
};

const THEME_KEY = "kd.theme";
type Theme = "light" | "dark";

const currentTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** Applies a theme; `save` remembers it, otherwise the page keeps following the system setting. */
function setTheme(theme: Theme, save: boolean): void {
  document.documentElement.dataset.theme = theme;
  if (save) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not remembered across visits; this page still switches.
    }
  }
  document.querySelector(".theme-toggle")?.setAttribute("aria-pressed", String(theme === "dark"));
}

function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

// Follow the system setting until the user picks a theme with the header switch.
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (savedTheme() === null) setTheme(e.matches ? "dark" : "light", false);
});

function paint(content: Html, title: string, focusMain: boolean, network: Network): void {
  root.innerHTML = renderLayout(content, network).value;
  setTheme(currentTheme(), false);
  document.title = title;
  syncWallet();
  revealClampToggles(root);
  if (focusMain) document.getElementById("main")?.focus();
}

const scanKey = (route: Route): string => [route.target, route.from, route.view, route.level, route.network].join("|");

/** A council member and a cleanup plan are always accounts; anything else goes through scanTarget (DAO first). */
function scan(route: Route & { target: string; network: Network }): Promise<KdReport> {
  const opts = { network: route.network };
  return route.from !== null || route.view === "cleanup" ? scanAccount(route.target, opts) : scanTarget(route.target, opts);
}

function paintHome(value: string, error: string | null, network: Network, focusMain: boolean): void {
  paint(renderHome(value, error, network), "Key Doctor · Check keys", focusMain, network);
}

/** Paints a scanned report for the route; DAO reports then fill in the proposal page. */
function paintReport(report: KdReport, route: Route, paging: Paging, seq: number): void {
  const target = report.target.id;
  const body =
    report.target.type === "dao"
      ? renderCouncil(report, paging)
      : route.view === "cleanup"
        ? renderCleanup(report, route.from, route.level, paging)
        : renderAccount(report, route.from, paging);
  paint(body, `${target} · Key Doctor`, false, report.chain.network);
  root.insertAdjacentHTML("beforeend", renderWatchDialog(target, report.target.type, WORKER_URL).value);
  syncWallet();
  if (report.target.type === "dao") void paintProposals(report.target.id, report.chain.network, pageOf(paging, PROPOSALS_LIST), paging, seq);
}

const currentNetwork = (): Network => parseRoute(location.search).network ?? lastReport?.chain.network ?? storedNetwork();

/** The wallet Connect Wallet last connected and the accounts it holds; Revoke and Delete sign with it. */
let connected: { walletId: WalletId; accounts: string[] } | null = null;

/** Revoke and Delete work only when the connected wallet holds the account on screen. View is never touched.
 *  Also shows the wallet name and Disconnect in place of Connect Wallet while a wallet is connected. */
function syncWallet(): void {
  const ok = connected !== null && lastReport !== null && connected.accounts.includes(lastReport.target.id);
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-action="delete-key"]')) {
    b.disabled = !ok;
    b.title = ok ? "" : "Connect Wallet as this account to enable";
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-wallet-off]")) el.hidden = connected !== null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-wallet-on]")) el.hidden = connected === null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-wallet-name]")) {
    el.textContent = connected === null ? "" : `${walletLabel(connected.walletId)} · ${connected.accounts.join(", ") || "no account"}`;
  }
}

/** `rescan` false re-renders from the last report when the URL still points at it (page changes, back/forward). */
async function render(focusMain: boolean, rescan = true): Promise<void> {
  const route = parseRoute(location.search);
  const paging = parsePaging(location.search);
  const seq = ++scanSeq;
  if (!rescan && route.target !== null && lastReport !== null && scanKey(route) === lastScanKey) {
    paintReport(lastReport, route, paging, seq);
    // Back/forward between pages of one report: keep the scroll position the browser restores.
    if (focusMain) document.getElementById("main")?.focus({ preventScroll: true });
    return;
  }
  if (route.target === null) {
    const error = route.invalid === null ? null : "Invalid target. Enter a valid .near or .testnet account name.";
    paintHome(route.invalid ?? "", error, route.network ?? storedNetwork(), focusMain);
    return;
  }
  const target = route.target;
  const network = route.network ?? "testnet";
  paint(renderScanning(target, route.from), `Scanning ${target} · Key Doctor`, focusMain, network);
  try {
    const report = await scan({ ...route, target, network });
    if (seq !== scanSeq) return;
    lastReport = report;
    lastScanKey = scanKey(route);
    proposalPages.clear();
    paintReport(report, route, paging, seq);
  } catch (e) {
    if (seq !== scanSeq) return;
    if (!isKdError(e)) console.error("scan failed", { target, error: e });
    paint(renderError(target, route.from, isKdError(e) ? e.kd : UNKNOWN_ERROR, network), `${target} · Key Doctor`, false, network);
  }
}

/**
 * Fills the Proposals section after the council report with one page of proposals; a failed read never touches
 * the report. A page past the end (an old link) shows the last page instead.
 */
async function paintProposals(dao: string, network: Network, page: number, paging: Paging, seq: number): Promise<void> {
  // A page already read paints at once, so changing another list's page does not flash "Loading proposals…".
  const cached = proposalPages.get(page);
  const box0 = document.getElementById(PROPOSALS_ID);
  if (cached !== undefined && box0 !== null) {
    box0.innerHTML = renderProposals(cached, page, paging).value;
    revealClampToggles(box0);
    return;
  }
  const read = async (p: number): Promise<ListProposalsResult | null> => {
    if (proposalPages.has(p)) return proposalPages.get(p) ?? null;
    const result = await listProposals(dao, { network, limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE }).catch(() => null);
    if (seq === scanSeq) proposalPages.set(p, result);
    return result;
  };
  let shown = page;
  let result = await read(page);
  const last = result === null ? 1 : Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  if (result !== null && page > last) {
    shown = last;
    result = await read(last);
  }
  const box = document.getElementById(PROPOSALS_ID);
  if (seq !== scanSeq || box === null) return;
  box.innerHTML = renderProposals(result, shown, paging).value;
  revealClampToggles(box);
}

/** A Previous/Next link: new URL, same report, then bring the list's top into view. */
function changePage(link: HTMLAnchorElement): void {
  const list = link.dataset.pageList ?? "";
  history.pushState(null, "", link.getAttribute("href") ?? "./");
  void render(false, false).then(() => {
    const anchor = document.querySelector<HTMLElement>(`[data-list-anchor="${CSS.escape(list)}"]`);
    anchor?.scrollIntoView({ block: "start" });
    anchor?.focus({ preventScroll: true });
  });
}

function navigate(href: string): void {
  history.pushState(null, "", href);
  window.scrollTo(0, 0);
  void render(true);
}

function closeDialog(dialog: HTMLDialogElement): void {
  dialog.close();
}

/** Signs an accepted plan through the chosen wallet, or shows why the guards refused it. Re-renders on success. */
function signPlan(button: HTMLButtonElement, status: HTMLElement, plan: DeletePlan, walletId: WalletId): void {
  if (!plan.ok) {
    status.textContent = plan.errors.map((e) => GUARD_TEXT[e]).join(" ");
    return;
  }
  const account = lastReport!.target.id;
  const network = lastReport!.chain.network;
  button.disabled = true;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transaction there before you approve.`;
  // Loaded on demand: the wallet SDK is large and only needed when someone signs.
  import("./wallet.ts")
    .then((w) => w.signDeleteKeys(account, network, plan, walletId, (t) => (status.textContent = t)))
    .then(() => {
      void render(false);
    })
    .catch((e: unknown) => {
      button.disabled = false;
      status.textContent = `Not done: ${e instanceof Error ? e.message : "the wallet did not sign."}`;
    });
}

let pendingWallet: ((id: WalletId) => void) | null = null;

/** Opens the wallet dialog; `then` runs with the wallet the user picks. Closing the dialog drops it. */
function askWallet(trigger: HTMLElement, then: (id: WalletId) => void): void {
  const dialog = document.getElementById("wallet-dialog") as HTMLDialogElement | null;
  if (dialog === null) return;
  pendingWallet = then;
  dialogTrigger = trigger;
  dialog.showModal();
  void decorateWallets(dialog);
}

/** Fills each wallet button with the name and icon its SDK module declares; the static label stays if loading fails. */
async function decorateWallets(dialog: HTMLElement): Promise<void> {
  try {
    const { walletMetadata } = await import("./wallet.ts");
    const meta = await walletMetadata(lastReport?.chain.network ?? "testnet");
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-wallet]")) {
      const m = meta[button.dataset.wallet ?? ""];
      if (m === undefined || button.querySelector("img") !== null) continue;
      const img = document.createElement("img");
      img.src = m.iconUrl;
      img.alt = "";
      img.width = img.height = 24;
      button.prepend(img);
      button.lastChild!.textContent = m.name;
    }
  } catch {
    // keep the static labels
  }
}

/** Read-only connect request (no contractId, so no key is added). */
function connectWallet(status: HTMLElement, walletId: WalletId): void {
  // The Meteor extension injects window.meteorCom; without it the SDK falls back to a web popup.
  if (walletId === "meteor-wallet" && !("meteorCom" in window)) {
    const link = document.createElement("a");
    link.href = METEOR_INSTALL_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Install the Meteor Wallet extension";
    status.replaceChildren(link, " in this browser, then reload this page.");
    return;
  }
  status.textContent = `Check the ${walletLabel(walletId)} window.`;
  import("./wallet.ts")
    .then((w) => w.openWallet(currentNetwork(), walletId))
    .then((accounts) => {
      connected = { walletId, accounts };
      const target = lastReport?.target.id;
      status.textContent =
        target === undefined || accounts.includes(target) ? "" : `${walletLabel(walletId)} holds ${accounts.join(", ") || "no account"}, not ${target}. Revoke and Delete stay off.`;
      syncWallet();
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : "";
      status.textContent = /closed/i.test(msg) ? "Wallet window closed." : `Not opened: ${msg || "the wallet did not respond."}`;
    });
}

root.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("a[data-nav], a[data-page-list], [data-action]");
  if (el === null) return;
  if (el instanceof HTMLAnchorElement && el.hasAttribute("data-page-list")) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    changePage(el);
    return;
  }
  if (el instanceof HTMLAnchorElement && el.hasAttribute("data-nav")) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(el.getAttribute("href") ?? "./");
    return;
  }
  const dialog = document.getElementById("watch-dialog") as HTMLDialogElement | null;
  switch (el.dataset.action) {
    case "network": {
      // Re-render the home page on the chosen network, keeping what the user typed.
      const network: Network = el.dataset.network === "mainnet" ? "mainnet" : "testnet";
      const typed = (document.getElementById("target") as HTMLInputElement | null)?.value ?? "";
      storeNetwork(network);
      history.replaceState(null, "", homeHref(network));
      paintHome(typed, null, network, false);
      document.querySelector<HTMLElement>(`[data-action="network"][data-network="${network}"]`)?.focus();
      break;
    }
    case "delete-key": {
      const m = lastReport?.members[0];
      const status = document.getElementById(el.dataset.status ?? "");
      if (!lastReport || !m || !status || !el.dataset.key) break;
      const plan = buildDeletePlan(m, [el.dataset.key], null);
      if (!plan.ok) {
        status.textContent = plan.errors.map((e) => GUARD_TEXT[e]).join(" ");
        break;
      }
      if (connected === null) break;
      signPlan(el as HTMLButtonElement, status, plan, connected.walletId);
      break;
    }
    case "open-wallet": {
      const status = document.getElementById("wallet-status");
      if (!status) break;
      askWallet(el, (walletId) => connectWallet(status, walletId));
      break;
    }
    case "disconnect-wallet": {
      const status = document.getElementById("wallet-status");
      const was = connected;
      if (was === null) break;
      connected = null;
      syncWallet();
      if (status) status.textContent = "Disconnecting…";
      import("./wallet.ts")
        .then((w) => w.disconnectWallet(currentNetwork(), was.walletId))
        .then(() => status && (status.textContent = "Wallet disconnected."))
        .catch(() => status && (status.textContent = "Disconnected here; the wallet may still hold the session."));
      break;
    }
    case "choose-wallet": {
      const walletId = el.dataset.wallet;
      const choose = pendingWallet;
      pendingWallet = null;
      const open = el.closest("dialog");
      if (open !== null) closeDialog(open);
      if (choose !== null && isWalletId(walletId)) choose(walletId);
      break;
    }
    case "rescan":
      void render(false);
      break;
    case "theme":
      setTheme(currentTheme() === "dark" ? "light" : "dark", true);
      break;
    case "toggle-more":
      toggleClamp(el);
      break;
    case "watch":
      if (dialog === null) break;
      dialogTrigger = el;
      dialog.showModal();
      break;
    case "view-key": {
      const m = lastReport?.members[0];
      const key = m?.keys.find((k) => k.public_key === el.dataset.key);
      const keyDialog = document.getElementById("key-dialog") as HTMLDialogElement | null;
      if (!lastReport || !m || !key || keyDialog === null) break;
      keyDialog.innerHTML = renderKeyDetail(key, m, lastReport).value;
      dialogTrigger = el;
      keyDialog.showModal();
      break;
    }
    case "close-dialog": {
      const open = el.closest("dialog") ?? dialog;
      if (open !== null) closeDialog(open);
      break;
    }
    case "copy-command": {
      const label = el.querySelector("[data-copy-label]");
      navigator.clipboard
        .writeText(el.dataset.command ?? "")
        .then(() => {
          if (label) label.textContent = "Copied";
        })
        .catch(() => {
          if (label) label.textContent = "Select and copy";
        });
      break;
    }
    case "watch-links": {
      const box = document.getElementById("watch-links");
      if (!box || !WORKER_URL) break;
      (el as HTMLButtonElement).disabled = true;
      fetch(`${WORKER_URL}/api/watch-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: el.dataset.target }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((link) => {
          box.innerHTML = renderWatchLinks(link as Parameters<typeof renderWatchLinks>[0]).value;
        })
        .catch(() => {
          box.innerHTML = renderWatchLinks({ link_private: "", link_group: "", expires_at: "" }).value;
        });
      break;
    }
  }
});

// Backdrop click closes; the native <dialog> already traps focus and closes on Esc.
root.addEventListener("click", (event) => {
  const t = event.target;
  if (t instanceof HTMLDialogElement && t.open) closeDialog(t);
});
root.addEventListener(
  "close",
  () => {
    dialogTrigger?.focus();
    dialogTrigger = null;
  },
  true,
);

root.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.id !== "check-form") return;
  event.preventDefault();
  const raw = String(new FormData(form).get("target") ?? "");
  const selected = parseRoute(location.search).network ?? storedNetwork();
  try {
    const { id, network } = resolveInput(raw, selected);
    // A typed suffix wins over the switch; remember it so the next home visit matches.
    storeNetwork(network);
    navigate(routeHref(id, null, network));
  } catch (e) {
    paintHome(raw, isKdError(e) ? e.kd.message.en : UNKNOWN_ERROR.message.en, selected, false);
    document.getElementById("target")?.focus();
  }
});

window.addEventListener("popstate", () => void render(true, false));

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => revealClampToggles(root), 150);
});
void render(false);
