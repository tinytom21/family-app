import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calendarCheck,
  mask,
  sessionChecks,
  verdict,
} from "../web/public/check-logic.js";

/**
 * The setup checker's judgement, tested without a browser, a Supabase project
 * or a Google account. The missing-refresh-token case in particular is only
 * otherwise reachable by deliberately misconfiguring a real project.
 */

const goodSession = {
  user: { email: "tom@example.com" },
  provider_token: "ya29." + "x".repeat(120),
  provider_refresh_token: "1//0g" + "y".repeat(80),
};

const state = (checks: any[], title: string) =>
  checks.find((c) => c.title.includes(title))?.state;

test("a fully working setup passes every check", () => {
  const checks = sessionChecks(goodSession);
  assert.equal(state(checks, "Signed in"), "pass");
  assert.equal(state(checks, "access token"), "pass");
  assert.equal(state(checks, "refresh token"), "pass");
  assert.equal(verdict(checks).state, "pass");
  assert.equal(verdict(checks).failed, 0);
});

test("a missing refresh token fails and says exactly what to check", () => {
  // The whole reason this page exists: everything else looks fine, and
  // calendar access dies quietly an hour later.
  const checks = sessionChecks({
    ...goodSession,
    provider_refresh_token: undefined,
  });
  assert.equal(state(checks, "access token"), "pass");
  assert.equal(state(checks, "refresh token"), "fail");

  const problem = checks.find((c) => c.title.includes("refresh token"));
  assert.match(problem.fix, /access_type=offline/);
  assert.match(problem.fix, /prompt=consent/);
  assert.equal(verdict(checks).failed, 1);
});

test("a missing access token is reported separately", () => {
  const checks = sessionChecks({ ...goodSession, provider_token: null });
  assert.equal(state(checks, "access token"), "fail");
  assert.equal(state(checks, "refresh token"), "pass");
});

test("tokens are shown recognisably but never in full", () => {
  const masked = mask(goodSession.provider_refresh_token);
  assert.ok(!masked.includes(goodSession.provider_refresh_token));
  assert.ok(masked.startsWith("1//0gyy"));
  assert.match(masked, /\d+ chars/);
  assert.equal(mask(undefined), "");
  // Short values are hidden entirely rather than mostly revealed.
  assert.ok(!mask("shortsecret").includes("shortsecret"));
});

test("a 403 blames the two things that actually cause it", () => {
  const check = calendarCheck(403, {
    error: { message: "Request had insufficient authentication scopes." },
  });
  assert.equal(check.state, "fail");
  assert.match(check.fix, /not enabled on the project/);
  assert.match(check.fix, /scope was not requested/);
});

test("a 401 is diagnosed as expiry, not misconfiguration", () => {
  const check = calendarCheck(401, { error: { message: "Invalid Credentials" } });
  assert.equal(check.state, "fail");
  assert.match(check.fix, /expired/);
});

test("a successful call counts the events it got back", () => {
  assert.match(
    calendarCheck(200, { items: [{}, {}, {}] }).detail,
    /3 upcoming events/,
  );
  // Singular reads properly, and an empty calendar is still a pass.
  assert.match(calendarCheck(200, { items: [{}] }).detail, /1 upcoming event\b/);
  assert.equal(calendarCheck(200, {}).state, "pass");
});

test("the verdict counts every failure, not just the first", () => {
  const checks = sessionChecks({ user: {} });
  checks.push(calendarCheck(403, {}));
  const summary = verdict(checks);
  assert.equal(summary.failed, 3);
  assert.match(summary.message, /3 things to fix/);
});
