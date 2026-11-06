// Browser entry: routing, scanning and DOM events. Rendering lives in pure modules that tests run in Node.
import { isKdError, listProposals, scanAccount, scanTarget, type KdError, type KdReport, type ListProposalsResult, type Network } from "key-doctor";
import { revealClampToggles, toggleClamp } from "./clamp.ts";
import { html, type Html } from "./html.ts";
import { renderAgents, renderError, renderHome, renderLayout, renderOnCall, renderScanning } from "./pages.ts";
import { buildDeletePlan, GUARD_TEXT, METEOR_INSTALL_URL, type DeletePlan } from "./cleanup.ts";
import { renderCleanup } from "./cleanup-view.ts";
import { PAGE_SIZE, pageOf, parsePaging, type Paging } from "./paging.ts";
import { renderKeyDetail } from "./key-detail.ts";
import { PROPOSALS_ID, PROPOSALS_LIST, renderProposals } from "./proposals-view.ts";
import { renderAccount, renderCouncil } from "./report.ts";
import { budgetHref, guardHref, homeHref, parseRoute, resolveInput, routeHref, suffixNetwork, type Page, type Route } from "./route.ts";
import { yoctoToNear } from "./format.ts";
import { formToInput, validateGuardForm } from "./guard-form.ts";
import {
  actProposalArgs,
  addAgentProposal,
  agentProposal,
  amountFromForm,
  BudgetFlowError,
  confirmFirstSignature,
  confirmProposal,
  rulesProposal,
  withdrawProposal,
  type ConfirmedProposal,
  type VoteAction,
} from "./budget-flow.ts";
import { budgetRpc, proposalLabel, readBudget, readProposal, topUpBlocks, TOP_UP_TEXT, type BudgetLive } from "./budget-read.ts";
import { BUDGET_FACTORY_NAME, describeKind, renderBudget, renderBudgetLoading, renderBudgetNext, renderBudgetPanel, renderBudgetSetup, renderBudgetStart, type BudgetPanel } from "./budget-view.ts";
import {
  addGuardRoleProposal,
  createGuardProposal,
  guardChangeProposal,
  isGuardMethod,
  missingProposePermissions,
  removeGuardRoleProposal,
  type AddProposalArgs,
} from "./guard-proposals.ts";
import { readGuardDao, type GuardDao } from "./guard-read.ts";
import { renderGuardCreate, renderGuardDao, renderGuardLoading, renderGuardPreview, renderGuardStart, renderGuardSubmitted, type GuardPreview } from "./guard-view.ts";
import { renderWatchDialog, renderWatchLinks } from "./watch.ts";
import { isWalletId, walletLabel, type WalletId } from "./wallets.ts";
import { connectedAccount, forgetConnected, lockedNotice, rememberConnected, viewerRole, walletBar, type Role } from "./session.ts";

declare const __KD_WORKER_URL__: string;
/** Set at build time (KD_WORKER_URL); empty means the MVP dialog with no Worker call. */
const WORKER_URL = typeof __KD_WORKER_URL__ === "string" ? __KD_WORKER_URL__.replace(/\/+$/, "") : "";
declare const __KD_GUARD_FACTORY__: string;
/** Set at build time (KD_GUARD_FACTORY); empty means the Agent Guard page only explains how to configure it. */
const GUARD_FACTORY = typeof __KD_GUARD_FACTORY__ === "string" ? __KD_GUARD_FACTORY__ : "";
/** The Agent Guard page's last read, and the proposals its preview would sign. */
let guardState: GuardDao | null = null;
let guardPreview: (GuardPreview & { labels: string[] }) | null = null;
declare const __KD_BUDGET_FACTORY__: string;
/** Set at build time (KD_BUDGET_FACTORY); empty means Agent Budgets cannot be created yet (the v2 factory is not deployed). */
const BUDGET_FACTORY = typeof __KD_BUDGET_FACTORY__ === "string" ? __KD_BUDGET_FACTORY__ : "";
/** Budgets are read from the Budget factory when set, else from the Guard factory. */
const BUDGET_READ_FACTORY = BUDGET_FACTORY || GUARD_FACTORY;
/** The Agent Budget page's last read, and the proposal that is between sign 1 and sign 2. */
let budgetState: BudgetLive | null = null;
let budgetSign2: { account: string; walletId: WalletId; confirmed: ConfirmedProposal; description: string } | null = null;

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

