// Live-run entry point: node packages/key-doctor/scripts/scan.ts <id> [--dao] [--network testnet] [--block N] [--save-raw <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isKdError, resolveTarget, scanAccount } from "../src/index.ts";
import type { Network } from "../src/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dao: { type: "boolean", default: false },
    network: { type: "string" },
    block: { type: "string" },
    "save-raw": { type: "string" },
  },
});

function die(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

const id = positionals[0];
if (id === undefined) die("usage: scan.ts <id> [--dao] [--network testnet] [--block N] [--save-raw <dir>]");
if (values.network !== undefined && values.network !== "mainnet" && values.network !== "testnet") {
  die("--network must be mainnet or testnet");
}
const network = values.network as Network | undefined;
const blockHeight = values.block === undefined ? undefined : Number(values.block);
const saveRaw = values["save-raw"];

try {
  const target = resolveTarget(id, { network, blockHeight });
  if (saveRaw !== undefined && target.network === "mainnet") {
    die("--save-raw is refused for mainnet targets: fixtures hold testnet data only");
  }
  if (values.dao) die("--dao is not available yet (scanDao lands in GĐ1 S3)");

  if (saveRaw !== undefined) {
    mkdirSync(saveRaw, { recursive: true });
    const realFetch = globalThis.fetch;
    let n = 0;
    // Writes the response body only, never the request URL.
    globalThis.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      const sent = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: { request_type?: string } };
      const method = (sent.params?.request_type ?? sent.method ?? "unknown").replace(/[^a-z_]/g, "");
      n += 1;
      writeFileSync(join(saveRaw, `${n}.${method}.json`), await res.clone().text());
      return res;
    };
  }

  const report = await scanAccount(id, { network, blockHeight });
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (isKdError(e)) die(JSON.stringify(e.kd, null, 2), 1);
  die("scan failed", 1);
}
