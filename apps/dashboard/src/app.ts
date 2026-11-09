// Browser entry: routing, scanning and DOM events. Rendering lives in pure modules that tests run in Node.
import { isKdError, listProposals, scanAccount, scanTarget, type KdError, type KdReport, type ListProposalsResult, type Network, type Rpc } from "key-doctor";
import { revealClampToggles, toggleClamp } from "./clamp.ts";
import { html, type Html } from "./html.ts";
import { renderAgents, renderAlertsDrawer, renderError, renderHome, renderLayout, renderScanning } from "./pages.ts";
import { buildDeletePlan, GUARD_TEXT, METEOR_INSTALL_URL, type DeletePlan } from "./cleanup.ts";
import { renderCleanup } from "./cleanup-view.ts";
import { PAGE_SIZE, pageOf, parsePaging, type Paging } from "./paging.ts";
import { renderKeyDetail } from "./key-detail.ts";
import { PROPOSALS_ID, PROPOSALS_LIST, renderProposals } from "./proposals-view.ts";
import { renderAccount, renderCouncil } from "./report.ts";
import { budgetHref, guardHref, homeHref, parseRoute, resolveInput, routeHref, settledHref, suffixNetwork, yieldHref, type Page, type Route, type RouteLink } from "./route.ts";
import { renderAgentGuide } from "./agent-guide.ts";
import { yoctoToNear } from "./format.ts";
import { formToInput, validateGuardForm, type GuardFormError } from "./guard-form.ts";
import { agentKeyFile, agentKeyProblem, agentKeyUnsaved, budgetCheckFailures, firstSignatureProblem, planBudget, secondSignatureCalls, sputnikCreateArgs, SPUTNIK_FACTORY, UNSAVED_KEY_QUESTION, type BudgetChain, type BudgetPlan } from "./budget-create.ts";
import {
  actProposalArgs,
  addAgentProblem,
  addAgentProposal,
  addRecipientProposal,
  agentProposal,
  amountFromForm,
  BudgetFlowError,
  confirmFirstSignature,
  confirmProposal,
  createPlanProposal,
  freshAgentAccount,
  PAYOUT_STRATEGY,
  planChangeProposal,
  planFromForm,
  rulesProposal,
  voteResultText,
  withdrawProposal,
  type ConfirmedProposal,
  type VoteAction,
} from "./budget-flow.ts";
import { budgetRpc, proposalLabel, readBalance, readBudget, readProposal, topUpBlocks, TOP_UP_TEXT, type BudgetLive } from "./budget-read.ts";
import {
  BALANCED_RULES,
  CAUTIOUS_RULES,
  balanceAfter,
  BUDGET_FACTORY_NAME,
  describeKind,
  renderBudget,
  renderAgentAdded,
  renderBudgetActivity,
  renderBudgetAgent,
  renderBudgetApprove,
  renderBudgetCreate,
  renderBudgetKey,
  renderBudgetLoading,
  renderBudgetNext,
  renderBudgetPanel,
  renderBudgetPause,
  renderBudgetSetup,
  renderBudgetStart,
  renderRecipients,
  fenceSentence,
  isModalPanel,
  type BudgetPanel,
} from "./budget-view.ts";
import {
  addGuardRoleProposal,
  createGuardProposal,
  guardChangeProposal,
  isGuardMethod,
  missingProposePermissions,
  removeGuardRoleProposal,
  type AddProposalArgs,
  type RawPolicy,
} from "./guard-proposals.ts";
import { readGuardDao, type GuardDao } from "./guard-read.ts";
import { renderGuardCreate, renderGuardDao, renderGuardLoading, renderGuardPreview, renderGuardStart, renderGuardSubmitted, type GuardPreview } from "./guard-view.ts";
import { avatar } from "./ui.ts";
import { readAgentBudgets, readMyAgents, type BudgetCard, type MyAgents } from "./agents-read.ts";
import { renderMyAgents, renderMyAgentsError, renderMyAgentsLoading, renderMyAgentsSignedOut } from "./agents-view.ts";
import { allowedYieldKind, registerProposal, supplyProposal, tokenRaw, withdrawAllProposal, YIELD_ALLOWLIST, YieldProposalError } from "./yield-proposals.ts";
import { councilAccounts, readYield, rememberYieldDao, type YieldLive } from "./yield-read.ts";
import { renderYield, renderYieldLoading, renderYieldPanel, renderYieldStart, type YieldPanel } from "./yield-view.ts";
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
/** Set at build time (KD_BUDGET_FACTORY); empty means Agent Budgets cannot be created from this build. */
const BUDGET_FACTORY = typeof __KD_BUDGET_FACTORY__ === "string" ? __KD_BUDGET_FACTORY__ : "";
/** Budgets are read from the Budget factory when set, else from the Guard factory. */
const BUDGET_READ_FACTORY = BUDGET_FACTORY || GUARD_FACTORY;
/** The Agent Budget page's last read, and the proposal that is between sign 1 and sign 2. */
let budgetState: BudgetLive | null = null;
/** An agent being added: its account and the key made for it. */
interface NewAgent {
  account: string;
  key: { publicKey: string; privateKey: string };
}

let budgetSign2: { account: string; walletId: WalletId; confirmed: ConfirmedProposal; description: string; agent: NewAgent | null } | null = null;
/** An agent whose last signature has started. Its private key exists only here: leaving the page loses it. */
let budgetNewAgent: NewAgent | null = null;
/** A Budget being created. `key` exists from sign 2 on, and only here: leaving the page loses it. */
let budgetCreation: { plan: BudgetPlan; account: string; walletId: WalletId; key: { publicKey: string; privateKey: string } | null } | null = null;
/** The public key of the last agent key the owner downloaded: any other key in memory is still at risk. */
let savedAgentKey: string | null = null;
/** Where the page stood when it took an agent key, so Back can be undone if the owner stays. */
let agentKeyHref: string | null = null;

const agentKeyAtRisk = (): boolean => agentKeyUnsaved(budgetNewAgent?.key ?? budgetCreation?.key, savedAgentKey);
/** Asks before anything drops an agent key that was never downloaded. True means go ahead. */
const mayDropAgentKey = (): boolean => !agentKeyAtRisk() || window.confirm(UNSAVED_KEY_QUESTION);

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
  paint(renderHome(value, error, network), "Keyfence · Spending limits for AI agents", focusMain, network);
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
  paint(body, `${target} · Keyfence`, false, report.chain.network);
  root.insertAdjacentHTML("beforeend", renderWatchDialog(target, report.target.type, WORKER_URL).value);
  syncWallet();
  if (report.target.type === "dao") void paintProposals(report.target.id, report.chain.network, pageOf(paging, PROPOSALS_LIST), paging, seq);
}

const currentNetwork = (): Network => parseRoute(location.search).network ?? lastReport?.chain.network ?? storedNetwork();

/** The wallet Connect Wallet last connected and the accounts it holds; Revoke and Delete sign with it. */
let connected: { walletId: WalletId; accounts: string[] } | null = null;
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
  // My Agents lists what the connected accounts sit on: a new wallet means a new list.
  const route = parseRoute(location.search);
  const shown = root.querySelector<HTMLElement>("[data-agents-for]")?.dataset.agentsFor ?? null;
  const now = (connected?.accounts ?? []).join(",");
  if (route.target === null && route.page === "my-agents" && shown !== null && shown !== now) void render(false);
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
    const account = connected.accounts[0] ?? "";
    el.innerHTML = html`${account === "" ? "" : avatar(account)}<span class="wallet-name">${connected.accounts.join(", ") || "no account"}</span>`.value;
  }
}

