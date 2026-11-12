// Telegram message templates (§9). Pure: report/diff/alert in, Telegram HTML out. Rule texts come from `messages`.
// Every value from the chain, a user or `messages` goes through `esc`; only the tags written here are markup.
import { orderSuggestions, YIELD_REASON_TEXT, YIELD_TOKENS, YIELD_WARNING_TEXT } from "key-doctor";
import type { Flag, KdAlert, KdBudgetAlert, KdDiff, KdReport, KdYieldAdvice, KdYieldReport, Member, Severity, Status } from "key-doctor";
import { esc, type Button, type Outgoing } from "./api.ts";

export type Lang = "vi" | "en";

const HEADER = "<b>Key Doctor On Call</b>";
const MAX_LINES = 5;

const STATUS: Record<Lang, Record<Status, string>> = {
  vi: { high: "RỦI RO CAO", cleanup: "CẦN DỌN", note: "LƯU Ý", ok: "ỔN" },
  en: { high: "HIGH RISK", cleanup: "CLEANUP", note: "NOTE", ok: "OK" },
};
const SEVERITY_MARK: Record<Severity, string> = { high: "🔴", cleanup: "🟠", note: "⚪" };
const RANK: Record<Status, number> = { ok: 0, note: 1, cleanup: 2, high: 3 };

const fmt = (n: number) => n.toLocaleString("en-US");
/** Bold label, escaped. */
const b = (s: string) => `<b>${esc(s)}</b>`;
/** An account, DAO or token id: monospace, tap to copy. */
const id = (s: string) => `<code>${esc(s)}</code>`;
/** `2026-10-31T02:00:59Z` -> `2026-10-31 02:00 UTC`; a scan time reads better than a block height. */
const fmtTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

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
  return n > 0 ? [`<i>${lang === "vi" ? `… và ${n} mục nữa trên dashboard` : `… and ${n} more on the dashboard`}</i>`] : [];
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
    lines.push("", b(lang === "vi" ? "Vấn đề:" : "Issues:"));
    for (const f of flags.slice(0, MAX_LINES)) lines.push(`${SEVERITY_MARK[f.severity]} ${esc(f.messages[lang].title)}`);
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
  for (const f of r.dao_flags) lines.push(`${SEVERITY_MARK[f.severity]} ${esc(f.messages[lang].title)}`);
  const high = r.members.filter((m) => m.error === null && m.status === "high");
  if (high.length > 0) {
    lines.push("", b(lang === "vi" ? "Rủi ro cao:" : "High risk:"));
    for (const m of high.slice(0, MAX_LINES)) {
      const f = topFlags(m.flags)[0];
      lines.push(`- ${id(m.account_id)}: ${esc(f ? f.messages[lang].title : STATUS[lang].high)}`);
    }
    lines.push(...more(lang, high.length - MAX_LINES));
  }
  if (s.members_cleanup > 0) lines.push("", lang === "vi" ? `${b("Cần dọn:")} ${s.members_cleanup} người` : `${b("Need cleanup:")} ${s.members_cleanup}`);
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
    `${id(target)}: ${b(STATUS[lang][r.summary.status])}  (block ${fmt(r.chain.block_height)})`,
    "",
    ...body,
    "",
    lang === "vi" ? `/watch ${esc(target)} để nhận cảnh báo` : `/watch ${esc(target)} to get alerts`,
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
        ? `${id(target)}: đã lưu mốc so sánh lúc ${fmtTime(d.to.generated_at)}. Lần sau gọi /changes sẽ thấy thay đổi.`
        : `${id(target)}: baseline saved at ${fmtTime(d.to.generated_at)}. The next /changes will show what changed.`,
    );
  } else if (!d.summary.has_changes) {
    lines.push(
      lang === "vi"
        ? `${id(target)}: không có thay đổi từ ${d.from ? fmtTime(d.from.generated_at) : "?"} đến ${fmtTime(d.to.generated_at)}.`
        : `${id(target)}: no changes from ${d.from ? fmtTime(d.from.generated_at) : "?"} to ${fmtTime(d.to.generated_at)}.`,
    );
  } else {
    lines.push(
      lang === "vi"
        ? `${id(target)}: thay đổi từ ${d.from ? fmtTime(d.from.generated_at) : "?"} đến ${fmtTime(d.to.generated_at)}`
        : `${id(target)}: changes from ${d.from ? fmtTime(d.from.generated_at) : "?"} to ${fmtTime(d.to.generated_at)}`,
      "",
    );
    const shown = 10;
    for (const c of d.changes.slice(0, shown)) lines.push(`${SEVERITY_MARK[c.severity]} ${esc(c.messages[lang])}`);
    lines.push(...more(lang, d.changes.length - shown));
  }
  const skipped = d.limitations.filter((l) => l !== d.limitations[0]);
  if (skipped.length > 0) lines.push("", ...skipped.map((l) => `ⓘ <i>${esc(l)}</i>`));
  return { text: lines.join("\n"), buttons: dashboardButton(lang, dashboardUrl, target) };
}

