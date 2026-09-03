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

import { toAnthropicDialect, toGeminiDialect } from "./dialect.ts";

type Json = Record<string, unknown>;

export interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface GenerateRequest {
  readonly system: string;
  /** Full history, oldest first. Always ends with a user turn. */
  readonly turns: readonly Turn[];
  readonly schema: Json;
}

/**
 * Token counts normalised across providers. `inputTokens` always means
 * full-price uncached input — the two SDKs disagree about whether cached
 * tokens are included in their input total, so that is reconciled here rather
 * than left for the cost function to guess at.
 */
export interface Usage {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

export interface GenerateResult {
  readonly text: string;
  readonly usage: Usage;
}

export interface PlanProvider {
  readonly id: "claude" | "gemini";
  readonly model: string;
  /** Cost in US dollars for the given usage. */
  costUsd(usage: Usage): number;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
  };
}

export function addUsage(total: Usage, delta: Usage): void {
  total.inputTokens += delta.inputTokens;
  total.cachedReadTokens += delta.cachedReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
  total.outputTokens += delta.outputTokens;
  total.thoughtTokens += delta.thoughtTokens;
}

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

const CLAUDE_USD_PER_MTOK = {
  input: 5.0,
  output: 25.0,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

export class ClaudeProvider implements PlanProvider {
  readonly id = "claude" as const;
  readonly model: string;
  #client: any;

  constructor(
    model = process.env.CLAUDE_MODEL ?? "claude-opus-5",
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

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const client = await this.#ensureClient();

    // Claude has no server-side conversation state, so repair turns resend the
    // history. The cached system prefix is what keeps that affordable.
    const stream = client.beta.messages.stream({
      model: this.model,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: toAnthropicDialect(request.schema),
        },
      },
      system: [
        {
          type: "text",
          text: request.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: request.turns.map((t) => ({ role: t.role, content: t.text })),
    });

    const message = await stream.finalMessage();

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

    const block = message.content.find((b: any) => b.type === "text");
    if (!block) throw new Error("No text block in the Claude response.");

    return {
      text: block.text,
      usage: {
        inputTokens: message.usage.input_tokens ?? 0,
        cachedReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        thoughtTokens: 0,
      },
    };
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

    const interaction = await client.interactions.create({
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
