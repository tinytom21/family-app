import { test } from "node:test";
import assert from "node:assert/strict";

import {
  outForDinner,
  proposeWeek,
  slotsFromWeek,
  weekForPrompt,
} from "../src/domain/sitting.ts";
import { makePerson } from "../src/domain/people.ts";
import type { CalendarEvent } from "../src/domain/agenda.ts";

const WEEK = [
  "2026-08-17", // Mon
  "2026-08-18", // Tue
  "2026-08-19", // Wed
  "2026-08-20", // Thu
  "2026-08-21", // Fri
  "2026-08-22", // Sat
  "2026-08-23", // Sun
];

const PEOPLE = [
  makePerson({ name: "Tom", ageBracket: "adult" }),
  makePerson({ name: "Priya", ageBracket: "adult" }),
  makePerson({ name: "Aria", ageBracket: "child", excludes: ["nuts"] }),
  makePerson({ name: "Noor", ageBracket: "child" }),
];

const at = (
  id: string,
  summary: string,
  from: string,
  to: string,
): CalendarEvent => ({
  id,
  summary,
  startsAt: `2026-08-17T${from}:00+01:00`,
  endsAt: `2026-08-17T${to}:00+01:00`,
});

/* ---------------- out for dinner ---------------- */

test("being busy through dinner does not mean being absent", () => {
  // The whole point: a call from home blocks cooking, not eating. Reading it
  // as absence is the mistake that makes people stop believing the grid.
  const verdict = outForDinner("2026-08-17", [
    at("e", "Client call", "17:30", "20:30"),
  ]);
  assert.equal(verdict.out, false);
});

test("a meal somewhere else does mean being absent", () => {
  const verdict = outForDinner("2026-08-17", [
    at("e", "Dinner with the Hardys", "19:00", "22:00"),
  ]);
  assert.equal(verdict.out, true);
  assert.equal(verdict.why, "Dinner with the Hardys");
});

test("an all-day entry that puts someone elsewhere marks them out", () => {
  const verdict = outForDinner("2026-08-21", [
    { id: "e", summary: "Staying at Grandma's", onDate: "2026-08-21" },
  ]);
  assert.equal(verdict.out, true);
  assert.equal(verdict.why, "Staying at Grandma's");
});

test("an all-day entry that is merely context does not", () => {
  const verdict = outForDinner("2026-08-17", [
    { id: "e", summary: "Charlton school holidays", onDate: "2026-08-17" },
  ]);
  assert.equal(verdict.out, false);
});

test("a meal event outside the dinner slot is ignored", () => {
  // Lunch out says nothing about being home for dinner.
  const verdict = outForDinner("2026-08-17", [
    at("e", "Dinner planning meeting", "12:00", "13:00"),
  ]);
  assert.equal(verdict.out, false);
});

/* ---------------- the grid ---------------- */

test("having somebody's events counts as having their calendar", () => {
  // Otherwise a person could have their evenings read off a calendar while the
  // grid still labelled them a guess.
  const week = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-17"],
    eventsByPerson: { tom: [at("t", "Call", "17:00", "18:00")] },
    connected: [],
  });
  assert.equal(
    week[0].attendance.find((a) => a.personId === "tom")!.source,
    "calendar",
  );
  assert.equal(
    week[0].attendance.find((a) => a.personId === "priya")!.source,
    "assumed",
  );
});

test("with no calendars everyone is assumed in, and it says so", () => {
  const week = proposeWeek({ people: PEOPLE, dates: WEEK });
  const monday = week[0];

  assert.equal(monday.attendance.length, 4);
  assert.ok(monday.attendance.every((a) => a.present));
  assert.ok(monday.attendance.every((a) => a.source === "assumed"));
  assert.match(monday.attendance[0].why, /No calendar connected/);
  // 1 + 1 + 0.6 + 0.6
  assert.equal(monday.portions, 3.2);
  assert.ok(monday.cookId);
});

test("portions drop when somebody is out", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: WEEK,
    eventsByPerson: {
      aria: [{ id: "a", summary: "Staying at Grandma's", onDate: "2026-08-21" }],
    },
    connected: ["aria"],
  });

  const friday = week.find((d) => d.date === "2026-08-21")!;
  assert.equal(friday.portions, 2.6, "Aria's 0.6 comes off");
  const aria = friday.attendance.find((a) => a.personId === "aria")!;
  assert.equal(aria.present, false);
  assert.equal(aria.portion, 0);
  assert.equal(aria.source, "calendar");

  // Every other day is unaffected.
  assert.equal(week.find((d) => d.date === "2026-08-20")!.portions, 3.2);
});

test("the cook is somebody present, able, and actually free", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-17"],
    eventsByPerson: {
      tom: [
        at("t1", "Drop Leo at wallingford", "17:00", "18:00"),
        at("t2", "Prepare documentation", "18:00", "20:30"),
      ],
    },
    connected: ["tom", "priya"],
  });

  const monday = week[0];
  assert.equal(monday.cookId, "priya", "Tom has no unbroken stretch left");
  assert.equal(monday.cookMinutes, 45);
  const tom = monday.attendance.find((a) => a.personId === "tom")!;
  assert.equal(tom.present, true, "busy, but still eating");
  assert.equal(tom.freeMinutes, 0);
});