/** Proposal-watch alert (§9.1). */
export function renderAlert(lang: Lang, a: KdAlert, dashboardUrl?: string): Outgoing {
  const m = a.messages[lang];
  const lines = [HEADER, b(m.title), "", esc(m.body)];
  const p = a.proposal;
  if (p) {
    const pending = p.pending_voters.length > 0 ? p.pending_voters.map(id).join(", ") : "-";
    const needed = p.approvals_needed === null ? "?" : String(p.approvals_needed);
    lines.push(
      lang === "vi"
        ? `${b("Phiếu:")} ${p.approvals_have}/${needed} đã duyệt. ${b("Còn chờ:")} ${pending}`
        : `${b("Votes:")} ${p.approvals_have}/${needed} approved. ${b("Still to vote:")} ${pending}`,
    );
  }
  lines.push("", `👉 ${b(m.action)}`);
  const buttons: Button[] = [];
  if (p?.ui_url) buttons.push({ text: lang === "vi" ? "Mở đề xuất" : "Open proposal", url: p.ui_url });
  buttons.push(...dashboardButton(lang, dashboardUrl, a.target));
  return { text: lines.join("\n"), buttons };
}

/** One plan message (§9.5). The texts come whole from `budgetAlerts`. */
export function renderBudgetAlert(lang: Lang, a: KdBudgetAlert): Outgoing {
  const m = a.messages[lang];
  const short = a.plan?.pause_reason === "insufficient_balance" || a.plan?.pause_reason === "guard_low_near";
  const buttons: Button[] = [];
  if (a.links.tx) buttons.push({ text: lang === "vi" ? "Xem giao dịch" : "View transaction", url: a.links.tx });
  const open = a.links.dashboard.includes("/?target=") ? (lang === "vi" ? "Mở Key Check cho tài khoản này" : "Open Key Check for this account") : lang === "vi" ? "Mở Agent Budget" : "Open Agent Budget";
  if (a.links.dashboard) buttons.push({ text: short ? "Top up" : open, url: a.links.dashboard });
  return { text: [b(`Key Doctor · ${m.title}`), esc(m.body), ...(m.action ? [`👉 ${b(m.action)}`] : [])].join("\n"), buttons };
}