function paint(content: Html, title: string, focusMain: boolean, network: Network, page: Page = "check"): void {
  root.innerHTML = renderLayout(content, network, page).value;
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
let connected: { walletId: WalletId; accounts: string[]; iconUrl?: string } | null = null;
/** Display state restored from a past visit; the wallet is asked again whenever something is signed. */
let restoredFor: Network | null = null;

function restoreConnected(network: Network): void {
  if (connected !== null || restoredFor === network) return;
  restoredFor = network;
  connected = connectedAccount(network);
}

const viewerRoleNow = (): Role => viewerRole(connected?.accounts ?? null, lastReport?.target.id ?? "");

/** Revoke and Delete work only when the connected wallet holds the account on screen. View is never touched.
 *  Also shows the wallet name and Disconnect in place of Connect Wallet while a wallet is connected. */
function syncWallet(): void {
  restoreConnected(currentNetwork());
  const role = viewerRoleNow();
  const id = lastReport?.target.id ?? "";
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-action="delete-key"]')) {
    const locked = role !== "owner";
    b.classList.toggle("btn-locked", locked);
    b.setAttribute("aria-disabled", String(locked));
    b.title = locked ? lockedNotice(role, id, connected?.accounts ?? null).text : "";
  }
  if (lastReport !== null) {
    for (const bar of root.querySelectorAll<HTMLElement>("[data-wallet-bar]")) {
      bar.outerHTML = walletBar(role, id, connected?.accounts ?? null, lastReport.chain.network).value;
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-wallet-off]")) el.hidden = connected !== null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-wallet-on]")) el.hidden = connected === null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-wallet-name]")) {
    if (connected === null) {
      el.replaceChildren();
      continue;
    }
    el.title = walletLabel(connected.walletId);
    const name = document.createElement("span");
    name.textContent = connected.accounts.join(", ") || "no account";
    if (connected.iconUrl === undefined) {
      el.replaceChildren(name);
      continue;
    }
    const img = document.createElement("img");
    img.src = connected.iconUrl;
    img.alt = "";
    img.width = img.height = 16;
    el.replaceChildren(img, name);
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
  if (route.target === null && route.page === "guard") {
    await renderGuard(route.dao, focusMain, seq);
    return;
  }
  if (route.target === null && route.page === "budget") {
    await renderBudgetPage(route.dao, focusMain, seq);
    return;
  }
  if (route.target === null && route.page !== "check") {
    const network = route.network ?? storedNetwork();
    if (route.page === "oncall") paint(renderOnCall(), "On Call · Key Doctor", focusMain, network, "oncall");
    else paint(renderAgents(WORKER_URL), "Agents · Key Doctor", focusMain, network, "agents");
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

const budgetNetwork = (): Network => suffixNetwork(BUDGET_READ_FACTORY) ?? "testnet";

/** The Agent Budget page: the DAO form, or the DAO's Budget read live from the chain. Nothing here is sample data. */
async function renderBudgetPage(dao: string | null, focusMain: boolean, seq: number): Promise<void> {
  const network = budgetNetwork();
  const title = "Agent Budget · Key Doctor";
  budgetState = null;
  budgetSign2 = null;
  const start = (value: string, error: string | null) => {
    const note =
      BUDGET_READ_FACTORY === ""
        ? "Reading a Budget needs the Guard factory set when this site is built (KD_GUARD_FACTORY). It is not set here."
        : `Budgets are read from ${BUDGET_READ_FACTORY} on ${network}.`;
    paint(html`${renderBudgetStart(value, error, note)}${renderBudgetSetup(BUDGET_FACTORY !== "")}`, title, focusMain, network, "budget");
  };
  if (dao === null || BUDGET_READ_FACTORY === "") {
    start(dao ?? "", null);
    return;
  }
  if (suffixNetwork(dao) !== network) {
    start(dao, `The Budget factory is on ${network}: enter a ${network} DAO.`);
    return;
  }
  paint(renderBudgetLoading(dao), title, focusMain, network, "budget");
  try {
    const state = await readBudget(dao, BUDGET_READ_FACTORY, network);
    if (seq !== scanSeq) return;
    budgetState = state;
    paint(renderBudget(state, network, renderBudgetSetup(BUDGET_FACTORY !== "")), `${dao} · Agent Budget`, false, network, "budget");
  } catch (e) {
    if (seq !== scanSeq) return;
    if (!isKdError(e)) console.error("budget read failed", { dao, error: e });
    const why =
      e instanceof Error && e.message === "FACTORY_UNREADABLE"
        ? `Could not read the Guard factory ${BUDGET_READ_FACTORY}. Try again later.`
        : isKdError(e)
          ? `${dao}: ${e.kd.message.en}`
          : `${dao} is not a Sputnik DAO.`;
    start(dao, why);
  }
}

const budgetStatus = (): HTMLElement | null => document.getElementById("budget-status");

/** Puts a button into a status line, next to its text. */
function statusWithButton(status: HTMLElement, text: string, action: string, label: string): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-tint";
  btn.dataset.action = action;
  btn.textContent = label;
  status.replaceChildren(`${text} `, btn);
}