/** `rescan` false re-renders from the last report when the URL still points at it (page changes, back/forward). */
async function render(focusMain: boolean, rescan = true): Promise<void> {
  const route = parseRoute(location.search);
  const paging = parsePaging(location.search);
  const seq = ++scanSeq;
  // A link opens its drawer once: a rescan or a reload lands on the plain page.
  if (route.link !== null) history.replaceState(history.state, "", settledHref(route));
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
    await renderBudgetPage(route.dao, focusMain, seq, route.link, route.help);
    return;
  }
  if (route.target === null && route.page === "yield") {
    await renderYieldPage(route.dao, focusMain, seq);
    return;
  }
  if (route.target === null && route.page === "my-agents") {
    await renderMyAgentsPage(focusMain, seq);
    return;
  }
  if (route.target === null && route.page === "mcp") {
    paint(renderAgents(WORKER_URL), "For AI agents · Keyfence", focusMain, route.network ?? storedNetwork(), "mcp");
    return;
  }
  if (route.target === null) {
    const error = route.invalid === null ? null : "Invalid target. Enter a valid .near or .testnet account name.";
    paintHome(route.invalid ?? "", error, route.network ?? storedNetwork(), focusMain);
    const bell = document.querySelector<HTMLElement>('[data-action="alerts-open"]');
    if (route.link?.kind === "alerts" && bell !== null) openAlerts(bell);
    return;
  }
  const target = route.target;
  const network = route.network ?? "testnet";
  paint(renderScanning(target, route.from), `Scanning ${target} · Keyfence`, focusMain, network);
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
    paint(renderError(target, route.from, isKdError(e) ? e.kd : UNKNOWN_ERROR, network), `${target} · Keyfence`, false, network);
  }
}

const budgetNetwork = (): Network => suffixNetwork(BUDGET_READ_FACTORY) ?? "testnet";

/** The Agent Budget page: the DAO form, or the DAO's Budget read live from the chain. Nothing here is sample data. */
async function renderBudgetPage(dao: string | null, focusMain: boolean, seq: number, link: RouteLink | null, help: boolean): Promise<void> {
  const network = budgetNetwork();
  const title = "Budget · Keyfence";
  budgetState = null;
  budgetSign2 = null;
  budgetCreation = null;
  budgetNewAgent = null;
  if (help) {
    paint(renderAgentGuide(dao), "How your agent works · Keyfence", focusMain, network, "budget");
    return;
  }
  const start = (value: string, error: string | null) => {
    const read =
      BUDGET_READ_FACTORY === ""
        ? "Reading a Budget needs the Guard factory set when this site is built (KD_GUARD_FACTORY). It is not set here."
        : `Budgets are read from ${BUDGET_READ_FACTORY} on ${network}.`;
    const note = link === null ? read : `This link needs a Budget: open yours here, then do it from the page. ${read}`;
    const open = renderBudgetStart(value, error, note);
    const create = renderBudgetCreate(renderBudgetSetup(BUDGET_FACTORY !== ""));
    paint(error === null ? html`${create}${open}` : html`${open}${create}`, title, focusMain, network, "budget");
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
    paint(renderBudget(state, network, renderBudgetSetup(BUDGET_FACTORY !== "")), `${dao} · Keyfence`, false, network, "budget");
    if (link !== null && state.guard !== null) followBudgetLink(link, state);
  } catch (e) {
    if (seq !== scanSeq) return;
    if (!isKdError(e)) console.error("budget read failed", { dao, error: e });
    const why =
      e instanceof Error && e.message === "FACTORY_UNREADABLE"
        ? `Could not read the Budget factory ${BUDGET_READ_FACTORY}. Try again later.`
        : isKdError(e)
          ? `${dao}: ${e.kd.message.en}`
          : `${dao} is not an Agent Budget account.`;
    start(dao, why);
  }
}

const budgetStatus = (): HTMLElement | null => document.getElementById("budget-status");

/** §10.5. A link never signs anything: it opens the drawer, or finds the card, and the owner goes on from there. */
function followBudgetLink(link: RouteLink, state: BudgetLive): void {
  const main = document.getElementById("main");
  if (main === null) return;
  if (link.kind === "add-agent") openBudgetPanel("add-agent", main);
  if (link.kind === "topup") {
    const error = link.token === "near" ? null : `This page tops up NEAR only, so nothing is filled in for ${link.token}.`;
    const values: Record<string, string> = budgetPanelValues("topup", state);
    if (error === null && link.amount !== null) values.amount = link.amount;
    showBudgetDrawer(renderBudgetPanel("topup", state, error, values), main, true);
  }
  if (link.kind === "strategy") {
    if (link.id === PAYOUT_STRATEGY && state.plans !== null) openBudgetPanel("plan", main);
    else {
      const status = budgetStatus();
      if (status !== null) status.textContent = link.id === PAYOUT_STRATEGY ? "Scheduled payouts cannot be set up here right now: the plans could not be read." : `Strategy ${link.id} is not available yet.`;
    }
  }
  if (link.kind === "plan") {
    const row = document.getElementById(`plan-${link.id}`);
    if (row !== null) {
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
    } else {
      const status = budgetStatus();
      if (status !== null) status.textContent = `Plan ${link.id} was not found on this Budget.`;
    }
  }
  if (link.kind === "approve") {
    const row = document.querySelector<HTMLElement>(`[data-action="budget-approve"][data-id="${link.id}"]`);
    if (row !== null) {
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
    } else {
      const status = budgetStatus();
      if (status !== null) status.textContent = `Request ${link.id} is no longer waiting for you.`;
    }
  }
}

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
    statusWithButton(status, "Connect the owner's wallet first.", "open-wallet", "Connect Wallet");
    return null;
  }
  const account = connected.accounts.find((a) => missingProposePermissions(state.dao.policy, a, labels).length === 0);
  if (account === undefined) {
    const shown = connected.accounts[0] ?? "no account";
    status.textContent = `${shown} may not change ${state.dao.dao}. Switch to the owner's account.`;
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
function startTwoSignatures(args: AddProposalArgs, agent: NewAgent | null = null): void {
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
      status.textContent = "Signature 1 done. Reading the request back from the chain…";
      try {
        const confirmed = await confirmAfterSign1(args.proposal, outcome, state.dao.dao, network);
        budgetSign2 = { account, walletId, confirmed, description: args.proposal.description, agent };
        status.textContent = "Signature 1 of 2 done and checked against the chain.";
        if (next) next.innerHTML = renderBudgetNext(confirmed.id, args.proposal.description).value;
        next?.querySelector("button")?.focus();
      } catch (e) {
        const why = e instanceof BudgetFlowError ? e.message : "The request could not be checked.";
        statusWithButton(status, `Signature 1 is done, but signature 2 is not offered: ${why} Reload, then approve or reject it under "Needs you".`, "rescan", "Reload");
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
  const { account, walletId, confirmed, agent } = pending;
  button.disabled = true;
  // Before the wallet opens: an answer lost on the way back must not lose the key of an agent that now exists.
  budgetNewAgent = agent;
  agentKeyHref = location.href;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Signature 2 of 2: check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signActProposal(account, budgetNetwork(), state.dao.dao, actProposalArgs(confirmed, "VoteApprove"), walletId, (t) => (status.textContent = t)))
    .then(() => statusAfterVote(budgetNetwork(), state.dao.dao, confirmed.id))
    .then(async (after) => {
      budgetSign2 = null;
      const next = document.getElementById("budget-next");
      if (next) next.innerHTML = "";
      if (agent === null) return statusWithButton(status, voteResultText(confirmed.id, "VoteApprove", confirmed.kind, after), "rescan", "Reload");
      status.textContent = "Checking the chain…";
      showAgentAdded(status, state, agent, await readAgentProblem(state, agent, 5));
    })
    .catch(async (e: unknown) => {
      if (agent !== null && (await readAgentProblem(state, agent, 2)) === null) {
        budgetSign2 = null;
        const next = document.getElementById("budget-next");
        if (next) next.innerHTML = "";
        showAgentAdded(status, state, agent, null);
        return;
      }
      button.disabled = false;
      notDone(status, e);
    });
}

/** Sputnik shows a failed call as Approved, so only the agent's own keys say it exists. Reads lag, so a miss is read again. */
async function readAgentProblem(state: BudgetLive, agent: NewAgent, tries: number): Promise<string | null> {
  const guardId = state.guard?.guard_id ?? "";
  const rpc = budgetRpc(budgetNetwork());
  let problem: string | null = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) await sleep(2000);
    const keys = await rpc.block().then(({ height }) => rpc.viewAccessKeyList(agent.account, height)).catch(() => null);
    problem = agentKeyProblem(guardId, agent.key.publicKey, keys);
    if (problem === null) break;
  }
  return problem;
}

