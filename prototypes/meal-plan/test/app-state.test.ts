import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app-state.ts";
import { weekDates } from "../src/domain/week.ts";

const DRAFT = {
  householdName: "The Hardys",
  people: [
    { name: "Tom", ageBracket: "adult" },
    { name: "Priya", ageBracket: "adult" },
    { name: "Aria", ageBracket: "child", excludes: "peanuts" },
  ],
};

test("a real household is planned for the week in front of it", async () => {
  // The whole point: the fixtures live in August 2026, and a family setting up
  // in September must not be handed a plan whose every day has already been.
  const app = createApp({ today: "2026-09-03" });
  await app.handle("/api/household/create", DRAFT);
  const state: any = (await app.handle("/api/state")).body;

  assert.equal(state.today, "2026-09-03");
  assert.equal(state.plan.weekStarting, "2026-09-04");
  assert.deepEqual(
    [...new Set(state.plan.meals.map((m: any) => m.date))].sort(),
    weekDates("2026-09-04"),
  );
  assert.equal(state.household.weekStarting, "2026-09-04");
});

test("the leftover link survives the move onto real dates", async () => {
  const app = createApp({ today: "2026-09-03" });
  await app.handle("/api/household/create", DRAFT);
  const state: any = (await app.handle("/api/state")).body;

  const leftovers = state.plan.meals.find((m: any) => m.leftoverOf);
  assert.ok(leftovers, "the starter week has a leftovers night");
  // If this pointed at a day outside the plan, the stew's ingredients would be
  // bought twice and nobody would notice until the delivery arrived.
  assert.ok(
    state.plan.meals.some(
      (m: any) => m.date === leftovers.leftoverOf && !m.leftoverOf,
    ),
    `nothing is cooked on ${leftovers.leftoverOf}`,
  );
});

test("a real household starts with an empty cupboard and no jobs", async () => {
  const app = createApp({ today: "2026-09-03" });
  await app.handle("/api/household/create", DRAFT);
  const state: any = (await app.handle("/api/state")).body;

  assert.deepEqual(state.larder.items, []);
  assert.deepEqual(state.larder.freezer, []);
  assert.equal(state.tasks.items.length, 0);
  assert.equal(state.week.connected.length, 0, "no calendars borrowed");
  assert.deepEqual(
    state.household.people.map((p: any) => p.name),
    ["Tom", "Priya", "Aria"],
  );
});

test("the example household keeps the week its fixtures were written for", async () => {
  // Its calendars, larder dates and jobs are all August. Re-dating half of
  // them would make the example demonstrate nothing.
  const app = createApp({ today: "2026-09-03" });
  await app.handle("/api/household/example", {});
  const state: any = (await app.handle("/api/state")).body;

  assert.equal(state.today, "2026-08-16");
  assert.equal(state.plan.weekStarting, "2026-08-17");
  assert.ok(state.week.connected.length > 0, "the example calendars are loaded");
  assert.ok(state.tasks.items.length > 0, "and the example jobs");
});

test("the jobs scheduler has a week to work with, not a week that has gone", async () => {
  // The failure this guards against is silent: scheduleTasks skips days before
  // today, so a plan stuck in the past places nothing and simply looks empty.
  const app = createApp({ today: "2026-09-03" });
  await app.handle("/api/household/create", DRAFT);
  await app.handle("/api/tasks/add", {
    title: "Ring the dentist",
    effortMinutes: 15,
  });
  const state: any = (await app.handle("/api/state")).body;

  assert.equal(state.tasks.schedule.days.length, 7);
  assert.equal(
    state.tasks.schedule.days.flatMap((d: any) => d.placed).length,
    1,
    "the job found an evening",
  );
});

test("setUp is false until somebody has been through the intro screen", async () => {
  const app = createApp({ today: "2026-09-03" });
  assert.equal(((await app.handle("/api/state")).body as any).setUp, false);
  await app.handle("/api/household/example", {});
  assert.equal(((await app.handle("/api/state")).body as any).setUp, true);
});