/** The connected owner account that may run an action, or null after saying why in the status line. */
function budgetSigner(status: HTMLElement, labels: string[]): { account: string; walletId: WalletId; state: BudgetLive; guardId: string } | null {
  const state = budgetState;
  const guardId = state?.guard?.guard_id;
  if (state === null || guardId === undefined) return null;
  if (connected === null) {
    statusWithButton(status, "Connect the wallet of a DAO council member first.", "open-wallet", "Connect Wallet");
    return null;
  }
  const account = connected.accounts.find((a) => missingProposePermissions(state.dao.policy, a, labels).length === 0);
  if (account === undefined) {
    const shown = connected.accounts[0] ?? "no account";
    status.textContent = `${shown} may not add ${missingProposePermissions(state.dao.policy, shown, labels).join(" and ")} proposals in ${state.dao.dao}. Switch to a council account.`;
    return null;
  }
  return { account, walletId: connected.walletId, state, guardId };
}

const notDone = (status: HTMLElement, e: unknown): void => {
  status.textContent = `Not done: ${e instanceof Error ? e.message : "the wallet did not sign."}`;
};

/** Sign 1 outcome to a matched proposal. The chain can lag the wallet's answer, so an unreadable proposal is retried. */
async function confirmAfterSign1(built: AddProposalArgs["proposal"], outcome: unknown, dao: string, network: Network): Promise<ConfirmedProposal> {
  const rpc = budgetRpc(network);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await confirmFirstSignature(built, outcome, (id) => readProposal(rpc, dao, id));
    } catch (e) {
      if (!(e instanceof BudgetFlowError && e.code === "PROPOSAL_UNREADABLE") || attempt >= 3) throw e;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Sign 1 of an owner action: add the proposal, take its id from the transaction outcome, read it back and compare.
 * Only a match shows the button for sign 2. If sign 1 went through but this stops, the proposal waits under "Needs you".
 */
function startTwoSignatures(args: AddProposalArgs): void {
  const status = budgetStatus();
  if (status === null) return;
  const signer = budgetSigner(status, [proposalLabel(args.proposal.kind)]);
  if (signer === null) return;
  const { account, walletId, state } = signer;
  const network = budgetNetwork();
  budgetSign2 = null;
  const next = document.getElementById("budget-next");
  if (next) next.innerHTML = "";
  status.textContent = `Waiting for ${walletLabel(walletId)}. Signature 1 of 2: check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signAddProposalOutcome(account, network, state.dao.dao, state.dao.policy.proposal_bond, args, walletId, (t) => (status.textContent = t)))
    .then(async (outcome) => {
      status.textContent = "Signature 1 done. Reading the proposal back from the chain…";
      try {
        const confirmed = await confirmAfterSign1(args.proposal, outcome, state.dao.dao, network);
        budgetSign2 = { account, walletId, confirmed, description: args.proposal.description };
        status.textContent = "Signature 1 of 2 done and checked against the chain.";
        if (next) next.innerHTML = renderBudgetNext(confirmed.id, args.proposal.description).value;
        next?.querySelector("button")?.focus();
      } catch (e) {
        const why = e instanceof BudgetFlowError ? e.message : "The proposal could not be checked.";
        statusWithButton(status, `Signature 1 is done, but signature 2 is not offered: ${why} Reload, then approve or reject the proposal under "Needs you".`, "rescan", "Reload");
      }
    })
    .catch((e: unknown) => notDone(status, e));
}

/** Sign 2: `act_proposal(id, "VoteApprove", proposal)` for the proposal this page just matched. */
function signSecondSignature(button: HTMLButtonElement): void {
  const status = budgetStatus();
  const pending = budgetSign2;
  const state = budgetState;
  if (status === null || pending === null || state === null) return;
  const { account, walletId, confirmed } = pending;
  button.disabled = true;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Signature 2 of 2: check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signActProposal(account, budgetNetwork(), state.dao.dao, actProposalArgs(confirmed, "VoteApprove"), walletId, (t) => (status.textContent = t)))
    .then(() => {
      budgetSign2 = null;
      const next = document.getElementById("budget-next");
      if (next) next.innerHTML = "";
      statusWithButton(status, `Done: proposal #${confirmed.id} approved.`, "rescan", "Reload");
    })
    .catch((e: unknown) => {
      button.disabled = false;
      notDone(status, e);
    });
}

