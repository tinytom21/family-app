import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app-state.ts";
import { nextStartOn, weekdayIndex } from "../src/domain/week.ts";
import { userPrompt } from "../src/ai/planner.ts";

const DRAFT = {
  householdName: "The Baileys",
  people: [
    { name: "Tom", ageBracket: "adult" },
    { name: "Jess", ageBracket: "adult" },
    { name: "Leo", ageBracket: "child" },
  ],
};

/* ---------------- which day a week begins ---------------- */

test("set up on a Saturday, the week starts on Monday", () => {
  // The exact complaint: opened on a Saturday, offered a week from Sunday.
  assert.equal(weekdayIndex("2026-10-03"), 6);
  assert.equal(nextStartOn("2026-10-03"), "2026-10-05");
});

test("opened on the start day itself, the plan is for the week after", () => {
  // Tonight's dinner is decided by the time anybody fills in a plan. The date
  // picker is there for the Monday-morning planner who wants today.
  assert.equal(nextStartOn("2026-10-05"), "2026-10-12");
});

test("a family whose weeks start on Sunday gets Sundays", () => {
  assert.equal(nextStartOn("2026-10-03", 0), "2026-10-04");
});

test("a new household starts on the day it asks for", async () => {
  const app = createApp({ today: "2026-10-03" });
  await app.handle("/api/household/create", { ...DRAFT, weekStartsOn: 4 });
  const state: any = (await app.handle("/api/state")).body;
  assert.equal(state.plan.weekStarting, "2026-10-08", "the next Thursday");
  assert.equal(state.household.weekStartsOn, 4);
});

test("choosing a start date moves the plan, and remembers the weekday", async () => {
  const app = createApp({ today: "2026-10-03" });
  await app.handle("/api/household/create", DRAFT);

  const moved: any = (await app.handle("/api/week/start", { date: "2026-10-04" })).body;
  assert.equal(moved.plan.weekStarting, "2026-10-04");
  const dates = [...new Set(moved.plan.meals.map((m: any) => m.date))].sort();
  assert.equal(dates[0], "2026-10-04");
  assert.equal(dates.length, 7, "the same week of meals, on new dates");
  assert.equal(moved.household.weekStartsOn, 0, "so next week defaults to Sunday too");
});

test("a start date that is not a date is refused", async () => {
  const app = createApp({ today: "2026-10-03" });
  await app.handle("/api/household/create", DRAFT);
  for (const date of ["next monday", "2026-13-40", "", undefined]) {
    const res = await app.handle("/api/week/start", { date });
    assert.equal(res.status, 400, `accepted ${JSON.stringify(date)}`);
  }
});

/* ---------------- the family's own words ---------------- */

test("standing instructions are kept with the household", async () => {
  const app = createApp({ today: "2026-10-03" });
  await app.handle("/api/household/create", {
    ...DRAFT,
    instructions: "  Pizza on Fridays.  ",
  });
  let state: any = (await app.handle("/api/state")).body;
  assert.equal(state.household.instructions, "Pizza on Fridays.");

  state = (await app.handle("/api/household/instructions", {
    text: "Pizza on Fridays. Fish on Wednesdays.",
  })).body;
  assert.equal(state.household.instructions, "Pizza on Fridays. Fish on Wednesdays.");

  const snapshot: any = (await app.handle("/api/snapshot")).body;
  assert.equal(snapshot.household.instructions, "Pizza on Fridays. Fish on Wednesdays.");
});

test("a week's notes belong to that week, and follow it if its date moves", async () => {
  const app = createApp({ today: "2026-10-03" });
  await app.handle("/api/household/create", DRAFT);

  let state: any = (await app.handle("/api/week/note", { text: "Jess away Thursday" })).body;
  assert.equal(state.week.note, "Jess away Thursday");

  // Written for "this week", then the start date was corrected: still this week.
  state = (await app.handle("/api/week/start", { date: "2026-10-06" })).body;
  assert.equal(state.week.note, "Jess away Thursday");

  // Clearing it clears it, rather than leaving an empty note behind.
  state = (await app.handle("/api/week/note", { text: "   " })).body;
  assert.equal(state.week.note, "");
  const snapshot: any = (await app.handle("/api/snapshot")).body;
  assert.deepEqual(snapshot.weekNotes, {});
});

test("the planner is told the family's words, and nobody else's", async () => {
  let asked: any = null;
  const app = createApp({
    today: "2026-10-03",
    ai: {
      available: true,
      async generatePlan(constraints) {
        asked = constraints;
        throw new Error("captured");
      },
    },
  });
  await app.handle("/api/household/create", {
    ...DRAFT,
    instructions: "Pizza on Fridays.",
  });
  await app.handle("/api/week/note", { text: "Out for dinner on Friday." });
  await app.handle("/api/plan/generate");

  assert.equal(asked.standing, "Pizza on Fridays.");
  assert.equal(asked.thisWeek, "Out for dinner on Friday.");
  // The example family's notes — a made-up child's nut allergy and their
  // swimming night — used to reach every real household's prompt.
  assert.equal(asked.notes, undefined);

  const prompt = userPrompt(asked, [{ date: "2026-10-09", slot: "dinner" }]);
  assert.match(prompt, /EVERY WEEK[^\n]*\nPizza on Fridays\./);
  assert.match(prompt, /THIS WEEK ONLY[^\n]*\nOut for dinner on Friday\./);
  assert.doesNotMatch(prompt, /Aria|swimming/);
});

test("the example family still has its own notes", async () => {
  const app = createApp({ today: "2026-10-03" });
  const state: any = (await app.handle("/api/household/example")).body;
  assert.match(state.household.instructions, /nut allergy/);
});
