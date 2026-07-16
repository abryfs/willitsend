// Builds the playground into site/dist: bundles site/main.ts (which imports
// the engine straight from src/core, so the playground can never drift from
// the library) and copies the static shell.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("site/dist", { recursive: true });

await build({
  entryPoints: ["site/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: "site/dist/main.js",
});

await cp("site/index.html", "site/dist/index.html");
await cp("site/fonts", "site/dist/fonts", { recursive: true });
await cp("site/og.png", "site/dist/og.png");
console.log("site/dist ready");
