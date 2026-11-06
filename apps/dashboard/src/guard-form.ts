// The "Create Agent Guard" form, pure: raw input strings to the factory's `create` args. The caps and the name rule
// mirror contracts/guard-factory (MAX_* in types.rs, `guard_account`), so a form that passes here is not refused
// on chain after the council voted for it.
import { resolveTarget } from "key-doctor";
import { nearToYocto } from "./format.ts";

export const MAX_AGENTS = 10;
export const MAX_WHITELIST = 50;
export const MAX_GUARDIANS = 5;
export const MAX_LABEL_CHARS = 64;
export const MAX_NAME_LEN = 32;
/** The factory's MIN_GUARD_BALANCE: the least funding on top of the Guard's code storage. */
export const MIN_FUNDING_YOCTO = 5n * 10n ** 23n;
/** Added to the deposit for the factory's registry record (about 0.003 NEAR measured); the rest reaches the Guard. */
export const RECORD_STORAGE_YOCTO = 10n ** 22n;

export interface GuardFormInput {
  name: string;
  maxPerTx: string;
  maxPerDay: string;
  maxPendingPerAgent: string;
  minReserve: string;
  funding: string;
  agents: { account_id: string; label: string }[];
  whitelist: { account_id: string; label: string; max_per_tx: string }[];
  guardians: string[];
}

/** Exactly the JSON `factory.create` takes. Amounts are yoctoNEAR strings. */
export interface GuardCreateArgs {
  name: string;
  policy: { max_per_tx: string; max_per_day: string; max_pending_per_agent: number; min_reserve: string };
  /** With `public_key` the Guard also creates the agent's account, holding that one key. */
  agents: { account_id: string; label: string; public_key?: string }[];
  whitelist: { account_id: string; label: string; max_per_tx: string | null }[];
  guardians: string[];
}

export type GuardFormCode =
  | "INVALID_NAME"
  | "INVALID_AMOUNT"
  | "PER_TX_OVER_DAILY"
  | "INVALID_PENDING"
  | "FUNDING_TOO_LOW"
  | "FUNDING_BELOW_RESERVE"
  | "FUNDING_UNDER_MINIMUM"
  | "NO_AGENTS"
  | "TOO_MANY_AGENTS"
  | "TOO_MANY_WHITELIST"
  | "TOO_MANY_GUARDIANS"
  | "INVALID_ACCOUNT"
  | "LABEL_TOO_LONG";

export interface GuardFormError {
  /** Input path, e.g. `maxPerTx`, `agents.2.account_id`. */
  field: string;
  code: GuardFormCode;
}

export const GUARD_FORM_TEXT: Record<GuardFormCode, { vi: string; en: string }> = {
  INVALID_NAME: { vi: "Tên chỉ gồm a-z, 0-9, - và _, tối đa 32 ký tự.", en: "Use a-z, 0-9, - and _ only, at most 32 characters." },
  INVALID_AMOUNT: { vi: "Nhập số NEAR lớn hơn 0, ví dụ 1.5.", en: "Enter a NEAR amount above 0, e.g. 1.5." },
  PER_TX_OVER_DAILY: { vi: "Hạn mức mỗi giao dịch lớn hơn hạn mức mỗi ngày.", en: "The per-transaction limit is above the daily limit." },
  INVALID_PENDING: { vi: "Nhập số nguyên từ 1 đến 100.", en: "Enter a whole number from 1 to 100." },
  FUNDING_TOO_LOW: { vi: "Factory cần ít nhất 0.5 NEAR cho Guard.", en: "The factory needs at least 0.5 NEAR for the Guard." },
  FUNDING_BELOW_RESERVE: { vi: "Số nạp thấp hơn mức dự trữ: Guard sẽ từ chối mọi yêu cầu.", en: "Funding is below the reserve: the Guard would refuse every request." },
  FUNDING_UNDER_MINIMUM: {
    vi: "Số nạp phải đủ cho bond của mọi yêu cầu chờ, gas của agent, mức dự trữ và 0.5 NEAR cho Guard.",
    en: "Funding must cover every waiting request's bond, the agent's gas, the reserve and 0.5 NEAR for the Guard.",
  },
  NO_AGENTS: { vi: "Thêm ít nhất một agent.", en: "Add at least one agent." },
  TOO_MANY_AGENTS: { vi: `Tối đa ${MAX_AGENTS} agent.`, en: `At most ${MAX_AGENTS} agents.` },
  TOO_MANY_WHITELIST: { vi: `Tối đa ${MAX_WHITELIST} người nhận.`, en: `At most ${MAX_WHITELIST} receivers.` },
  TOO_MANY_GUARDIANS: { vi: `Tối đa ${MAX_GUARDIANS} guardian.`, en: `At most ${MAX_GUARDIANS} guardians.` },
  INVALID_ACCOUNT: { vi: "Không phải account id NEAR hợp lệ.", en: "Not a valid NEAR account id." },
  LABEL_TOO_LONG: { vi: `Nhãn tối đa ${MAX_LABEL_CHARS} ký tự.`, en: `Labels are at most ${MAX_LABEL_CHARS} characters.` },
};

/** An account id exactly as typed: no case folding, no trimming, so what the council sees is what the chain gets. */
function isAccountId(id: string): boolean {
  try {
    return resolveTarget(id).id === id;
  } catch {
    return false;
  }
}

