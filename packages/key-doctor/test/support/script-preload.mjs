// Preloaded into scripts/scan.ts by the AC8 test: a stub fetch that logs each request to KD_STUB_LOG.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (rel) => readFileSync(join(import.meta.dirname, "..", "..", "fixtures", rel), "utf8");
globalThis.fetch = async (input, init) => {
  const sent = JSON.parse(String(init.body));
  appendFileSync(process.env.KD_STUB_LOG, `${sent.params.request_type ?? sent.method}\n`);
  let body;
  if (sent.method === "block") body = fx("rpc/block.json");
  else if (sent.params.request_type === "view_access_key_list") body = fx("rpc/view_access_key_list.b.json");
  else body = fx("rpc/view_account.game.json");
  return new Response(body, { status: 200 });
};
