/**
 * The judgement half of the Google setup checker, with no DOM in it.
 *
 * Split out so the interesting cases can be tested without a browser, a
 * Supabase project or a Google account — particularly the missing-refresh-token
 * case, which is the one that silently ruins calendar sync and is otherwise
 * only reachable by deliberately misconfiguring a real project.
 *
 * Plain JavaScript rather than TypeScript so the browser can import it as-is.
 */

export const pass = (title, detail) => ({ state: "pass", title, detail });
export const fail = (title, detail, fix) => ({ state: "fail", title, detail, fix });
export const warn = (title, detail, fix) => ({ state: "warn", title, detail, fix });

/** Show enough of a token to recognise it, never enough to use it. */
export function mask(token) {
  if (!token) return "";
  if (token.length <= 16) return `${"•".repeat(token.length)} (${token.length} chars)`;
  return `${token.slice(0, 8)}…${token.slice(-6)} (${token.length} chars)`;
}

/**
 * What the returned session tells us about steps 1-6 of the runbook.
 */
export function sessionChecks(session) {
  const checks = [];

  checks.push(
    pass("Signed in through Supabase", session.user?.email ?? session.user?.id ?? ""),
  );

  if (session.provider_token) {
    checks.push(pass("Google access token received", mask(session.provider_token)));
  } else {
    checks.push(
      fail(
        "No Google access token",
        "session.provider_token is empty",
        "Usually means the sign-in did not complete against Google, or the page was reloaded after the token was consumed. Sign out and try once more.",
      ),
    );
  }

  if (session.provider_refresh_token) {
    checks.push(
      pass("Google refresh token received", mask(session.provider_refresh_token)),
    );
  } else {
    checks.push(
      fail(
        "No Google refresh token",
        "session.provider_refresh_token is empty",
        "This is the important one. Check access_type=offline and prompt=consent are both being sent, and that you are not re-using a previous consent. Without it, calendar access dies when the access token expires in an hour.",
      ),
    );
  }

  return checks;
}

/**
 * What the Calendar API's answer tells us. `status` is the HTTP status and
 * `body` the parsed JSON, successful or not.
 */
export function calendarCheck(status, body) {
  if (status === 200) {
    const events = body?.items ?? [];
    return pass(
      "Read the primary calendar",
      `${events.length} upcoming event${events.length === 1 ? "" : "s"} returned`,
    );
  }

  const reason = body?.error?.message ?? `HTTP ${status}`;

  if (status === 403) {
    return fail(
      "Calendar API refused the call",
      reason,
      "Usually the Calendar API is not enabled on the project (step 2), or the calendar scope was not requested at consent (step 4).",
    );
  }
  if (status === 401) {
    return fail(
      "Calendar API rejected the token",
      reason,
      "The access token has expired — they last about an hour. Sign out and back in.",
    );
  }
  return fail("Calendar API refused the call", reason);
}

/** One sentence for the top of the results, based on everything above. */
export function verdict(checks) {
  const failed = checks.filter((c) => c.state === "fail").length;
  return {
    state: failed ? "fail" : "pass",
    failed,
    message: failed
      ? `${failed} thing${failed === 1 ? "" : "s"} to fix — see the notes above.`
      : "All good. The console side of the runbook is correct and provably working.",
  };
}
