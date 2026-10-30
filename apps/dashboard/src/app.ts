// Browser entry: routing, scanning and DOM events. Rendering lives in pure modules that tests run in Node.
import { isKdError, listProposals, scanAccount, scanTarget, type KdError, type KdReport, type ListProposalsResult, type Network } from "key-doctor";
import { revealClampToggles, toggleClamp } from "./clamp.ts";
import type { Html } from "./html.ts";
import { renderError, renderHome, renderLayout, renderScanning } from "./pages.ts";
import { buildDeletePlan, GUARD_TEXT, METEOR_INSTALL_URL, type DeletePlan } from "./cleanup.ts";
import { renderCleanup } from "./cleanup-view.ts";
import { PAGE_SIZE, pageOf, parsePaging, type Paging } from "./paging.ts";
import { PROPOSALS_ID, PROPOSALS_LIST, renderProposals } from "./proposals-view.ts";
import { renderAccount, renderCouncil } from "./report.ts";
import { homeHref, parseRoute, resolveInput, routeHref, type Route } from "./route.ts";
import { renderWatchDialog, renderWatchLinks } from "./watch.ts";

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

function paint(content: Html, title: string, focusMain: boolean, network: Network): void {
  root.innerHTML = renderLayout(content, network).value;
  document.title = title;
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
  if (report.target.type === "dao") void paintProposals(report.target.id, report.chain.network, pageOf(paging, PROPOSALS_LIST), paging, seq);
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

/** Signs an accepted plan through Meteor, or shows why the guards refused it. Re-renders on success. */
function signPlan(button: HTMLButtonElement, status: HTMLElement, plan: DeletePlan): void {
  if (!plan.ok) {
    status.textContent = plan.errors.map((e) => GUARD_TEXT[e]).join(" ");
    return;
  }
  const account = lastReport!.target.id;
  const network = lastReport!.chain.network;
  button.disabled = true;
  status.textContent = "Waiting for Meteor Wallet. Check the transaction there before you approve.";
  // Loaded on demand: the wallet SDK is large and only needed when someone signs.
  import("./wallet.ts")
    .then((w) => w.signDeleteKeys(account, network, plan, (t) => (status.textContent = t)))
    .then(() => {
      void render(false);
    })
    .catch((e: unknown) => {
      button.disabled = false;
      status.textContent = `Not done: ${e instanceof Error ? e.message : "the wallet did not sign."}`;
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
      signPlan(el as HTMLButtonElement, status, buildDeletePlan(m, [el.dataset.key], null));
      break;
    }
    case "open-wallet": {
      const status = document.getElementById(`wallet-status-${el.dataset.step}`);
      if (!lastReport || !status) break;
      // The Meteor extension injects window.meteorCom; without it the SDK falls back to a web popup.
      if (!("meteorCom" in window)) {
        const link = document.createElement("a");
        link.href = METEOR_INSTALL_URL;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Install the Meteor Wallet extension";
        status.replaceChildren(link, " in this browser, then reload this page.");
        break;
      }
      status.textContent = "Check the Meteor Wallet popup.";
      import("./wallet.ts")
        .then((w) => w.openWallet(lastReport!.chain.network))
        .then(() => (status.textContent = ""))
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : "";
          status.textContent = /closed/i.test(msg) ? "Wallet window closed." : `Not opened: ${msg || "the wallet did not respond."}`;
        });
      break;
    }
    case "rescan":
      void render(false);
      break;
    case "toggle-more":
      toggleClamp(el);
      break;
    case "watch":
      if (dialog === null) break;
      dialogTrigger = el;
      dialog.showModal();
      break;
    case "close-dialog":
      if (dialog !== null) closeDialog(dialog);
      break;
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
