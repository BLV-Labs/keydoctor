// GĐ10 numbers on the home page. The JSON is the output of `pnpm stats --block 223787777 --all`, committed under
// data/, so the page shows exactly what the script measured. Aggregates only, no DAO or account names.
import measured from "../../../data/network-stats-all.json" with { type: "json" };

/** The fields of kd.network_stats.v1 that the home page reads. */
export interface HomeStats {
  network: string;
  /** Missing in files written before `--all` existed; those cover active DAOs only. */
  scope?: "active" | "all";
  block_height: number;
  block_timestamp: string;
  ruleset_version: string;
  active_days: number;
  daos_active: number;
  daos_scanned: number;
  daos_failed: number;
  council_size: { one_member: number };
  daos_single_vote_transfer: number;
  council_members: number;
  members_high: number;
  function_call_keys: number;
  function_call_keys_never_used: number;
  full_access_keys: number;
  full_access_keys_never_used: number;
}

export const NETWORK_STATS: HomeStats = measured as HomeStats;
