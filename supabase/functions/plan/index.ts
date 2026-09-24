/**
 * The model, for people who are not sitting at the laptop.
 *
 * GitHub Pages runs nothing, so the published app has no way to call Claude:
 * a key shipped to a web page is a key given away. This function is the
 * smallest thing that fixes that. It holds the key, satisfies itself that the
 * caller is a signed-in member of the household they claim, counts what they
 * spend, and forwards the request Claude would have received anyway.
 *
 * What it deliberately is not is a model API of its own. The prompt, the
 * schema, the repair loop and the validation all stay in the app where they
 * are tested; this only carries the request across the gap. That is why the
 * body arrives already built — one implementation of "what we ask Claude for",
 * used by the laptop and the phone alike.
 *
 * Three protections, in order of how much they matter:
 *
 *   1. **Someone else's household cannot spend your money.** Membership is
 *      checked in the database, under the caller's own token, by the same Row
 *      Level Security that protects everything else.
 *   2. **Nothing can run up a bill.** Every call is counted against a daily
 *      cap per household, claimed *before* the request goes out, and the
 *      database clamps the cap even if this function asks for more.
 *   3. **The client cannot choose an expensive model or an enormous answer.**
 *      Both are allow-listed here rather than trusted from the browser.
 *
 * Deploy:  supabase functions deploy plan
 * Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETAS = "server-side-fallback-2026-07-01";

/** Cheap enough to be wrong about. Anything dearer is a deliberate change here. */
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
const DEFAULT_MODEL = "claude-opus-5";

/** A week's plan is long; a request that wants far more is not a week's plan. */
const MAX_TOKENS_CEILING = 32000;
/** The whole prompt, including the catalogue and the week. Generous, and finite. */
const MAX_BODY_BYTES = 400_000;

const DAILY_CALLS = Number(Deno.env.get("PLAN_DAILY_CALLS") ?? 20);
const FORCED_MODEL = Deno.env.get("PLAN_MODEL")?.trim();

/* The published site and a laptop are different origins, so this is a
   cross-origin call and the browser will ask first. Anything not on the list
   gets no CORS headers and therefore gets nowhere. */
const ORIGINS = (
  Deno.env.get("PLAN_ALLOWED_ORIGINS") ??
  "https://tinytom21.github.io,http://localhost:4321,http://localhost:4322,http://localhost:4323"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ORIGINS.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-expose-headers": "x-plan-calls-today, x-plan-daily-cap, x-plan-model",
    "vary": "origin",
  };
}

function reply(
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

/**
 * Only the fields the app actually sends, and only within limits set here.
 *
 * Built rather than filtered: an allow-list cannot be defeated by a field
 * nobody thought of, which is the whole reason this function exists.
 */
function safeRequest(body: any): { ok: true; request: Record<string, unknown>; model: string } | { ok: false; why: string } {
  if (!body || typeof body !== "object") return { ok: false, why: "no request" };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, why: "a request needs messages" };
  }

  const asked = typeof body.model === "string" ? body.model : DEFAULT_MODEL;
  const model = FORCED_MODEL || (MODELS.includes(asked) ? asked : DEFAULT_MODEL);

  const maxTokens = Number(body.max_tokens);
  const request: Record<string, unknown> = {
    model,
    max_tokens: Math.min(
      Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : MAX_TOKENS_CEILING,
      MAX_TOKENS_CEILING,
    ),
    messages: body.messages,
  };
  if (body.system) request.system = body.system;
  if (body.thinking) request.thinking = body.thinking;
  if (body.output_config) request.output_config = body.output_config;
  if (body.fallbacks) request.fallbacks = body.fallbacks;

  return { ok: true, request, model };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return reply({ error: "POST a request to plan with." }, 405, origin);
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) {
    return reply(
      { error: "This project has no model key set. Run: supabase secrets set ANTHROPIC_API_KEY=..." },
      501,
      origin,
    );
  }

  // Present because the function verifies the JWT before running, but the app
  // needs the token itself: membership is checked as the caller, not as this
  // function, so the database's own rules decide.
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return reply({ error: "Sign in first." }, 401, origin);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return reply({ error: "That request is far larger than a week's plan." }, 413, origin);
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply({ error: "That was not JSON." }, 400, origin);
  }

  const householdId = payload?.householdId;
  if (typeof householdId !== "string" || !householdId) {
    return reply({ error: "Which household is this for?" }, 400, origin);
  }

  const checked = safeRequest(payload?.request);
  if (!checked.ok) return reply({ error: checked.why }, 400, origin);

  /* ---- claim the call before spending anything ---- */

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const rpc = (name: string, args: unknown) =>
    fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: anonKey,
        authorization,
      },
      body: JSON.stringify(args),
    });

  let claim: any;
  try {
    const claimed = await rpc("claim_model_call", {
      target: householdId,
      daily_cap: DAILY_CALLS,
    });
    claim = await claimed.json();
    if (!claimed.ok) {
      return reply(
        { error: claim?.message ?? "Could not check your household." },
        claimed.status,
        origin,
      );
    }
  } catch (error) {
    return reply({ error: `Could not reach the database: ${error}` }, 502, origin);
  }

  if (!claim?.ok) {
    if (claim?.problem === "daily-cap") {
      return reply(
        {
          error:
            `That is ${claim.calls_today} plans today, which is this household's daily limit. ` +
            `It resets at midnight UTC — or raise PLAN_DAILY_CALLS if the limit is wrong.`,
        },
        429,
        origin,
      );
    }
    return reply({ error: "That is not your household." }, 403, origin);
  }

  const counters = {
    "x-plan-calls-today": String(claim.calls_today ?? 0),
    "x-plan-daily-cap": String(claim.cap ?? DAILY_CALLS),
    "x-plan-model": checked.model,
  };

  /* ---- and only now, the model ---- */

  let answer: Response;
  try {
    answer = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETAS,
      },
      body: JSON.stringify(checked.request),
    });
  } catch (error) {
    return reply({ error: `Could not reach the model: ${error}` }, 502, origin, counters);
  }

  const text = await answer.text();
  if (!answer.ok) {
    // Passed through with its own status, because the app already knows how to
    // read "busy", "out of credit" and "rejected key" differently.
    return new Response(text, {
      status: answer.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...corsHeaders(origin),
        ...counters,
      },
    });
  }

  // Best effort, and deliberately after the answer is safely in hand: a failure
  // to write the token count must not lose somebody the plan they just paid for.
  try {
    const message = JSON.parse(text);
    await rpc("record_model_usage", {
      target: householdId,
      in_tokens: message?.usage?.input_tokens ?? 0,
      out_tokens: message?.usage?.output_tokens ?? 0,
    });
  } catch {
    /* counted as a call either way, which is what the cap is made of */
  }

  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...counters,
    },
  });
});