/** Raw token units to `1,234.56` (rounded down): bigint math, so large balances stay exact. */
export function fmtUnits(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const cents = ((v % base) * 100n) / base;
  return `${(v / base).toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

const pct = (apr: number) => `${(apr * 100).toFixed(2)}%`;
const usd = (n: number | null) =>
  n === null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.floor(n / 1e3)}k` : `$${Math.floor(n)}`;

function councilLine(lang: Lang, dao: string, c: KdReport["summary"] | null): string {
  if (c === null) {
    return lang === "vi"
      ? "⚠️ Không kiểm tra được khóa của council: rủi ro chưa rõ, không phải thấp."
      : "⚠️ Council keys could not be checked: risk unknown, not low.";
  }
  if (c.status === "high") {
    return lang === "vi"
      ? `🔴 ${b("Khóa council: RỦI RO CAO")} (${c.members_high} người). Chạy /check ${esc(dao)} và xử lý trước khi bỏ phiếu chuyển tiền.`
      : `🔴 ${b("Council keys: HIGH RISK")} (${c.members_high} ${c.members_high === 1 ? "member" : "members"}). Run /check ${esc(dao)} and fix it before any vote that moves funds.`;
  }
  return lang === "vi" ? `Khóa council: ${b(STATUS.vi[c.status])}` : `Council keys: ${b(STATUS.en[c.status])}`;
}

/** Says who ordered the suggestions (plan §2): a TEE model, with its id and generation id, or the rules. */
function adviceLine(lang: Lang, a: KdYieldAdvice): string {
  if (a.by === "model" && a.model !== null) {
    const gen = a.generation_id === null ? "" : lang === "vi" ? `, mã ${esc(a.generation_id)}` : `, id ${esc(a.generation_id)}`;
    return lang === "vi"
      ? `🤖 <i>Thứ tự và lý do do AI gợi ý (${esc(a.model)} chạy trong TEE của NEAR AI${gen}). Mọi con số do code tính.</i>`
      : `🤖 <i>AI-assisted order and reasons (${esc(a.model)} in a NEAR AI TEE${gen}). Every number comes from code.</i>`;
  }
  return `<i>${lang === "vi" ? "Thứ tự theo quy tắc: APR cao nhất trước." : "Ordered by rules: highest APR first."}</i>`;
}

/**
 * `/yield` reply and the opt-in push (YD3). Every number comes from kd.yield.v1, every reason and note from
 * `messages`. A high-risk council leads the message: a proposal is only as safe as the council that votes on it.
 */
export function renderYield(
  lang: Lang,
  r: KdYieldReport,
  council: KdReport["summary"] | null,
  opts: { update?: boolean; watching?: boolean; dashboardUrl?: string; advice?: KdYieldAdvice | null } = {},
): Outgoing {
  const vi = lang === "vi";
  const net = r.chain.network;
  const lines = [HEADER];
  const warn = council === null || council.status === "high";
  if (warn) lines.push(councilLine(lang, r.dao, council));
  lines.push(
    opts.update
      ? vi ? `${b("Cập nhật lợi suất:")} ${id(r.dao)} (${net})` : `${b("Yield update:")} ${id(r.dao)} (${net})`
      : vi ? `${b("Lợi suất cho")} ${id(r.dao)} (${net})` : `${b("Yield for")} ${id(r.dao)} (${net})`,
  );
  if (!warn) lines.push(councilLine(lang, r.dao, council));

  lines.push("", b(vi ? "Số dư:" : "Holdings:"));
  for (const h of r.holdings) {
    if (h.balance === null || h.available === null) {
      lines.push(vi ? `- ${esc(h.symbol)}: không đọc được` : `- ${esc(h.symbol)}: could not be read`);
      continue;
    }
    const open = h.open_transfers.length;
    lines.push(
      vi
        ? `- ${esc(h.symbol)}: ${fmtUnits(h.balance, h.decimals)}, còn tự do ${fmtUnits(h.available, h.decimals)}${open > 0 ? ` (${open} đề xuất chuyển đang mở)` : ""}`
        : `- ${esc(h.symbol)}: ${fmtUnits(h.balance, h.decimals)}, free ${fmtUnits(h.available, h.decimals)}${open > 0 ? ` (${open} open transfer proposals)` : ""}`,
    );
  }

  lines.push("", b(vi ? "Đề xuất:" : "Suggestion:"));
  if (r.suggestions.length === 0) lines.push(vi ? "- Chưa có đề xuất nào." : "- No suggestion right now.");
  const advice = opts.advice ?? null;
  for (const { suggestion: s, reason } of orderSuggestions(r, advice).slice(0, MAX_LINES)) {
    const o = r.opportunities.find((x) => x.id === s.opportunity_id);
    const h = r.holdings.find((x) => x.token_id === s.token_id);
    if (o === undefined || h === undefined) continue;
    const max = fmtUnits(s.max_amount, h.decimals);
    lines.push(vi ? `- Gửi ${esc(o.symbol)} vào Rhea Lend: APR ${b(pct(o.apr))}, tối đa ${max}` : `- Supply ${esc(o.symbol)} on Rhea Lend: ${b(pct(o.apr))} APR, up to ${max}`);
    for (const w of o.warnings) lines.push(`  ⚠️ ${esc(YIELD_WARNING_TEXT[w][lang])}`);
    if (reason !== null) lines.push(`  ${esc(reason[lang])}`);
  }
  if (r.suggestions.length > 0 && advice !== null) lines.push(adviceLine(lang, advice));

  const reference = r.opportunities.filter((o) => !o.executable);
  if (reference.length > 0) {
    lines.push("", b(vi ? "Tham khảo mainnet (không thực hiện được từ DAO này):" : "Mainnet reference (not executable from this DAO):"));
    for (const o of reference.slice(0, MAX_LINES)) {
      lines.push(
        vi
          ? `- ${esc(o.symbol)}: APR ${pct(o.apr)} · TVL ${usd(o.tvl_usd)} · thanh khoản ${usd(o.liquidity_usd)}`
          : `- ${esc(o.symbol)}: ${pct(o.apr)} APR · TVL ${usd(o.tvl_usd)} · liquidity ${usd(o.liquidity_usd)}`,
      );
    }
  }

  const listed = r.rejected.filter((x) => !x.reasons.includes("NOT_ALLOWLISTED"));
  const offList = r.rejected.length - listed.length;
  if (listed.length > 0 || offList > 0) lines.push("", b(vi ? "Bị loại:" : "Filtered out:"));
  for (const x of listed.slice(0, MAX_LINES)) {
    const symbol = YIELD_TOKENS[x.network].find((t) => t.token_id === x.token_id)?.symbol ?? x.token_id;
    lines.push(`- ${esc(symbol)} (${x.network}): ${esc(x.reasons.map((c) => YIELD_REASON_TEXT[c][lang]).join(" "))}`);
  }
  if (offList > 0) lines.push(vi ? `- ${offList} token khác không nằm trong danh sách cho phép.` : `- ${offList} other tokens are not on the allowlist.`);

  lines.push("", ...r.notes.map((n) => `ⓘ <i>${esc(n[lang])}</i>`));
  const failed = [...r.errors, ...r.holdings.filter((h) => h.error !== null).map((h) => `${h.symbol}: ${h.error}`)];
  if (failed.length > 0) {
    lines.push(
      vi
        ? `Không đọc được ${failed.length} nguồn (${esc(failed.slice(0, 3).join(", "))}); đề xuất bị ảnh hưởng đã bị bỏ.`
        : `${failed.length} reads failed (${esc(failed.slice(0, 3).join(", "))}); suggestions they affect were dropped.`,
    );
  }
  if (!opts.update && !opts.watching) {
    lines.push("", vi ? `/yield_watch ${esc(r.dao)} để nhận tin khi đề xuất thay đổi` : `/yield_watch ${esc(r.dao)} to get a message when the suggestion changes`);
  }
  return { text: lines.join("\n"), buttons: dashboardButton(lang, opts.dashboardUrl, r.dao) };
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
    "/yield <DAO>: lãi suất Rhea Lend cho tiền của DAO, council tự bỏ phiếu",
    "/yield_watch <DAO>: nhận tin khi đề xuất lợi suất thay đổi",
    "/yield_unwatch <DAO>: tắt tin lợi suất",
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
    "/yield <DAO>: Rhea Lend rates for the DAO's funds; the council votes on any move",
    "/yield_watch <DAO>: get a message when the yield suggestion changes",
    "/yield_unwatch <DAO>: stop yield messages",
    "",
    "You can also just send a name like a.kd-demo.testnet. Key Doctor reads public data only, holds no keys and uses no AI.",
  ];
  const [header, ...rest] = lang === "vi" ? vi : en;
  return { text: [header, ...rest.map(esc)].join("\n") };
}

