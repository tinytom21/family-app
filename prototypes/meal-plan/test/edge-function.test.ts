/**
 * The `plan` function is deployed to Supabase, not bundled here, so nothing
 * else in this repo would ever notice if it stopped parsing — or if the order
 * of the two things that matter got swapped.
 *
 * It runs on Deno, so these are not type checks. They are the checks that a
 * deploy is worth making at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const FUNCTION = join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "supabase/functions/plan/index.ts",
);

const source = await readFile(FUNCTION, "utf8");

test("the function parses", async () => {
  // Deployed by hand, to somewhere with no build step in front of it: a stray
  // character here is only ever found by the family it stops.
  await transform(source, { loader: "ts" });
});

test("nothing is spent before the call is claimed", async () => {
  // The allowance is the whole cost control. Claiming after the request would
  // mean a failing loop could spend all day and count none of it.
  const claim = source.indexOf("claim_model_call");
  const spend = source.indexOf("ANTHROPIC_URL,");
  assert.ok(claim > 0, "the function no longer claims a call");
  assert.ok(spend > 0, "the function no longer calls the model");
  assert.ok(claim < spend, "the model is called before the call is claimed");
});

test("the browser cannot choose the model or the answer length", async () => {
  // Both arrive from a page anybody can edit, so both are decided here.
  assert.match(source, /const MODELS = \[/);
  assert.match(source, /Math\.min\(/);
  assert.match(source, /MAX_TOKENS_CEILING/);
});

test("the browser is allowed to send what the page sends", async () => {
  // A header the page sends but the function does not list is refused by the
  // browser before the request goes anywhere, and reported only as "Failed to
  // fetch". That is exactly how the first real call died.
  const allowed = source.match(/"access-control-allow-headers":\s*"([^"]+)"/)?.[1] ?? "";
  const page = await readFile(
    join(fileURLToPath(new URL("..", import.meta.url)), "web/public/app/model.js"),
    "utf8",
  );
  const block = page.match(/headers:\s*\{([^}]*)\}/)?.[1] ?? "";
  const sent = [...block.matchAll(/^\s*"?([a-z-]+)"?\s*:/gim)].map((m) => m[1].toLowerCase());
  assert.ok(sent.length > 0, "could not find the headers model.js sends");
  for (const header of sent) {
    assert.ok(
      allowed.split(",").map((h) => h.trim()).includes(header),
      `model.js sends "${header}", which the function does not allow`,
    );
  }
});

test("a slow plan ends in a sentence, not a silent cut-off", async () => {
  // Supabase kills a free-tier function at 150s with no CORS headers, which a
  // browser reports as "Failed to fetch". The function must give up first.
  assert.match(source, /AbortController/);
  const deadline = Number(source.match(/PLAN_DEADLINE_MS"\) \?\? ([\d_]+)/)?.[1].replace(/_/g, ""));
  assert.ok(deadline > 0 && deadline < 150_000, `deadline is ${deadline}ms`);
});

test("the key never leaves the function", async () => {
  const key = /ANTHROPIC_API_KEY/g;
  const uses = source.match(key) ?? [];
  // Once to read it, once to send it as a header, and once in the message
  // telling somebody to set it. Anything else deserves a second look.
  assert.ok(uses.length <= 3, `ANTHROPIC_API_KEY appears ${uses.length} times`);
  assert.doesNotMatch(source, /console\.(log|error|warn)\([^)]*key/i);
});
