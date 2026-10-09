import { test } from "node:test";
import assert from "node:assert/strict";

import { proposeWeek } from "../src/domain/sitting.ts";
import type { UsualWeek } from "../src/domain/sitting.ts";
import { makePerson } from "../src/domain/people.ts";
import type { CalendarEvent } from "../src/domain/agenda.ts";
import { createApp } from "../src/app-state.ts";

const WEEK = [
  "2026-10-05", // Mon
  "2026-10-06", // Tue
  "2026-10-07", // Wed
  "2026-10-08", // Thu
  "2026-10-09", // Fri
  "2026-10-10", // Sat
  "2026-10-11", // Sun
];

const PEOPLE = [
  makePerson({ name: "Tom", ageBracket: "adult" }),
  makePerson({ name: "Jess", ageBracket: "adult" }),
  makePerson({ name: "Leo", ageBracket: "child" }),
];

// Mon Tom 45, Tue Jess 30, Wed Tom 20, Sun nobody — the rest left to the guess.
const USUAL: UsualWeek = {
  1: { cookId: "tom", minutes: 45 },
  2: { cookId: "jess", minutes: 30 },
  3: { cookId: "tom", minutes: 20 },
  0: { cookId: null, minutes: 0 },
};

const event = (date: string, summary: string, from: string, to: string): CalendarEvent => ({
  id: `${date}-${summary}`,
  summary,
  startsAt: `${date}T${from}:00+01:00`,
  endsAt: `${date}T${to}:00+01:00`,
});

/* ---------------- the table, given a usual week ---------------- */

test("the usual week decides the cook and the time, and says so", () => {
  const week = proposeWeek({ people: PEOPLE, dates: WEEK, usual: USUAL });
  const [mon, tue, wed] = week;

  assert.equal(mon.cookName, "Tom");
  assert.equal(mon.cookMinutes, 45);
  assert.equal(mon.cookSource, "usual");
  assert.equal(mon.minutesSource, "usual");

  assert.equal(tue.cookName, "Jess");
  assert.equal(tue.cookMinutes, 30);
  assert.equal(wed.cookMinutes, 20, "a short usual evening is kept, not lengthened");
});

test("a usual night off means nobody cooks", () => {
  const sunday = proposeWeek({ people: PEOPLE, dates: WEEK, usual: USUAL })[6];
  assert.equal(sunday.cookId, null);
  assert.equal(sunday.cookSource, "usual");
  assert.match(sunday.note, /nobody free to cook/);
});

test("days the usual week does not mention are worked out as before", () => {
  const thursday = proposeWeek({ people: PEOPLE, dates: WEEK, usual: USUAL })[3];
  assert.notEqual(thursday.cookSource, "usual");
  assert.ok(thursday.cookName, "somebody is still proposed");
});

test("when the usual cook is out, somebody else cooks and the note says why", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: WEEK,
    usual: USUAL,
    overrides: { present: { "2026-10-05|tom": false } },
  });
  const monday = week[0];
  assert.equal(monday.cookName, "Jess");
  assert.notEqual(monday.cookSource, "usual");
  assert.match(monday.note, /Tom usually cooks, but is out/);
});

test("this week's diary can shorten the usual time, but never lengthen it", () => {
  // Parents' evening 17:00–20:00 leaves Tom the half hour before 20:30.
  // (A meeting that ends at 7pm would not do it: the evening window runs to
  // 20:30, and the longest free stretch is what counts.)
  const week = proposeWeek({
    people: PEOPLE,
    dates: WEEK,
    usual: USUAL,
    eventsByPerson: { tom: [event("2026-10-05", "Parents evening", "17:00", "20:00")] },
  });
  const monday = week[0];
  assert.equal(monday.cookName, "Tom", "still Tom's night");
  assert.equal(monday.cookMinutes, 30);
  assert.equal(monday.minutesSource, "calendar");

  // A clear diary on Wednesday does not turn Tom's usual 20 minutes into 90.
  assert.equal(week[2].cookMinutes, 20);
  assert.equal(week[2].minutesSource, "usual");
});

test("a correction for this week beats the usual week", () => {
  const monday = proposeWeek({
    people: PEOPLE,
    dates: WEEK,
    usual: USUAL,
    overrides: { cook: { "2026-10-05": "jess" }, minutes: { "2026-10-05": 60 } },
  })[0];
  assert.equal(monday.cookName, "Jess");
  assert.equal(monday.cookMinutes, 60);
  assert.equal(monday.cookSource, "override");
  assert.equal(monday.minutesSource, "override");
});

test("somebody no longer in the household is quietly passed over", () => {
  const monday = proposeWeek({
    people: PEOPLE,
    dates: WEEK,
    usual: { 1: { cookId: "gran", minutes: 45 } },
  })[0];
  assert.ok(monday.cookName, "somebody still cooks");
  assert.notEqual(monday.cookSource, "usual");
});

/* ---------------- saving it from the app ---------------- */

async function household() {
  const app = createApp({ today: "2026-10-03" });
  await app.handle("/api/household/create", {
    householdName: "The Baileys",
    people: [
      { name: "Tom", ageBracket: "adult" },
      { name: "Jess", ageBracket: "adult" },
      { name: "Leo", ageBracket: "child" },
    ],
  });
  return app;
}

test("the usual week is saved from the table as it stands, and used next week", async () => {
  const app = await household();
  // Set this week the way it usually goes: Jess on Mondays, 25 minutes.
  await app.handle("/api/week/cook", { date: "2026-10-05", personId: "jess" });
  await app.handle("/api/week/minutes", { date: "2026-10-05", minutes: 25 });

  let state: any = (await app.handle("/api/week/save-usual")).body;
  const monday = state.household.usualWeek.find((d: any) => d.day === "Mon");
  assert.deepEqual(monday, { weekday: 1, day: "Mon", cookName: "Jess", minutes: 25 });
  assert.equal(state.household.usualWeek[0].day, "Mon", "listed in the family's own order");

  // This week now shows the usual rather than a correction...
  assert.equal(state.week.days[0].cookSource, "usual");
  assert.equal(state.week.days[0].cookName, "Jess");

  // ...and so does next week, which nobody has touched.
  state = (await app.handle("/api/week/start", { date: "2026-10-12" })).body;
  assert.equal(state.week.days[0].cookName, "Jess");
  assert.equal(state.week.days[0].cookMinutes, 25);
  assert.equal(state.week.days[0].cookSource, "usual");
});

test("saving the usual week leaves who is in for dinner alone", async () => {
  const app = await household();
  await app.handle("/api/week/present", { date: "2026-10-07", personId: "leo", present: false });
  const state: any = (await app.handle("/api/week/save-usual")).body;
  const wednesday = state.week.days[2];
  assert.equal(
    wednesday.attendance.find((a: any) => a.personId === "leo").present,
    false,
    "Leo is still out on Wednesday",
  );
});

test("the usual week is kept with the household, and can be dropped", async () => {
  const app = await household();
  await app.handle("/api/week/save-usual");
  const snapshot: any = (await app.handle("/api/snapshot")).body;
  assert.equal(Object.keys(snapshot.household.usualWeek).length, 7);

  const state: any = (await app.handle("/api/week/forget-usual")).body;
  assert.equal(state.household.usualWeek, null);
  assert.ok(state.week.days.every((d: any) => d.cookSource !== "usual"));
});