/** Approve or Reject a pending proposal: re-read it first and stop if it is no longer what the page showed. */
function actOnPending(button: HTMLButtonElement): void {
  const status = budgetStatus();
  const state = budgetState;
  const id = Number(button.dataset.id);
  const action: VoteAction = button.dataset.vote === "VoteReject" ? "VoteReject" : "VoteApprove";
  const shown = state?.proposals?.find((p) => p.id === id);
  if (status === null || state === null || shown === undefined || state.guard === null) return;
  if (connected === null) {
    statusWithButton(status, "Connect the wallet of a DAO council member first.", "open-wallet", "Connect Wallet");
    return;
  }
  const guardId = state.guard.guard_id;
  const registry = state.dao.guards.map((g) => g.guard_id);
  const account = connected.accounts.find((a) => !topUpBlocks(state.dao.policy, a, guardId, registry).includes("NOT_COUNCIL"));
  if (account === undefined) {
    status.textContent = TOP_UP_TEXT.NOT_COUNCIL;
    return;
  }
  const { walletId } = connected;
  const network = budgetNetwork();
  button.disabled = true;
  status.textContent = "Checking the proposal on the chain…";
  confirmProposal({ description: shown.description, kind: shown.kind }, id, (n) => readProposal(budgetRpc(network), state.dao.dao, n))
    .then((confirmed) => {
      status.textContent = `Waiting for ${walletLabel(walletId)}. ${action === "VoteApprove" ? "Approve" : "Reject"} proposal #${id}: ${describeKind(confirmed.kind)}.`;
      return import("./wallet.ts").then((w) => w.signActProposal(account, network, state.dao.dao, actProposalArgs(confirmed, action), walletId, (t) => (status.textContent = t)));
    })
    .then(() => statusWithButton(status, `Done: proposal #${id} ${action === "VoteApprove" ? "approved" : "rejected"}.`, "rescan", "Reload"))
    .catch((e: unknown) => {
      button.disabled = false;
      notDone(status, e);
    });
}

/** The guardian's emergency stop on the Budget page: one direct `pause` call on the Guard. */
function pauseBudget(button: HTMLButtonElement): void {
  const status = budgetStatus();
  const guard = budgetState?.guard;
  if (status === null || !guard) return;
  if (connected === null) {
    statusWithButton(status, "Connect a guardian's wallet first.", "open-wallet", "Connect Wallet");
    return;
  }
  const guardians = guard.config?.guardians ?? [];
  const account = connected.accounts.find((a) => guardians.includes(a));
  if (account === undefined) {
    status.textContent = `${connected.accounts[0] ?? "This account"} is not a guardian of ${guard.guard_id}. Guardians: ${guardians.join(", ")}.`;
    return;
  }
  const { walletId } = connected;
  button.disabled = true;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signGuardPause(account, budgetNetwork(), guard.guard_id, walletId, (t) => (status.textContent = t)))
    .then(() => statusWithButton(status, "Paused. Every request now fails with PAUSED until the DAO passes unpause.", "rescan", "Reload"))
    .catch((e: unknown) => {
      button.disabled = false;
      notDone(status, e);
    });
}

function openBudgetPanel(panel: BudgetPanel): void {
  const box = document.getElementById("budget-action");
  if (box === null || budgetState === null) return;
  box.innerHTML = renderBudgetPanel(panel, budgetState).value;
  box.scrollIntoView({ block: "start" });
  const first = box.querySelector<HTMLElement>("input");
  first?.focus();
}

const isBudgetPanel = (v: unknown): v is BudgetPanel => v === "topup" || v === "withdraw" || v === "rules" || v === "add-agent";

