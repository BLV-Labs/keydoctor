import type { YieldRejectReason, YieldWarning } from "../types.ts";

type Text = { vi: string; en: string };

/** Why a row is not suggested. Fixed text: no chain or API value goes in. */
export const YIELD_REASON_TEXT: Record<YieldRejectReason, Text> = {
  NOT_ALLOWLISTED: {
    vi: "Token không nằm trong danh sách cho phép (chỉ USDC và USDt gốc, không token bridge).",
    en: "Token is not on the allowlist (native USDC and USDt only, no bridged tokens).",
  },
  DEPOSIT_CLOSED: { vi: "Rhea Lend đang đóng nạp cho token này.", en: "Rhea Lend has deposits closed for this token." },
  WITHDRAW_CLOSED: { vi: "Rhea Lend đang đóng rút cho token này.", en: "Rhea Lend has withdrawals closed for this token." },
  PRICE_UNKNOWN: { vi: "Không đọc được giá token.", en: "The token price could not be read." },
  PRICE_GAP: { vi: "Giá lệch hơn 1% so với $1.", en: "The price is more than 1% away from $1." },
  TVL_LOW: { vi: "Tổng tiền gửi dưới $1M.", en: "Total supplied is below $1M." },
  LIQUIDITY_LOW: { vi: "Thanh khoản rút được dưới $250k.", en: "Withdrawable liquidity is below $250k." },
  SOURCE_MISSING: { vi: "Chỉ có một nguồn APR, không đối chiếu được.", en: "Only one APR source answered, so it could not be cross-checked." },
  SOURCE_GAP: { vi: "Hai nguồn APR lệch nhau hơn 1 điểm phần trăm.", en: "The two APR sources differ by more than 1 percentage point." },
};

export const YIELD_WARNING_TEXT: Record<YieldWarning, Text> = {
  APR_HIGH: {
    vi: "APR trên 30%: lãi cao bất thường thường đi kèm rủi ro cao.",
    en: "APR above 30%: unusually high yield usually comes with high risk.",
  },
};

/** Y9: always shown. */
export const PAYROLL_NOTE: Text = {
  vi: "Hãy giữ đủ tiền cho lương và các khoản chi sắp tới. Rút tiền về cần một lần bỏ phiếu nữa của council.",
  en: "Keep enough for payroll and upcoming payments. Getting funds back needs another council vote.",
};

export const TEST_DATA_NOTE: Text = {
  vi: "Lãi suất testnet là dữ liệu thử, không phải lợi nhuận thật.",
  en: "Testnet rates are test data, not real yield.",
};

export const NO_SUGGESTION_NOTE: Text = {
  vi: "DAO không giữ token nào đủ điều kiện, nên không có đề xuất. Key Doctor không đề xuất swap.",
  en: "The DAO holds no eligible token, so there is no suggestion. Key Doctor does not suggest swaps.",
};

export const REFERENCE_NOTE: Text = {
  vi: "Lãi suất mainnet chỉ để tham khảo; đề xuất chỉ dùng mạng của DAO.",
  en: "Mainnet rates are for reference only; suggestions use the DAO's own network.",
};

/** Always shown: the report filters data, it does not advise (plan §2). */
export const NOT_ADVICE_NOTE: Text = {
  vi: "Đây là dữ liệu đã lọc, không phải lời khuyên tài chính. Council tự quyết và tự ký.",
  en: "This is filtered data, not financial advice. The council decides and signs.",
};
