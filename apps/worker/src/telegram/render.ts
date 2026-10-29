// Telegram message templates (§9). Pure: report/diff/alert in, plain text out. Rule texts come from `messages`.
import type { Flag, KdAlert, KdDiff, KdReport, Member, Severity, Status } from "key-doctor";
import type { Button, Outgoing } from "./api.ts";

export type Lang = "vi" | "en";

const HEADER = "Key Doctor On Call";
const MAX_LINES = 5;

const STATUS: Record<Lang, Record<Status, string>> = {
  vi: { high: "RỦI RO CAO", cleanup: "CẦN DỌN", note: "LƯU Ý", ok: "ỔN" },
  en: { high: "HIGH RISK", cleanup: "CLEANUP", note: "NOTE", ok: "OK" },
};
const SEVERITY_MARK: Record<Severity, string> = { high: "🔴", cleanup: "🟠", note: "⚪" };
const RANK: Record<Status, number> = { ok: 0, note: 1, cleanup: 2, high: 3 };

const fmt = (n: number) => n.toLocaleString("en-US");

export function langOf(code: unknown): Lang {
  return typeof code === "string" && code.toLowerCase().startsWith("vi") ? "vi" : "en";
}

export function dashboardButton(lang: Lang, dashboardUrl: string | undefined, target: string): Button[] {
  if (!dashboardUrl) return [];
  const base = dashboardUrl.replace(/\/+$/, "");
  return [{ text: lang === "vi" ? "Xem chi tiết trên dashboard" : "View on dashboard", url: `${base}/?target=${encodeURIComponent(target)}` }];
}

const topFlags = (flags: readonly Flag[]): Flag[] => {
  const seen = new Set<string>();
  return [...flags]
    .sort((a, b) => RANK[b.severity] - RANK[a.severity])
    .filter((f) => (seen.has(f.rule_id) ? false : (seen.add(f.rule_id), true)));
};

function more(lang: Lang, n: number): string[] {
  return n > 0 ? [lang === "vi" ? `… và ${n} mục nữa trên dashboard` : `… and ${n} more on the dashboard`] : [];
}

function accountBlock(lang: Lang, m: Member): string[] {
  const c = m.counts;
  const lines = [
    lang === "vi"
      ? `${c.full_access} khóa toàn quyền · ${c.function_call} khóa app · ${c.ml_dsa} ML-DSA · ${c.unused} khóa chưa dùng`
      : `${c.full_access} full-access keys · ${c.function_call} app keys · ${c.ml_dsa} ML-DSA · ${c.unused} never used`,
  ];
  const flags = topFlags(m.flags);
  if (flags.length > 0) {
    lines.push("", lang === "vi" ? "Vấn đề:" : "Issues:");
    for (const f of flags.slice(0, MAX_LINES)) lines.push(`${SEVERITY_MARK[f.severity]} ${f.messages[lang].title}`);
    lines.push(...more(lang, flags.length - MAX_LINES));
  } else {
    lines.push("", lang === "vi" ? "Không thấy vấn đề nào." : "No issues found.");
  }
  return lines;
}

function councilBlock(lang: Lang, r: KdReport): string[] {
  const s = r.summary;
  const lines = [
    lang === "vi"
      ? `Council ${s.council_size} người: ${s.members_high} rủi ro cao, ${s.members_cleanup} cần dọn, ${s.pq_ready} sẵn sàng lượng tử.`
      : `Council of ${s.council_size}: ${s.members_high} high risk, ${s.members_cleanup} need cleanup, ${s.pq_ready} quantum-ready.`,
  ];
  for (const f of r.dao_flags) lines.push(`${SEVERITY_MARK[f.severity]} ${f.messages[lang].title}`);
  const high = r.members.filter((m) => m.error === null && m.status === "high");
  if (high.length > 0) {
    lines.push("", lang === "vi" ? "Rủi ro cao:" : "High risk:");
    for (const m of high.slice(0, MAX_LINES)) {
      const f = topFlags(m.flags)[0];
      lines.push(`- ${m.account_id}: ${f ? f.messages[lang].title : STATUS[lang].high}`);
    }
    lines.push(...more(lang, high.length - MAX_LINES));
  }
  if (s.members_cleanup > 0) lines.push("", lang === "vi" ? `Cần dọn: ${s.members_cleanup} người` : `Need cleanup: ${s.members_cleanup}`);
  const unread = r.members.filter((m) => m.error !== null).length;
  if (unread > 0) {
    lines.push(
      lang === "vi"
        ? `Không đọc được: ${unread} người (rủi ro chưa rõ, không phải thấp)`
        : `Could not read: ${unread} (risk unknown, not low)`,
    );
  }
  return lines;
}