function showAgentAdded(status: HTMLElement, state: BudgetLive, agent: NewAgent, problem: string | null): void {
  const next = document.getElementById("budget-next");
  status.textContent = "";
  if (next) next.innerHTML = renderAgentAdded(agent.account, state.guard?.guard_id ?? "", state.dao.dao, budgetNetwork(), problem).value;
  next?.querySelector("button")?.focus();
}

/** The proposal's status after a vote, null when unreadable. Reads lag at the final block, so an open one is read again. */
async function statusAfterVote(network: Network, dao: string, id: number): Promise<unknown> {
  let status: unknown = null;
  for (let tries = 0; tries < 4; tries += 1) {
    if (tries > 0) await new Promise((done) => setTimeout(done, 1500));
    const raw: unknown = await readProposal(budgetRpc(network), dao, id).catch(() => null);
    status = typeof raw === "object" && raw !== null ? (raw as { status?: unknown }).status ?? null : null;
    if (status !== null && status !== "InProgress") break;
  }
  return status;
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
    statusWithButton(status, "Connect the owner's wallet first.", "open-wallet", "Connect Wallet");
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
  status.textContent = "Checking the request on the chain…";
  confirmProposal({ description: shown.description, kind: shown.kind }, id, (n) => readProposal(budgetRpc(network), state.dao.dao, n))
    .then((confirmed) => {
      status.textContent = `Waiting for ${walletLabel(walletId)}. ${action === "VoteApprove" ? "Approve" : "Reject"} request #${id}: ${describeKind(confirmed.kind)}.`;
      return import("./wallet.ts")
        .then((w) => w.signActProposal(account, network, state.dao.dao, actProposalArgs(confirmed, action), walletId, (t) => (status.textContent = t)))
        .then(() => statusAfterVote(network, state.dao.dao, id))
        .then((after) => statusWithButton(status, voteResultText(id, action, confirmed.kind, after), "rescan", "Reload"));
    })
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
    status.textContent = `${connected.accounts[0] ?? "This account"} may not pause this Budget. Accounts that may: ${guardians.join(", ")}.`;
    return;
  }
  const { walletId } = connected;
  button.disabled = true;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signGuardPause(account, budgetNetwork(), guard.guard_id, walletId, (t) => (status.textContent = t)))
    .then(() => statusWithButton(status, "Paused. Every payment your agents ask for is rejected until you resume.", "rescan", "Reload"))
    .catch((e: unknown) => {
      button.disabled = false;
      notDone(status, e);
    });
}

/** The Yield agent page's last read. */
let yieldState: YieldLive | null = null;

const yieldNetwork = (dao: string): Network => suffixNetwork(dao) ?? "testnet";
const yieldStatus = (): HTMLElement | null => document.getElementById("yield-status");

/** The Yield agent page: the DAO form, or the DAO's treasury, Rhea Lend rates and yield proposals read live. */
async function renderYieldPage(dao: string | null, focusMain: boolean, seq: number): Promise<void> {
  const title = "Yield agent · Keyfence";
  yieldState = null;
  if (dao === null) {
    paint(renderYieldStart("", null), title, focusMain, "testnet", "my-agents");
    return;
  }
  const network = yieldNetwork(dao);
  paint(renderYieldLoading(dao), title, focusMain, network, "my-agents");
  try {
    const live = await readYield(dao, network);
    if (seq !== scanSeq) return;
    yieldState = live;
    rememberYieldDao(dao);
    paint(renderYield(live, network), `${dao} · Yield agent · Keyfence`, false, network, "my-agents");
  } catch (e) {
    if (seq !== scanSeq) return;
    if (!isKdError(e)) console.error("yield read failed", { dao, error: e });
    const why = isKdError(e) ? `${dao}: ${e.kd.message.en}` : `${dao} could not be read right now. Try again.`;
    paint(renderYieldStart(dao, why), title, false, network, "my-agents");
  }
}

function openYieldPanel(panel: YieldPanel, trigger: HTMLElement, error: string | null = null, amount = ""): void {
  const state = yieldState;
  const box = document.getElementById("yield-action") as HTMLDialogElement | null;
  if (state === null || box === null) return;
  const content = renderYieldPanel(panel, state, yieldNetwork(state.report.dao), error, amount);
  if (content === null) return;
  box.innerHTML = content.value;
  dialogTrigger = trigger;
  if (!box.open) box.showModal();
  box.querySelector<HTMLElement>("input")?.focus();
}

/** The proposal for a drawer, built only from the allowlist. A typed amount that does not fit reopens the drawer with why. */
function yieldProposalFor(panel: YieldPanel, amountText: string): AddProposalArgs | string {
  const state = yieldState;
  if (state === null) return "Reload the page first.";
  const network = yieldNetwork(state.report.dao);
  const token = YIELD_ALLOWLIST[network]?.tokens[0];
  try {
    if (panel === "register") return registerProposal(network);
    if (token === undefined) return `Yield proposals are not open on ${network} yet.`;
    if (panel === "withdraw") return withdrawAllProposal(network, token.token_id);
    const raw = tokenRaw(amountText, token.decimals);
    if (raw === null) return `Enter an amount like 12.5, with at most ${token.decimals} decimals.`;
    const available = state.report.holdings.find((h) => h.token_id === token.token_id)?.available ?? null;
    if (available === null) return "The DAO's available balance could not be read. Reload and try again.";
    return supplyProposal(network, token.token_id, raw, available);
  } catch (e) {
    if (e instanceof YieldProposalError) return e.message;
    throw e;
  }
}

