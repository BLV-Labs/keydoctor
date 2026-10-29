// Builds the static site into dist/: the bundled app plus public/ and the design tokens.
// `--serve` rebuilds on change and serves dist/ on http://localhost:8788.
import { context, build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const dist = join(app, "dist");
const serve = process.argv.includes("--serve");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(app, "public"), dist, { recursive: true });
cpSync(join(app, "../../docs/design/dashboard/tokens.css"), join(dist, "tokens.css"));

const options = {
  entryPoints: [join(app, "src/app.ts")],
  outfile: join(dist, "app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: !serve,
  sourcemap: serve,
  logLevel: "info",
};

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 8788 });
  console.log(`Dashboard on http://localhost:${port}`);
} else {
  await build(options);
}
