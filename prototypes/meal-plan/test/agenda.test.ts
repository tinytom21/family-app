import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agendaForPrompt,
  assessDay,
  assessWeek,
  fromGoogleEvent,
  localParts,
  longestFreeStretch,
} from "../src/domain/agenda.ts";
import type { CalendarEvent } from "../src/domain/agenda.ts";

const at = (id: string, summary: string, start: string, end?: string): CalendarEvent => ({
  id,
  summary,
  startsAt: start,
  endsAt: end,
});

/* ---------------- time handling ---------------- */

test("wall-clock time is read in the household's zone, not the server's", () => {
  // 17:00 British Summer Time is 16:00 UTC. Reading this with getHours() on a
  // UTC server would move every summer evening an hour earlier and silently
  // free up time nobody has.
  const summer = localParts("2026-08-17T16:00:00Z", "Europe/London");
  assert.equal(summer?.date, "2026-08-17");
  assert.equal(summer?.minutes, 17 * 60);

  // In January the same offset does not apply.
  const winter = localParts("2026-01-17T16:00:00Z", "Europe/London");
  assert.equal(winter?.minutes, 16 * 60);
});

test("an offset in the timestamp is honoured", () => {
  const parts = localParts("2026-08-17T19:15:00+01:00", "Europe/London");
  assert.equal(parts?.date, "2026-08-17");
  assert.equal(parts?.minutes, 19 * 60 + 15);
});

test("garbage timestamps return null rather than a wrong time", () => {
  assert.equal(localParts("not a date", "Europe/London"), null);
});

/* ---------------- the gap calculation ---------------- */

const WINDOW = { from: 17 * 60, to: 20 * 60 + 30 }; // 210 minutes

test("an empty evening is the whole window", () => {
  assert.equal(longestFreeStretch(WINDOW, []), 210);
});

test("the longest stretch is found, not the first or the total", () => {
  // Busy 18:00-18:30 and 19:00-19:15. Gaps: 60, 30, 75. Total free is 165,
  // but you cannot cook across a gap, so the answer is 75.
  const busy = [
    { from: 18 * 60, to: 18 * 60 + 30 },
    { from: 19 * 60, to: 19 * 60 + 15 },
  ];
  assert.equal(longestFreeStretch(WINDOW, busy), 75);
});

test("overlapping commitments are merged rather than double-counted", () => {
  const busy = [
    { from: 17 * 60, to: 19 * 60 },
    { from: 18 * 60, to: 18 * 60 + 30 }, // wholly inside the first
  ];
  assert.equal(longestFreeStretch(WINDOW, busy), 90); // 19:00-20:30
});

test("commitments outside the window do not count against it", () => {
  const busy = [{ from: 9 * 60, to: 16 * 60 }];
  assert.equal(longestFreeStretch(WINDOW, busy), 210);
});

test("a commitment spanning the whole window leaves nothing", () => {
  const busy = [{ from: 16 * 60, to: 22 * 60 }];
  assert.equal(longestFreeStretch(WINDOW, busy), 0);
});

/* ---------------- days ---------------- */

test("a clear weeknight keeps the usual ceiling", () => {
  const day = assessDay("2026-08-18", []);
  assert.equal(day.availability, "clear");
  assert.equal(day.cookingMinutes, 45);
  assert.match(day.note, /clear/i);
});

test("a clear weekend gets the longer ceiling", () => {
  const day = assessDay("2026-08-22", []); // Saturday
  assert.equal(day.cookingMinutes, 90);
});

test("the calendar can lower the ceiling but never raise it", () => {
  // Three free hours on a Tuesday is still a 45-minute weeknight.
  const day = assessDay("2026-08-18", []);
  assert.equal(day.freeMinutes, 210);
  assert.equal(day.cookingMinutes, 45);
});

test("a busy evening is marked tight and explains itself", () => {
  // Free 17:00-17:30 (30) and 18:00-18:30 (30), then busy to close.
  const day = assessDay("2026-08-17", [
    at("1", "Drop Leo at Wallingford", "2026-08-17T17:30:00+01:00", "2026-08-17T18:00:00+01:00"),
    at("2", "Parents evening", "2026-08-17T18:30:00+01:00", "2026-08-17T20:30:00+01:00"),
  ]);
  assert.equal(day.availability, "tight");
  assert.equal(day.cookingMinutes, 30);
  assert.match(day.note, /Drop Leo at Wallingford 17:30–18:00/);
  assert.match(day.note, /30 minutes/);
});

