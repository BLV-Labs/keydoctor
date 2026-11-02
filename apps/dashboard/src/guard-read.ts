// Read-only RPC views for the Agent Guard page. Every read of one page load is pinned to one block, like a scan.
import { createRpc, DEFAULT_RPC_URLS, type Network, type Rpc } from "key-doctor";
import type { RawPolicy } from "./guard-proposals.ts";
import { GUARD_ROLE } from "./guard-proposals.ts";

export interface GuardLive {
  guard_id: string;
  name: string;
  /** False while the factory's create is still in flight. */
  ready: boolean;
  /** Listed in the DAO's `agent-guard` role, i.e. P2 passed: without it the Guard cannot add transfers. */
  in_role: boolean;
  config: { paused: boolean; proposal_bond: string; agents: number; whitelist: number; guardians: string[] } | null;
  policy: { max_per_tx: string; max_per_day: string; max_pending_per_agent: number; min_reserve: string } | null;
  window: { spent_in_window: string; remaining: string; resets_at: string } | null;
  agents: { account_id: string; label: string; enabled: boolean; pending: number }[] | null;
}

export interface GuardDao {
  dao: string;
  factory: string;
  policy: RawPolicy;
  guards: GuardLive[];
}

const isPolicy = (v: unknown): v is RawPolicy =>
  typeof v === "object" && v !== null && Array.isArray((v as RawPolicy).roles) && typeof (v as RawPolicy).proposal_bond === "string";

function roleMembers(policy: RawPolicy): string[] {
  const role = policy.roles.find((r) => r.name === GUARD_ROLE);
  const kind = role?.kind as { Group?: unknown } | undefined;
  return Array.isArray(kind?.Group) ? (kind.Group as string[]) : [];
}

/** One Guard's views; a failed view leaves its field null so one broken Guard never hides the others. */
async function readGuard(rpc: Rpc, height: number, g: { guard_id: string; name: string; ready: boolean }, members: string[]): Promise<GuardLive> {
  const view = <T>(method: string): Promise<T | null> =>
    g.ready ? (rpc.callFunction(g.guard_id, height, method, {}) as Promise<T>).catch(() => null) : Promise.resolve(null);
  const [config, policy, window, agents] = await Promise.all([
    view<GuardLive["config"]>("get_config"),
    view<GuardLive["policy"]>("get_policy"),
    view<GuardLive["window"]>("get_window"),
    view<GuardLive["agents"]>("get_agents"),
  ]);
  return { guard_id: g.guard_id, name: g.name, ready: g.ready, in_role: members.includes(g.guard_id), config, policy, window, agents };
}

/** Throws a KdError from the DAO read, `NOT_A_DAO`, or `FACTORY_UNREADABLE` when the factory view fails. */
export async function readGuardDao(dao: string, factory: string, network: Network): Promise<GuardDao> {
  const rpc = createRpc({ url: DEFAULT_RPC_URLS[network] });
  const { height } = await rpc.block();
  const [policy, listed] = await Promise.all([
    rpc.callFunction(dao, height, "get_policy", {}),
    rpc.callFunction(factory, height, "get_guards_for_dao", { dao_id: dao }).catch((e: unknown) => {
      console.error("guard factory read failed", { factory, error: e });
      throw new Error("FACTORY_UNREADABLE");
    }),
  ]);
  if (!isPolicy(policy)) throw new Error("NOT_A_DAO");
  const rows = Array.isArray(listed) ? (listed as { guard_id: string; name: string; ready: boolean }[]) : [];
  const members = roleMembers(policy);
  const guards = await Promise.all(rows.map((g) => readGuard(rpc, height, g, members)));
  return { dao, factory, policy, guards };
}