/** One signature: the connected council member adds the proposal with the DAO's bond. It moves no funds. */
function signYieldProposal(panel: YieldPanel, amountText: string, trigger: HTMLElement): void {
  const state = yieldState;
  const status = yieldStatus();
  if (state === null || status === null) return;
  const built = yieldProposalFor(panel, amountText);
  if (typeof built === "string") {
    openYieldPanel(panel, trigger, built, amountText);
    return;
  }
  (document.getElementById("yield-action") as HTMLDialogElement | null)?.close();
  if (connected === null) {
    statusWithButton(status, "Connect a council member's wallet first.", "open-wallet", "Connect Wallet");
    return;
  }
  const policy = state.policy;
  const account = policy === null ? undefined : connected.accounts.find((a) => missingProposePermissions(policy, a, ["call"]).length === 0);
  if (policy === null || account === undefined) {
    status.textContent =
      policy === null
        ? "The DAO's policy could not be read, so the bond is unknown. Reload and try again."
        : `${connected.accounts[0] ?? "This account"} may not add function-call proposals to ${state.report.dao}. Switch to a council member's account.`;
    return;
  }
  const { walletId } = connected;
  const dao = state.report.dao;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transaction there before you approve.`;
  import("./wallet.ts")
    .then((w) => w.signAddProposals(account, yieldNetwork(dao), dao, policy.proposal_bond, [built], walletId, (t) => (status.textContent = t)))
    .then(() => statusWithButton(status, "Proposal added. The council votes on it under Council votes; funds move only when it passes.", "rescan", "Reload"))
    .catch((e: unknown) => notDone(status, e));
}

/** Approve or Reject a yield proposal: re-read it first and stop if it is no longer what the page showed. */
function voteYield(button: HTMLButtonElement): void {
  const status = yieldStatus();
  const state = yieldState;
  const id = Number(button.dataset.id);
  const action: VoteAction = button.dataset.vote === "VoteReject" ? "VoteReject" : "VoteApprove";
  const shown = state?.proposals?.find((p) => p.id === id);
  if (status === null || state === null || shown === undefined) return;
  if (connected === null) {
    statusWithButton(status, "Connect a council member's wallet first.", "open-wallet", "Connect Wallet");
    return;
  }
  const account = state.policy === null ? undefined : councilAccounts(state.policy, connected.accounts)[0];
  if (account === undefined) {
    status.textContent = `${connected.accounts[0] ?? "This account"} is not on ${state.report.dao}'s council.`;
    return;
  }
  const { walletId } = connected;
  const dao = state.report.dao;
  const network = yieldNetwork(dao);
  button.disabled = true;
  status.textContent = "Checking the proposal on the chain…";
  confirmProposal({ description: shown.description, kind: shown.kind }, id, (n) => readProposal(budgetRpc(network), dao, n))
    .then((confirmed) => {
      if (action === "VoteApprove" && !allowedYieldKind(network, confirmed.kind)) {
        throw new Error(`Proposal #${id} is not a call this page builds. Check it in the DAO before you vote.`);
      }
      status.textContent = `Waiting for ${walletLabel(walletId)}. ${action === "VoteApprove" ? "Approve" : "Reject"} proposal #${id}.`;
      return import("./wallet.ts")
        .then((w) => w.signActProposal(account, network, dao, actProposalArgs(confirmed, action), walletId, (t) => (status.textContent = t)))
        .then(() => statusAfterVote(network, dao, id))
        .then((after) => statusWithButton(status, voteResultText(id, action, confirmed.kind, after), "rescan", "Reload"));
    })
    .catch((e: unknown) => {
      button.disabled = false;
      notDone(status, e);
    });
}

/** The last Your agents read: Review and Reject on that page act on the budget named by the button. */
let agentsView: { data: MyAgents; accounts: string[]; cards: BudgetCard[] } | null = null;

function paintMyAgents(view: { data: MyAgents; accounts: string[]; cards: BudgetCard[] }, focusMain: boolean): void {
  agentsView = view;
  paint(renderMyAgents(view.data, view.accounts, view.cards), "Your agents · Keyfence", focusMain, budgetNetwork(), "my-agents");
}

/** Your agents: needs a connected wallet, then reads every budget of its accounts, all at once. */
async function renderMyAgentsPage(focusMain: boolean, seq: number): Promise<void> {
  const network = budgetNetwork();
  const title = "Your agents · Keyfence";
  const accounts = connected?.accounts ?? [];
  budgetState = null;
  agentsView = null;
  if (accounts.length === 0) {
    paint(renderMyAgentsSignedOut(), title, focusMain, network, "my-agents");
    return;
  }
  paint(renderMyAgentsLoading(accounts), title, focusMain, network, "my-agents");
  try {
    const data = await readMyAgents(accounts, BUDGET_READ_FACTORY, network);
    const cards = await readAgentBudgets(data.budgetDaos, BUDGET_READ_FACTORY, network);
    if (seq !== scanSeq) return;
    paintMyAgents({ data, accounts: [...accounts], cards }, false);
  } catch (e) {
    if (seq !== scanSeq) return;
    console.error("my agents read failed", { error: e });
    paint(renderMyAgentsError("We could not read your budgets right now. Nothing was changed.", accounts), title, false, network, "my-agents");
  }
}

/** Reads one budget again after its card failed, then paints the page with the new card. */
async function retryAgentBudget(button: HTMLElement): Promise<void> {
  const dao = button.dataset.dao;
  const view = agentsView;
  if (dao === undefined || view === null) return;
  const [card] = await readAgentBudgets([dao], BUDGET_READ_FACTORY, budgetNetwork());
  if (agentsView !== view || card === undefined) return;
  if (card.live === null) {
    const status = document.getElementById("budget-status");
    if (status !== null) status.textContent = "Still could not read that budget. Try again in a moment.";
    return;
  }
  paintMyAgents({ ...view, cards: view.cards.map((c) => (c.dao === dao ? card : c)) }, false);
}

/** Your agents: points the Approve and Reject flow at the budget of the row that was pressed. */
function selectAgentBudget(button: HTMLElement): void {
  const live = agentsView?.cards.find((c) => c.dao === button.dataset.dao)?.live ?? null;
  if (live !== null) budgetState = live;
}

/** Shows the waiting rows past the first five. */
function showAllWaiting(button: HTMLElement): void {
  for (const row of document.querySelectorAll<HTMLElement>("[data-inbox-extra]")) row.hidden = false;
  button.remove();
}

function openAlerts(trigger: HTMLElement): void {
  const drawer = document.getElementById("alerts-drawer") as HTMLDialogElement | null;
  if (drawer === null) return;
  drawer.innerHTML = renderAlertsDrawer(alertsTarget()).value;
  dialogTrigger = trigger;
  drawer.showModal();
}

function openBudgetPanel(panel: BudgetPanel, trigger: HTMLElement): void {
  if (budgetState === null) return;
  showBudgetDrawer(renderBudgetPanel(panel, budgetState, null, budgetPanelValues(panel, budgetState)), trigger, isModalPanel(panel));
  document.querySelector<HTMLElement>("#budget-panel-form :is(input:not([type=hidden]), select)")?.focus();
}

/** Opens the Budget pop-up with `content`: a centred dialog for a short confirm, a right-side drawer for a form. */
function showBudgetDrawer(content: Html, trigger: HTMLElement, modal = false): void {
  const box = document.getElementById("budget-action") as HTMLDialogElement | null;
  if (box === null) return;
  box.className = modal ? "modal" : "drawer";
  box.innerHTML = content.value;
  dialogTrigger = trigger;
  if (!box.open) box.showModal();
}

/** Status lines live on the page, so the drawer closes before signing starts. */
const closeBudgetDrawer = (): void => (document.getElementById("budget-action") as HTMLDialogElement | null)?.close();

const budgetPanelTo = (): Record<string, string> => (connected?.accounts[0] === undefined ? {} : { to: connected.accounts[0] });

