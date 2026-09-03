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
    return {
      kind: "quota",
      // A rate limit does clear, but not on the timescale of a page waiting.
      retryable: true,
      advice:
        "You are over the rate limit for this key. The free tier is tight — wait a minute, or use a different model.",
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
  const attempts = options.attempts ?? 4;
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

      const exponential = Math.min(max, base * 2 ** (attempt - 1));
      const waitMs = Math.round(exponential * (0.5 + random() * 0.5));
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
