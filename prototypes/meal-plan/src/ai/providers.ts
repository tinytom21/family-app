/**
 * One interface, two model providers.
 *
 * The prototype runs on Claude; the production plan leans Gemini because the
 * Calendar work already puts the project in Google Cloud. Rather than rewriting
 * the planner each time that argument is revisited, both live behind this
 * interface and the choice is an environment variable.
 *
 * Everything provider-specific is confined to this file and `dialect.ts`:
 * message history vs. server-side conversation ids, cache accounting, schema
 * subset, pricing. The planner, the validator and the shopping-list engine
 * never learn which model answered.
 */

import { toGeminiDialect } from "./dialect.ts";
import { withRetry } from "./retry.ts";

/* The interface and its types live in `provider.ts`, which imports nothing at
   all. This file is where the SDKs are, and everything that imports it gets
   them — which is precisely what the hosted build must not do. They are
   re-exported here so that every existing caller carries on unchanged. */
import type {
  GenerateRequest,
  GenerateResult,
  Json,
  PlanProvider,
  Turn,
  Usage,
} from "./provider.ts";
import { addUsage, emptyUsage } from "./provider.ts";
import {
  ANTHROPIC_BETAS,
  DEFAULT_MODEL,
  anthropicBody,
  claudeCostUsd,
  readAnthropicMessage,
} from "./anthropic-wire.ts";

export { addUsage, emptyUsage };
export type { GenerateRequest, GenerateResult, PlanProvider, Turn, Usage };

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

export class ClaudeProvider implements PlanProvider {
  readonly id = "claude" as const;
  readonly model: string;
  #client: any;

  constructor(
    model = process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    client?: unknown,
  ) {
    this.model = model;
    this.#client = client;
  }

  async #ensureClient(): Promise<any> {
    if (!this.#client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.#client = new Anthropic();
    }
    return this.#client;
  }

  costUsd(u: Usage): number {
    return claudeCostUsd(u);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const client = await this.#ensureClient();

    const message = await withRetry(() => this.#once(client, request), {
      onRetry: ({ attempt, waitMs }) =>
        console.log(
          `  ${this.model} is busy; retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1})`,
        ),
    });
    return readAnthropicMessage(message);
  }

  /* The request itself is built in `anthropic-wire.ts`, because the hosted
     build sends the identical thing over plain HTTP to a function that holds
     the key. Two copies of it would drift, and the symptom would be a better
     plan on one machine than the other with nowhere obvious to look. */
  async #once(client: any, request: GenerateRequest): Promise<any> {
    const stream = client.beta.messages.stream({
      ...anthropicBody(request, this.model),
      betas: ANTHROPIC_BETAS,
    });
    return await stream.finalMessage();
  }
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

/** Promotional rate through 2026-12-31; it doubles on 2027-01-01. */
const GEMINI_USD_PER_MTOK = {
  input: 0.75,
  output: 3.75,
  cachedInput: 0.075,
};

export class GeminiProvider implements PlanProvider {
  readonly id = "gemini" as const;
  readonly model: string;
  #client: any;
  /** Server-side conversation, so repair turns need not resend the plan. */
  #previousInteractionId: string | undefined;

  constructor(
    model = process.env.GEMINI_MODEL ?? "gemini-3.7-flash",
    client?: unknown,
  ) {
    this.model = model;
    this.#client = client;
  }

  async #ensureClient(): Promise<any> {
    if (!this.#client) {
      const { GoogleGenAI } = await import("@google/genai");
      this.#client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    return this.#client;
  }

