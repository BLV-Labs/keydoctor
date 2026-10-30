import { resolveTarget, type Network } from "key-doctor";

export const BOT_USERNAME = "KeyDoctorOnCallBot";
export const BOT_URL = `https://t.me/${BOT_USERNAME}`;

export type Page = "check" | "oncall" | "agents";

export interface Route {
  /** The nav page: `?page=` without a target; any `?target=` is the Check page. */
  page: Page;
  /** Normalized account id, or null for the home page. */
  target: string | null;
  /** The raw `?target=` value when it is not a valid account id. */
  invalid: string | null;
  /** The DAO whose council the account was opened from. */
  from: string | null;
  view: "report" | "cleanup";
  level: "safe" | "full";
  /**
   * With a target: the network it is scanned on (the name suffix wins, `?network=` only matters for an
   * implicit account). On the home page: the `?network=` switch value, or null when the URL has none.
   */
  network: Network | null;
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

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const raw = params.get("target");
  const view = params.get("view") === "cleanup" ? "cleanup" : "report";
  const level = params.get("level") === "full" ? "full" : "safe";
  const network = parseNetwork(params.get("network"));
  const p = params.get("page");
  const page: Page = raw === null && (p === "oncall" || p === "agents") ? p : "check";
  if (raw === null || raw.trim() === "") return { page, target: null, invalid: null, from: null, view: "report", level, network };
  const target = normalize(raw);
  if (target === null) return { page: "check", target: null, invalid: raw, from: null, view: "report", level, network };
  const fromRaw = params.get("from");
  const from = fromRaw === null ? null : normalize(fromRaw);
  return {
    page: "check",
    target,
    invalid: null,
    from: from === target ? null : from,
    view,
    level,
    network: suffixNetwork(target) ?? network ?? "testnet",
  };
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
