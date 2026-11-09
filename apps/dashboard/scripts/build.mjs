// Builds the static site into dist/: the bundled app plus public/ and the design tokens.
// `--serve` rebuilds on change and serves dist/ on http://localhost:8788.
import { context, build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const dist = join(app, "dist");
const serve = process.argv.includes("--serve");
// Optional Worker origin for one-tap watch links (P1). Empty keeps the MVP dialog with no Worker call.
const workerUrl = (process.env.KD_WORKER_URL ?? "").replace(/\/+$/, "");
if (workerUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(workerUrl) && !/^http:\/\/localhost(:\d+)?$/.test(workerUrl)) {
  throw new Error("KD_WORKER_URL must be an https origin, e.g. https://key-doctor.example.workers.dev");
}

// Optional Guard factory account for the Agent Guard page. Empty keeps the page as setup instructions only.
const guardFactory = process.env.KD_GUARD_FACTORY ?? "";
if (guardFactory && !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(testnet|near)$/.test(guardFactory)) {
  throw new Error("KD_GUARD_FACTORY must be a .testnet or .near account, e.g. guards.kdfactory.testnet");
}

// Optional factory that creates Agent Budgets (Guard v2). Empty keeps "Create Agent Budget" closed: not deployed yet.
const budgetFactory = process.env.KD_BUDGET_FACTORY ?? "";
if (budgetFactory && !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(testnet|near)$/.test(budgetFactory)) {
  throw new Error("KD_BUDGET_FACTORY must be a .testnet or .near account, e.g. keydoctor-guards-v2.testnet");
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(app, "public"), dist, { recursive: true });
cpSync(join(app, "../../docs/design/dashboard/tokens.css"), join(dist, "tokens.css"));
cpSync(join(app, "../../docs/design/keyfence/tokens-keyfence.css"), join(dist, "tokens-keyfence.css"));
if (workerUrl) {
  const headers = join(dist, "_headers");
  writeFileSync(headers, readFileSync(headers, "utf8").replace("connect-src ", `connect-src ${workerUrl} `));
}

const options = {
  entryPoints: [join(app, "src/app.ts")],
  outdir: dist,
  splitting: true,
  chunkNames: "chunk-[hash]",
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: !serve,
  sourcemap: serve,
  logLevel: "info",
  alias: { buffer: "buffer/", util: "util/", crypto: join(here, "crypto-shim.mjs") },
  inject: [join(here, "buffer-shim.mjs")],
  define: { global: "globalThis", "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}", "process.browser": "true", "process.version": JSON.stringify(""), "process.platform": JSON.stringify("browser"), __KD_WORKER_URL__: JSON.stringify(workerUrl), __KD_GUARD_FACTORY__: JSON.stringify(guardFactory), __KD_BUDGET_FACTORY__: JSON.stringify(budgetFactory) },
};

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 8788 });
  console.log(`Dashboard on http://localhost:${port}`);
} else {
  await build(options);
}