/** What a pop-up starts with: the connected account, and for Top up the reason the chain check already blocks it. */
function budgetPanelValues(panel: BudgetPanel, state: BudgetLive): Record<string, string> {
  const values = budgetPanelTo();
  const guardId = state.guard?.guard_id;
  if (panel === "topup" && connected !== null && guardId !== undefined) {
    const registry = state.dao.guards.map((g) => g.guard_id);
    const blocks = topUpBlocks(state.dao.policy, connected.accounts[0] ?? "", guardId, registry);
    const sender = connected.accounts.find((a) => topUpBlocks(state.dao.policy, a, guardId, registry).length === 0);
    if (sender === undefined && blocks.length > 0) values.blocked = blocks.map((b) => TOP_UP_TEXT[b]).join(" ");
    else if (sender !== undefined) values.to = sender;
  }
  return values;
}

function openBudgetApprove(button: HTMLElement): void {
  const state = budgetState;
  const proposal = state?.proposals?.find((p) => p.id === Number(button.dataset.id));
  if (state === null || proposal === undefined) return;
  showBudgetDrawer(renderBudgetApprove(proposal, state), button, true);
}

function openBudgetAgent(button: HTMLElement): void {
  const state = budgetState;
  const agent = state?.guard?.agents?.find((a) => a.account_id === button.dataset.agent);
  if (state === null || agent === undefined) return;
  showBudgetDrawer(renderBudgetAgent(agent, state), button);
}

function openBudgetPause(button: HTMLElement): void {
  if (budgetState === null) return;
  showBudgetDrawer(renderBudgetPause(budgetState), button, true);
}

/** Edit the fence: Save stays off until a value changes, a per-payment limit above the daily one is named, and the sentence follows what is typed. */
function syncBudgetFence(form: HTMLFormElement): void {
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement | null;
  const inputs = ["maxPerTx", "maxPerDay", "maxPending", "minReserve"].map(input);
  const changed = inputs.some((i) => i !== null && `${i.value.trim()}${i.dataset.was?.endsWith(" NEAR") === true ? " NEAR" : ""}` !== (i.dataset.was ?? ""));
  const perTx = Number(input("maxPerTx")?.value);
  const perDay = Number(input("maxPerDay")?.value);
  const bad = Number.isFinite(perTx) && Number.isFinite(perDay) && perTx > perDay;
  const error = document.getElementById("bp-fence-error");
  if (error !== null) error.hidden = !bad;
  const save = form.querySelector<HTMLButtonElement>('[type="submit"]');
  if (save !== null) save.disabled = !changed || bad;
  const summary = document.getElementById("bp-summary");
  if (summary !== null) {
    const count = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
    summary.textContent = fenceSentence(count(summary.dataset.agents), `${input("maxPerDay")?.value.trim()} NEAR`, `${input("maxPerTx")?.value.trim()} NEAR`, count(summary.dataset.recipients));
  }
}

/** Repaints Activity with one chip pressed. A summary tile also brings it into view. */
function filterBudgetActivity(el: HTMLElement): void {
  const box = document.getElementById("budget-activity");
  const filter = el.dataset.filter;
  if (box === null || budgetState === null || !(filter === "all" || filter === "waiting" || filter === "auto" || filter === "rejected")) return;
  const fromTile = el.classList.contains("tile");
  box.outerHTML = renderBudgetActivity(budgetState, filter).value;
  const next = document.getElementById("budget-activity");
  if (fromTile) next?.scrollIntoView({ block: "nearest" });
  else next?.querySelector<HTMLElement>(`[data-filter="${filter}"]`)?.focus();
}

function syncBudgetAfter(): void {
  const input = document.getElementById("bp-amount") as HTMLInputElement | null;
  const after = document.getElementById("bp-after");
  const panel = input?.form?.dataset.panel;
  if (input === null || after === null || budgetState === null || !(panel === "topup" || panel === "withdraw")) return;
  after.textContent = balanceAfter(budgetState, panel, input.value);
}

/** Resume is `unpause`, which only the DAO may call: a Guard change proposal, two signatures. */
function resumeBudget(): void {
  const guardId = budgetState?.guard?.guard_id;
  if (guardId !== undefined) startTwoSignatures(guardChangeProposal(guardId, "unpause", {}));
}

/** Cautious and Balanced reset the rule fields to their numbers; Custom shows them. */
function chooseBudgetPreset(button: HTMLElement): void {
  const form = button.closest("form");
  const chosen = button.dataset.preset ?? "balanced";
  const custom = chosen === "custom";
  if (form === null) return;
  const preset = form.elements.namedItem("preset") as HTMLInputElement | null;
  if (preset !== null) preset.value = chosen;
  for (const b of form.querySelectorAll<HTMLElement>('[data-action="budget-preset"]')) b.setAttribute("aria-pressed", String(b === button));
  const fields = document.getElementById("bs-custom");
  if (fields !== null) fields.hidden = !custom;
  if (custom) return;
  for (const [name, value] of Object.entries(chosen === "cautious" ? CAUTIOUS_RULES : BALANCED_RULES)) {
    const input = form.elements.namedItem(name) as HTMLInputElement | null;
    if (input !== null) input.value = value;
  }
}

/** Applies `change` to the recipient lines held in the form's hidden whitelist field and repaints the list. */
function changeBudgetRecipients(change: (lines: string[]) => string[]): void {
  const field = document.querySelector<HTMLTextAreaElement>('#budget-setup-form textarea[name="whitelist"]');
  const list = document.getElementById("bs-recipients");
  if (field === null || list === null) return;
  field.value = change(field.value.split("\n").filter((l) => l.trim() !== "")).join("\n");
  list.innerHTML = renderRecipients(field.value).value;
}

function addBudgetRecipient(): void {
  const input = document.getElementById("bs-recipient") as HTMLInputElement | null;
  const account = input?.value.trim() ?? "";
  if (input === null || account === "") return;
  changeBudgetRecipients((lines) => [...lines, account]);
  input.value = "";
  input.focus();
}

/** Says whether the typed Budget name is free. Anything but a clear answer from the chain says nothing. */
async function checkBudgetName(input: HTMLInputElement): Promise<void> {
  const message = document.getElementById("b-name-msg");
  const name = input.value.trim();
  if (message === null) return;
  message.textContent = "";
  message.className = "small";
  if (!/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(name)) return;
  const rpc = budgetRpc(budgetNetwork());
  try {
    const { height } = await rpc.block();
    const taken = await accountExists(rpc, `${name}.${SPUTNIK_FACTORY}`, height);
    if (input.value.trim() !== name) return;
    message.textContent = taken ? "This name is taken" : "Name is free";
    message.classList.add(taken ? "text-high" : "text-ok");
  } catch {
    // Unknown stays unsaid; the check before signature 1 still runs.
  }
}

const isBudgetPanel = (v: unknown): v is BudgetPanel => v === "topup" || v === "withdraw" || v === "rules" || v === "add-agent" || v === "recipients" || v === "plan";

