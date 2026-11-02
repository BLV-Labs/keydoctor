import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { diffReports, type KdAlert, type KdReport } from "key-doctor";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { findNames, handleUpdate, incomingFrom, parseCommand, MAX_SUBS_PER_CHAT } from "../src/telegram/commands.ts";
import { langOf, renderAlert, renderChanges, renderCheck, renderHelp } from "../src/telegram/render.ts";
import { testD1, type TestD1 } from "./support/d1.ts";
import { DAO, addKey, fixture, installChain, type Chain } from "./support/rpc.ts";

const SECRET = "hook-secret";
const daoReport = () => fixture<KdReport>("reports/dao-kd-demo.report.json");
const accountReport = () => fixture<KdReport>("reports/account-b.report.json");

function setup(t: TestContext) {
  const db = testD1();
  const chain = installChain(t);
  const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: SECRET, DASHBOARD_URL: "https://kd.example/" };
  return { db, chain, env };
}

let updateId = 1;
const update = (text: string, opts: { chat?: number; type?: string; lang?: string } = {}) => ({
  update_id: updateId++,
  message: {
    message_id: 1,
    text,
    chat: { id: opts.chat ?? 42, type: opts.type ?? "private" },
    from: { id: 7, is_bot: false, language_code: opts.lang ?? "en" },
  },
});

async function say(env: Env, chain: Chain, text: string, opts: Parameters<typeof update>[1] = {}) {
  const before = chain.telegram.length;
  await handleUpdate(update(text, opts), env);
  const sent = chain.telegram.slice(before).filter((x) => x.method === "sendMessage");
  return sent.at(-1)?.body as { chat_id: string; text: string; reply_markup?: any } | undefined;
}
const rows = (db: TestD1, table: string) => db.raw.prepare(`SELECT * FROM ${table}`).all() as any[];

