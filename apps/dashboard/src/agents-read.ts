// Read-only chain data for My Agents: the agents of every DAO where a connected wallet account sits on the council.
// Payment agents come from the Guard factory's `list_guards`; Yield agents from the DAOs this browser created one for
// with "Earn on idle funds" (a Yield agent has no contract to list). One unreadable DAO never hides the others.
import { createRpc, DEFAULT_RPC_URLS, type Network, type Rpc } from "key-doctor";
import { readBudget, type BudgetLive } from "./budget-read.ts";
import { readGuardDao, type GuardDao } from "./guard-read.ts";
import { suffixNetwork } from "./route.ts";
import { councilAccounts, parsePolicy, readYieldPositions, seenYieldDaos, type YieldPosition } from "./yield-read.ts";
import { loadSettings } from "./yield-settings.ts";

export type AgentStatus = "on" | "off" | "waiting" | "farming" | "idle" | "unknown";

export interface AgentRow {
  kind: "payment" | "yield";
  dao: string;
  /** The payment agent's account; null for a Yield agent, which has no account of its own. */
  account: string | null;
  label: string;
  status: AgentStatus;
  /** Requests waiting for the council (payment only). */
  pending: number;
  /** yoctoNEAR the agent spent in the last 24 hours; null when unread or not a payment agent. */
  spent_24h: string | null;
  /** Raw token units supplied on Rhea Lend (yield only); null when unread. */
  supplied: string | null;
}

export interface CouncilDao {
  dao: string;
  /** The connected accounts on this DAO's council. */
  members: string[];
  /** Why this DAO's agents could not be read; null when they were. */
  error: string | null;
}

export interface MyAgents {
  network: Network;
  daos: CouncilDao[];
  rows: AgentRow[];
  /** The council DAOs that have a Budget (a Guard), in read order: one card each on the Your agents page. */
  budgetDaos: string[];
  /** DAOs from the factory whose policy could not be read, so the page cannot tell if they are yours. */
  unread: number;
}

const PAGE = 100;
/** list_guards pages read at most: 1000 Guards, far more than testnet holds. */
const MAX_PAGES = 10;

/** Unique DAO ids from `list_guards` rows, in the order they first appear. */
export function guardDaoIds(rows: unknown[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const dao = typeof r === "object" && r !== null ? (r as { dao_id?: unknown }).dao_id : undefined;
    if (typeof dao === "string") out.add(dao);
  }
  return [...out];
}

/** One row per agent of each Guard. Off wins over waiting: a paused Guard rejects every request. */
export function paymentRows(dao: GuardDao): AgentRow[] {
  return dao.guards.flatMap((g) =>
    (g.agents ?? []).map((a): AgentRow => {
      const off = !a.enabled || g.config?.paused === true;
      return {
        kind: "payment",
        dao: dao.dao,
        account: a.account_id,
        label: a.label,
        status: off ? "off" : a.pending > 0 ? "waiting" : "on",
        pending: a.pending,
        spent_24h: a.spent_24h ?? null,
        supplied: null,
      };
    }),
  );
}

/** The Yield agent row of one DAO from its Rhea Lend positions. */
export function yieldRow(dao: string, positions: YieldPosition[] | null): AgentRow {
  const supplied = positions === null ? null : positions.reduce((sum, p) => sum + BigInt(p.supplied), 0n).toString();
  return {
    kind: "yield",
    dao,
    account: null,
    label: "Yield agent",
    status: positions === null ? "unknown" : positions.length > 0 ? "farming" : "idle",
    pending: 0,
    spent_24h: null,
    supplied,
  };
}

/**
 * The DAOs on `network` that have a Yield agent: opened on the Yield page and given limits (Create in "Earn on idle
 * funds", or Set limits on the agent page). Only opening a DAO's Yield page reads it; it does not create an agent.
 */
export function createdYieldDaos(seen: readonly string[], network: Network, hasSettings: (dao: string) => boolean): string[] {
  return seen.filter((d) => suffixNetwork(d) === network && hasSettings(d));
}

/** One budget on the Your agents page. `live` is null when its read failed, so only its card says so. */
export interface BudgetCard {
  dao: string;
  live: BudgetLive | null;
}

/** Reads every budget in parallel; a failed read leaves `live` null and never touches the others. */
export async function readAgentBudgets(daos: readonly string[], factory: string, network: Network, read: typeof readBudget = readBudget): Promise<BudgetCard[]> {
  const settled = await Promise.allSettled(daos.map((dao) => read(dao, factory, network)));
  return settled.map((r, i): BudgetCard => {
    if (r.status === "rejected") console.error("budget read failed", { dao: daos[i], error: r.reason });
    return { dao: daos[i] ?? "", live: r.status === "fulfilled" ? r.value : null };
  });
}