/** The owner-action form: validates, then starts the one-signature Top up or the two-signature flow. */
function submitBudgetPanel(form: HTMLFormElement): void {
  const state = budgetState;
  const panel = form.dataset.panel;
  const status = budgetStatus();
  if (state === null || state.guard === null || status === null || !isBudgetPanel(panel)) return;
  const values = Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));
  const reject = (error: string) => {
    form.outerHTML = renderBudgetPanel(panel, state, error, { ...values, ...budgetPanelTo() }).value;
    document.querySelector<HTMLElement>("#budget-panel-form :is(input:not([type=hidden]), select)")?.focus();
  };
  const guardId = state.guard.guard_id;
  if (panel === "plan") {
    const now = Date.now();
    const result = planFromForm(values, state.guard, now);
    if (!result.ok) return reject(result.error);
    if (values.step !== "confirm") {
      form.outerHTML = renderBudgetPanel("plan", state, null, { ...values, step: "confirm" }, now).value;
      document.querySelector<HTMLElement>('#budget-panel-form [type="submit"]')?.focus();
      return;
    }
    closeBudgetDrawer();
    startTwoSignatures(createPlanProposal(guardId, result.value));
    return;
  }
  if (panel === "add-agent") {
    void addBudgetAgent(state, guardId, (values.label ?? "").trim(), reject);
    return;
  }
  if (panel === "rules") {
    const result = rulesProposal(guardId, values);
    if (!result.ok) return reject(result.error);
    closeBudgetDrawer();
    startTwoSignatures(result.value);
    return;
  }
  if (panel === "recipients") {
    const result = addRecipientProposal(guardId, values, (state.guard.whitelist ?? []).map((w) => w.account_id));
    if (!result.ok) return reject(result.error);
    closeBudgetDrawer();
    startTwoSignatures(result.value);
    return;
  }
  const amount = amountFromForm(values.amount ?? "", panel === "withdraw" ? state.withdrawable : null);
  if (!amount.ok) return reject(amount.error);
  closeBudgetDrawer();
  if (panel === "withdraw") {
    if (connected === null) return statusWithButton(status, "Connect the owner's wallet first.", "open-wallet", "Connect Wallet");
    const to = connected.accounts.find((a) => missingProposePermissions(state.dao.policy, a, ["transfer"]).length === 0);
    if (to === undefined) {
      status.textContent = `${connected.accounts[0] ?? "This account"} may not withdraw from ${state.dao.dao}. Switch to the owner's account.`;
      return;
    }
    startTwoSignatures({ proposal: withdrawProposal(to, amount.value.yocto, amount.value.near) });
    return;
  }
  void topUpBudget(state, guardId, amount.value, status);
}

/** One plain transfer, only after the roles as they are now, not at page load, show one owner and the DAO's own Guard (§11.10.4). */
async function topUpBudget(state: BudgetLive, guardId: string, amount: { yocto: string; near: string }, status: HTMLElement): Promise<void> {
  if (connected === null) return statusWithButton(status, "Connect your wallet first.", "open-wallet", "Connect Wallet");
  const { accounts, walletId } = connected;
  const network = budgetNetwork();
  const registry = state.dao.guards.map((g) => g.guard_id);
  status.textContent = "Checking who controls this Budget on the chain…";
  try {
    const { policy } = await readNewDao(state.dao.dao, network);
    const sender = accounts.find((a) => topUpBlocks(policy, a, guardId, registry).length === 0);
    if (sender === undefined) {
      status.textContent = topUpBlocks(policy, accounts[0] ?? "", guardId, registry).map((b) => TOP_UP_TEXT[b]).join(" ");
      return;
    }
    status.textContent = `Waiting for ${walletLabel(walletId)}. Check the transfer there before you approve.`;
    const wallet = await import("./wallet.ts");
    await wallet.signTopUp(sender, network, state.dao.dao, amount.yocto, walletId, (t) => (status.textContent = t));
    statusWithButton(status, `Done: ${amount.near} NEAR sent to ${state.dao.dao}.`, "rescan", "Reload");
  } catch (e) {
    notDone(status, e);
  }
}

/** Add an agent. Its account and key come first, because the proposal carries the public key. */
async function addBudgetAgent(state: BudgetLive, guardId: string, label: string, reject: (error: string) => void): Promise<void> {
  const problem = addAgentProblem(label, (state.guard?.agents ?? []).map((a) => a.account_id), state.withdrawable);
  if (problem !== null) return reject(problem);
  const rpc = budgetRpc(budgetNetwork());
  try {
    const { height } = await rpc.block();
    const account = await freshAgentAccount(guardId, (id) => accountExists(rpc, id, height));
    if (account === null) return reject("No free agent name is left for this Budget.");
    const key = (await import("./wallet.ts")).newAgentKey();
    closeBudgetDrawer();
    startTwoSignatures(addAgentProposal(guardId, account, label, key.publicKey), { account, key });
  } catch {
    reject("Could not read the chain. Try again.");
  }
}

/** Enable, disable or remove an agent: a Guard change proposal, two signatures. */
function changeBudgetAgent(button: HTMLButtonElement): void {
  const guardId = budgetState?.guard?.guard_id;
  if (guardId === undefined) return;
  const proposal = agentProposal(guardId, button.dataset.op ?? "", button.dataset.agent ?? "");
  if (proposal !== null) startTwoSignatures(proposal);
}

function dropBudgetRecipient(account: string): void {
  const guardId = budgetState?.guard?.guard_id;
  if (guardId !== undefined && account !== "") startTwoSignatures(guardChangeProposal(guardId, "remove_whitelist", { account_id: account }));
}

const budgetSetupStatus = (): HTMLElement | null => document.getElementById("budget-setup-status");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** False only when the chain says the account does not exist; any other failure is not an answer. */
async function accountExists(rpc: Rpc, id: string, height: number): Promise<boolean> {
  try {
    await rpc.viewAccount(id, height);
    return true;
  } catch (e) {
    if (isKdError(e) && e.kd.code === "NOT_FOUND") return false;
    throw e;
  }
}

/** The DAO's policy and proposal count, for `firstSignatureProblem`. */
async function readNewDao(dao: string, network: Network): Promise<{ policy: RawPolicy; last: number }> {
  const rpc = budgetRpc(network);
  const { height } = await rpc.block();
  const [policy, last] = await Promise.all([rpc.callFunction(dao, height, "get_policy", {}), rpc.callFunction(dao, height, "get_last_proposal_id", {})]);
  return { policy: policy as RawPolicy, last: Number(last) };
}

/** What sign 2 left on the chain. A read that fails stays null, which `budgetCheckFailures` counts as not passed. */
async function readBudgetChain(plan: BudgetPlan, network: Network): Promise<BudgetChain> {
  const rpc = budgetRpc(network);
  const quiet = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const head = await quiet(rpc.block());
  if (head === null) return { guardDao: null, guardKeys: null, agentKeys: null, policy: null };
  const agent = plan.args.agents[0]?.account_id ?? "";
  const [info, guardKeys, agentKeys, policy] = await Promise.all([
    quiet(rpc.callFunction(plan.guardId, head.height, "kd_guard_info", {})),
    quiet(rpc.viewAccessKeyList(plan.guardId, head.height)),
    quiet(rpc.viewAccessKeyList(agent, head.height)),
    quiet(rpc.callFunction(plan.dao, head.height, "get_policy", {})),
  ]);
  return { guardDao: (info as { dao_id?: string } | null)?.dao_id ?? null, guardKeys, agentKeys, policy: policy as RawPolicy | null };
}

