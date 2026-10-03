/**
 * What we ask Claude for, and how to read the answer — with no SDK in sight.
 *
 * Two things call Claude. The local server does it through the official SDK,
 * with a key in its environment. The hosted build cannot: a key shipped to a
 * web page is a key given away, so it goes through a function on Supabase that
 * holds the key and checks the caller is in the household.
 *
 * Both build the request here and read the reply here. A second copy of "what
 * we ask Claude for" is a second thing to keep in step, and the first time the
 * two drifted you would get a noticeably better plan on one machine than the
 * other, for no visible reason, and no obvious place to look.
 */

import { toAnthropicDialect } from "./dialect.ts";
import type { GenerateRequest, GenerateResult, Json } from "./provider.ts";
import type { Usage } from "./provider.ts";

/** If the first model is busy, Anthropic picks another rather than failing. */
export const ANTHROPIC_BETAS = ["server-side-fallback-2026-07-01"];
/**
 * Sonnet 5.5: fast enough to finish a week inside the hosted function's time
 * limit, and well under half the price of Opus for a task that is mostly
 * following rules carefully. Override with CLAUDE_MODEL locally, PLAN_MODEL on
 * the hosted function.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/* The endpoint and API version are deliberately absent. This module is bundled
   into a public web page, which never calls Anthropic directly — it asks the
   `plan` function, which has its own copy of both. A published page carrying
   the address of an API it cannot call only invites the question of what else
   it is carrying. */
/** A week of meals is a long answer. This is the ceiling, not the expectation. */
export const MAX_TOKENS = 32000;

export function anthropicBody(request: GenerateRequest, model: string): Json {
  return {
    model,
    max_tokens: MAX_TOKENS,
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: toAnthropicDialect(request.schema),
      },
    },
    // Claude has no server-side conversation state, so repair turns resend the
    // history. The cached system prefix is what keeps that affordable.
    system: [
      {
        type: "text",
        text: request.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: request.turns.map((t) => ({ role: t.role, content: t.text })),
  };
}

export function readAnthropicMessage(message: any): GenerateResult {
  if (message.stop_reason === "refusal") {
    throw new Error(
      `Claude declined the request (${message.stop_details?.category ?? "unknown"}).`,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      "Hit max_tokens before the plan was complete — raise max_tokens or plan fewer days.",
    );
  }

  const block = message.content?.find((b: any) => b.type === "text");
  if (!block) throw new Error("No text block in the Claude response.");

  return {
    text: block.text,
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      cachedReadTokens: message.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      thoughtTokens: 0,
    },
  };
}

interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheReadMultiplier: number;
  readonly cacheWriteMultiplier: number;
}

/**
 * US dollars per million tokens, from Anthropic's models page (October 2026).
 *
 * Per model, because one price for every model is how a plan from Sonnet came
 * to be shown at two and a half times what it actually cost. A model missing
 * from here is priced as the dearest one listed, so an unknown model can only
 * ever be shown as costing too much, never too little.
 */
export const CLAUDE_USD_PER_MTOK: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-sonnet-5": { input: 3, output: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-opus-5": { input: 5, output: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
};

const DEAREST = Object.values(CLAUDE_USD_PER_MTOK).reduce((a, b) => (b.output > a.output ? b : a));

/** Dated snapshot IDs ("claude-haiku-4-5-20251001") price as their family. */
function priceFor(model: string): Price {
  const known = Object.keys(CLAUDE_USD_PER_MTOK)
    .filter((id) => model === id || model.startsWith(`${id}-2`))
    .sort((a, b) => b.length - a.length)[0];
  return known ? CLAUDE_USD_PER_MTOK[known] : DEAREST;
}

export function claudeCostUsd(u: Usage, model: string = DEFAULT_MODEL): number {
  const p = priceFor(model);
  const m = 1_000_000;
  return (
    (u.inputTokens / m) * p.input +
    (u.outputTokens / m) * p.output +
    (u.cachedReadTokens / m) * p.input * p.cacheReadMultiplier +
    (u.cacheWriteTokens / m) * p.input * p.cacheWriteMultiplier
  );
}
