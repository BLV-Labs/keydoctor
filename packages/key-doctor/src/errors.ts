import type { KdError, KdErrorCode } from "./types.ts";
import { MAX_KEYS, MAX_MEMBERS, MAX_ROLES } from "./rules/thresholds.ts";

export type KdErrorVariant = "eth_implicit" | "network_conflict" | "block_height" | "keys" | "members" | "roles";

type Text = { vi: string; en: string };

const TEXT: Record<KdErrorCode, Text> = {
  INVALID_TARGET: {
    vi: "Mục tiêu không hợp lệ. Hãy nhập một tên account .near hoặc .testnet hợp lệ.",
    en: "Invalid target. Enter a valid .near or .testnet account name.",
  },
  NOT_FOUND: {
    vi: "Account không tồn tại ở block này.",
    en: "This account does not exist at this block.",
  },
  NOT_A_DAO: {
    vi: "Account này không phải Sputnik DAO.",
    en: "This account is not a Sputnik DAO.",
  },
  RPC_ERROR: {
    vi: "Không đọc được dữ liệu chuỗi lúc này. Rủi ro chưa được xác định, không phải là thấp.",
    en: "Could not read chain data right now. The risk is unknown, not low.",
  },
  RATE_LIMITED: {
    vi: "Nút RPC đang giới hạn tần suất. Hãy thử lại sau. Rủi ro chưa được xác định, không phải là thấp.",
    en: "The RPC node is rate limiting requests. Try again later. The risk is unknown, not low.",
  },
  LIMIT_EXCEEDED: {
    vi: `Vượt giới hạn quét của Key Doctor (tối đa ${MAX_KEYS} khóa mỗi account, ${MAX_MEMBERS} thành viên council, ${MAX_ROLES} role).`,
    en: `This exceeds a Key Doctor scan limit (at most ${MAX_KEYS} keys per account, ${MAX_MEMBERS} council members, ${MAX_ROLES} roles).`,
  },
  UNAUTHORIZED: {
    vi: "Không có quyền thực hiện yêu cầu này.",
    en: "You are not allowed to do this.",
  },
  EXPIRED: {
    vi: "Liên kết đã hết hạn.",
    en: "This link has expired.",
  },
};

const VARIANT_TEXT: Record<KdErrorVariant, Text> = {
  eth_implicit: {
    vi: "Account kiểu Ethereum (0x...) chưa được hỗ trợ.",
    en: "Ethereum-style accounts are not supported.",
  },
  network_conflict: {
    vi: "Đuôi account không khớp với mạng đã chọn.",
    en: "The account suffix does not match the selected network.",
  },
  block_height: {
    vi: "Block height phải là số nguyên dương.",
    en: "The block height must be a positive integer.",
  },
  keys: {
    vi: `Account có hơn ${MAX_KEYS} khóa; Key Doctor chỉ quét tối đa ${MAX_KEYS} khóa mỗi account.`,
    en: `This account has more than ${MAX_KEYS} keys; Key Doctor scans at most ${MAX_KEYS} per account.`,
  },
  members: {
    vi: `DAO có hơn ${MAX_MEMBERS} thành viên council; Key Doctor chỉ quét tối đa ${MAX_MEMBERS}.`,
    en: `This DAO has more than ${MAX_MEMBERS} council members; Key Doctor scans at most ${MAX_MEMBERS}.`,
  },
  roles: {
    vi: `Policy có hơn ${MAX_ROLES} role; Key Doctor chỉ quét tối đa ${MAX_ROLES} role.`,
    en: `This policy has more than ${MAX_ROLES} roles; Key Doctor scans at most ${MAX_ROLES}.`,
  },
};

const RETRYABLE_DEFAULT: Record<KdErrorCode, boolean> = {
  INVALID_TARGET: false,
  NOT_FOUND: false,
  NOT_A_DAO: false,
  RPC_ERROR: true,
  RATE_LIMITED: true,
  LIMIT_EXCEEDED: false,
  UNAUTHORIZED: false,
  EXPIRED: false,
};

export function kdError(code: KdErrorCode, opts: { retryable?: boolean; variant?: KdErrorVariant } = {}): KdError {
  return {
    schema_version: "kd.error.v1",
    code,
    message: opts.variant ? VARIANT_TEXT[opts.variant] : TEXT[code],
    retryable: opts.retryable ?? RETRYABLE_DEFAULT[code],
  };
}

/** Never sets `cause`: the original error can hold the RPC URL. */
export class KdErrorException extends Error {
  readonly kd: KdError;
  constructor(kd: KdError) {
    super(kd.message.en);
    this.name = "KdErrorException";
    this.kd = kd;
  }
}

export function isKdError(e: unknown): e is KdErrorException {
  if (e instanceof KdErrorException) return true;
  const kd = (e as { kd?: { schema_version?: unknown } } | null | undefined)?.kd;
  return e instanceof Error && kd?.schema_version === "kd.error.v1";
}

export function fail(code: KdErrorCode, opts: { retryable?: boolean; variant?: KdErrorVariant } = {}): KdErrorException {
  return new KdErrorException(kdError(code, opts));
}
