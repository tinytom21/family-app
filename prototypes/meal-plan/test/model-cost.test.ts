import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MODEL, claudeCostUsd } from "../src/ai/anthropic-wire.ts";
import { emptyUsage } from "../src/ai/provider.ts";

/** Roughly one week's plan, as measured: 2,300 tokens in, 7,000 out. */
const week = () => ({ ...emptyUsage(), inputTokens: 2300, outputTokens: 7000 });
const pence = (usd: number) => Math.round(usd * 1000) / 1000;

test("the default is Sonnet 5.5, under its real name", () => {
  // Hyphens, not dots: "claude-sonnet-5.5" is a model that does not exist.
  assert.equal(DEFAULT_MODEL, "claude-sonnet-5-5");
});

test("each model is priced as itself", () => {
  // One price for every model showed a Sonnet plan at 2.5 times its cost.
  assert.equal(pence(claudeCostUsd(week(), "claude-sonnet-5-5")), 0.075);
  assert.equal(pence(claudeCostUsd(week(), "claude-opus-5-5")), 0.149);
  assert.equal(pence(claudeCostUsd(week(), "claude-haiku-4-5")), 0.037);
});

test("a dated snapshot is priced as its family", () => {
  assert.equal(
    claudeCostUsd(week(), "claude-haiku-4-5-20251001"),
    claudeCostUsd(week(), "claude-haiku-4-5"),
  );
});

test("an unknown model is never shown as cheaper than it might be", () => {
  const unknown = claudeCostUsd(week(), "claude-something-new");
  for (const known of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"]) {
    assert.ok(unknown >= claudeCostUsd(week(), known), `cheaper than ${known}`);
  }
});
