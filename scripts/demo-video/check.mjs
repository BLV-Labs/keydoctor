#!/usr/bin/env node
// Read-only readiness check before recording the demo video (scripts/demo-video/README.md). Signs nothing,
// writes nothing, never prints a key or a token. Exits 1 when any check fails.
//
//   node scripts/demo-video/check.mjs
//
// Env (the same names guard-mcp and demo.sh use):
//   GUARD_CONTRACT_ID, AGENT_ACCOUNT_ID, AGENT_KEY_PATH   scene 1, the Guard the agent pays through
//   KD_DEMO_A, KD_DEMO_B, KD_DEMO_C, KD_DEMO_PREFIX       scene 2, the council and its DAO
//   KD_WORKER_URL (default the hosted Worker), RUN_CHECK_TOKEN (only checked for presence)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { account, fmt, query, yocto } from "../guard-setup/near.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER = process.env.KD_WORKER_URL || "https://key-doctor.duonghb53.workers.dev";
const env = (k) => process.env[k] || "";
let failed = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const fail = (m) => {
  failed++;
  console.log(`  FAIL  ${m}`);
};

async function view(contract, method, args = {}) {
  const r = await query({
    request_type: "call_function",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}

async function mcp(name, args) {
  const res = await fetch(`${WORKER}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (!body.result?.structuredContent) throw new Error(JSON.stringify(body.error ?? body.result).slice(0, 200));
  return body.result.structuredContent;
}

function invoices() {
  return ["inv-001", "inv-002", "inv-003", "inv-004"].map((id) => {
    const text = readFileSync(join(ROOT, "demo/invoices", `${id}.md`), "utf8");
    const to = /\*\*Pay to:\*\* `([^`]+)`/.exec(text)?.[1];
    const amount = /\*\*Amount:\*\* ([\d.]+) NEAR/.exec(text)?.[1];
    if (!to || !amount) throw new Error(`cannot read receiver and amount from ${id}.md`);
    return { id, to, amount: BigInt(yocto(amount)) };
  });
}

async function clip1() {
  console.log("Scene 1: Agent Budget pays the invoices");
  const guard = env("GUARD_CONTRACT_ID");
  if (!guard) return fail("GUARD_CONTRACT_ID is not set");
  const info = await view(guard, "kd_guard_info").catch(() => null);
  if (!info) return fail(`${guard} is not a Guard`);
  ok(`${guard}: Guard ${info.version}, DAO ${info.dao_id}`);
  const [config, policy, whitelist, window, agents] = await Promise.all([
    view(guard, "get_config"),
    view(guard, "get_policy"),
    view(guard, "get_whitelist"),
    view(guard, "get_window"),
    view(guard, "get_agents"),
  ]);
  config.paused ? fail("the Guard is paused") : ok("the Guard is not paused");

  const [valid, injected] = [invoices().slice(0, 3), invoices()[3]];
  const listed = new Map(whitelist.map((w) => [w.account_id, w]));
  const perTx = BigInt(policy.max_per_tx);
  let total = 0n;
  for (const inv of valid) {
    total += inv.amount;
    const w = listed.get(inv.to);
    const cap = w?.max_per_tx ? BigInt(w.max_per_tx) : perTx;
    if (!w) fail(`${inv.id}: ${inv.to} is not a recipient, it would wait instead of paying`);
    else if (inv.amount > perTx || inv.amount > cap) fail(`${inv.id}: ${fmt(inv.amount)} is over the per-payment limit`);
    else if (!(await account(inv.to)).exists) fail(`${inv.id}: ${inv.to} does not exist, the payout would fail`);
    else ok(`${inv.id}: ${fmt(inv.amount)} to ${inv.to} is within the limits`);
  }
  const remaining = BigInt(window.remaining);
  remaining >= total
    ? ok(`the 24-hour window has ${fmt(remaining)} left for ${fmt(total)}`)
    : fail(`the 24-hour window has ${fmt(remaining)} left, the three invoices need ${fmt(total)}; wait for the reset`);
  listed.has(injected.to)
    ? fail(`${injected.id}: ${injected.to} is a recipient, so the injected invoice could be paid`)
    : ok(`${injected.id}: ${injected.to} is not a recipient, it will wait for the owner`);

  const dao = await account(info.dao_id);
  BigInt(dao.spendable) >= total
    ? ok(`the Budget (DAO) can spend ${fmt(dao.spendable)}`)
    : fail(`the Budget (DAO) can spend ${fmt(dao.spendable)}, the invoices need ${fmt(total)}: Top up`);
  const g = await query({ request_type: "view_account", account_id: guard });
  const reserve = BigInt(g.storage_usage) * 10n ** 19n > BigInt(policy.min_reserve) ? BigInt(g.storage_usage) * 10n ** 19n : BigInt(policy.min_reserve);
  const bond = BigInt(config.proposal_bond);
  // The agent may file all four invoices at once, so four bonds can be out together. Each request record also
  // stays in the Guard's storage (Guard 1.5.0+), which raises the reserve: 0.01 NEAR (1 KB) per request is a margin.
  const requests = BigInt(invoices().length);
  const need = reserve + requests * (bond + 10n ** 22n);
  BigInt(g.amount) >= need
    ? ok(`the Guard holds ${fmt(g.amount)}, enough for ${requests} requests (${fmt(bond)} bond each) above its ${fmt(reserve)} reserve`)
    : fail(`the Guard holds ${fmt(g.amount)}, it needs ${fmt(need)} to file ${requests} requests at once: Top up the Guard`);

  const agentId = env("AGENT_ACCOUNT_ID");
  if (!agentId) return fail("AGENT_ACCOUNT_ID is not set");
  const agent = agents.find((a) => a.account_id === agentId);
  if (!agent) return fail(`${agentId} is not an agent of this Guard`);
  if (!agent.enabled) fail(`${agentId} is disabled`);
  else if (agent.pending + 1 > policy.max_pending_per_agent)
    fail(`${agentId} has ${agent.pending} waiting requests (limit ${policy.max_pending_per_agent}): approve or reject them first`);
  else ok(`${agentId} is enabled, ${agent.pending} waiting, limit ${policy.max_pending_per_agent}`);
  const keys = (await query({ request_type: "view_access_key_list", account_id: agentId })).keys;
  const scoped = keys.every((k) => k.access_key.permission?.FunctionCall?.receiver_id === guard);
  scoped
    ? ok(`${agentId} has ${keys.length} key(s), each a function-call key for the Guard only`)
    : fail(`${agentId} also has a full-access or other key: the video says the agent holds only a Guard key, so delete it first`);
  const path = env("AGENT_KEY_PATH");
  if (!path || !existsSync(path)) return fail("AGENT_KEY_PATH does not point at the agent key file");
  const pub = JSON.parse(readFileSync(path, "utf8")).public_key; // public half only
  keys.some((k) => k.public_key === pub)
    ? ok("the key file matches a key on the agent account")
    : fail("the key file's public key is not on the agent account");
}

async function clip2and3() {
  console.log("Scene 2: council attack");
  const health = await fetch(WORKER).then((r) => r.ok, () => false);
  health ? ok(`Worker ${WORKER} answers`) : fail(`Worker ${WORKER} does not answer`);
  env("RUN_CHECK_TOKEN") ? ok("RUN_CHECK_TOKEN is set") : fail("RUN_CHECK_TOKEN is not set: demo.sh run-check needs it");
  const members = ["A", "B", "C"].map((k) => [k, env(`KD_DEMO_${k}`)]);
  if (members.some(([, id]) => !id)) return fail("set KD_DEMO_A, KD_DEMO_B and KD_DEMO_C (older accounts you hold keys for)");
  const prefix = env("KD_DEMO_PREFIX");
  if (!prefix) return fail("KD_DEMO_PREFIX is not set");
  const dao = `${prefix}.sputnik-v2.testnet`;
  const daoExists = (await account(dao)).exists;
  for (const [k, id] of members) {
    const a = await account(id);
    if (!a.exists) {
      fail(`${k} ${id} does not exist`);
      continue;
    }
    const p = await mcp("preflight", { target: id });
    const flags = p.account.flags.map((f) => (typeof f === "string" ? f : f.rule_id)).join(", ") || "none";
    const line = `${k} ${id}: ${fmt(a.spendable)} spendable, preflight ${p.verdict} (flags ${flags})`;
    // A votes and B proposes/rejects on camera, so a fresh key on either spoils the before/after; C never signs.
    if (p.verdict !== "block") ok(line);
    else if (k === "C") warn(`${line}; C does not sign, but the scan will show C high`);
    else fail(`${line}; this member already looks compromised before the attack, wait until its new key is 48 hours old`);
    if (k === "A" && !daoExists && BigInt(a.spendable) < BigInt(yocto("7"))) warn("A needs about 7 NEAR for demo.sh dao");
    if (k === "B" && BigInt(a.spendable) < BigInt(yocto("2"))) warn("B needs about 2 NEAR (1 NEAR per proposal)");
  }
  if (!daoExists) return ok(`${dao} does not exist yet: run demo.sh dao, then /watch it in the group`);
  const last = await view(dao, "get_last_proposal_id");
  ok(`${dao} exists with ${last} proposal(s)`);
  const report = await mcp("diagnose", { target: dao });
  console.log(`  scan  ${dao}: ${report.summary.status}, ${report.summary.members_high} high, ${report.summary.members_cleanup} cleanup`);
  for (const m of report.members) {
    const flags = m.flags.map((f) => f.rule_id).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "none";
    console.log(`        ${m.account_id}: ${m.status} (${flags})`);
  }
}

for (const step of [clip1, clip2and3]) {
  try {
    await step();
  } catch (e) {
    fail(`could not finish: ${e.message}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nReady to record.");
process.exit(failed ? 1 : 0);
