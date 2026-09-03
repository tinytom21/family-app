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
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const docs = join(root, "..", "..", "docs");
const out = join(docs, "app");

/* ---- does the client actually parse? ----
 *
 * The rendering client is hand-written JavaScript that nothing compiles, so a
 * stray character in it is not caught by the type stripper, the tests, or
 * esbuild — none of them ever read the file. A syntax error there takes the
 * whole page down while every other check stays green, which is exactly how
 * one reached the published site once. Cheap to check, embarrassing to miss.
 */
for (const file of ["app/app.js", "app/setup.js", "app/account.js", "check-google.js", "check-logic.js"]) {
  const source = join(root, "web/public", file);
  try {
    execFileSync(process.execPath, ["--check", source], { stdio: "pipe" });
  } catch (error) {
    throw new Error(
      `Refusing to build: ${file} does not parse.\n${error.stderr?.toString() ?? error.message}`,
    );
  }
}

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
  join(docs, "vendor-supabase.js"),
);

/* The client and the setup checker, copied across untouched.
 *
 * Untouched is the point. An earlier version of this script rewrote absolute
 * paths on the way past, which worked right up until it missed one — the
 * checker's `import "/check-logic.js"` — and shipped a page that 404'd only
 * when hosted under a subpath, never locally. The layout under web/public now
 * matches the layout under docs/ exactly, every path in it is relative, and
 * this step copies rather than edits. What runs locally is what gets served.
 */
await cp(join(root, "web/public/app"), out, { recursive: true });
for (const file of [
  "check-google.html",
  "check-google.css",
  "check-google.js",
  "check-logic.js",
]) {
  await cp(join(root, "web/public", file), join(docs, file));
}

/* ---- the Supabase project, if this build has been given one ----
 *
 * The anon key is public by design — it names the project, not the person, and
 * ships in the JavaScript of every Supabase web app there is. What protects a
 * family's week is the Row Level Security in supabase/schema.sql, written on
 * the assumption that whoever is calling already has this key.
 *
 * A *service role* key is an entirely different animal and must never come
 * near this file; the check below refuses the build if one turns up.
 */
const config = await readConfig();
await writeFile(
  join(out, "supabase-config.js"),
  config
    ? `window.__SUPABASE_CONFIG=${JSON.stringify(config)};\n`
    : "/* No Supabase project configured: accounts are off in this build. */\n",
  "utf8",
);
console.log(
  config
    ? `  accounts on — ${config.url}`
    : "  accounts off — no project configured",
);

async function readConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (url && anonKey) return checkConfig({ url, anonKey });

  try {
    const raw = await readFile(join(root, "..", "..", "supabase.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.url && parsed.anonKey) return checkConfig(parsed);
  } catch {
    /* absent is a valid state: the build simply has accounts off */
  }
  return null;
}

function checkConfig({ url, anonKey }) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) {
    throw new Error(`Supabase URL looks wrong: ${url}`);
  }
  // Supabase has two key formats and both have a publishable half and a secret
  // half. The secret half bypasses RLS completely and can read and write every
  // row in the database, so publishing one hands the whole thing away.
  //
  //   new     sb_publishable_...   safe    sb_secret_...        never
  //   legacy  role: "anon"         safe    role: "service_role" never
  //
  // Checked by prefix *and* by JWT payload, because a guard that only knew
  // about one format would wave the other one straight through.
  if (/^sb_secret_/.test(anonKey)) {
    throw new Error(
      "Refusing to build: that is a secret key. Use the publishable one (sb_publishable_…).",
    );
  }
  const payload = decodeJwtPayload(anonKey);
  if (payload?.role && payload.role !== "anon") {
    throw new Error(
      `Refusing to build: that key has role "${payload.role}". Only the anon / publishable key may be published.`,
    );
  }
  if (!/^sb_publishable_/.test(anonKey) && !payload) {
    throw new Error(
      "Refusing to build: that key is neither a JWT nor an sb_publishable_ key, so its privileges cannot be checked.",
    );
  }
  return { url, anonKey };
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null; // newer publishable keys are not JWTs; nothing to inspect
  }
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