/** The owner-action form: validates, then starts the one-signature Top up or the two-signature flow. */
function submitBudgetPanel(form: HTMLFormElement): void {
  const state = budgetState;
  const panel = form.dataset.panel;
  const status = budgetStatus();
  if (state === null || state.guard === null || status === null || !isBudgetPanel(panel)) return;
  const values = Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));
  const reject = (error: string) => {
    form.outerHTML = renderBudgetPanel(panel, state, error, values).value;
    document.querySelector<HTMLElement>("#budget-panel-form input")?.focus();
  };
  const guardId = state.guard.guard_id;
  if (panel === "rules" || panel === "add-agent") {
    const result = panel === "rules" ? rulesProposal(guardId, values) : addAgentProposal(guardId, values, (state.guard.agents ?? []).map((a) => a.account_id));
    if (!result.ok) return reject(result.error);
    startTwoSignatures(result.value);
    return;
  }
  const amount = amountFromForm(values.amount ?? "", panel === "withdraw" ? state.balance : null);
  if (!amount.ok) return reject(amount.error);
  if (panel === "withdraw") {
    if (connected === null) return statusWithButton(status, "Connect the wallet of a DAO council member first.", "open-wallet", "Connect Wallet");
    const to = connected.accounts.find((a) => missingProposePermissions(state.dao.policy, a, ["transfer"]).length === 0);
    if (to === undefined) {
      status.textContent = `${connected.accounts[0] ?? "This account"} may not add transfer proposals in ${state.dao.dao}. Switch to a council account.`;
      return;
    }
    startTwoSignatures({ proposal: withdrawProposal(to, amount.value.yocto, amount.value.near) });
    return;
  }
  // Top up: one plain transfer, but only after the DAO's roles show this account is an owner and the Guard is the DAO's own.
  if (connected === null) return statusWithButton(status, "Connect your wallet first.", "open-wallet", "Connect Wallet");
  const registry = state.dao.guards.map((g) => g.guard_id);
  const sender = connected.accounts.find((a) => topUpBlocks(state.dao.policy, a, guardId, registry).length === 0);
  if (sender === undefined) {
    status.textContent = topUpBlocks(state.dao.policy, connected.accounts[0] ?? "", guardId, registry).map((b) => TOP_UP_TEXT[b]).join(" ");
    return;
  }
  const { walletId } = connected;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transfer there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signTopUp(sender, budgetNetwork(), state.dao.dao, amount.value.yocto, walletId, (t) => (status.textContent = t)))
    .then(() => statusWithButton(status, `Done: ${amount.value.near} NEAR sent to ${state.dao.dao}.`, "rescan", "Reload"))
    .catch((e: unknown) => notDone(status, e));
}

/** Enable, disable or remove an agent: a Guard change proposal, two signatures. */
function changeBudgetAgent(button: HTMLButtonElement): void {
  const guardId = budgetState?.guard?.guard_id;
  if (guardId === undefined) return;
  const proposal = agentProposal(guardId, button.dataset.op ?? "", button.dataset.agent ?? "");
  if (proposal !== null) startTwoSignatures(proposal);
}

/** The create form only checks the rules: creating a Budget needs the v2 factory, which is not deployed. */
function submitBudgetSetup(form: HTMLFormElement): void {
  const data = new FormData(form);
  const get = (name: string) => String(data.get(name) ?? "");
  const values = Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v)]));
  // Code storage is the factory's to report; before it exists the funding check covers the minimum only.
  const result = validateGuardForm(formToInput(get), BUDGET_FACTORY || BUDGET_FACTORY_NAME, "0");
  if (!result.ok) {
    form.outerHTML = renderBudgetSetup(BUDGET_FACTORY !== "", values, result.errors).value;
    document.querySelector<HTMLElement>('#budget-setup-form [aria-invalid="true"]')?.focus();
    return;
  }
  form.outerHTML = renderBudgetSetup(
    BUDGET_FACTORY !== "",
    values,
    [],
    BUDGET_FACTORY === ""
      ? `Your rules are valid. Creating the budget is not available yet: ${BUDGET_FACTORY_NAME} is not deployed.`
      : "Your rules are valid. Creating the budget from this page is not available yet.",
  ).value;
}