/** Every `list_guards` row of a factory, paged. Throws `FACTORY_UNREADABLE` when a page cannot be read. */
export async function listGuardRows(rpc: Rpc, factory: string, height: number): Promise<unknown[]> {
  const listed: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await rpc.callFunction(factory, height, "list_guards", { from_index: page * PAGE, limit: PAGE }).catch((e: unknown) => {
      console.error("guard factory read failed", { factory, error: e });
      throw new Error("FACTORY_UNREADABLE");
    });
    if (!Array.isArray(rows)) throw new Error("FACTORY_UNREADABLE");
    listed.push(...rows);
    if (rows.length < PAGE) break;
  }
  return listed;
}

/** Throws `FACTORY_UNREADABLE` when `list_guards` fails. An empty factory reads only the Yield DAOs. */
export async function readMyAgents(accounts: readonly string[], factory: string, network: Network): Promise<MyAgents> {
  const rpc = createRpc({ url: DEFAULT_RPC_URLS[network] });
  const { height } = await rpc.block();
  const listed = factory === "" ? [] : await listGuardRows(rpc, factory, height);
  const guarded = new Set(guardDaoIds(listed));
  const yieldDaos = new Set(createdYieldDaos(seenYieldDaos(), network, (d) => loadSettings(d) !== null));
  const all = [...new Set([...guarded, ...yieldDaos])];
  let unread = 0;
  const council = (
    await Promise.all(
      all.map(async (dao) => {
        const policy = parsePolicy(await rpc.callFunction(dao, height, "get_policy", {}).catch(() => null));
        if (policy === null) {
          unread += 1;
          return null;
        }
        const members = councilAccounts(policy, accounts);
        return members.length === 0 ? null : { dao, members };
      }),
    )
  ).filter((d): d is { dao: string; members: string[] } => d !== null);
  const daos: CouncilDao[] = [];
  const rows: AgentRow[] = [];
  await Promise.all(
    council.map(async ({ dao, members }) => {
      let error: string | null = null;
      const [payment, positions] = await Promise.all([
        guarded.has(dao)
          ? readGuardDao(dao, factory, network).then(paymentRows, () => {
              error = `Could not read ${dao}'s Guards right now.`;
              return [];
            })
          : [],
        yieldDaos.has(dao) ? readYieldPositions(dao, network) : undefined,
      ]);
      daos.push({ dao, members, error });
      rows.push(...payment);
      if (positions !== undefined) rows.push(yieldRow(dao, positions));
    }),
  );
  const order = new Map(all.map((d, i) => [d, i]));
  const byDao = (a: { dao: string }, b: { dao: string }) => (order.get(a.dao) ?? 0) - (order.get(b.dao) ?? 0);
  const budgetDaos = daos.filter((d) => guarded.has(d.dao)).sort(byDao).map((d) => d.dao);
  return { network, daos: daos.sort(byDao), rows: rows.sort(byDao), budgetDaos, unread };
}

/** Unique, non-empty DAO ids on `network`, in the order given. */
export function pickerCandidates(lists: readonly (readonly string[])[], network: Network): string[] {
  return [...new Set(lists.flat().filter((d) => d !== "" && suffixNetwork(d) === network))];
}

/** The candidates whose council holds one of `accounts`, in order. A DAO whose policy cannot be read is dropped. */
export async function councilCandidates(candidates: readonly string[], accounts: readonly string[], getPolicy: (dao: string) => Promise<unknown>): Promise<string[]> {
  const kept = await Promise.all(
    candidates.map(async (dao) => {
      const policy = parsePolicy(await getPolicy(dao).catch(() => null));
      return policy !== null && councilAccounts(policy, accounts).length > 0;
    }),
  );
  return candidates.filter((_, i) => kept[i]);
}

/**
 * The DAOs the connected wallet sits on, for the DAO pickers: Guard DAOs of `factories` plus `extra` ids this browser
 * knows. A factory that cannot be read adds nothing. Never throws.
 */
export async function readWalletDaos(accounts: readonly string[], network: Network, factories: readonly string[], extra: readonly string[]): Promise<string[]> {
  const rpc = createRpc({ url: DEFAULT_RPC_URLS[network] });
  const { height } = await rpc.block();
  const guarded = await Promise.all(
    [...new Set(factories.filter((f) => f !== ""))].map((f) => listGuardRows(rpc, f, height).then(guardDaoIds, () => [] as string[])),
  );
  const candidates = pickerCandidates([...guarded, extra], network);
  return councilCandidates(candidates, accounts, (dao) => rpc.callFunction(dao, height, "get_policy", {}));
}
