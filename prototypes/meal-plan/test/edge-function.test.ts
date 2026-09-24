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

test("the key never leaves the function", async () => {
  const key = /ANTHROPIC_API_KEY/g;
  const uses = source.match(key) ?? [];
  // Once to read it, once to send it as a header, and once in the message
  // telling somebody to set it. Anything else deserves a second look.
  assert.ok(uses.length <= 3, `ANTHROPIC_API_KEY appears ${uses.length} times`);
  assert.doesNotMatch(source, /console\.(log|error|warn)\([^)]*key/i);
});
