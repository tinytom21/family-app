import { test } from "node:test";
import assert from "node:assert/strict";

import { nextWeekStart, redatePlan, todayIn, weekDates } from "../src/domain/week.ts";
import { GOOD_PLAN } from "../src/demo-data.ts";

test("today is read in the household's zone, not the server's", () => {
  // 00:30 UTC on the 4th is still the 4th in London during summer time, but
  // the evening of the 3rd in New York. A server in the wrong place would
  // plan the wrong week.
  const instant = new Date("2026-09-04T00:30:00Z");
  assert.equal(todayIn("Europe/London", instant), "2026-09-04");
  assert.equal(todayIn("America/New_York", instant), "2026-09-03");
});

test("planning starts tomorrow, whatever day you set it up", () => {
  assert.equal(nextWeekStart("2026-09-03"), "2026-09-04");
  // Across a month end, and across the end of British Summer Time.
  assert.equal(nextWeekStart("2026-09-30"), "2026-10-01");
  assert.equal(nextWeekStart("2026-10-24"), "2026-10-25");
});

test("a week is seven consecutive days", () => {
  assert.deepEqual(weekDates("2026-09-04"), [
    "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07",
    "2026-09-08", "2026-09-09", "2026-09-10",
  ]);
});

test("re-dating a plan keeps its shape and its leftover links", () => {
  const moved = redatePlan(GOOD_PLAN, "2026-09-04");

  assert.equal(moved.weekStarting, "2026-09-04");
  assert.equal(moved.meals.length, GOOD_PLAN.meals.length);
  assert.deepEqual(
    [...new Set(moved.meals.map((m) => m.date))].sort(),
    weekDates("2026-09-04"),
  );

  // The Tuesday batch cook is now a Friday, and the Thursday that ate its
  // leftovers has followed it rather than pointing at a day that no longer
  // exists. Getting this wrong buys the stew's ingredients twice.
  const leftovers = moved.meals.find((m) => m.leftoverOf);
  assert.ok(leftovers, "the fixture has a leftovers meal");
  assert.ok(
    moved.meals.some((m) => m.date === leftovers.leftoverOf && !m.leftoverOf),
    `nothing is cooked on ${leftovers.leftoverOf}`,
  );
  assert.equal(leftovers.leftoverOf, "2026-09-05");
  assert.equal(leftovers.date, "2026-09-07");
});

test("re-dating leaves the recipes alone", () => {
  const moved = redatePlan(GOOD_PLAN, "2026-09-04");
  assert.deepEqual(moved.recipes, GOOD_PLAN.recipes);
});

test("re-dating to the week it already has changes nothing", () => {
  assert.deepEqual(redatePlan(GOOD_PLAN, "2026-08-17"), {
    ...GOOD_PLAN,
    weekStarting: "2026-08-17",
  });
});
