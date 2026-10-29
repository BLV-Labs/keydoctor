// Browser entry: routing, scanning and DOM events. Rendering lives in pure modules that tests run in Node.
import { isKdError, resolveTarget, scanAccount, scanTarget, type KdError, type KdReport } from "key-doctor";
import type { Html } from "./html.ts";
import { renderError, renderHome, renderLayout, renderScanning } from "./pages.ts";
import { renderCleanup } from "./cleanup-view.ts";
import { renderAccount, renderCouncil } from "./report.ts";
import { parseRoute, routeHref, type Route } from "./route.ts";
import { renderWatchDialog, renderWatchLinks } from "./watch.ts";

declare const __KD_WORKER_URL__: string;
/** Set at build time (KD_WORKER_URL); empty means the MVP dialog with no Worker call. */
const WORKER_URL = typeof __KD_WORKER_URL__ === "string" ? __KD_WORKER_URL__.replace(/\/+$/, "") : "";

const root = document.getElementById("app") as HTMLElement;
let scanSeq = 0;
let dialogTrigger: HTMLElement | null = null;

const UNKNOWN_ERROR: KdError = {
  schema_version: "kd.error.v1",
  code: "RPC_ERROR",
  message: { vi: "", en: "Could not read chain data right now. The risk is unknown, not low." },
  retryable: true,
};

function paint(content: Html, title: string, focusMain: boolean): void {
  root.innerHTML = renderLayout(content).value;
  document.title = title;
  if (focusMain) document.getElementById("main")?.focus();
}

/** A council member and a cleanup plan are always accounts; anything else goes through scanTarget (DAO first). */
function scan(route: Route & { target: string }): Promise<KdReport> {
  return route.from !== null || route.view === "cleanup" ? scanAccount(route.target) : scanTarget(route.target);
}

async function render(focusMain: boolean): Promise<void> {
  const route = parseRoute(location.search);
  const seq = ++scanSeq;
  if (route.target === null) {
    const error = route.invalid === null ? null : "Invalid target. Enter a valid .near or .testnet account name.";
    paint(renderHome(route.invalid ?? "", error), "Key Doctor · Check keys", focusMain);
    return;
  }
  const target = route.target;
  paint(renderScanning(target, route.from), `Scanning ${target} · Key Doctor`, focusMain);
  try {
    const report = await scan({ ...route, target });
    if (seq !== scanSeq) return;
    const body =
      report.target.type === "dao"
        ? renderCouncil(report)
        : route.view === "cleanup"
          ? renderCleanup(report, route.from, route.level)
          : renderAccount(report, route.from);
    paint(body, `${target} · Key Doctor`, false);
    root.insertAdjacentHTML("beforeend", renderWatchDialog(target, report.target.type, WORKER_URL).value);
  } catch (e) {
    if (seq !== scanSeq) return;
    if (!isKdError(e)) console.error("scan failed", { target, error: e });
    paint(renderError(target, route.from, isKdError(e) ? e.kd : UNKNOWN_ERROR), `${target} · Key Doctor`, false);
  }
}

function navigate(href: string): void {
  history.pushState(null, "", href);
  window.scrollTo(0, 0);
  void render(true);
}

function closeDialog(dialog: HTMLDialogElement): void {
  dialog.close();
}

root.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("a[data-nav], [data-action]");
  if (el === null) return;
  if (el instanceof HTMLAnchorElement && el.hasAttribute("data-nav")) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(el.getAttribute("href") ?? "./");
    return;
  }
  const dialog = document.getElementById("watch-dialog") as HTMLDialogElement | null;
  switch (el.dataset.action) {
    case "rescan":
      void render(false);
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
  try {
    navigate(routeHref(resolveTarget(raw).id));
  } catch (e) {
    paint(renderHome(raw, isKdError(e) ? e.kd.message.en : UNKNOWN_ERROR.message.en), "Key Doctor · Check keys", false);
    document.getElementById("target")?.focus();
  }
});

window.addEventListener("popstate", () => void render(true));
void render(false);