export const TEXT = {
  usage: (lang: Lang, cmd: string): Outgoing => ({
    text: lang === "vi" ? `Cách dùng: /${cmd} &lt;account hoặc DAO&gt;, ví dụ /${cmd} a.kd-demo.testnet` : `Usage: /${cmd} &lt;account or DAO&gt;, e.g. /${cmd} a.kd-demo.testnet`,
  }),
  error: (lang: Lang, message: { vi: string; en: string }): Outgoing => ({ text: `${HEADER}\n${esc(message[lang])}` }),
  watched: (lang: Lang, target: string, type: "dao" | "account"): Outgoing => ({
    text: [
      HEADER,
      lang === "vi" ? `Đã bật theo dõi ${id(target)} cho chat này.` : `This chat now watches ${id(target)}.`,
      "",
      ...(lang === "vi"
        ? [
            "- Tin mỗi ngày (khoảng 24 giờ một lần) khi khóa được thêm hoặc xóa.",
            ...(type === "dao"
              ? ["- Cảnh báo trước phiếu cuối khi người bỏ phiếu có khóa toàn quyền mới (kiểm mỗi 15 phút).", "- Cảnh báo đề xuất đổi thành viên, policy hoặc code."]
              : ["- Nếu account này ở trong council, hãy /watch thêm tên DAO để nhận cảnh báo đề xuất."]),
          ]
        : [
            "- A daily message (about every 24 hours) when a key is added or removed.",
            ...(type === "dao"
              ? ["- A warning before the final vote when a voter has a new full-access key (checked every 15 minutes).", "- A warning for proposals that change members, policy or code."]
              : ["- If this account sits in a council, also /watch the DAO to get proposal warnings."]),
          ]),
    ].join("\n"),
  }),
  alreadyWatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Chat này đã theo dõi ${id(target)} rồi.` : `This chat already watches ${id(target)}.`,
  }),
  tooMany: (lang: Lang, max: number): Outgoing => ({
    text: lang === "vi" ? `Mỗi chat theo dõi tối đa ${max} target. Dùng /unwatch để bớt.` : `A chat can watch at most ${max} targets. Use /unwatch to remove one.`,
  }),
  unwatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Đã tắt theo dõi ${id(target)}.` : `Stopped watching ${id(target)}.`,
  }),
  adminsOnly: (lang: Lang): Outgoing => ({
    text:
      lang === "vi"
        ? "Trong nhóm, chỉ admin mới tắt được theo dõi. Nhờ một admin gửi lệnh này."
        : "In a group, only admins can stop watching. Ask an admin to send this command.",
  }),
  notWatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Chat này không theo dõi ${id(target)}.` : `This chat does not watch ${id(target)}.`,
  }),
  list: (lang: Lang, items: { target: string; target_type: string }[]): Outgoing => ({
    text:
      items.length === 0
        ? lang === "vi"
          ? "Chat này chưa theo dõi gì. Gửi /watch &lt;account hoặc DAO&gt; để bắt đầu."
          : "This chat watches nothing yet. Send /watch &lt;account or DAO&gt; to start."
        : [b(lang === "vi" ? "Chat này đang theo dõi:" : "This chat watches:"), ...items.map((i) => `- ${id(i.target)} (${esc(i.target_type)})`)].join("\n"),
  }),
  linkExpired: (lang: Lang): Outgoing => ({
    text:
      lang === "vi"
        ? "Link đã hết hạn hoặc đã được dùng. Tạo lại trên dashboard hoặc nhờ agent, hoặc gửi /watch &lt;account hoặc DAO&gt;."
        : "This link has expired or was already used. Create a new one on the dashboard or through your agent, or send /watch &lt;account or DAO&gt;.",
  }),
  yieldUsage: (lang: Lang, cmd: string): Outgoing => ({
    text: lang === "vi" ? `Cách dùng: /${cmd} &lt;DAO&gt;, ví dụ /${cmd} kd-demo.sputnik-dao.testnet` : `Usage: /${cmd} &lt;DAO&gt;, e.g. /${cmd} kd-demo.sputnik-dao.testnet`,
  }),
  yieldWatched: (lang: Lang, target: string): Outgoing => ({
    text: [
      HEADER,
      lang === "vi" ? `Chat này sẽ nhận tin lợi suất của ${id(target)}.` : `This chat now gets yield messages for ${id(target)}.`,
      lang === "vi"
        ? "Rhea Lend được đọc mỗi 15 phút. Chỉ gửi tin khi đề xuất hàng đầu đổi hoặc APR đổi từ 0,5 điểm phần trăm. Cảnh báo khóa vẫn cần /watch riêng."
        : "Rhea Lend is read every 15 minutes. A message comes only when the top suggestion changes or its APR moves 0.5 percentage points. Key alerts still need /watch.",
    ].join("\n"),
  }),
  yieldAlreadyWatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Chat này đã nhận tin lợi suất của ${id(target)} rồi.` : `This chat already gets yield messages for ${id(target)}.`,
  }),
  yieldUnwatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Đã tắt tin lợi suất của ${id(target)}.` : `Stopped yield messages for ${id(target)}.`,
  }),
  yieldNotWatched: (lang: Lang, target: string): Outgoing => ({
    text: lang === "vi" ? `Chat này không nhận tin lợi suất của ${id(target)}.` : `This chat does not get yield messages for ${id(target)}.`,
  }),
  rateLimited: (lang: Lang, seconds: number): Outgoing => ({
    text: `${HEADER}\n${lang === "vi" ? `Gọi quá nhanh. Thử lại sau ${seconds} giây.` : `Too many requests. Try again in ${seconds} seconds.`}`,
  }),
  internal: (lang: Lang): Outgoing => ({
    text: lang === "vi" ? "Có lỗi khi xử lý. Hãy thử lại sau." : "Something went wrong. Try again later.",
  }),
};
