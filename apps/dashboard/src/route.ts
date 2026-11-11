import { resolveTarget, type Network } from "key-doctor";

export const BOT_USERNAME = "KeyDoctorOnCallBot";
export const BOT_URL = `https://t.me/${BOT_USERNAME}`;

export type Page = "check" | "mcp" | "guard" | "budget" | "my-agents" | "yield" | "roadmap";

/** What a link asks the page to open once, after it has painted (docs/final-idea.md §10.1, §10.5). */
export type RouteLink =
  | { kind: "alerts" }
  | { kind: "add-agent" }
  | { kind: "approve"; id: number }
  | { kind: "topup"; token: string; amount: string | null }
  | { kind: "strategy"; id: string }
  | { kind: "plan"; id: number };

export interface Route {
  /** The nav page: `?page=` without a target; any `?target=` is the Check page. */
  page: Page;
  /** Normalized account id, or null for the home page. */
  target: string | null;
  /** The raw `?target=` value when it is not a valid account id. */
  invalid: string | null;
  /** The DAO whose council the account was opened from. */
  from: string | null;
  /** The Agent Guard, Agent Budget or Yield agent page's DAO (`?page=guard&dao=`, `?page=budget&dao=`, `?page=yield&dao=`), or null. */
  dao: string | null;
  view: "report" | "cleanup";
  level: "safe" | "full";
  /**
   * With a target: the network it is scanned on (the name suffix wins, `?network=` only matters for an
   * implicit account). On the home page: the `?network=` switch value, or null when the URL has none.
   */
  network: Network | null;
  link: RouteLink | null;
  /** `?page=budget&help=agent`: the "How your agent works" page. */
  help: boolean;
  /** `?page=yield&new=1`: the New yield agent wizard. */
  yieldNew: boolean;
}

const NETWORK_SUFFIX: Record<Network, string> = { mainnet: ".near", testnet: ".testnet" };

const parseNetwork = (raw: string | null): Network | null => (raw === "mainnet" || raw === "testnet" ? raw : null);

/** The network a name's suffix fixes, or null for an implicit account or a top-level name. */
export function suffixNetwork(id: string): Network | null {
  if (id.endsWith(NETWORK_SUFFIX.testnet)) return "testnet";
  if (id.endsWith(NETWORK_SUFFIX.mainnet)) return "mainnet";
  return null;
}

const normalize = (raw: string): string | null => {
  try {
    return resolveTarget(raw).id;
  } catch {
    return null;
  }
};

/** The old pages and the deep links; anything malformed opens nothing rather than the wrong thing. */
function parseLink(p: string | null, params: URLSearchParams): RouteLink | null {
  if (p === "oncall") return { kind: "alerts" };
  if (p === "agents") return { kind: "add-agent" };
  if (p !== "budget") return null;
  const approve = params.get("approve");
  if (approve !== null && /^\d{1,15}$/.test(approve)) return { kind: "approve", id: Number(approve) };
  const plan = params.get("plan");
  if (plan !== null && /^\d{1,9}$/.test(plan)) return { kind: "plan", id: Number(plan) };
  const strategy = params.get("strategy");
  if (strategy !== null && /^[a-z0-9-]{1,64}$/.test(strategy)) return { kind: "strategy", id: strategy };
  const token = params.get("topup");
  if (token === null || token.trim() === "") return null;
  const amount = params.get("amount");
  return { kind: "topup", token: token.trim().toLowerCase(), amount: amount !== null && /^\d+(\.\d+)?$/.test(amount) ? amount : null };
}

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const raw = params.get("target");
  const view = params.get("view") === "cleanup" ? "cleanup" : "report";
  const level = params.get("level") === "full" ? "full" : "safe";
  const network = parseNetwork(params.get("network"));
  const p = params.get("page");
  const daoRaw = p === "guard" || p === "budget" || p === "agents" || p === "yield" ? params.get("dao") : null;
  const dao = daoRaw === null ? null : normalize(daoRaw);
  const page = raw === null ? pageOf(p, dao) : "check";
  const link = raw === null ? parseLink(p, params) : null;
  const help = raw === null && p === "budget" && params.get("help") === "agent";
  const yieldNew = raw === null && p === "yield" && params.get("new") === "1";
  if (raw === null || raw.trim() === "") return { page, target: null, invalid: null, from: null, dao, view: "report", level, network, link, help, yieldNew };
  const target = normalize(raw);
  if (target === null) return { page: "check", target: null, invalid: raw, from: null, dao: null, view: "report", level, network, link: null, help: false, yieldNew: false };
  const fromRaw = params.get("from");
  const from = fromRaw === null ? null : normalize(fromRaw);
  return {
    page: "check",
    target,
    invalid: null,
    from: from === target ? null : from,
    dao: null,
    view,
    level,
    network: suffixNetwork(target) ?? network ?? "testnet",
    link: null,
    help: false,
    yieldNew: false,
  };
}

