/**
 * Trying again, when trying again is the right answer.
 *
 * Model providers fail in two quite different ways and the difference decides
 * what to do about it. "API key is invalid" will fail identically forever, and
 * retrying it wastes a minute before telling you the same thing. "This model is
 * currently experiencing high demand" is a queue, not a verdict — it clears on
 * its own, often within seconds, and it is by far the most common failure on a
 * free tier where capacity goes to paying traffic first.
 *
 * Treating those two the same is how an app either nags a user about their key
 * when the key is fine, or sits in a retry loop against a 401 that will never
 * change. So the classification comes first and the backoff second.
 */

export type FailureKind = "auth" | "capacity" | "quota" | "input" | "unknown";

export interface Classified {
  readonly kind: FailureKind;
  /** Whether trying the identical request again could plausibly work. */
  readonly retryable: boolean;
  /** What a person should do about it, if anything. */
  readonly advice: string;
  /** Seconds the provider itself asked us to wait, when it said. */
  readonly retryAfterSeconds?: number;
}

/**
 * How long the provider asked us to wait.
 *
 * Google states this in the error text — "Please retry in 42.792564234s" — and
 * it is far better information than any backoff we could invent, because it
 * distinguishes a queue that clears in seconds from a quota that resets
 * tomorrow. Ignoring it is how a client hammers a limit it has already hit.
 */
export function retryAfterSeconds(message: string): number | undefined {
  const patterns = [
    /retry in ([0-9.]+)s/i,
    /retryDelay"?:\s*"?([0-9.]+)s/i,
    /try again in ([0-9.]+) ?s/i,
  ];
  for (const pattern of patterns) {
    const hit = message.match(pattern);
    if (hit) return Number(hit[1]);
  }
  return undefined;
}

export function classifyFailure(error: unknown): Classified {
  const status = (error as { status?: number })?.status ?? 0;
  const message = (error instanceof Error ? error.message : String(error)) ?? "";
  const text = message.toLowerCase();

  if (status === 401 || status === 403 || /api key|authenticat|unauthor/.test(text)) {
    return {
      kind: "auth",
      retryable: false,
      advice: "The key was rejected. Check it, or run `npm run doctor`.",
    };
  }

  if (status === 429 || /quota|rate limit|resource_exhausted/.test(text)) {
    const after = retryAfterSeconds(message);
    // A per-day quota does not clear while anybody is waiting, and every retry
    // against it spends another request from a budget that is already empty.
    // The free tier allows twenty a day, so retrying is actively harmful.
    const daily = /per day|requests_per_day|free_tier/.test(text);
    return {
      kind: "quota",
      retryable: !daily && after !== undefined && after <= 30,
      ...(after !== undefined ? { retryAfterSeconds: after } : {}),
      advice: daily
        ? "That is the daily cap for this key, not a momentary spike — it resets tomorrow. " +
          "Add billing, or switch provider with MEAL_PLAN_PROVIDER=claude."
        : `Over the rate limit${after ? `; the provider asked for ${Math.ceil(after)}s` : ""}. ` +
          "The free tier is tight — wait, or use a different model.",
    };
  }

  if (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    /high demand|overload|unavailable|try again later|internal server/.test(text)
  ) {
    return {
      kind: "capacity",
      retryable: true,
      advice:
        "The model is busy, which is the provider's side and not your setup. " +
        "It usually clears in seconds; a different model via GEMINI_MODEL avoids the queue entirely.",
    };
  }

  if (status >= 400 && status < 500) {
    return {
      kind: "input",
      retryable: false,
      advice: "The provider rejected the request itself, so retrying will not help.",
    };
  }

  return { kind: "unknown", retryable: false, advice: "" };
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onRetry?: (info: { attempt: number; waitMs: number; because: string }) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/**
 * Exponential backoff with jitter, but only for failures worth repeating.
 *
 * The jitter matters more than it looks: without it every client that failed at
 * the same moment comes back at the same moment, which is how a busy service
 * stays busy.
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  // Two, not four. Every attempt spends a request, and a free tier can be as
  // small as twenty a day — a generous retry count turns one click of Replan
  // into most of a day's budget without producing anything.
  const attempts = options.attempts ?? 2;
  const base = options.baseDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 20_000;
  const sleep = options.sleep ?? wait;
  const random = options.random ?? Math.random;

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      last = error;
      const verdict = classifyFailure(error);
      if (!verdict.retryable || attempt === attempts) break;

      // The provider's own figure beats our guess when it gives one.
      const exponential = Math.min(max, base * 2 ** (attempt - 1));
      const jittered = Math.round(exponential * (0.5 + random() * 0.5));
      const waitMs = verdict.retryAfterSeconds
        ? Math.round(verdict.retryAfterSeconds * 1000)
        : jittered;
      options.onRetry?.({
        attempt,
        waitMs,
        because: error instanceof Error ? error.message : String(error),
      });
      await sleep(waitMs);
    }
  }
  throw last;
}