test("children are never put down to cook", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-17"],
    eventsByPerson: {
      tom: [at("t", "Out", "17:00", "21:00")],
      priya: [at("p", "Out", "17:00", "21:00")],
    },
    connected: ["tom", "priya", "aria", "noor"],
  });
  assert.equal(week[0].cookId, null);
  assert.match(week[0].note, /nobody free to cook/);
});

test("an evening with nobody free to cook is a real answer", () => {
  const week = proposeWeek({
    people: [PEOPLE[0]],
    dates: ["2026-08-17"],
    eventsByPerson: { tom: [at("t", "Work", "17:00", "21:00")] },
    connected: ["tom"],
  });
  assert.equal(week[0].cookId, null);
  assert.equal(week[0].cookMinutes, 0);
  assert.equal(week[0].portions, 1, "still needs feeding");
  assert.match(weekForPrompt(week)[0], /NOBODY CAN COOK/);
});

test("the cooking rota does not land on one person all week", () => {
  const week = proposeWeek({ people: PEOPLE, dates: WEEK });
  const cooks = week.map((d) => d.cookId);
  assert.equal(new Set(cooks).size, 2, `got ${JSON.stringify(cooks)}`);
});

test("weekends get the longer ceiling", () => {
  const week = proposeWeek({ people: PEOPLE, dates: WEEK });
  assert.equal(week.find((d) => d.date === "2026-08-19")!.cookMinutes, 45);
  assert.equal(week.find((d) => d.date === "2026-08-22")!.cookMinutes, 90);
});

/* ---------------- overrides ---------------- */

test("an override beats the calendar and says who decided", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-21"],
    eventsByPerson: {
      aria: [{ id: "a", summary: "Staying at Grandma's", onDate: "2026-08-21" }],
    },
    connected: ["aria"],
    overrides: { present: { "2026-08-21|aria": true } },
  });

  const aria = week[0].attendance.find((a) => a.personId === "aria")!;
  assert.equal(aria.present, true);
  assert.equal(aria.source, "override");
  assert.equal(aria.why, "You said so");
  assert.equal(week[0].portions, 3.2);
});

test("an override can also put somebody out who the calendar thinks is in", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-17"],
    overrides: { present: { "2026-08-17|tom": false } },
  });
  assert.equal(week[0].portions, 2.2);
  assert.equal(week[0].attendance.find((a) => a.personId === "tom")!.present, false);
});

test("the cook and the time can both be overridden, including to nobody", () => {
  const chosen = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-17"],
    overrides: { cook: { "2026-08-17": "priya" }, minutes: { "2026-08-17": 20 } },
  });
  assert.equal(chosen[0].cookId, "priya");
  assert.equal(chosen[0].cookMinutes, 20);
  assert.equal(chosen[0].cookSource, "override");
  assert.equal(chosen[0].minutesSource, "override");

  const nobody = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-17"],
    overrides: { cook: { "2026-08-17": null } },
  });
  assert.equal(nobody[0].cookId, null);
  assert.equal(nobody[0].cookMinutes, 0);
});

test("overrides survive a fresh read of the calendar", () => {
  // The whole reason overrides are stored apart from the proposal: a refresh
  // must never quietly undo somebody's correction.
  const overrides = { present: { "2026-08-21|aria": true } };
  const before = proposeWeek({ people: PEOPLE, dates: ["2026-08-21"], overrides });

  const after = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-21"],
    eventsByPerson: {
      aria: [{ id: "new", summary: "Away camping", onDate: "2026-08-21" }],
    },
    connected: ["aria"],
    overrides,
  });

  assert.equal(before[0].portions, after[0].portions);
  assert.equal(after[0].attendance.find((a) => a.personId === "aria")!.present, true);
});

/* ---------------- what comes out of it ---------------- */

test("a day with nobody in is not a slot worth planning", () => {
  const week = proposeWeek({
    people: [PEOPLE[0]],
    dates: WEEK,
    eventsByPerson: {
      tom: [{ id: "a", summary: "Away with work", onDate: "2026-08-19" }],
    },
    connected: ["tom"],
  });

  const slots = slotsFromWeek(week);
  assert.equal(slots.length, 6);
  assert.equal(
    slots.some((s) => s.date === "2026-08-19"),
    false,
  );
});

test("the prompt lines name who is in, who is out and who cooks", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: ["2026-08-21"],
    eventsByPerson: {
      aria: [{ id: "a", summary: "Staying at Grandma's", onDate: "2026-08-21" }],
    },
    connected: ["aria"],
  });

  const line = weekForPrompt(week)[0];
  assert.match(line, /2\.6 portions/);
  assert.match(line, /away: Aria/);
  assert.match(line, /cooks, \d+ min/);
});