/** The Agent Guard page: the DAO form, or the DAO's Guards read live. Guards exist only on the factory's network. */
async function renderGuard(dao: string | null, focusMain: boolean, seq: number): Promise<void> {
  const network = suffixNetwork(GUARD_FACTORY) ?? "testnet";
  guardState = null;
  guardPreview = null;
  const title = "Agent Guard · Key Doctor";
  if (dao === null || GUARD_FACTORY === "") {
    paint(renderGuardStart("", null, GUARD_FACTORY), title, focusMain, network, "guard");
    return;
  }
  if (suffixNetwork(dao) !== network) {
    paint(renderGuardStart(dao, `The Guard factory is on ${network}: enter a ${network} DAO.`, GUARD_FACTORY), title, focusMain, network, "guard");
    return;
  }
  paint(renderGuardLoading(dao), title, focusMain, network, "guard");
  try {
    const state = await readGuardDao(dao, GUARD_FACTORY, network);
    if (seq !== scanSeq) return;
    guardState = state;
    paint(renderGuardDao(state, network), `${dao} · Agent Guard`, false, network, "guard");
  } catch (e) {
    if (seq !== scanSeq) return;
    if (!isKdError(e)) console.error("guard read failed", { dao, error: e });
    const why =
      e instanceof Error && e.message === "FACTORY_UNREADABLE"
        ? `Could not read the Guard factory ${GUARD_FACTORY}. Try again later.`
        : isKdError(e)
          ? `${dao}: ${e.kd.message.en}`
          : `${dao} is not a Sputnik DAO.`;
    paint(renderGuardStart(dao, why, GUARD_FACTORY), title, false, network, "guard");
  }
}

function showGuardPreview(preview: GuardPreview & { labels: string[] }): void {
  guardPreview = preview;
  const box = document.getElementById("guard-preview");
  if (box === null) return;
  box.innerHTML = renderGuardPreview(preview).value;
  box.scrollIntoView({ block: "start" });
  box.querySelector<HTMLElement>("h2")?.setAttribute("tabindex", "-1");
  box.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
}

/** The create form: valid input previews P1 (factory.create) and P2 (the agent-guard role); invalid input re-renders the form with its errors. */
function submitGuardCreate(form: HTMLFormElement): void {
  if (guardState === null) return;
  const data = new FormData(form);
  const get = (name: string) => String(data.get(name) ?? "");
  const result = validateGuardForm(formToInput(get), guardState.factory, guardState.code_storage);
  if (!result.ok) {
    const values = Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v)]));
    form.outerHTML = renderGuardCreate(guardState.factory, values, result.errors).value;
    document.querySelector<HTMLElement>('#guard-create-form [aria-invalid="true"]')?.focus();
    return;
  }
  const role = addGuardRoleProposal(guardState.policy, result.guardId);
  showGuardPreview({
    dao: guardState.dao,
    bond: guardState.policy.proposal_bond,
    proposals: role === null ? [createGuardProposal(guardState.factory, result.args, result.depositYocto)] : [createGuardProposal(guardState.factory, result.args, result.depositYocto), role],
    labels: role === null ? ["call"] : ["call", "policy"],
    notes: [
      `Both proposals need the council's votes. The Guard can propose transfers only after both pass: P1 creates ${result.guardId}, P2 lets it into the agent-guard role.`,
      `P1 attaches the funding plus ${yoctoToNear(guardState.code_storage)} NEAR for the Guard's own copy of the code and 0.01 NEAR for the factory's record: the DAO pays for its Guard.`,
      "If P1 fails on chain, the factory refunds the whole deposit to the DAO.",
    ],
  });
}

function submitGuardChange(form: HTMLFormElement): void {
  if (guardState === null) return;
  const data = new FormData(form);
  const method = String(data.get("method") ?? "");
  const guardId = form.dataset.guard ?? "";
  const error = form.querySelector<HTMLElement>("[data-change-error]") ?? form.appendChild(Object.assign(document.createElement("p"), { className: "field-error" }));
  error.dataset.changeError = "";
  let args: unknown;
  try {
    args = JSON.parse(String(data.get("args") ?? ""));
  } catch {
    args = null;
  }
  if (!isGuardMethod(method) || typeof args !== "object" || args === null || Array.isArray(args)) {
    error.textContent = "Arguments must be one JSON object, e.g. {}.";
    return;
  }
  error.textContent = "";
  showGuardPreview({ dao: guardState.dao, bond: guardState.policy.proposal_bond, proposals: [guardChangeProposal(guardId, method, args)], labels: ["call"], notes: [] });
}