/** /check result (§9.2). */
export function renderCheck(lang: Lang, r: KdReport, dashboardUrl?: string): Outgoing {
  const target = r.target.id;
  const member = r.members[0];
  const body = r.target.type === "dao" || member === undefined ? councilBlock(lang, r) : accountBlock(lang, member);
  const lines = [
    HEADER,
    `${target}: ${STATUS[lang][r.summary.status]}  (block ${fmt(r.chain.block_height)})`,
    "",
    ...body,
    "",
    lang === "vi" ? `/watch ${target} để nhận cảnh báo` : `/watch ${target} to get alerts`,
  ];
  return { text: lines.join("\n"), buttons: dashboardButton(lang, dashboardUrl, target) };
}

/** /changes result: kd.diff.v1 grouped by severity. */
export function renderChanges(lang: Lang, d: KdDiff, dashboardUrl?: string): Outgoing {
  const target = d.target.id;
  const lines = [HEADER];
  if (d.is_baseline) {
    lines.push(
      lang === "vi"
        ? `${target}: đã lưu mốc so sánh ở block ${fmt(d.to.block_height)}. Lần sau gọi /changes sẽ thấy thay đổi.`
        : `${target}: baseline saved at block ${fmt(d.to.block_height)}. The next /changes will show what changed.`,
    );
  } else if (!d.summary.has_changes) {
    lines.push(
      lang === "vi"
        ? `${target}: không có thay đổi từ block ${fmt(d.from?.block_height ?? 0)} đến ${fmt(d.to.block_height)}.`
        : `${target}: no changes from block ${fmt(d.from?.block_height ?? 0)} to ${fmt(d.to.block_height)}.`,
    );
  } else {
    lines.push(
      lang === "vi"
        ? `${target}: thay đổi từ block ${fmt(d.from?.block_height ?? 0)} đến ${fmt(d.to.block_height)}`
        : `${target}: changes from block ${fmt(d.from?.block_height ?? 0)} to ${fmt(d.to.block_height)}`,
      "",
    );
    const shown = 10;
    for (const c of d.changes.slice(0, shown)) lines.push(`${SEVERITY_MARK[c.severity]} ${c.messages[lang]}`);
    lines.push(...more(lang, d.changes.length - shown));
  }
  const skipped = d.limitations.filter((l) => l !== d.limitations[0]);
  if (skipped.length > 0) lines.push("", ...skipped.map((l) => `ⓘ ${l}`));
  return { text: lines.join("\n"), buttons: dashboardButton(lang, dashboardUrl, target) };
}

/** Proposal-watch alert (§9.1). */
export function renderAlert(lang: Lang, a: KdAlert, dashboardUrl?: string): Outgoing {
  const m = a.messages[lang];
  const lines = [HEADER, m.title, "", m.body];
  const p = a.proposal;
  if (p) {
    const pending = p.pending_voters.length > 0 ? p.pending_voters.join(", ") : "-";
    const needed = p.approvals_needed === null ? "?" : String(p.approvals_needed);
    lines.push(
      lang === "vi"
        ? `Phiếu: ${p.approvals_have}/${needed} đã duyệt. Còn chờ: ${pending}`
        : `Votes: ${p.approvals_have}/${needed} approved. Still to vote: ${pending}`,
    );
  }
  lines.push("", m.action);
  const buttons: Button[] = [];
  if (p?.ui_url) buttons.push({ text: lang === "vi" ? "Mở đề xuất" : "Open proposal", url: p.ui_url });
  buttons.push(...dashboardButton(lang, dashboardUrl, a.target));
  return { text: lines.join("\n"), buttons };
}

