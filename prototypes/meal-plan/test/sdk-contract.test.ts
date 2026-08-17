import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClaudeProvider,
  GeminiProvider,
  addUsage,
  emptyUsage,
  selectProvider,
  type Usage,
} from "../src/ai/providers.ts";
import { generatePlan } from "../src/ai/planner.ts";
import { CONSTRAINTS } from "../src/demo-data.ts";

/**
 * Node strips TypeScript types rather than checking them, so a misspelled SDK
 * field sails through until the first billed call. These pin the surfaces we
 * build against without spending a request.
 */

test("both SDKs expose the surfaces the providers call", async () => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: "test-key-not-used" });
  assert.equal(typeof anthropic.beta.messages.stream, "function");

  const { GoogleGenAI } = await import("@google/genai");
  const google = new GoogleGenAI({ apiKey: "test-key-not-used" });
  assert.equal(typeof google.interactions.create, "function");
});

test("provider selection follows the env var, then the available key", () => {
  assert.equal(selectProvider({ MEAL_PLAN_PROVIDER: "claude" } as any).id, "claude");
  assert.equal(selectProvider({ MEAL_PLAN_PROVIDER: "gemini" } as any).id, "gemini");

  // No explicit choice: whichever key is present, Claude first.
  assert.equal(selectProvider({ ANTHROPIC_API_KEY: "x" } as any).id, "claude");
  assert.equal(selectProvider({ GEMINI_API_KEY: "x" } as any).id, "gemini");
  assert.equal(
    selectProvider({ ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" } as any).id,
    "claude",
  );
});

test("a missing or bogus provider fails with an instruction, not a stack trace", () => {
  assert.throws(() => selectProvider({} as any), /ANTHROPIC_API_KEY or GEMINI_API_KEY/);
  assert.throws(
    () => selectProvider({ MEAL_PLAN_PROVIDER: "llama" } as any),
    /Unknown MEAL_PLAN_PROVIDER/,
  );
});

test("usage accumulates across repair rounds", () => {
  const total = emptyUsage();
  const round: Usage = {
    inputTokens: 100,
    cachedReadTokens: 10,
    cacheWriteTokens: 5,
    outputTokens: 200,
    thoughtTokens: 50,
  };
  addUsage(total, round);
  addUsage(total, round);
  assert.equal(total.inputTokens, 200);
  assert.equal(total.outputTokens, 400);
  assert.equal(total.thoughtTokens, 100);
});

test("each provider prices its own tokens", () => {
  const usage: Usage = {
    inputTokens: 1_000_000,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
    thoughtTokens: 0,
  };
  const claude = new ClaudeProvider().costUsd(usage);
  const gemini = new GeminiProvider().costUsd(usage);

  assert.equal(claude, 30, "Opus 5 is $5 in + $25 out per million");
  assert.equal(gemini, 4.5, "3.7 Flash is $0.75 in + $3.75 out per million");
  assert.ok(gemini < claude);
});

test("cached reads are cheaper than fresh input for both providers", () => {
  for (const provider of [new ClaudeProvider(), new GeminiProvider()]) {
    const fresh = provider.costUsd({
      inputTokens: 100_000,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
    });
    const cached = provider.costUsd({
      inputTokens: 0,
      cachedReadTokens: 100_000,
      cacheWriteTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
    });
    assert.ok(cached < fresh, `${provider.id} should reward a cache hit`);
  }
});

test("the planner runs against a fake provider, model and network absent", async () => {
  // Proves the seam is real: the loop, the validator and the repair prompt
  // work with no SDK involved at all.
  const calls: { system: string; turnCount: number }[] = [];
  const fake = {
    id: "claude" as const,
    model: "fake-1",
    costUsd: () => 0,
    generate: async (req: any) => {
      calls.push({ system: req.system, turnCount: req.turns.length });
      return {
        text: JSON.stringify({
          reasoning: "a fake plan",
          recipes: [],
          meals: [],
        }),
        usage: emptyUsage(),
      };
    },
  };

  const run = await generatePlan(CONSTRAINTS, {
    provider: fake,
    slots: [{ date: "2026-08-17", slot: "dinner" }],
    maxRepairs: 1,
  });

  // An empty plan fails validation, so it should have tried the repair round.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].turnCount, 3, "repair resends the history");
  assert.ok(calls[0].system.includes("INGREDIENT CATALOGUE"));
  assert.equal(run.attempts, 2);
  assert.equal(run.model, "fake-1");
  assert.ok(!run.validation.ok);
  assert.ok(run.validation.violations.some((v) => v.code === "missing-slot"));
});
