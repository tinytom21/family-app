/**
 * Verifies the Google Cloud runbook end to end, from a browser, before any of
 * the real app exists.
 *
 * It does exactly what step 7 of the runbook describes — signInWithOAuth with
 * the calendar scope, access_type=offline and prompt=consent — and then reports
 * on the three things that actually matter: did we get signed in, did Google
 * hand back a refresh token, and can that token really read a calendar.
 *
 * The refresh token is the one to watch. Everything else can look fine while
 * it is quietly missing, and the failure only surfaces an hour later when the
 * access token expires and there is nothing to renew it with.
 */

import {
  calendarCheck,
  fail,
  sessionChecks,
  verdict,
} from "/check-logic.js";

const $ = (id) => document.getElementById(id);
const STORE = "family-app.supabase";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const redirectUrl = `${location.origin}${location.pathname}`;
$("redirect-url").textContent = redirectUrl;

$("copy-redirect").addEventListener("click", async () => {
  await navigator.clipboard.writeText(redirectUrl);
  $("copy-redirect").textContent = "Copied";
  setTimeout(() => ($("copy-redirect").textContent = "Copy"), 1500);
});

/* ---------- remember the project between reloads ---------- */

const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}");
$("supabase-url").value = saved.url ?? "";
$("supabase-key").value = saved.key ?? "";

const persist = () => {
  localStorage.setItem(
    STORE,
    JSON.stringify({
      url: $("supabase-url").value.trim().replace(/\/$/, ""),
      key: $("supabase-key").value.trim(),
    }),
  );
  syncButton();
};
$("supabase-url").addEventListener("input", persist);
$("supabase-key").addEventListener("input", persist);

function creds() {
  return {
    url: $("supabase-url").value.trim().replace(/\/$/, ""),
    key: $("supabase-key").value.trim(),
  };
}

function syncButton() {
  const { url, key } = creds();
  const ready = /^https:\/\/.+\.supabase\.co$/.test(url) && key.length > 20;
  $("signin").disabled = !ready;
  $("signin-hint").textContent = ready
    ? "Make sure the redirect URL above is on the allow list first."
    : "Fill in both fields to enable this.";
}
syncButton();

/* ---------- client ---------- */

let client = null;
function getClient() {
  const { url, key } = creds();
  if (!url || !key) return null;
  client ??= window.supabase.createClient(url, key, {
    auth: { detectSessionInUrl: true, persistSession: true },
  });
  return client;
}

/**
 * Ask Supabase what it thinks is configured before handing the browser over.
 *
 * Without this, a half-configured provider sends you to a bare JSON error page
 * on Supabase's domain — no styling, no explanation, and no way back except
 * the back button. Better to catch it here and say which screen to go and fix.
 */
async function preflight() {
  const { url, key } = creds();
  try {
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
    });
    if (!res.ok) {
      if (res.status === 401) {
        return fail(
          "Supabase rejected the key",
          `HTTP ${res.status} from /auth/v1/settings`,
          "The anon / publishable key does not match this project. Copy both values again from Project Settings → API.",
        );
      }
      return null; // some other blip; not worth blocking the attempt over
    }
    const settings = await res.json();
    if (settings?.external?.google === false) {
      return fail(
        "Google sign-in is switched off in Supabase",
        "/auth/v1/settings reports external.google = false",
        "Supabase → Authentication → Sign In / Providers → Google. Turn it on, paste both the Client ID and the Client Secret from Google Cloud, then press Save.",
      );
    }
  } catch {
    // Offline, or CORS being awkward. A diagnostic should never be the thing
    // that stops you trying.
  }
  return null;
}

$("signin").addEventListener("click", async () => {
  persist();

  $("signin").disabled = true;
  const problem = await preflight();
  $("signin").disabled = false;
  if (problem) {
    render([problem], null);
    return;
  }

  const { error } = await getClient().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: redirectUrl,
      scopes: SCOPE,
      queryParams: {
        access_type: "offline", // ask for a refresh token at all
        prompt: "consent", // ask again even if they consented before
      },
    },
  });
  if (error) render([fail("Could not start sign-in", error.message)], null);
});

$("signout").addEventListener("click", async () => {
  await getClient()?.auth.signOut();
  location.href = redirectUrl;
});

/* ---------- checks ---------- */

/** Errors can come back in the query string or the fragment, depending on flow. */
function errorFromUrl() {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const code = query.get("error") ?? hash.get("error");
  if (!code) return null;
  const description =
    query.get("error_description") ?? hash.get("error_description") ?? "";
  return { code, description: description.replace(/\+/g, " ") };
}

async function run() {
  const returned = errorFromUrl();
  if (returned) {
    render(
      [
        fail(
          "Sign-in came back with an error",
          `${returned.code}: ${returned.description}`,
          /secret|provider/i.test(returned.description)
            ? "Supabase → Authentication → Sign In / Providers → Google, and make sure both the Client ID and the Client Secret are saved."
            : "Check the redirect URL is on Supabase's allow list, exactly as shown above.",
        ),
      ],
      null,
    );
    return;
  }

  const supabase = getClient();
  if (!supabase) return;

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    render([fail("Could not read the session", error.message)], null);
    return;
  }
  const session = data.session;
  if (!session) return; // not signed in yet; nothing to report

  $("signout").hidden = false;
  const checks = sessionChecks(session);
  render(checks, session);

  /* the real proof: call Google with it */
  if (session.provider_token) {
    await callCalendar(session.provider_token, checks, session);
  }
}

async function callCalendar(token, checks, session) {
  const params = new URLSearchParams({
    maxResults: "5",
    timeMin: new Date().toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await res.json();

    checks.push(calendarCheck(res.status, body));
    render(checks, session);
    if (res.ok) renderEvents(body.items ?? []);
  } catch (error) {
    checks.push(fail("Calendar request failed", String(error)));
    render(checks, session);
  }
}

/* ---------- rendering ---------- */

function render(checks, session) {
  $("results-panel").hidden = false;
  const list = $("checks");
  list.replaceChildren();

  for (const check of checks) {
    const row = document.createElement("li");
    row.className = `check-row ${check.state}`;

    const mark = document.createElement("span");
    mark.className = "check-mark";
    mark.textContent = check.state === "pass" ? "✓" : check.state === "warn" ? "!" : "✗";

    const title = document.createElement("span");
    title.className = "check-title";
    title.textContent = check.title;

    row.append(mark, title);

    if (check.detail) {
      const detail = document.createElement("span");
      detail.className = "check-detail";
      detail.textContent = check.detail;
      row.append(detail);
    }
    if (check.fix) {
      const fix = document.createElement("span");
      fix.className = "check-fix";
      fix.textContent = check.fix;
      row.append(fix);
    }
    list.append(row);
  }

  const summary = verdict(checks);
  const box = $("verdict");
  box.className = `verdict ${summary.state}`;
  box.textContent = summary.message;

  $("next-panel").hidden = !session || summary.failed > 0;
  $("setup-panel").hidden = Boolean(session) && summary.failed === 0;
}

function renderEvents(events) {
  $("events-block").hidden = events.length === 0;
  const list = $("events");
  list.replaceChildren();

  const fmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  for (const event of events) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = event.summary ?? "(no title)";
    const when = document.createElement("span");
    when.className = "when";
    const start = event.start?.dateTime ?? event.start?.date;
    when.textContent = start
      ? event.start.date
        ? new Date(`${start}T12:00:00Z`).toDateString()
        : fmt.format(new Date(start))
      : "";
    li.append(name, when);
    list.append(li);
  }
}

run();