/** Previews the ChangePolicy that takes the Guard out of the agent-guard role: a Guard cannot be deleted. */
function previewGuardRetire(guardId: string): void {
  if (guardState === null) return;
  const proposal = removeGuardRoleProposal(guardState.policy, guardId);
  if (proposal === null) return;
  showGuardPreview({
    dao: guardState.dao,
    bond: guardState.policy.proposal_bond,
    proposals: [proposal],
    labels: ["policy"],
    notes: [
      `Once it passes, ${guardId} can no longer propose or approve transfers. Proposals it already added stay for the council to decide.`,
      "The Guard account and its code storage stay on chain. To get its other NEAR back, propose withdraw_excess (Propose a change).",
    ],
  });
}

/** A guardian's emergency stop: signs `pause` on the Guard directly with the connected wallet, no DAO vote. */
function pauseGuard(button: HTMLButtonElement): void {
  const guardId = button.dataset.guard ?? "";
  const status = document.querySelector<HTMLElement>(`[data-pause-status="${CSS.escape(guardId)}"]`);
  const guardians = guardState?.guards.find((g) => g.guard_id === guardId)?.config?.guardians ?? [];
  if (status === null || guardState === null) return;
  if (connected === null) {
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "btn btn-tint";
    fix.dataset.action = "open-wallet";
    fix.textContent = "Connect Wallet";
    status.replaceChildren("Connect a guardian's wallet first. ", fix);
    return;
  }
  // The Guard refuses anyone else with NOT_GUARDIAN: say so before the wallet opens a transaction that fails.
  const account = connected.accounts.find((a) => guardians.includes(a));
  if (account === undefined) {
    status.textContent = `${connected.accounts[0] ?? "This account"} is not a guardian of ${guardId}. Guardians: ${guardians.join(", ")}.`;
    return;
  }
  const { walletId } = connected;
  const network = suffixNetwork(guardId) ?? "testnet";
  button.disabled = true;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signGuardPause(account, network, guardId, walletId, (t) => (status.textContent = t)))
    .then(() => {
      status.textContent = "Paused. Every request now fails with PAUSED until the DAO passes unpause. Reload to see the status.";
    })
    .catch((e: unknown) => {
      button.disabled = false;
      status.textContent = `Not done: ${e instanceof Error ? e.message : "the wallet did not sign."}`;
    });
}

/** Signs the previewed proposals with the connected wallet, after checking the account may propose them. */
function signGuardProposals(button: HTMLButtonElement): void {
  const status = document.getElementById("guard-sign-status");
  const preview = guardPreview;
  const state = guardState;
  if (status === null || preview === null || state === null) return;
  if (connected === null) {
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "btn btn-tint";
    fix.dataset.action = "open-wallet";
    fix.textContent = "Connect Wallet";
    status.replaceChildren("Connect the wallet of a council member first. ", fix);
    return;
  }
  // A proposal the DAO refuses still costs a failed transaction: say so before the wallet opens.
  const account = connected.accounts.find((a) => missingProposePermissions(state.policy, a, preview.labels).length === 0);
  if (account === undefined) {
    const shown = connected.accounts[0] ?? "no account";
    const missing = missingProposePermissions(state.policy, shown, preview.labels);
    status.textContent = `${shown} may not add ${missing.join(" and ")} proposals in ${state.dao}. Switch to a council account.`;
    return;
  }
  const { walletId } = connected;
  const network = suffixNetwork(state.dao) ?? "testnet";
  button.disabled = true;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signAddProposals(account, network, state.dao, state.policy.proposal_bond, preview.proposals, walletId, (t) => (status.textContent = t)))
    .then(() => {
      status.innerHTML = renderGuardSubmitted(state.dao).value;
    })
    .catch((e: unknown) => {
      button.disabled = false;
      status.textContent = `Not done: ${e instanceof Error ? e.message : "the wallet did not sign."}`;
    });
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

/** The wallet answers when the transaction is submitted, so the first rescan can still list the key; read until it is gone (about 20 s at most). */
async function waitForRemoval(plan: DeletePlan): Promise<void> {
  const route = parseRoute(location.search);
  if (route.target === null) return;
  const removed = new Set(plan.transactions.flat().map((a) => a.public_key));
  for (let i = 0; i < 10; i++) {
    const report = await scan({ ...route, target: route.target, network: route.network ?? "testnet" }).catch(() => null);
    if (report !== null && !report.members[0]?.keys.some((k) => removed.has(k.public_key))) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
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
      status.textContent = "Approved. Waiting for the chain to show the change…";
      return waitForRemoval(plan);
    })
    .then(() => {
      void render(false);
    })
    .catch((e: unknown) => {
      button.disabled = false;
      if (e instanceof Error && /^.* is connected as /.test(e.message)) {
        connected = null;
        forgetConnected(network);
        syncWallet();
      }
      status.textContent = `Not done: ${e instanceof Error ? e.message : "the wallet did not sign."}`;
    });
}