test("an evening that is gone entirely says so, and suggests leftovers", () => {
  const day = assessDay("2026-08-19", [
    at("1", "Swimming", "2026-08-19T17:00:00+01:00", "2026-08-19T20:30:00+01:00"),
  ]);
  assert.equal(day.availability, "out");
  assert.equal(day.cookingMinutes, 0);
  assert.match(day.note, /leftovers|reheating/);
});

test("all-day entries are context, not a time cost", () => {
  const day = assessDay("2026-08-17", [
    { id: "h", summary: "Charlton school holidays", onDate: "2026-08-17" },
  ]);
  assert.equal(day.availability, "clear");
  assert.equal(day.cookingMinutes, 45);
  assert.equal(day.allDay.length, 1);
  assert.equal(day.events.length, 0);
});

test("events on other days are ignored", () => {
  const day = assessDay("2026-08-17", [
    at("1", "Tomorrow's thing", "2026-08-18T18:00:00+01:00", "2026-08-18T20:00:00+01:00"),
  ]);
  assert.equal(day.events.length, 0);
  assert.equal(day.cookingMinutes, 45);
});

test("an event with no end time is assumed to take an hour", () => {
  // "7.15 counselling" with no duration should still block the evening's tail.
  const day = assessDay("2026-08-18", [
    at("1", "7.15 counselling", "2026-08-18T19:15:00+01:00"),
  ]);
  // Free 17:00-19:15 is 135; capped to the weeknight 45.
  assert.equal(day.freeMinutes, 135);
  assert.equal(day.cookingMinutes, 45);
  assert.match(day.note, /19:15–20:15/);
});

/* ---------------- week + prompt ---------------- */

test("a week is assessed day by day", () => {
  const dates = ["2026-08-17", "2026-08-18", "2026-08-22"];
  const week = assessWeek(dates, [
    at("1", "Swimming", "2026-08-18T17:00:00+01:00", "2026-08-18T20:30:00+01:00"),
  ]);
  assert.deepEqual(week.map((d) => d.availability), ["clear", "out", "clear"]);
  assert.deepEqual(week.map((d) => d.cookingMinutes), [45, 0, 90]);
});

test("the prompt view carries the number and the reason for it", () => {
  const lines = agendaForPrompt(
    assessWeek(["2026-08-19"], [
      at("1", "Swimming", "2026-08-19T17:00:00+01:00", "2026-08-19T20:30:00+01:00"),
      { id: "h", summary: "School holidays", onDate: "2026-08-19" },
    ]),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^2026-08-19: 0 min to cook/);
  assert.match(lines[0], /Swimming/);
  assert.match(lines[0], /School holidays/);
});

/* ---------------- Google mapping ---------------- */

test("Google's two event shapes both map across", () => {
  const timed = fromGoogleEvent({
    id: "a",
    summary: "Louie walk",
    start: { dateTime: "2026-08-18T13:30:00+01:00" },
    end: { dateTime: "2026-08-18T14:30:00+01:00" },
  });
  assert.equal(timed?.startsAt, "2026-08-18T13:30:00+01:00");
  assert.equal(timed?.onDate, undefined);

  const allDay = fromGoogleEvent({
    id: "b",
    summary: "Charlton school holidays",
    start: { date: "2026-07-20" },
  });
  assert.equal(allDay?.onDate, "2026-07-20");
  assert.equal(allDay?.startsAt, undefined);
});

test("an event with no title still blocks the time", () => {
  const event = fromGoogleEvent({
    id: "c",
    start: { dateTime: "2026-08-18T18:00:00+01:00" },
    end: { dateTime: "2026-08-18T19:00:00+01:00" },
  });
  assert.equal(event?.summary, "(busy)");
});

test("unusable entries are dropped rather than guessed at", () => {
  assert.equal(fromGoogleEvent({ summary: "no id" }), null);
  assert.equal(fromGoogleEvent({ id: "d", summary: "no start" }), null);
  assert.equal(fromGoogleEvent(null), null);
});