describe("GĐ4 webhook", () => {
  it("rejects a missing or wrong secret token and does no work", async (t) => {
    const { env, chain } = setup(t);
    for (const header of [undefined, "wrong"]) {
      const res = await worker.fetch(
        new Request("https://kd.test/telegram", { method: "POST", headers: header ? { "x-telegram-bot-api-secret-token": header } : {}, body: JSON.stringify(update("/help")) }),
        env,
        { waitUntil: () => assert.fail("no work without the secret") },
      );
      assert.equal(res.status, 401);
    }
    const noSecret = await worker.fetch(
      new Request("https://kd.test/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "" }, body: "{}" }),
      { ...env, TELEGRAM_WEBHOOK_SECRET: "" },
      { waitUntil: () => {} },
    );
    assert.equal(noSecret.status, 401);
    assert.equal(chain.telegram.length, 0);
  });

  it("answers 200 at once and does the work in waitUntil", async (t) => {
    const { env, chain } = setup(t);
    const pending: Promise<unknown>[] = [];
    const res = await worker.fetch(
      new Request("https://kd.test/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(update("/help")) }),
      env,
      { waitUntil: (p) => pending.push(p) },
    );
    assert.equal(res.status, 200);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.equal(chain.telegram[0]?.method, "sendMessage");
    assert.equal(chain.telegram[0]?.body.chat_id, "42");
  });
});

describe("GĐ4 parsing (no LLM: commands and a name regex)", () => {
  it("parses commands, @bot suffixes and arguments", () => {
    assert.deepEqual(parseCommand("/check a.kd-demo.testnet", false), { name: "check", target: "a.kd-demo.testnet" });
    assert.deepEqual(parseCommand("/watch@KeyDoctorOnCallBot kd-demo.sputnik-v2.testnet", true), { name: "watch", target: "kd-demo.sputnik-v2.testnet" });
    assert.deepEqual(parseCommand("/changes", false), { name: "changes", target: null });
    assert.deepEqual(parseCommand("/list", true), { name: "list" });
    assert.deepEqual(parseCommand("/start", false), { name: "help" });
    assert.deepEqual(parseCommand("/nope", false), { name: "help" });
    assert.deepEqual(parseCommand("/nope", true), { name: "ignore" });
  });

  it("free text: exactly one name runs /check, otherwise /help in private and silence in groups", () => {
    assert.deepEqual(parseCommand("is b.kd-demo.testnet safe?", false), { name: "check", target: "b.kd-demo.testnet" });
    assert.deepEqual(parseCommand("Check KD-DEMO.SPUTNIK-V2.TESTNET please", true), { name: "check", target: "kd-demo.sputnik-v2.testnet" });
    assert.deepEqual(parseCommand("hello", false), { name: "help" });
    assert.deepEqual(parseCommand("hello", true), { name: "ignore" });
    assert.deepEqual(parseCommand("a.testnet or b.testnet?", false), { name: "help" });
    assert.deepEqual(findNames("see x.near, x.near and y.testnet"), ["x.near", "y.testnet"]);
    assert.deepEqual(findNames("mail me at bob@example.com"), []);
  });

  it("ignores updates without text, from bots or channels; picks vi or en from language_code", () => {
    assert.equal(incomingFrom({ edited_message: {} }), null);
    assert.equal(incomingFrom({ message: { text: "/help", chat: { id: 1, type: "channel" }, from: {} } }), null);
    assert.equal(incomingFrom({ message: { text: "/help", chat: { id: 1, type: "private" }, from: { is_bot: true } } }), null);
    assert.equal(incomingFrom(update("/help", { lang: "vi-VN" }))?.lang, "vi");
    assert.equal(langOf(undefined), "en");
  });
});

describe("GĐ4 message rendering", () => {
  it("/check for a DAO follows §9.2 in both languages, with rule titles verbatim", () => {
    const en = renderCheck("en", daoReport(), "https://kd.example");
    assert.equal(
      en.text,
      [
        "Key Doctor On Call",
        `${DAO}: HIGH RISK  (block 182,340,111)`,
        "",
        "Council of 3: 1 high risk, 1 need cleanup, 1 quantum-ready.",
        "",
        "High risk:",
        "- a.kd-demo.testnet: Too many full-access keys",
        "",
        "Need cleanup: 1",
        "",
        `/watch ${DAO} to get alerts`,
      ].join("\n"),
    );
    assert.deepEqual(en.buttons, [{ text: "View on dashboard", url: `https://kd.example/?target=${DAO}` }]);
    const vi = renderCheck("vi", daoReport());
    assert.match(vi.text, /Council 3 người: 1 rủi ro cao, 1 cần dọn, 1 sẵn sàng lượng tử\./);
    assert.match(vi.text, /- a\.kd-demo\.testnet: Quá nhiều khóa toàn quyền/);
    assert.deepEqual(vi.buttons, []);
  });

  it("/check for an account lists its issues, most severe first", () => {
    const r = renderCheck("en", accountReport());
    assert.match(r.text, /b\.kd-demo\.testnet: CLEANUP/);
    assert.match(r.text, /1 full-access keys · 1 app keys · 0 ML-DSA · 0 never used/);
    const issues = r.text.split("Issues:\n")[1]!.split("\n\n")[0]!.split("\n");
    assert.deepEqual(issues, ["🟠 App key with unlimited allowance", "🟠 App key can call any method", "⚪ No post-quantum key"]);
  });

  it("/check marks members that could not be read as unknown risk", () => {
    const r = daoReport();
    r.members[2]!.error = "RPC_ERROR";
    assert.match(renderCheck("en", r).text, /Could not read: 1 \(risk unknown, not low\)/);
  });

  it("/changes: baseline, no change, and changes with severity marks", () => {
    const base = daoReport();
    assert.match(renderChanges("en", diffReports(null, base)).text, /baseline saved at 2026-11-03 02:00 UTC/);
    const same = { ...daoReport(), generated_at: "2026-11-04T02:00:30Z", chain: { ...base.chain, block_height: base.chain.block_height + 10 } };
    assert.match(renderChanges("vi", diffReports(base, same)).text, /không có thay đổi từ 2026-11-03 02:00 UTC đến 2026-11-04 02:00 UTC/);
    const curr = daoReport();
    curr.members[1]!.keys.push({ ...curr.members[1]!.keys[0]!, public_key: "ed25519:Fresh" });
    const text = renderChanges("en", diffReports(base, curr)).text;
    assert.match(text, /🔴 b\.kd-demo\.testnet has a new full-access key/);
    assert.match(text, /changes from 2026-11-03 02:00 UTC to 2026-11-03 02:00 UTC/);
    assert.doesNotMatch(text, /block/);
  });

  it("proposal alert follows §9.1: voters still to vote, verify through another channel, open-proposal link", () => {
    const a = fixture<KdAlert>("alerts/voter-new-full-access-key.alert.json");
    a.proposal!.ui_url = "https://ui.example/p/2";
    const vi = renderAlert("vi", a, "https://kd.example");
    assert.equal(
      vi.text,
      [
        "Key Doctor On Call",
        `CẢNH BÁO: ${DAO}`,
        "",
        a.messages.vi.body,
        "Phiếu: 1/2 đã duyệt. Còn chờ: b.kd-demo.testnet, c.kd-demo.testnet",
        "",
        "Trước khi bỏ phiếu: xác minh với a.kd-demo.testnet qua kênh khác (gọi điện, gặp trực tiếp).",
      ].join("\n"),
    );
    assert.deepEqual(vi.buttons?.map((b) => b.text), ["Mở đề xuất", "Xem chi tiết trên dashboard"]);
    assert.match(renderAlert("en", a).text, /Still to vote: b\.kd-demo\.testnet, c\.kd-demo\.testnet/);
  });

  it("help exists in both languages", () => {
    assert.match(renderHelp("vi").text, /\/watch <account hoặc DAO>/);
    assert.match(renderHelp("en").text, /uses no AI/);
  });
});

describe("GĐ4 commands end to end (stub RPC, Telegram and D1)", () => {
  it("/check replies with the summary and never touches D1", async (t) => {
    const { env, chain, db } = setup(t);
    const sent = await say(env, chain, `/check ${DAO}`);
    assert.match(sent!.text, /HIGH RISK/);
    assert.ok(chain.telegram.some((x) => x.method === "sendChatAction"));
    assert.deepEqual(db.log, []);
  });

  it("a plain message with one name runs /check", async (t) => {
    const { env, chain } = setup(t);
    const sent = await say(env, chain, "is b.kd-demo.testnet ok?");
    assert.match(sent!.text, /b\.kd-demo\.testnet: CLEANUP/);
  });

  it("errors reply with the kd.error.v1 text in the user's language", async (t) => {
    const { env, chain } = setup(t);
    assert.match((await say(env, chain, "/check nobody.kd-demo.testnet", { lang: "vi" }))!.text, /Account không tồn tại/);
    assert.match((await say(env, chain, "/check Bad!Name"))!.text, /Invalid target/);
    assert.match((await say(env, chain, "/watch"))!.text, /Usage: \/watch/);
  });

  it("/watch in a group: one row, baseline and proposal state saved; twice is still one row (UC4 done-when)", async (t) => {
    const { env, chain, db } = setup(t);
    const first = await say(env, chain, `/watch ${DAO}`, { chat: -100, type: "supergroup" });
    assert.match(first!.text, /This chat now watches kd-demo\.sputnik-dao\.testnet/);
    assert.match(first!.text, /before the final vote/);
    const again = await say(env, chain, `/watch@KeyDoctorOnCallBot ${DAO}`, { chat: -100, type: "supergroup" });
    assert.match(again!.text, /already watches/);
    const subs = rows(db, "subscriptions");
    assert.equal(subs.length, 1);
    assert.deepEqual({ ...subs[0], created_at: "x" }, { target: DAO, network: "testnet", target_type: "dao", chat_id: "-100", chat_type: "supergroup", created_at: "x" });
    assert.equal(rows(db, "snapshots").length, 1);
    assert.deepEqual(rows(db, "proposal_state").map((r) => [r.target, r.last_proposal_id, r.pending_json]), [[DAO, 4, "{}"]]);
  });

  it("/watch on an account adds no proposal state; an existing baseline is not replaced", async (t) => {
    const { env, chain, db } = setup(t);
    await say(env, chain, "/changes b.kd-demo.testnet");
    const baseline = rows(db, "snapshots")[0];
    addKey(chain, "b.kd-demo.testnet", "ed25519:AddedAfterBaseline111111111111111111111111");
    const sent = await say(env, chain, "/watch b.kd-demo.testnet");
    assert.match(sent!.text, /also \/watch the DAO/);
    assert.deepEqual(rows(db, "snapshots"), [baseline]);
    assert.deepEqual(rows(db, "proposal_state"), []);
  });

  it("/list and /unwatch", async (t) => {
    const { env, chain, db } = setup(t);
    assert.match((await say(env, chain, "/list"))!.text, /watches nothing yet/);
    await say(env, chain, `/watch ${DAO}`);
    assert.match((await say(env, chain, "/list"))!.text, new RegExp(`- ${DAO} \\(dao\\)`));
    assert.match((await say(env, chain, `/unwatch ${DAO}`))!.text, /Stopped watching/);
    assert.match((await say(env, chain, `/unwatch ${DAO}`))!.text, /does not watch/);
    assert.equal(rows(db, "subscriptions").length, 0);
  });

  it("/changes does not move the baseline", async (t) => {
    const { env, chain, db } = setup(t);
    assert.match((await say(env, chain, `/changes ${DAO}`))!.text, /baseline saved/);
    addKey(chain, "c.kd-demo.testnet", "ed25519:NewOnC11111111111111111111111111111111111");
    const a = await say(env, chain, `/changes ${DAO}`);
    const b = await say(env, chain, `/changes ${DAO}`);
    assert.match(a!.text, /🔴 c\.kd-demo\.testnet has a new full-access key/);
    assert.equal(a!.text, b!.text);
    assert.equal(rows(db, "snapshots").length, 1);
  });

  it("a chat over the subscription cap is refused", async (t) => {
    const { env, chain, db } = setup(t);
    for (let i = 0; i < MAX_SUBS_PER_CHAT; i++) {
      db.raw.prepare("INSERT INTO subscriptions VALUES (?, 'testnet', 'account', '42', 'private', 'x')").run(`acc${i}.testnet`);
    }
    assert.match((await say(env, chain, `/watch ${DAO}`))!.text, /at most 20 targets/);
  });

  it("a chat that blocked the bot loses its subscriptions", async (t) => {
    const { env, chain, db } = setup(t);
    await say(env, chain, `/watch ${DAO}`);
    chain.telegramStatus = 403;
    await say(env, chain, "/list");
    assert.equal(rows(db, "subscriptions").length, 0);
  });
});