/** A locked Revoke/Delete was clicked: say why in the status line, with the button that fixes it. No wallet window opens. */
function explainLock(status: HTMLElement): void {
  const role = viewerRoleNow();
  const notice = lockedNotice(role, lastReport?.target.id ?? "", connected?.accounts ?? null);
  const fix = document.createElement("button");
  fix.type = "button";
  fix.className = "btn btn-tint";
  fix.dataset.action = notice.action === "switch" ? "switch-account" : "open-wallet";
  fix.textContent = notice.action === "switch" ? "Switch account" : "Connect Wallet";
  status.replaceChildren(`${notice.text} `, fix);
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
      rememberConnected(currentNetwork(), { walletId, accounts });
      const target = lastReport?.target.id;
      status.textContent =
        target === undefined || accounts.includes(target) ? "" : `${walletLabel(walletId)} holds ${accounts.join(", ") || "no account"}, not ${target}. Revoke and Delete stay off.`;
      syncWallet();
      // The icon the wallet's own SDK module declares; the chip shows the name alone if it cannot be read.
      void import("./wallet.ts")
        .then((w) => w.walletMetadata(currentNetwork()))
        .then((meta) => {
          if (connected?.walletId !== walletId) return;
          connected.iconUrl = meta[walletId]?.iconUrl;
          syncWallet();
        })
        .catch(() => {});
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
      if (connected === null || viewerRoleNow() !== "owner") {
        explainLock(status);
        break;
      }
      const plan = buildDeletePlan(m, [el.dataset.key], null);
      if (!plan.ok) {
        status.textContent = plan.errors.map((e) => GUARD_TEXT[e]).join(" ");
        break;
      }
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
      forgetConnected(currentNetwork());
      syncWallet();
      if (status) status.textContent = "Disconnecting…";
      import("./wallet.ts")
        .then((w) => w.disconnectWallet(currentNetwork(), was.walletId))
        .then(() => status && (status.textContent = ""))
        .catch(() => status && (status.textContent = "Disconnected here; the wallet may still hold the session."));
      break;
    }
    case "switch-account": {
      // Forget the display state, then ask again. The wallet picks the account; Disconnect there if it keeps the old one.
      connected = null;
      forgetConnected(currentNetwork());
      syncWallet();
      askWallet(el, (walletId) => {
        const status = document.getElementById("wallet-status");
        if (status) connectWallet(status, walletId);
      });
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
    case "guard-sign":
      signGuardProposals(el as HTMLButtonElement);
      break;
    case "guard-pause":
      pauseGuard(el as HTMLButtonElement);
      break;
    case "guard-retire":
      previewGuardRetire(el.dataset.guard ?? "");
      break;
    case "budget-open":
      if (isBudgetPanel(el.dataset.panel)) openBudgetPanel(el.dataset.panel);
      break;
    case "budget-close":
      document.getElementById("budget-action")?.replaceChildren();
      break;
    case "budget-act":
      actOnPending(el as HTMLButtonElement);
      break;
    case "budget-agent":
      changeBudgetAgent(el as HTMLButtonElement);
      break;
    case "budget-sign2":
      signSecondSignature(el as HTMLButtonElement);
      break;
    case "budget-pause":
      pauseBudget(el as HTMLButtonElement);
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
      keyDialog.innerHTML = renderKeyDetail(key, m, lastReport, viewerRoleNow()).value;
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
  if (form.id === "guard-dao-form") {
    event.preventDefault();
    const raw = String(new FormData(form).get("dao") ?? "").trim();
    navigate(guardHref(raw));
    return;
  }
  if (form.id === "budget-dao-form") {
    event.preventDefault();
    navigate(budgetHref(String(new FormData(form).get("dao") ?? "").trim()));
    return;
  }
  if (form.id === "budget-panel-form") {
    event.preventDefault();
    submitBudgetPanel(form);
    return;
  }
  if (form.id === "budget-setup-form") {
    event.preventDefault();
    submitBudgetSetup(form);
    return;
  }
  if (form.id === "guard-create-form") {
    event.preventDefault();
    submitGuardCreate(form);
    return;
  }
  if (form.classList.contains("guard-change-form")) {
    event.preventDefault();
    submitGuardChange(form);
    return;
  }
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