export function renderHelp(lang: Lang): Outgoing {
  const vi = [
    HEADER,
    "Kiểm tra khóa của account NEAR hoặc council của DAO Sputnik, và cảnh báo trước khi council bỏ phiếu.",
    "",
    "/check <account hoặc DAO>: kiểm tra ngay",
    "/changes <account hoặc DAO>: xem thay đổi so với mốc",
    "/watch <account hoặc DAO>: nhận cảnh báo trong chat này",
    "/unwatch <account hoặc DAO>: tắt cảnh báo",
    "/list: các target chat này đang theo dõi",
    "",
    "Có thể gửi thẳng một tên như a.kd-demo.testnet. Key Doctor chỉ đọc dữ liệu công khai, không giữ khóa, không dùng AI.",
  ];
  const en = [
    HEADER,
    "Checks the keys of a NEAR account or a Sputnik DAO council, and warns the council before the final vote.",
    "",
    "/check <account or DAO>: check now",
    "/changes <account or DAO>: what changed since the baseline",
    "/watch <account or DAO>: get alerts in this chat",
    "/unwatch <account or DAO>: stop alerts",
    "/list: targets this chat watches",
    "",
    "You can also just send a name like a.kd-demo.testnet. Key Doctor reads public data only, holds no keys and uses no AI.",
  ];
  return { text: (lang === "vi" ? vi : en).join("\n") };
}

export const TEXT = {
  usage: (lang: Lang, cmd: string): Outgoing => ({
    text: lang === "vi" ? `Cách dùng: /${cmd} <account hoặc DAO>, ví dụ /${cmd} a.kd-demo.testnet` : `Usage: /${cmd} <account or DAO>, e.g. /${cmd} a.kd-demo.testnet`,
  }),
  error: (lang: Lang, message: { vi: string; en: string }): Outgoing => ({ text: `${HEADER}\n${message[lang]}` }),
  watched: (lang: Lang, target: string, type: "dao" | "account"): Outgoing => ({
    text: [
      HEADER,
      lang === "vi" ? `Đã bật theo dõi ${target} cho chat này.` : `This chat now watches ${target}.`,
      "",
      ...(lang === "vi"
        ? [
            "- Tin hằng ngày (02:00 UTC) khi khóa được thêm hoặc xóa.",
            ...(type === "dao"
              ? ["- Cảnh báo trước phiếu cuối khi người bỏ phiếu có khóa toàn quyền mới (kiểm mỗi 15 phút).", "- Cảnh báo đề xuất đổi thành viên, policy hoặc code."]
              : ["- Nếu account này ở trong council, hãy /watch thêm tên DAO để nhận cảnh báo đề xuất."]),
          ]
        : [
            "- A daily message (02:00 UTC) when a key is added or removed.",
            ...(type === "dao"
              ? ["- A warning before the final vote when a voter has a new full-access key (checked every 15 minutes).", "- A warning for proposals that change members, policy or code."]
              : ["- If this account sits in a council, also /watch the DAO to get proposal warnings."]),
          ]),
    ].join("\n"),
  }),
  alreadyWatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Chat này đã theo dõi ${target} rồi.` : `This chat already watches ${target}.`,
  }),
  tooMany: (lang: Lang, max: number): Outgoing => ({
    text: lang === "vi" ? `Mỗi chat theo dõi tối đa ${max} target. Dùng /unwatch để bớt.` : `A chat can watch at most ${max} targets. Use /unwatch to remove one.`,
  }),
  unwatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Đã tắt theo dõi ${target}.` : `Stopped watching ${target}.`,
  }),
  notWatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Chat này không theo dõi ${target}.` : `This chat does not watch ${target}.`,
  }),
  list: (lang: Lang, items: { target: string; target_type: string }[]): Outgoing => ({
    text:
      items.length === 0
        ? lang === "vi"
          ? "Chat này chưa theo dõi gì. Gửi /watch <account hoặc DAO> để bắt đầu."
          : "This chat watches nothing yet. Send /watch <account or DAO> to start."
        : [lang === "vi" ? "Chat này đang theo dõi:" : "This chat watches:", ...items.map((i) => `- ${i.target} (${i.target_type})`)].join("\n"),
  }),
  internal: (lang: Lang): Outgoing => ({
    text: lang === "vi" ? "Có lỗi khi xử lý. Hãy thử lại sau." : "Something went wrong. Try again later.",
  }),
};
