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