/** Checks the form, then what the chain already holds, and offers the signature that comes next. */
async function submitBudgetSetup(form: HTMLFormElement): Promise<void> {
  // After sign 2 the status line holds the only copy of the agent key: nothing may repaint it.
  if (budgetCreation?.key) return;
  budgetCreation = null;
  const data = new FormData(form);
  const get = (name: string) => String(data.get(name) ?? "");
  const values = Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v)]));
  const repaint = (errors: GuardFormError[], result: string | null): void => {
    const current = document.getElementById("budget-setup-form");
    if (current) current.outerHTML = renderBudgetSetup(BUDGET_FACTORY !== "", values, errors, result).value;
    document.querySelector<HTMLElement>('#budget-setup-form [aria-invalid="true"]')?.focus();
  };
  // Code storage is the factory's to report; before reading it the funding check covers the minimum only.
  const rules = planBudget(get, null, BUDGET_FACTORY || BUDGET_FACTORY_NAME, "0");
  if (!rules.ok) {
    repaint(rules.errors, null);
    return;
  }
  if (BUDGET_FACTORY === "") {
    repaint([], `Your rules are valid. Creating the budget is not available yet: ${BUDGET_FACTORY_NAME} is not deployed.`);
    return;
  }
  repaint([], null);
  const status = budgetSetupStatus();
  if (status === null) return;
  const wallet = connected;
  const account = wallet?.accounts[0];
  if (wallet === null || account === undefined) {
    statusWithButton(status, "Your rules are valid. Connect the wallet that will own this budget.", "open-wallet", "Connect Wallet");
    return;
  }
  status.textContent = "Reading the chain…";
  try {
    const network = budgetNetwork();
    const rpc = budgetRpc(network);
    const { height } = await rpc.block();
    const factory = (await rpc.callFunction(BUDGET_FACTORY, height, "kd_factory_metadata", {})) as { guard_code_storage: string };
    const planned = planBudget(get, account, BUDGET_FACTORY, factory.guard_code_storage);
    if (!planned.ok) {
      repaint(planned.errors, null);
      return;
    }
    const { plan } = planned;
    if (await accountExists(rpc, plan.guardId, height)) {
      status.textContent = `The name ${plan.name} is taken: ${plan.guardId} already exists. Choose another name.`;
      return;
    }
    const resume = await accountExists(rpc, plan.dao, height);
    if (resume) {
      const dao = await readNewDao(plan.dao, network);
      const problem = firstSignatureProblem(dao.policy, dao.last, account);
      if (problem !== null) {
        status.textContent = `The name ${plan.name} is taken by ${plan.dao}. ${problem}`;
        return;
      }
      const held = await readBalance(plan.dao, height, network);
      if (held === null || BigInt(held.withdrawable) < BigInt(plan.guardDepositYocto)) {
        status.textContent = `${plan.dao} needs ${yoctoToNear(plan.guardDepositYocto)} NEAR free to finish the Budget and ${held === null ? "its balance could not be read" : `has ${yoctoToNear(held.withdrawable)} NEAR`}. Lower the funding, or send it more.`;
        return;
      }
    }
    budgetCreation = { plan, account, walletId: wallet.walletId, key: null };
    const waits = plan.args.whitelist.length === 0 ? " With no allowed receivers, every request waits for your approval." : "";
    if (resume) statusWithButton(status, `${plan.dao} is already yours and not finished yet. Signature 2 attaches 0.2 NEAR of bonds, which come back.${waits}`, "budget-guard", "Sign signature 2 of 2");
    else statusWithButton(status, `Your rules are valid. Signature 1 sends ${yoctoToNear(plan.firstDepositYocto)} NEAR to your new Budget, ${plan.dao}. Signature 2 attaches 0.2 NEAR of bonds, which come back.${waits}`, "budget-create", "Sign signature 1 of 2");
  } catch (e) {
    if (!isKdError(e)) console.error("budget setup read failed", { error: e });
    status.textContent = `Not done: could not read the chain. ${isKdError(e) ? e.kd.message.en : "Try again later."}`;
  }
}

