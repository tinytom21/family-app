/**
 * What a model provider looks like from the outside.
 *
 * Deliberately separate from `providers.ts`, which reaches for an SDK. This
 * file must never do that: the planner, the task capture and the hosted
 * browser build all depend on these types, and the browser build is only
 * allowed to contain code that no API key could hide in.
 *
 * That split is what lets one planner run two ways — against an SDK on a
 * laptop, and against a function on a server that holds the key — without the
 * planner knowing which.
 */

export type Json = Record<string, unknown>;

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
