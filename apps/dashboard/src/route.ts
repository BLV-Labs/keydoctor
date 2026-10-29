import { resolveTarget } from "key-doctor";

export const BOT_USERNAME = "KeyDoctorOnCallBot";
export const BOT_URL = `https://t.me/${BOT_USERNAME}`;

export interface Route {
  /** Normalized account id, or null for the home page. */
  target: string | null;
  /** The raw `?target=` value when it is not a valid account id. */
  invalid: string | null;
  /** The DAO whose council the account was opened from. */
  from: string | null;
  view: "report" | "cleanup";
  level: "safe" | "full";
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
  if (raw === null || raw.trim() === "") return { target: null, invalid: null, from: null, view: "report", level };
  const target = normalize(raw);
  if (target === null) return { target: null, invalid: raw, from: null, view: "report", level };
  const fromRaw = params.get("from");
  const from = fromRaw === null ? null : normalize(fromRaw);
  return { target, invalid: null, from: from === target ? null : from, view, level };
}

/** The `?target=` deep link, also used by the bot's "View on dashboard". */
export function routeHref(target: string, from?: string | null): string {
  const params = new URLSearchParams({ target });
  if (from) params.set("from", from);
  return `?${params.toString()}`;
}
