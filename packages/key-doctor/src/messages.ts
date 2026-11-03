import type { Messages } from "./types.ts";
import { BLOCK_TIME_MS, FA_OLD_DAYS, MAX_KEYS, ROLE_LABEL_MAX_LEN } from "./rules/thresholds.ts";

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
  FA_RECENT: (e: Evidence): Messages => {
    const ago = hoursText(num(e, "hours_ago") ?? 0);
    return {
      vi: {
        title: "Khóa toàn quyền mới thêm",
        explain: `Khóa toàn quyền này được thêm ${ago.vi} trước. Nếu chủ account không tự thêm, account có thể đã bị chiếm.`,
        fix: "Nếu không nhận ra khóa này, xóa nó ngay bằng một khóa bạn tin cậy, rồi kiểm tra tài sản trong account.",
      },
      en: {
        title: "New full-access key",
        explain: `This full-access key was added ${ago.en} ago. If the owner did not add it, the account may be compromised.`,
        fix: "If you do not recognise this key, delete it now with a key you trust, then check the account's funds.",
      },
    };
  },
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
  KEY_UNUSED: (): Messages => ({
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
  FC_UNLIMITED_ALLOWANCE: (): Messages => ({
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
  DAO_ADMIN: (e: Evidence): Messages => ({
    vi: {
      title: "Một thành viên đủ quyền đổi policy của DAO",
      explain: `Chỉ cần ${num(e, "approvals_needed")} phiếu của account này là đề xuất đổi policy được thông qua.`,
      fix: "Tăng ngưỡng bỏ phiếu cho các thay đổi policy, hoặc bỏ quyền này khỏi role.",
    },
    en: {
      title: "One member can change the DAO policy",
      explain: `${num(e, "approvals_needed")} vote from this account is enough to pass a policy change.`,
      fix: "Raise the vote threshold for policy changes, or remove this permission from the role.",
    },
  }),
  FC_DAO_VOTE: (_e: Evidence, s: Subject): Messages => ({
    vi: {
      title: "Khóa ứng dụng có thể bỏ phiếu thay thành viên council",
      explain: `Khóa function-call này trỏ vào DAO ${s.receiverId ?? "đang quét"} và gọi được act_proposal, nên có thể bỏ phiếu thay cho thành viên này.`,
      fix: "Thu hồi khóa này, hoặc cấp lại khóa không gồm act_proposal.",
    },
    en: {
      title: "App key can vote for a council member",
      explain: `This function-call key points at ${s.receiverId ?? "the scanned DAO"} and may call act_proposal, so it can vote for this member.`,
      fix: "Revoke the key, or issue one that does not include act_proposal.",
    },
  }),
  COUNCIL_SMALL: (e: Evidence): Messages => ({
    vi: {
      title: "Council quá nhỏ",
      explain: `Council chỉ có ${num(e, "council_size")} thành viên, nên mất một khóa là mất quyền kiểm soát DAO.`,
      fix: "Cân nhắc thêm thành viên vào council.",
    },
    en: {
      title: "Very small council",
      explain: `The council has only ${num(e, "council_size")} member(s), so losing one key can lose control of the DAO.`,
      fix: "Consider adding more council members.",
    },
  }),
  PQ_NONE: (): Messages => ({
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

export type MemberErrorCode = "RPC_ERROR" | "RATE_LIMITED" | "INVALID_ACCOUNT_ID" | "LIMIT_EXCEEDED";

const UNREAD = {
  vi: "Không đọc được khóa của account này. Rủi ro chưa được xác định, không phải là thấp.",
  en: "Could not read this account's keys. Its risk is unknown, not low.",
};

/** Fixed text for `members[].error`; no code implies low risk. */
export const MEMBER_ERROR_TEXT: Record<MemberErrorCode, { vi: string; en: string }> = {
  RPC_ERROR: UNREAD,
  RATE_LIMITED: UNREAD,
  INVALID_ACCOUNT_ID: UNREAD,
  LIMIT_EXCEEDED: {
    vi: `Account có hơn ${MAX_KEYS} khóa; Key Doctor chỉ quét tối đa ${MAX_KEYS}. Rủi ro chưa được xác định, không phải là thấp.`,
    en: `This account has more than ${MAX_KEYS} keys; Key Doctor scans at most ${MAX_KEYS}. Its risk is unknown, not low.`,
  },
};

export const roleTransferLimitation = (label: string): string =>
  `Role ${label} lets non-listed accounts approve transfers; they are not scanned.`;

export const rolePolicyLimitation = (label: string): string =>
  `Role ${label} lets non-listed accounts approve policy changes; they are not scanned.`;

export const roleTokenWeightLimitation = (label: string): string =>
  `Role ${label} votes by token weight; its approvals needed and admin status are not computed.`;

// Role names are chain text: only a plain short name is echoed into a limitation line.
const ROLE_LABEL = new RegExp(`^[A-Za-z0-9 _.-]{1,${ROLE_LABEL_MAX_LEN}}$`);
export const roleLabel = (name: string, index: number): string => (ROLE_LABEL.test(name) ? name : `#${index + 1}`);

export const missingMemberLimitation = (id: string): string =>
  `Council member ${id} does not exist; anyone who creates it gains its vote.`;

// ---------------------------------------------------------------------------
// kd.diff.v1 change texts (§4.3). Built from report fields only; ids are already validated or sanitized by the scan.
// ---------------------------------------------------------------------------

type Text = { vi: string; en: string };

export const DIFF_TEXT = {
  memberAdded: (id: string): Text => ({
    vi: `${id} được thêm vào council.`,
    en: `${id} was added to the council.`,
  }),
  memberRemoved: (id: string): Text => ({
    vi: `${id} bị bỏ khỏi council.`,
    en: `${id} was removed from the council.`,
  }),
  roleChanged: (id: string, becameAdmin: boolean): Text =>
    becameAdmin
      ? {
          vi: `Role của ${id} đã đổi: giờ account này một mình thông qua được thay đổi policy.`,
          en: `The roles of ${id} changed: this account can now pass policy changes alone.`,
        }
      : { vi: `Role của ${id} đã đổi.`, en: `The roles of ${id} changed.` },
  fullAccessKeyAdded: (id: string): Text => ({
    vi: `${id} có khóa toàn quyền mới. Nếu chủ account không tự thêm, account có thể đã bị chiếm.`,
    en: `${id} has a new full-access key. If the owner did not add it, the account may be compromised.`,
  }),
  daoVoteKeyAdded: (id: string): Text => ({
    vi: `${id} có khóa app mới được bỏ phiếu trong DAO này.`,
    en: `${id} has a new app key that can vote in this DAO.`,
  }),
  appKeyAdded: (id: string, receiverId: string | null): Text => ({
    vi: `${id} có khóa app mới${receiverId ? ` cho ${receiverId}` : ""}.`,
    en: `${id} has a new app key${receiverId ? ` for ${receiverId}` : ""}.`,
  }),
  fullAccessKeyRemoved: (id: string): Text => ({
    vi: `Một khóa toàn quyền của ${id} đã bị xóa.`,
    en: `A full-access key of ${id} was removed.`,
  }),
  appKeyRemoved: (id: string): Text => ({
    vi: `Một khóa app của ${id} đã bị xóa.`,
    en: `An app key of ${id} was removed.`,
  }),
  flagRaised: (id: string, title: Text): Text => ({
    vi: `${id}: ${title.vi}.`,
    en: `${id}: ${title.en}.`,
  }),
  flagCleared: (id: string, title: Text): Text => ({
    vi: `${id}: đã hết "${title.vi}".`,
    en: `${id}: resolved "${title.en}".`,
  }),
  pqReady: (id: string, ready: boolean): Text =>
    ready
      ? { vi: `${id} đã sẵn sàng chống lượng tử.`, en: `${id} is now quantum-ready.` }
      : { vi: `${id} không còn sẵn sàng chống lượng tử.`, en: `${id} is no longer quantum-ready.` },
};

export const DIFF_UNSEEN_LIMITATION = "A key added and removed between two scans is not seen.";
export const diffRulesetLimitation = (from: string, to: string): string =>
  `The ruleset changed from ${from} to ${to}; flag changes are not compared.`;
export const diffMemberErrorLimitation = (id: string): string =>
  `${id} could not be read in one of the two scans; its key and flag changes are not compared.`;

// ---------------------------------------------------------------------------
// kd.alert.v1 texts for checkProposals (§5.2, bot template §9.1). Ids are checked by the caller.
// ---------------------------------------------------------------------------

const YOCTO_PER_NEAR = 10n ** 24n;

/** yoctoNEAR string to NEAR without float rounding: "50000000000000000000000000" → "50". */
export function formatNear(yocto: string): string {
  if (!/^\d+$/.test(yocto)) return "?";
  const v = BigInt(yocto);
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${v / YOCTO_PER_NEAR}.${frac}` : `${v / YOCTO_PER_NEAR}`;
}

export type AlertText = { vi: { title: string; body: string; action: string }; en: { title: string; body: string; action: string } };

const hoursText = (h: number): Text =>
  h < 1 ? { vi: "chưa tới 1 giờ", en: "less than an hour" } : { vi: `khoảng ${h} giờ`, en: `about ${h} hour${h === 1 ? "" : "s"}` };

export function voterAlertText(dao: string, id: number, action: Text, voter: string, hours: number, afterTheFact: boolean): AlertText {
  const h = hoursText(hours);
  return {
    vi: {
      title: `${afterTheFact ? "ĐÃ THỰC THI" : "CẢNH BÁO"}: ${dao}`,
      body: `Đề xuất ${id}: ${action.vi}. ${voter} có khóa toàn quyền mới thêm ${h.vi} trước khi bỏ phiếu. Tài khoản có thể đã bị chiếm.`,
      action: afterTheFact
        ? `Đề xuất đã được thực thi. Xác minh với ${voter} qua kênh khác (gọi điện, gặp trực tiếp) và kiểm tra những gì đã thay đổi.`
        : `Trước khi bỏ phiếu: xác minh với ${voter} qua kênh khác (gọi điện, gặp trực tiếp).`,
    },
    en: {
      title: `${afterTheFact ? "EXECUTED" : "ALERT"}: ${dao}`,
      body: `Proposal ${id}: ${action.en}. ${voter} has a new full-access key added ${h.en} before voting. The account may be compromised.`,
      action: afterTheFact
        ? `The proposal has already been executed. Verify with ${voter} through another channel (call or meet in person) and check what changed.`
        : `Before you vote: verify with ${voter} through another channel (call or meet in person).`,
    },
  };
}

export function proposalAlertText(
  kind: "governance" | "upgrade",
  dao: string,
  id: number,
  action: Text,
  proposer: string,
  afterTheFact: boolean,
): AlertText {
  const gov = kind === "governance";
  const why: Text = gov
    ? { vi: "Đề xuất này thay đổi ai kiểm soát DAO.", en: "It changes who controls the DAO." }
    : { vi: "Đề xuất này thay code contract, code mới có thể chuyển mọi tài sản contract đang giữ.", en: "It replaces contract code, and new code can move any funds the contract holds." };
  return {
    vi: {
      title: `${afterTheFact ? "ĐÃ THỰC THI" : gov ? "ĐỔI QUYỀN DAO" : "NÂNG CẤP CODE"}: ${dao}`,
      body: `Đề xuất ${id}: ${action.vi}. ${why.vi}`,
      action: afterTheFact
        ? `Đề xuất đã được thực thi. Xác minh với ${proposer} qua kênh khác rằng chính họ tạo đề xuất, và kiểm tra những gì đã thay đổi.`
        : `Trước khi bỏ phiếu: xác minh với người tạo đề xuất ${proposer} qua kênh khác (gọi điện, gặp trực tiếp) rằng chính họ tạo nó.`,
    },
    en: {
      title: `${afterTheFact ? "EXECUTED" : gov ? "GOVERNANCE CHANGE" : "CODE UPGRADE"}: ${dao}`,
      body: `Proposal ${id}: ${action.en}. ${why.en}`,
      action: afterTheFact
        ? `The proposal has already been executed. Verify with ${proposer} through another channel that they created it, and check what changed.`
        : `Before you vote: verify with the proposer ${proposer} through another channel (call or meet in person) that they created it.`,
    },
  };
}

// Guard reason codes (§9.4). An unknown code is shown as is: the caller passes only [A-Z_] codes.
const GUARD_REASON: Record<string, Text> = {
  NOT_WHITELISTED: { vi: "người nhận không có trong danh sách được phép", en: "the receiver is not on the allowed list" },
  OVER_PER_TX: { vi: "vượt hạn mức mỗi lệnh", en: "over the per-payment limit" },
  OVER_RECIPIENT_LIMIT: { vi: "vượt hạn mức riêng của người nhận này", en: "over this receiver's own limit" },
  OVER_DAILY_LIMIT: { vi: "vượt hạn mức trong ngày", en: "over the daily limit" },
};

const reasonsText = (codes: string[]): Text => {
  const t = codes.map((c) => GUARD_REASON[c] ?? { vi: c, en: c });
  return t.length === 0 ? { vi: "không rõ", en: "not given" } : { vi: t.map((r) => r.vi).join("; "), en: t.map((r) => r.en).join("; ") };
};

const memoText = (memo: string): Text =>
  memo === "" ? { vi: "", en: "" } : { vi: ` Ghi chú của agent: "${memo}"`, en: ` Agent's note: "${memo}"` };

/** §9.4. `status` is the proposal status when Key Doctor saw it. */
export function guardPendingText(dao: string, id: number, action: Text, agent: string, reasons: string[], memo: string, status: string): AlertText {
  const why = reasonsText(reasons);
  const note = memoText(memo);
  const open = status === "InProgress";
  return {
    vi: {
      title: `AGENT XIN CHI, CẦN COUNCIL DUYỆT: ${dao}`,
      body: `Đề xuất ${id}: agent ${agent} xin ${action.vi}. Lý do Guard không tự duyệt: ${why.vi}.${note.vi}`,
      action: open
        ? "Đề xuất đang chờ council duyệt. Nếu không chắc: chọn Reject (không chọn Remove, để Guard được hoàn tiền cọc)."
        : `Đề xuất đã kết thúc trước khi Key Doctor thấy nó (trạng thái ${status}). Kiểm tra lại trên giao diện DAO.`,
    },
    en: {
      title: `AGENT PAYMENT NEEDS THE COUNCIL: ${dao}`,
      body: `Proposal ${id}: agent ${agent} asks to ${action.en}. Why the Guard did not approve it: ${why.en}.${note.en}`,
      action: open
        ? "The proposal waits for the council. If unsure, vote Reject (not Remove, so the Guard gets its bond back)."
        : `The proposal was already closed when Key Doctor saw it (status ${status}). Check it in the DAO UI.`,
    },
  };
}

/** Owner decision 2026-11-03 (Guard plan D9): every Guard outflow reaches the council, as a note. */
export function guardAutoText(dao: string, id: number, action: Text, guard: string, agent: string, memo: string, status: string): AlertText {
  const note = memoText(memo);
  if (status === "Approved") {
    return {
      vi: {
        title: `GUARD ĐÃ TỰ CHI: ${dao}`,
        body: `Đề xuất ${id}: Guard ${guard} tự duyệt ${action.vi} cho agent ${agent}, trong hạn mức.${note.vi}`,
        action: "Không cần làm gì nếu khoản này đúng. Nếu không: guardian dừng Guard (pause), rồi council xem lại agent và hạn mức.",
      },
      en: {
        title: `GUARD AUTO-PAID: ${dao}`,
        body: `Proposal ${id}: Guard ${guard} approved, within its limits, for agent ${agent}: ${action.en}.${note.en}`,
        action: "Nothing to do if this payment is expected. If not: a guardian pauses the Guard, then the council reviews the agent and the limits.",
      },
    };
  }
  return {
    vi: {
      title: `GUARD CHI KHÔNG THÀNH: ${dao}`,
      body: `Đề xuất ${id}: Guard ${guard} tự duyệt ${action.vi} cho agent ${agent}, nhưng tiền chưa chuyển (trạng thái ${status}).${note.vi}`,
      action: "Kiểm tra đề xuất trên giao diện DAO. Lý do hay gặp: số dư DAO không đủ cho khoản chi.",
    },
    en: {
      title: `GUARD PAYMENT NOT DONE: ${dao}`,
      body: `Proposal ${id}: Guard ${guard} approved, for agent ${agent}: ${action.en}, but nothing was paid (status ${status}).${note.en}`,
      action: "Check the proposal in the DAO UI. The usual cause: the DAO balance does not cover the payment.",
    },
  };
}

export const ACTION_TEXT = {
  transferNear: (amount: string, to: string): Text => ({ vi: `chuyển ${amount} NEAR cho ${to}`, en: `transfer ${amount} NEAR to ${to}` }),
  transferToken: (amount: string, token: string, to: string): Text => ({
    vi: `chuyển ${amount} (đơn vị gốc) token ${token} cho ${to}`,
    en: `transfer ${amount} raw units of ${token} to ${to}`,
  }),
  call: (methods: string, on: string): Text => ({ vi: `gọi ${methods} trên ${on}`, en: `call ${methods} on ${on}` }),
  addMember: (m: string, role: string): Text => ({ vi: `thêm ${m} vào role ${role}`, en: `add ${m} to role ${role}` }),
  removeMember: (m: string, role: string): Text => ({ vi: `bỏ ${m} khỏi role ${role}`, en: `remove ${m} from role ${role}` }),
  policy: (): Text => ({ vi: "đổi policy của DAO", en: "change the DAO policy" }),
  config: (): Text => ({ vi: "đổi cấu hình DAO", en: "change the DAO config" }),
  upgradeSelf: (): Text => ({ vi: "nâng cấp code contract của DAO", en: "upgrade the DAO contract code" }),
  upgradeRemote: (on: string): Text => ({ vi: `nâng cấp code của ${on}`, en: `upgrade the code of ${on}` }),
};
