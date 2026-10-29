import type { Messages } from "./types.ts";
import { BLOCK_TIME_MS, FA_OLD_DAYS } from "./rules/thresholds.ts";

type Evidence = Record<string, unknown>;
/** Chain-sourced ids the text may name; null when the id failed the account-id regex. */
interface Subject {
  receiverId: string | null;
}

const num = (e: Evidence, key: string): number | null => (typeof e[key] === "number" ? (e[key] as number) : null);

export const RECEIVERS_UNCHECKED_LIMITATION = "Some function-call key receivers were not checked.";

/** Always shown: ages are estimates. */
export const AGE_LIMITATION = `Key age is estimated from the access-key nonce, assuming ${BLOCK_TIME_MS / 1000} s blocks.`;

// Texts are built from evidence only, never from RPC text.
const BUILDERS = {
  FA_MANY: (e: Evidence): Messages => ({
    vi: {
      title: "Quá nhiều khóa toàn quyền",
      explain: `Account có ${num(e, "full_access_ed25519")} khóa toàn quyền. Lộ bất kỳ khóa nào cũng mất cả account.`,
      fix: "Giữ ít khóa nhất có thể, xóa khóa không dùng.",
    },
    en: {
      title: "Too many full-access keys",
      explain: `The account has ${num(e, "full_access_ed25519")} full-access keys. Leaking any one of them loses the whole account.`,
      fix: "Keep as few keys as possible and delete the ones you do not use.",
    },
  }),
  FA_MULTIPLE: (e: Evidence): Messages => ({
    vi: {
      title: "Nhiều khóa toàn quyền",
      explain: `Account có ${num(e, "full_access_ed25519")} khóa toàn quyền Ed25519. Mỗi khóa thêm là một nơi có thể bị lộ.`,
      fix: "Xóa các khóa toàn quyền không còn dùng.",
    },
    en: {
      title: "Several full-access keys",
      explain: `The account has ${num(e, "full_access_ed25519")} Ed25519 full-access keys. Each extra key is one more place that can leak.`,
      fix: "Delete the full-access keys you no longer use.",
    },
  }),
  PQ_PARTIAL: (e: Evidence): Messages => ({
    vi: {
      title: "Còn khóa Ed25519 toàn quyền bên cạnh ML-DSA",
      explain: `Account đã có ${num(e, "ml_dsa")} khóa ML-DSA nhưng vẫn còn ${num(e, "full_access_ed25519")} khóa Ed25519 toàn quyền, nên chưa được bảo vệ chống lượng tử.`,
      fix: "Khi chắc chắn khóa ML-DSA dùng được, xóa các khóa Ed25519 toàn quyền.",
    },
    en: {
      title: "Ed25519 full-access keys remain next to ML-DSA",
      explain: `The account has ${num(e, "ml_dsa")} ML-DSA key(s) but still ${num(e, "full_access_ed25519")} Ed25519 full-access key(s), so it is not yet protected against quantum attacks.`,
      fix: "Once you are sure the ML-DSA key works, delete the Ed25519 full-access keys.",
    },
  }),
  FA_OLD: (e: Evidence): Messages => {
    const age = num(e, "age_days");
    return {
      vi: {
        title: "Khóa toàn quyền cũ hoặc không rõ tuổi",
        explain:
          age === null
            ? "Không xác định được tuổi của khóa toàn quyền này."
            : `Khóa toàn quyền này đã ${age} ngày tuổi, quá ${FA_OLD_DAYS} ngày.`,
        fix: "Nếu không còn dùng khóa này, xóa nó; nếu còn dùng, cân nhắc thay bằng khóa mới.",
      },
      en: {
        title: "Old or unknown-age full-access key",
        explain:
          age === null
            ? "The age of this full-access key could not be determined."
            : `This full-access key is ${age} days old, over ${FA_OLD_DAYS} days.`,
        fix: "Delete the key if you no longer use it; otherwise consider replacing it with a new one.",
      },
    };
  },
  KEY_UNUSED: (_e: Evidence): Messages => ({
    vi: {
      title: "Khóa chưa từng dùng",
      explain: "Khóa này chưa ký giao dịch nào.",
      fix: "Nếu không nhận ra khóa này, xóa nó.",
    },
    en: {
      title: "Key never used",
      explain: "This key has never signed a transaction.",
      fix: "If you do not recognise this key, delete it.",
    },
  }),
  FA_BOT_LIKE: (e: Evidence): Messages => ({
    vi: {
      title: "Khóa toàn quyền dùng rất nhiều",
      explain: `Khóa toàn quyền này đã ký ${num(e, "use_count")} giao dịch, có thể là bot hoặc agent đang giữ khóa toàn quyền.`,
      fix: "Nếu là bot hoặc agent, thay bằng khóa function-call có giới hạn.",
    },
    en: {
      title: "Heavily used full-access key",
      explain: `This full-access key has signed ${num(e, "use_count")} transactions; a bot or agent may hold a full-access key.`,
      fix: "If it is a bot or agent, replace it with a restricted function-call key.",
    },
  }),
  FC_UNLIMITED_ALLOWANCE: (_e: Evidence): Messages => ({
    vi: {
      title: "Khóa ứng dụng chi không giới hạn",
      explain: "Khóa này trả phí gas không giới hạn từ account.",
      fix: "Thu hồi khóa trong mục Connected Apps nếu không dùng app này nữa.",
    },
    en: {
      title: "App key with unlimited allowance",
      explain: "This key can spend unlimited gas fees from the account.",
      fix: "Revoke it under Connected Apps if you no longer use this app.",
    },
  }),
  FC_ANY_METHOD: (_e: Evidence, s: Subject): Messages => ({
    vi: {
      title: "Khóa ứng dụng gọi được mọi hàm",
      explain: `Khóa này gọi được mọi hàm của contract ${s.receiverId ?? "được chỉ định"}.`,
      fix: "Thu hồi và cấp lại khóa chỉ cho các hàm cần thiết.",
    },
    en: {
      title: "App key can call any method",
      explain: `This key can call every method of ${s.receiverId ?? "its receiver contract"}.`,
      fix: "Revoke it and issue a key limited to the methods you need.",
    },
  }),
  FC_DEAD_RECEIVER: (_e: Evidence, s: Subject): Messages => ({
    vi: {
      title: "Khóa ứng dụng trỏ tới account không tồn tại",
      explain: `Khóa này chỉ định contract ${s.receiverId ?? "được chỉ định"} nhưng account đó không tồn tại.`,
      fix: "Thu hồi khóa này nếu không nhận ra nó.",
    },
    en: {
      title: "App key points to a missing account",
      explain: `This key names ${s.receiverId ?? "a receiver"} as its contract, but that account does not exist.`,
      fix: "Revoke the key if you do not recognise it.",
    },
  }),
  PQ_NONE: (_e: Evidence): Messages => ({
    vi: {
      title: "Chưa có khóa chống lượng tử",
      explain: "Account chưa có khóa ML-DSA.",
      fix: "Thêm khóa ML-DSA trong ví Meteor khi sẵn sàng.",
    },
    en: {
      title: "No post-quantum key",
      explain: "The account has no ML-DSA key.",
      fix: "Add an ML-DSA key in Meteor Wallet when you are ready.",
    },
  }),
};

export type MessageRuleId = keyof typeof BUILDERS;

export function ruleMessages(ruleId: MessageRuleId, evidence: Evidence, subject: Subject = { receiverId: null }): Messages {
  return BUILDERS[ruleId](evidence, subject);
}
