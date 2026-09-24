/**
 * Reaching the model from a page that has no key.
 *
 * The published app is static files. It cannot hold an API key — anyone could
 * read it out of the page and spend it — so the key lives in the `plan`
 * function on Supabase, and this is the short walk to it: your session token,
 * which household you are planning for, and the request the app already built.
 *
 * Sits in the page rather than in the bundle because this is where the one
 * Supabase client lives. Two clients would mean two ideas about whether you
 * are signed in, and the wrong one would always be the one asked.
 */

import { getClient, supabaseConfig } from "./account.js";
import { linkedHousehold } from "./sync.js";

let signedIn = false;
let watching = false;
let lastCounters = null;

/**
 * Whether the buttons should be live.
 *
 * Synchronous on purpose: it is read every time the screen is drawn, so it
 * answers from a flag kept up to date by the auth listener rather than making
 * the whole render wait on a promise.
 */
export function ready() {
  watch();
  return signedIn && Boolean(linkedHousehold());
}

function watch() {
  if (watching) return;
  const client = getClient();
  if (!client) return;
  watching = true;
  client.auth.getSession().then(({ data }) => {
    signedIn = Boolean(data.session);
  });
  client.auth.onAuthStateChange((_event, session) => {
    signedIn = Boolean(session);
  });
}

/** What the last call cost, as the function counted it: { callsToday, cap }. */
export function lastCall() {
  return lastCounters;
}

/**
 * One request to Claude, through the function.
 *
 * Errors keep the HTTP status at the front of the message, because the app
 * already knows how to tell a busy model from a rejected key from a spent
 * allowance, and it does that by reading the status.
 */
export async function call(request) {
  const config = supabaseConfig();
  const client = getClient();
  if (!config || !client) {
    throw new Error("This build has no Supabase project, so there is no model to ask.");
  }

  const householdId = linkedHousehold();
  if (!householdId) {
    throw new Error(
      "Save this household to your account first — the model plans for a household, not a browser.",
    );
  }

  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in to plan from here.");

  const response = await fetch(`${config.url}/functions/v1/plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      apikey: config.key,
    },
    body: JSON.stringify({ householdId, request }),
  });

  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* an error page rather than JSON; the text below is what there is */
  }

  lastCounters = {
    callsToday: Number(response.headers.get("x-plan-calls-today")) || null,
    cap: Number(response.headers.get("x-plan-daily-cap")) || null,
  };

  if (!response.ok) {
    const said =
      typeof body?.error === "string"
        ? body.error
        : (body?.error?.message ?? text.slice(0, 300));
    throw new Error(`${response.status} ${said}`);
  }

  return {
    message: body,
    model: response.headers.get("x-plan-model"),
    ...lastCounters,
  };
}

window.__familyModel = { ready, call, lastCall };
