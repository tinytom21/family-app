/**
 * Build the hosted demo.
 *
 * GitHub Pages serves files, so the app has to arrive as files. esbuild
 * compiles the TypeScript domain layer plus the browser adapter into one
 * script, and the rendering client is copied across untouched — it is plain
 * JavaScript and always has been.
 *
 *   node scripts/build-static.mjs        writes ../../docs/app
 *
 * The one thing this deliberately does not bundle is the model SDKs. The
 * browser adapter never imports them, so they cannot end up here by accident;
 * `assertNoSecretsShaped` below checks the built file anyway, because "cannot
 * happen" is a poor guard for "ships an API key to the internet".
 */

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "..", "..", "docs", "app");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/* ---- the app, compiled for a browser ---- */
const result = await build({
  entryPoints: [join(root, "web/static/main.ts")],
  outfile: join(out, "family-app.js"),
  bundle: true,
  format: "iife",
  target: ["es2022"],
  platform: "browser",
  minify: true,
  sourcemap: true,
  legalComments: "none",
  metafile: true,
});

/* Supabase, so Connect calendar still works once the Pages origin is added to
   Google and Supabase. The same prebuilt UMD file the local server hands out,
   copied rather than re-bundled so both hosts run identical bytes. */
await cp(
  join(root, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"),
  join(out, "vendor-supabase.js"),
);

/* ---- the rendering client and its markup ---- */
for (const file of [
  "index.html",
  "app.css",
  "app.js",
  "check-google.html",
  "check-google.css",
  "check-google.js",
  "check-logic.js",
]) {
  await cp(join(root, "web/public", file), join(out, file));
}

/* The local server serves Supabase from node_modules at /vendor/supabase.js;
   on Pages the app lives under a subpath, so the reference becomes relative. */
for (const file of ["index.html", "check-google.html"]) {
  const path = join(out, file);
  let html = await readFile(path, "utf8");
  html = html.replace("/vendor/supabase.js", "vendor-supabase.js");
  html = html.replace("/app.css", "app.css").replace("/app.js", "app.js");
  html = html.replace(
    "</head>",
    '  <script src="family-app.js"></script>\n</head>',
  );
  await writeFile(path, html, "utf8");
}

/* ---- the check that matters ---- */
const bundle = await readFile(join(out, "family-app.js"), "utf8");
assertNoSecretsShaped(bundle);

const bytes = result.metafile.outputs[
  Object.keys(result.metafile.outputs).find((k) => k.endsWith("family-app.js"))
].bytes;
console.log(`  docs/app/family-app.js  ${(bytes / 1024).toFixed(0)} kB`);
console.log("  no API keys, no model SDK, no server.\n");

/**
 * Refuse to ship anything key-shaped.
 *
 * A build that quietly embedded `process.env.ANTHROPIC_API_KEY` would publish
 * a live credential to a public web page, and it would look fine until the
 * bill arrived. Cheap to check, catastrophic to miss.
 */
function assertNoSecretsShaped(source) {
  const patterns = [
    /sk-ant-[A-Za-z0-9_-]{8,}/,
    /AIza[A-Za-z0-9_-]{20,}/,
    /ANTHROPIC_API_KEY\s*[:=]\s*["'][^"']+["']/,
    /GEMINI_API_KEY\s*[:=]\s*["'][^"']+["']/,
  ];
  for (const pattern of patterns) {
    const hit = source.match(pattern);
    if (hit) {
      throw new Error(
        `Refusing to write the bundle: it contains something key-shaped (${hit[0].slice(0, 12)}…).`,
      );
    }
  }
}
