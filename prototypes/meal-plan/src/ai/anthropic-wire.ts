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
export const DEFAULT_MODEL = "claude-opus-5";

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

export const CLAUDE_USD_PER_MTOK = {
  input: 5.0,
  output: 25.0,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

export function claudeCostUsd(u: Usage): number {
  const m = 1_000_000;
  return (
    (u.inputTokens / m) * CLAUDE_USD_PER_MTOK.input +
    (u.outputTokens / m) * CLAUDE_USD_PER_MTOK.output +
    (u.cachedReadTokens / m) *
      CLAUDE_USD_PER_MTOK.input *
      CLAUDE_USD_PER_MTOK.cacheReadMultiplier +
    (u.cacheWriteTokens / m) *
      CLAUDE_USD_PER_MTOK.input *
      CLAUDE_USD_PER_MTOK.cacheWriteMultiplier
  );
}
