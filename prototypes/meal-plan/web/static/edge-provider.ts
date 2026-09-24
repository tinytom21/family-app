/**
 * The same planner, asking the same model, without a key in sight.
 *
 * `ClaudeProvider` talks to the Anthropic SDK with a key from the environment,
 * which is right on a laptop and impossible on a static web page. This one
 * implements the identical interface and sends the identical request — built
 * by the same module, `anthropic-wire.ts` — to the `plan` function on
 * Supabase, which holds the key and checks who is asking.
 *
 * So the hosted app runs the real planner: the real prompt, the real schema,
 * the real repair loop, the real validation. The only thing that differs
 * between the two is which side of the gap the key is on.
 */

import {
  DEFAULT_MODEL,
  anthropicBody,
  claudeCostUsd,
  readAnthropicMessage,
} from "../../src/ai/anthropic-wire.ts";
import type {
  GenerateRequest,
  GenerateResult,
  PlanProvider,
  Usage,
} from "../../src/ai/provider.ts";
import { withRetry } from "../../src/ai/retry.ts";

declare global {
  interface Window {
    __familyModel?: {
      ready(): boolean;
      call(request: unknown): Promise<{
        message: unknown;
        model?: string | null;
        callsToday?: number | null;
        cap?: number | null;
      }>;
      lastCall(): { callsToday: number | null; cap: number | null } | null;
    };
  }
}

export class EdgeProvider implements PlanProvider {
  readonly id = "claude" as const;
  /** What the function actually used, which it may decide for itself. */
  model = DEFAULT_MODEL;

  costUsd(usage: Usage): number {
    return claudeCostUsd(usage);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = window.__familyModel;
    if (!model) throw new Error("The model is not switched on in this page.");

    const body = anthropicBody(request, this.model);
    // The same retry policy as the laptop: a busy model is worth waiting for,
    // a rejected key or a spent allowance is not.
    const answer = await withRetry(() => model.call(body), {});
    if (answer.model) this.model = answer.model;
    return readAnthropicMessage(answer.message);
  }
}