/** Sign 1: the DAO. It holds the money from here on, so nothing is offered until the chain shows it is the owner's alone. */
async function signBudgetCreate(button: HTMLButtonElement): Promise<void> {
  const creation = budgetCreation;
  const status = budgetSetupStatus();
  if (creation === null || status === null) return;
  const { plan, account, walletId } = creation;
  const network = budgetNetwork();
  button.disabled = true;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Signature 1 of 2: check the transaction there before you approve.`;
  try {
    const { signBudgetDao } = await import("./wallet.ts");
    await signBudgetDao(account, network, SPUTNIK_FACTORY, sputnikCreateArgs(plan.name, account), plan.firstDepositYocto, walletId, (step) => (status.textContent = step));
  } catch (e) {
    notDone(status, e);
    return;
  }
  status.textContent = "Checking the new Budget…";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dao = await readNewDao(plan.dao, network).catch(() => null);
    if (budgetCreation !== creation) return;
    if (dao !== null) {
      const problem = firstSignatureProblem(dao.policy, dao.last, account);
      if (problem !== null) status.textContent = `Stopped before signature 2: ${problem}`;
      else statusWithButton(status, `${plan.dao} is created and only your account controls it.`, "budget-guard", "Sign signature 2 of 2");
      return;
    }
    await sleep(1500);
  }
  status.textContent = `Signature 1 was sent, but ${plan.dao} cannot be read yet. Press Create Agent Budget to continue from where it stopped.`;
}

/** Sign 2: the Guard, the agent and the role. Only the chain can say it worked, because Sputnik shows a failed call as Approved. */
async function signBudgetGuard(button: HTMLButtonElement): Promise<void> {
  const creation = budgetCreation;
  const status = budgetSetupStatus();
  if (creation === null || status === null) return;
  const { plan, account, walletId } = creation;
  const network = budgetNetwork();
  button.disabled = true;
  status.textContent = "Reading the Budget again…";
  let signBudgetCalls: typeof import("./wallet.ts").signBudgetCalls;
  let key: { publicKey: string; privateKey: string };
  let calls: ReturnType<typeof secondSignatureCalls>;
  try {
    const dao = await readNewDao(plan.dao, network);
    const problem = firstSignatureProblem(dao.policy, dao.last, account);
    if (problem !== null) throw new Error(problem);
    const wallet = await import("./wallet.ts");
    signBudgetCalls = wallet.signBudgetCalls;
    key = wallet.newAgentKey();
    calls = secondSignatureCalls(plan, BUDGET_FACTORY, dao.policy, key.publicKey);
  } catch (e) {
    notDone(status, e);
    return;
  }
  // Before the wallet opens: an answer lost on the way back must not lose the key of an agent that now exists.
  creation.key = key;
  agentKeyHref = location.href;
  status.textContent = `Waiting for ${walletLabel(walletId)}. Signature 2 of 2: check the transaction there before you approve.`;
  let signError: unknown = null;
  try {
    await signBudgetCalls(account, network, plan.dao, calls, walletId, (step) => (status.textContent = step));
  } catch (e) {
    signError = e instanceof Error ? e : new Error("the wallet did not sign.");
  }
  status.textContent = "Checking the chain…";
  let chain = await readBudgetChain(plan, network);
  let failures = budgetCheckFailures(plan, key.publicKey, chain);
  for (let attempt = 0; failures.length > 0 && attempt < (signError === null ? 5 : 2); attempt += 1) {
    await sleep(2000);
    chain = await readBudgetChain(plan, network);
    failures = budgetCheckFailures(plan, key.publicKey, chain);
  }
  if (budgetCreation !== creation) return;
  if (signError !== null && !chain.agentKeys?.some((k) => k.publicKey === key.publicKey)) {
    creation.key = null;
    notDone(status, signError);
    return;
  }
  const agent = plan.args.agents[0]?.account_id ?? "";
  status.innerHTML = renderBudgetKey(agent, plan.guardId, plan.dao, network, failures.length === 0 ? null : failures.join("; ")).value;
  document.querySelector<HTMLButtonElement>('#budget-setup-form button[type="submit"]')?.setAttribute("disabled", "");
}

/** Saves the agent's key as a file. It is never shown: a file goes straight to where the agent runs. */
function downloadAgentKey(): void {
  const creation = budgetCreation;
  const account = budgetNewAgent?.account ?? creation?.plan.args.agents[0]?.account_id;
  const key = budgetNewAgent?.key ?? creation?.key;
  if (!key || account === undefined) return;
  savedAgentKey = key.publicKey;
  const url = URL.createObjectURL(new Blob([agentKeyFile(account, key)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${account}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** The Agent Guard page: the DAO form, or the DAO's Guards read live. Guards exist only on the factory's network. */
async function renderGuard(dao: string | null, focusMain: boolean, seq: number): Promise<void> {
  const network = suffixNetwork(GUARD_FACTORY) ?? "testnet";
  guardState = null;
  guardPreview = null;
  const title = "Agent Guard · Keyfence";
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
  const values = Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v)]));
  // Repaint on every submit: a valid one must drop the last errors, an invalid one must drop the last preview,
  // or its Sign button would sign values the form no longer holds.
  form.outerHTML = renderGuardCreate(guardState.factory, values, result.ok ? [] : result.errors).value;
  if (!result.ok) {
    guardPreview = null;
    document.getElementById("guard-preview")?.replaceChildren();
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
  if (!mayDropAgentKey()) return;
  history.pushState(null, "", href);
  window.scrollTo(0, 0);
  void render(true);
}

/** What the bell's /watch line names: the report or Budget on screen, else null. */
function alertsTarget(): string | null {
  const route = parseRoute(location.search);
  return route.target ?? route.dao;
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
    case "yield-open":
      openYieldPanel(el.dataset.panel === "withdraw" ? "withdraw" : el.dataset.panel === "register" ? "register" : "supply", el);
      break;
    case "yield-max": {
      const input = document.getElementById("yp-amount") as HTMLInputElement | null;
      if (input !== null) input.value = el.dataset.amount ?? "";
      input?.focus();
      break;
    }
    case "yield-sign":
      signYieldProposal(el.dataset.panel === "register" ? "register" : "withdraw", "", el);
      break;
    case "yield-vote":
      voteYield(el as HTMLButtonElement);
      break;
    case "agents-show-all":
      showAllWaiting(el);
      break;
    case "agents-retry":
      void retryAgentBudget(el);
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
      if (isBudgetPanel(el.dataset.panel)) openBudgetPanel(el.dataset.panel, el);
      break;
    case "budget-approve":
      selectAgentBudget(el);
      openBudgetApprove(el);
      break;
    case "budget-agent-open":
      openBudgetAgent(el);
      break;
    case "budget-filter":
      filterBudgetActivity(el);
      break;
    case "budget-resume":
      resumeBudget();
      break;
    case "budget-preset":
      chooseBudgetPreset(el);
      break;
    case "budget-recipient-add":
      addBudgetRecipient();
      break;
    case "budget-recipient-remove":
      changeBudgetRecipients((lines) => lines.filter((_, i) => i !== Number(el.dataset.line)));
      break;
    case "budget-pause":
      openBudgetPause(el);
      break;
    case "budget-pause-now": {
      closeBudgetDrawer();
      const pageButton = document.querySelector<HTMLButtonElement>('.budget-top [data-action="budget-pause"]');
      pauseBudget(pageButton ?? (el as HTMLButtonElement));
      break;
    }
    case "budget-chip": {
      const input = document.getElementById("bp-amount") as HTMLInputElement | null;
      if (input !== null) {
        input.value = el.dataset.amount ?? "";
        input.focus();
      }
      syncBudgetAfter();
      break;
    }
    case "budget-full": {
      const input = document.getElementById("bp-amount") as HTMLInputElement | null;
      if (input !== null) input.value = el.dataset.amount ?? "";
      syncBudgetAfter();
      break;
    }
    case "budget-act":
      selectAgentBudget(el);
      closeBudgetDrawer();
      actOnPending(el as HTMLButtonElement);
      break;
    case "budget-agent":
      closeBudgetDrawer();
      changeBudgetAgent(el as HTMLButtonElement);
      break;
    case "budget-plan": {
      const guardId = budgetState?.guard?.guard_id;
      const proposal = guardId === undefined ? null : planChangeProposal(guardId, el.dataset.op ?? "", Number(el.dataset.plan));
      if (proposal !== null) startTwoSignatures(proposal);
      break;
    }
    case "budget-plan-edit": {
      const form = el.closest("form");
      if (form === null || budgetState === null) break;
      const values = Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));
      form.outerHTML = renderBudgetPanel("plan", budgetState, null, { ...values, step: "edit" }).value;
      document.querySelector<HTMLElement>("#bp-receiver")?.focus();
      break;
    }
    case "budget-recipient-drop":
      closeBudgetDrawer();
      dropBudgetRecipient(el.dataset.account ?? "");
      break;
    case "budget-sign2":
      signSecondSignature(el as HTMLButtonElement);
      break;
    case "budget-create":
      void signBudgetCreate(el as HTMLButtonElement);
      break;
    case "budget-guard":
      void signBudgetGuard(el as HTMLButtonElement);
      break;
    case "budget-key":
      downloadAgentKey();
      break;
    case "alerts-open":
      openAlerts(el);
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
  // The account menu is a <details>: it closes on any click outside it.
  const menu = root.querySelector<HTMLDetailsElement>(".wallet-menu[open]");
  if (menu !== null && !(t instanceof Node && menu.contains(t))) menu.open = false;
});
root.addEventListener(
  "close",
  () => {
    dialogTrigger?.focus();
    dialogTrigger = null;
  },
  true,
);

root.addEventListener("input", (event) => {
  const el = event.target as HTMLElement;
  if (el.id === "bp-amount") syncBudgetAfter();
  const fence = el.closest<HTMLFormElement>('#budget-panel-form[data-panel="rules"]');
  if (fence !== null) syncBudgetFence(fence);
  if (el.id === "approve-check") {
    const input = el as HTMLInputElement;
    const confirm = input.closest("dialog")?.querySelector<HTMLButtonElement>('[data-vote="VoteApprove"]');
    if (confirm) confirm.disabled = input.value.trim() !== input.dataset.expect;
  }
});

root.addEventListener("change", (event) => {
  const el = event.target as HTMLElement;
  if (el.id === "bs-name") void checkBudgetName(el as HTMLInputElement);
});

root.addEventListener("keydown", (event) => {
  // Enter in the recipient box adds the line instead of submitting the whole form.
  if (event.key === "Enter" && (event.target as HTMLElement).id === "bs-recipient") {
    event.preventDefault();
    addBudgetRecipient();
  }
});

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
  if (form.id === "yield-dao-form") {
    event.preventDefault();
    navigate(yieldHref(String(new FormData(form).get("dao") ?? "").trim()));
    return;
  }
  if (form.id === "yield-panel-form") {
    event.preventDefault();
    signYieldProposal("supply", String(new FormData(form).get("amount") ?? ""), form);
    return;
  }
  if (form.id === "budget-panel-form") {
    event.preventDefault();
    submitBudgetPanel(form);
    return;
  }
  if (form.id === "budget-setup-form") {
    event.preventDefault();
    void submitBudgetSetup(form);
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

window.addEventListener("popstate", () => {
  // The URL has already moved: staying means putting the key's page back on top.
  if (!mayDropAgentKey()) {
    if (agentKeyHref !== null) history.pushState(null, "", agentKeyHref);
    return;
  }
  void render(true, false);
});
// Reload, closing the tab or typing a new address: the browser shows its own wording for this.
window.addEventListener("beforeunload", (event) => {
  if (!agentKeyAtRisk()) return;
  event.preventDefault();
  event.returnValue = "";
});

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => revealClampToggles(root), 150);
});
void render(false);
