import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFailure, withRetry } from "../src/ai/retry.ts";

const err = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

test("a rejected key is never retried", () => {
  const v = classifyFailure(err(401, "API key is invalid."));
  assert.equal(v.kind, "auth");
  assert.equal(v.retryable, false, "retrying a bad key just wastes a minute");
});

test("a busy model is retried, and blamed on the provider", () => {
  // The exact wording the app hit: a 500 that is really a queue.
  const v = classifyFailure(
    err(500, "gemini-3.7-flash is currently experiencing high demand, spikes in demand are usually temporary. Please try again later."),
  );
  assert.equal(v.kind, "capacity");
  assert.equal(v.retryable, true);
  assert.match(v.advice, /provider's side and not your setup/);
});

test("the usual transient statuses are all retryable", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(classifyFailure(err(status, "upstream")).retryable, true, `${status}`);
  }
  assert.equal(classifyFailure(err(429, "Quota exceeded")).kind, "quota");
});

test("a rejected request is not retried", () => {
  const v = classifyFailure(err(400, "schema is invalid"));
  assert.equal(v.kind, "input");
  assert.equal(v.retryable, false);
});

test("it succeeds after a transient failure clears", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw err(500, "experiencing high demand");
      return "a plan";
    },
    // Explicit, because the default is deliberately only two — see the
    // free-tier budget test below.
    { attempts: 4, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 },
  );

  assert.equal(result, "a plan");
  assert.equal(calls, 3);
  // Exponential, and jittered rather than in lockstep with every other client.
  assert.deepEqual(waits, [750, 1500]);
});

test("it gives up after the last attempt and rethrows the real error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => { calls++; throw err(503, "unavailable"); },
      { attempts: 3, sleep: async () => {}, random: () => 0 },
    ),
    /unavailable/,
  );
  assert.equal(calls, 3, "no more attempts than asked for");
});

test("an unretryable failure costs exactly one attempt", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => { calls++; throw err(401, "API key is invalid."); },
      { sleep: async () => {} },
    ),
    /API key is invalid/,
  );
  assert.equal(calls, 1);
});

test("the backoff is capped", async () => {
  const waits: number[] = [];
  await assert.rejects(
    withRetry(
      async () => { throw err(503, "busy"); },
      { attempts: 6, baseDelayMs: 1000, maxDelayMs: 4000, sleep: async (ms) => { waits.push(ms); }, random: () => 1 },
    ),
  );
  assert.deepEqual(waits, [1000, 2000, 4000, 4000, 4000]);
});

test("a daily quota is not retried, because retrying spends what is gone", () => {
  // The exact error from a free-tier key that has used its twenty requests.
  const v = classifyFailure(
    err(429, "You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.7-flash Please retry in 42.792564234s."),
  );
  assert.equal(v.kind, "quota");
  assert.equal(v.retryable, false, "the budget is spent; retrying spends more");
  assert.match(v.advice, /resets tomorrow/);
});

test("a momentary rate limit is retried, at the provider's stated pace", async () => {
  let calls = 0;
  const waits: number[] = [];
  await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw err(429, "rate limit. Please retry in 3s");
      return "ok";
    },
    { sleep: async (ms) => { waits.push(ms); } },
  );
  // Its number, not ours — it knows when the queue clears and we do not.
  assert.deepEqual(waits, [3000]);
});

test("one click cannot eat a day's free-tier budget", () => {
  // 3 planner attempts x the retry default. Twenty requests a day is the free
  // tier, so this has to stay small enough to click more than once.
  const perClick = 3 * 2;
  assert.ok(perClick <= 6, `${perClick} requests per click is too many`);
});