  costUsd(u: Usage): number {
    const m = 1_000_000;
    return (
      (u.inputTokens / m) * GEMINI_USD_PER_MTOK.input +
      (u.cachedReadTokens / m) * GEMINI_USD_PER_MTOK.cachedInput +
      (u.outputTokens / m) * GEMINI_USD_PER_MTOK.output
    );
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const client = await this.#ensureClient();
    const latest = request.turns[request.turns.length - 1];

    // A busy model is a queue, not a verdict — see retry.ts. Free-tier traffic
    // is exactly where this shows up, so giving up on the first 500 would make
    // the app look broken when it is only waiting its turn.
    const interaction = await withRetry(
      () => this.#once(client, request, latest),
      {
        onRetry: ({ attempt, waitMs }) =>
          console.log(
            `  ${this.model} is busy; retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1})`,
          ),
      },
    );

    this.#previousInteractionId = interaction.id;

    const text = interaction.output_text;
    if (!text) {
      throw new Error(
        `No text output (interaction ${interaction.id}, status ${interaction.status ?? "unknown"}).`,
      );
    }

    const u = interaction.usage ?? {};
    const cached = u.total_cached_tokens ?? 0;
    return {
      text,
      usage: {
        // Gemini's input total includes cached tokens; Claude's does not.
        inputTokens: Math.max(0, (u.total_input_tokens ?? 0) - cached),
        cachedReadTokens: cached,
        cacheWriteTokens: 0,
        outputTokens: u.total_output_tokens ?? 0,
        thoughtTokens: u.total_thought_tokens ?? 0,
      },
    };
  }

  async #once(client: any, request: GenerateRequest, latest: Turn): Promise<any> {
    return await client.interactions.create({
      model: this.model,
      input: latest.text,
      system_instruction: request.system,
      store: true,
      ...(this.#previousInteractionId
        ? { previous_interaction_id: this.#previousInteractionId }
        : {}),
      generation_config: {
        thinking_level: "high",
        max_output_tokens: 32000,
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: toGeminiDialect(request.schema),
      },
    });
  }
}

/* ------------------------------------------------------------------ */

/**
 * A key that is obviously not a key.
 *
 * Copying `$env:ANTHROPIC_API_KEY = "sk-ant-..."` straight out of a README sets
 * the variable to the literal placeholder, and the assignment succeeds even if
 * the command after it does not. The result is a provider that looks configured,
 * fails with a bare 401 from someone else's server, and gives no hint that it
 * picked the provider you were not trying to use.
 */
function looksLikePlaceholder(key: string): boolean {
  const value = key.trim();
  return (
    value.length < 20 ||
    value.includes("...") ||
    value.includes("…") ||
    /^(your|my|paste|insert|todo|xxx)/i.test(value)
  );
}

function usable(key: string | undefined): boolean {
  return Boolean(key?.trim()) && !looksLikePlaceholder(key!);
}

/**
 * Pick a provider. `MEAL_PLAN_PROVIDER` wins if set; otherwise whichever key is
 * present, preferring Claude because that is what the prototype runs on.
 */
export function selectProvider(env = process.env): PlanProvider {
  const requested = env.MEAL_PLAN_PROVIDER?.toLowerCase();
  const named: Record<string, () => PlanProvider> = {
    claude: () => new ClaudeProvider(),
    gemini: () => new GeminiProvider(),
  };

  if (requested) {
    const make = named[requested];
    if (!make) {
      throw new Error(
        `Unknown MEAL_PLAN_PROVIDER "${requested}". Use "claude" or "gemini".`,
      );
    }
    const variable = requested === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
    if (!usable(env[variable])) {
      throw new Error(
        `MEAL_PLAN_PROVIDER is "${requested}" but ${variable} ${describe(env[variable])}.`,
      );
    }
    return make();
  }

  // A placeholder must not shadow a real key. Anthropic is preferred, but only
  // when its key is actually a key — otherwise Gemini gets its turn instead of
  // the request failing against a provider you were not trying to use.
  if (usable(env.ANTHROPIC_API_KEY)) return new ClaudeProvider();
  if (usable(env.GEMINI_API_KEY)) return new GeminiProvider();

  const placeholders = (["ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const).filter(
    (name) => env[name]?.trim() && looksLikePlaceholder(env[name]!),
  );
  if (placeholders.length) {
    throw new Error(
      `${placeholders.join(" and ")} ${placeholders.length > 1 ? "are" : "is"} set to a placeholder, not a real key. ` +
        "Set the real value, or clear it with $env:NAME = $null and use the other provider.",
    );
  }
  throw new Error(
    "No model provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY " +
      "(or MEAL_PLAN_PROVIDER to force one).",
  );
}

const describe = (value: string | undefined): string =>
  !value?.trim() ? "is not set" : "is set to a placeholder, not a real key";