export function guardAccountId(name: string, factory: string): string {
  return `${name}.${factory}`;
}

export type GuardFormResult =
  | { ok: true; args: GuardCreateArgs; depositYocto: string; guardId: string }
  | { ok: false; errors: GuardFormError[] };

/** `codeStorageYocto`: what the Guard's copy of the code locks, read from the factory; the DAO's deposit pays it. */
export function validateGuardForm(input: GuardFormInput, factory: string, codeStorageYocto: string): GuardFormResult {
  const errors: GuardFormError[] = [];
  const err = (field: string, code: GuardFormCode) => errors.push({ field, code });

  const nameOk = /^[a-z0-9_-]{1,32}$/.test(input.name) && isAccountId(guardAccountId(input.name, factory));
  if (!nameOk) err("name", "INVALID_NAME");

  const amount = (field: keyof GuardFormInput, allowZero = false): bigint | null => {
    const y = nearToYocto(String(input[field]));
    if (y === null || (!allowZero && BigInt(y) === 0n)) {
      err(field, "INVALID_AMOUNT");
      return null;
    }
    return BigInt(y);
  };
  const perTx = amount("maxPerTx");
  const perDay = amount("maxPerDay");
  const reserve = amount("minReserve", true);
  const funding = amount("funding");
  if (perTx !== null && perDay !== null && perTx > perDay) err("maxPerTx", "PER_TX_OVER_DAILY");
  if (funding !== null && funding < MIN_FUNDING_YOCTO) err("funding", "FUNDING_TOO_LOW");
  else if (funding !== null && reserve !== null && funding <= reserve) err("funding", "FUNDING_BELOW_RESERVE");

  const pending = /^\d+$/.test(input.maxPendingPerAgent.trim()) ? Number(input.maxPendingPerAgent.trim()) : NaN;
  if (!(pending >= 1 && pending <= 100)) err("maxPendingPerAgent", "INVALID_PENDING");

  if (input.agents.length === 0) err("agents", "NO_AGENTS");
  if (input.agents.length > MAX_AGENTS) err("agents", "TOO_MANY_AGENTS");
  if (input.whitelist.length > MAX_WHITELIST) err("whitelist", "TOO_MANY_WHITELIST");
  if (input.guardians.length > MAX_GUARDIANS) err("guardians", "TOO_MANY_GUARDIANS");

  // The contract counts label length in chars (Rust `chars().count()`), i.e. code points, not UTF-16 units.
  const entry = (list: string, i: number, e: { account_id: string; label: string }) => {
    if (!isAccountId(e.account_id)) err(`${list}.${i}.account_id`, "INVALID_ACCOUNT");
    if ([...e.label].length > MAX_LABEL_CHARS) err(`${list}.${i}.label`, "LABEL_TOO_LONG");
  };
  input.agents.forEach((a, i) => entry("agents", i, a));
  const whitelist = input.whitelist.map((w, i) => {
    entry("whitelist", i, w);
    if (w.max_per_tx.trim() === "") return { account_id: w.account_id, label: w.label, max_per_tx: null };
    const cap = nearToYocto(w.max_per_tx);
    if (cap === null || BigInt(cap) === 0n) err(`whitelist.${i}.max_per_tx`, "INVALID_AMOUNT");
    return { account_id: w.account_id, label: w.label, max_per_tx: cap };
  });
  input.guardians.forEach((g, i) => {
    if (!isAccountId(g)) err(`guardians.${i}`, "INVALID_ACCOUNT");
  });

  if (errors.length > 0 || perTx === null || perDay === null || reserve === null || funding === null) return { ok: false, errors };
  return {
    ok: true,
    guardId: guardAccountId(input.name, factory),
    depositYocto: (funding + BigInt(codeStorageYocto) + RECORD_STORAGE_YOCTO).toString(),
    args: {
      name: input.name,
      policy: { max_per_tx: perTx.toString(), max_per_day: perDay.toString(), max_pending_per_agent: pending, min_reserve: reserve.toString() },
      agents: input.agents.map((a) => ({ account_id: a.account_id, label: a.label })),
      whitelist,
      guardians: [...input.guardians],
    },
  };
}

const lines = (raw: string): string[] =>
  raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** One entry per line, fields split on commas: the label is everything between the account id and the cap. */
function splitLine(line: string): string[] {
  return line.split(",").map((p) => p.trim());
}

/** The form's raw fields to `GuardFormInput`. Agents: `account, label`. Whitelist: `account, label, cap` (cap may be empty). */
export function formToInput(get: (name: string) => string): GuardFormInput {
  return {
    name: get("name").trim(),
    maxPerTx: get("maxPerTx").trim(),
    maxPerDay: get("maxPerDay").trim(),
    maxPendingPerAgent: get("maxPendingPerAgent").trim(),
    minReserve: get("minReserve").trim(),
    funding: get("funding").trim(),
    agents: lines(get("agents")).map((l) => {
      const [account_id = "", ...label] = splitLine(l);
      return { account_id, label: label.join(", ") };
    }),
    whitelist: lines(get("whitelist")).map((l) => {
      const [account_id = "", ...rest] = splitLine(l);
      const max_per_tx = rest.length >= 2 ? rest.pop()! : "";
      return { account_id, label: rest.join(", "), max_per_tx };
    }),
    guardians: lines(get("guardians")),
  };
}