/**
 * The old nav pages live on as links (§10.1): On Call is the bell drawer over Key Check, Agents and Agent Guard are
 * Agent Budget. `?page=guard&dao=` stays the council page: the README documents it and a many-member DAO has no other.
 */
function pageOf(p: string | null, dao: string | null): Page {
  if (p === "mcp" || p === "budget" || p === "my-agents" || p === "yield" || p === "roadmap") return p;
  if (p === "agents") return "budget";
  if (p === "guard") return dao === null ? "budget" : "guard";
  return "check";
}

/** Where a one-shot link settles, so a reload or a rescan does not open its drawer again. */
export function settledHref(route: Route): string {
  if (route.page !== "budget") return homeHref(route.network ?? "testnet");
  return route.dao === null ? pageHref("budget") : budgetHref(route.dao);
}

/**
 * What the home form submits: the typed name on the network the switch picks. A named account without a
 * `.near` / `.testnet` suffix gets the suffix of that network; a suffix the user typed always wins.
 * Throws the library's INVALID_TARGET error for a name that is not an account id.
 */
export function resolveInput(raw: string, network: Network): { id: string; network: Network } {
  const { id, kind } = resolveTarget(raw);
  const own = suffixNetwork(id);
  if (own !== null) return { id, network: own };
  if (kind === "implicit") return { id, network };
  return { id: resolveTarget(id + NETWORK_SUFFIX[network]).id, network };
}

/**
 * The `?target=` deep link, also used by the bot's "View on dashboard". `network` is written only for a
 * target whose name has no network suffix (an implicit account); a suffixed name carries its own.
 */
export function routeHref(target: string, from?: string | null, network?: Network | null): string {
  const params = new URLSearchParams({ target });
  if (from) params.set("from", from);
  if (network && suffixNetwork(target) === null) params.set("network", network);
  return `?${params.toString()}`;
}

/** The home page link that keeps the network switch on mainnet; testnet is the default. */
export function homeHref(network: Network): string {
  return network === "mainnet" ? "?network=mainnet" : "./";
}

/** In-app link to a nav page; Check is the home page. */
export function pageHref(page: Page, network: Network = "testnet"): string {
  return page === "check" ? homeHref(network) : `?page=${page}`;
}

/** The Agent Guard page for one DAO. */
export function guardHref(dao: string): string {
  return `?${new URLSearchParams({ page: "guard", dao }).toString()}`;
}

/** The Agent Budget page for one DAO. */
export function budgetHref(dao: string): string {
  return `?${new URLSearchParams({ page: "budget", dao }).toString()}`;
}

/** The Yield agent page for one DAO. */
export function yieldHref(dao: string): string {
  return `?${new URLSearchParams({ page: "yield", dao }).toString()}`;
}

/** The New yield agent wizard. */
export function yieldNewHref(): string {
  return "?page=yield&new=1";
}

/** The full "How your agent works" guide. */
export function agentGuideHref(dao: string | null): string {
  const params = new URLSearchParams({ page: "budget" });
  if (dao !== null) params.set("dao", dao);
  params.set("help", "agent");
  return `?${params.toString()}`;
}
