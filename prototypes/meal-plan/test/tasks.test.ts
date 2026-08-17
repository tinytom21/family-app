import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  addMonths,
  completeTask,
  daysBetween,
  nextOccurrence,
  remindersFor,
  rollForward,
  scheduleTasks,
  statusOf,
  weekdayOf,
} from "../src/domain/tasks.ts";
import type { Recurrence, Task } from "../src/domain/tasks.ts";
import { assessWeek } from "../src/domain/agenda.ts";
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

const task = (over: Partial<Task> = {}): Task => ({
  id: "t",
  title: "A job",
  category: "household",
  effortMinutes: 20,
  ...over,
});

/* ---------------- date arithmetic ---------------- */

test("addDays crosses a month boundary", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-09-01", -1), "2026-08-31");
});

test("addDays is unmoved by the end of British Summer Time", () => {
  // The clocks go back on 2026-10-25. Anchoring at midday is what stops this
  // landing on the 24th.
  assert.equal(addDays("2026-10-24", 1), "2026-10-25");
  assert.equal(addDays("2026-10-25", 1), "2026-10-26");
});

test("addMonths clamps rather than overflowing", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29"); // leap year
  assert.equal(addMonths("2026-03-31", 1), "2026-04-30");
  assert.equal(addMonths("2026-01-15", 1), "2026-02-15");
});

test("addMonths goes backwards and across years", () => {
  assert.equal(addMonths("2026-01-15", -1), "2025-12-15");
  assert.equal(addMonths("2026-08-15", 12), "2027-08-15");
});

test("daysBetween and weekdayOf agree with the calendar", () => {
  assert.equal(daysBetween("2026-08-17", "2026-08-20"), 3);
  assert.equal(daysBetween("2026-08-20", "2026-08-17"), -3);
  assert.equal(weekdayOf("2026-08-17"), 1); // Monday
  assert.equal(weekdayOf("2026-08-23"), 0); // Sunday
});

/* ---------------- recurrence ---------------- */

test("a weekly weekday recurrence lands on the next matching day", () => {
  const rec: Recurrence = {
    every: 1,
    unit: "week",
    weekdays: [2],
    anchor: "schedule",
  };
  // From a Tuesday, the next one is a week away, not today.
  assert.equal(nextOccurrence(rec, "2026-08-18"), "2026-08-25");
  // From a Wednesday, it is six days.
  assert.equal(nextOccurrence(rec, "2026-08-19"), "2026-08-25");
});

test("a fortnightly recurrence skips the week in between", () => {
  const rec: Recurrence = {
    every: 2,
    unit: "week",
    weekdays: [2],
    anchor: "schedule",
  };
  assert.equal(nextOccurrence(rec, "2026-08-18"), "2026-09-01");
});

test("a recurrence on several weekdays takes whichever comes first", () => {
  const rec: Recurrence = {
    every: 1,
    unit: "week",
    weekdays: [1, 4],
    anchor: "schedule",
  };
  assert.equal(nextOccurrence(rec, "2026-08-17"), "2026-08-20"); // Mon -> Thu
  assert.equal(nextOccurrence(rec, "2026-08-20"), "2026-08-24"); // Thu -> Mon
});

test("day and month recurrences step plainly", () => {
  assert.equal(
    nextOccurrence({ every: 3, unit: "day", anchor: "completion" }, "2026-08-17"),
    "2026-08-20",
  );
  assert.equal(
    nextOccurrence({ every: 1, unit: "month", anchor: "schedule" }, "2026-08-31"),
    "2026-09-30",
  );
});

/* ---------------- the two anchors ---------------- */

test("a schedule-anchored job keeps its schedule when done late", () => {
  const bins = task({
    dueOn: "2026-08-18", // Tuesday
    recurrence: { every: 1, unit: "week", weekdays: [2], anchor: "schedule" },
  });
  // Put out on Wednesday morning, a day late.
  const next = completeTask(bins, "2026-08-19");
  assert.equal(next.dueOn, "2026-08-25", "still the following Tuesday");
  assert.equal(next.lastCompletedOn, "2026-08-19");
  assert.equal(next.done, undefined, "recurring jobs are never finished");
});

test("a completion-anchored job restarts its clock from when it was done", () => {
  const sheets = task({
    dueOn: "2026-08-19",
    recurrence: { every: 2, unit: "week", anchor: "completion" },
  });
  // Four days late, so the next one moves four days too.
  const next = completeTask(sheets, "2026-08-23");
  assert.equal(next.dueOn, "2026-09-06");
});

test("finishing a schedule-anchored job very late does not leave it due in the past", () => {
  const bins = task({
    dueOn: "2026-07-21",
    recurrence: { every: 1, unit: "week", weekdays: [2], anchor: "schedule" },
  });
  const next = completeTask(bins, "2026-08-19");
  assert.ok(next.dueOn! > "2026-08-19", `got ${next.dueOn}`);
  assert.equal(next.dueOn, "2026-08-25");
});

test("a one-off task is simply finished", () => {
  const done = completeTask(task({ dueOn: "2026-08-18" }), "2026-08-18");
  assert.equal(done.done, true);
  assert.equal(done.dueOn, "2026-08-18");
});

test("missed fixed occurrences roll forward instead of stacking up", () => {
  // Three weeks of missed bin days should read as "last Tuesday", not "21 days".
  const bins = task({
    dueOn: "2026-07-28",
    recurrence: { every: 1, unit: "week", weekdays: [2], anchor: "schedule" },
  });
  const rolled = rollForward(bins, "2026-08-16");
  assert.equal(rolled.dueOn, "2026-08-11");
  assert.equal(statusOf(rolled, "2026-08-16"), "overdue");
});

test("a completion-anchored job that is a month late really is a month late", () => {
  const sheets = task({
    dueOn: "2026-07-15",
    recurrence: { every: 2, unit: "week", anchor: "completion" },
  });
  assert.equal(rollForward(sheets, "2026-08-16").dueOn, "2026-07-15");
});

test("statusOf buckets by distance from today", () => {
  const on = (dueOn?: string) => statusOf(task({ dueOn }), "2026-08-17");
  assert.equal(on("2026-08-15"), "overdue");
  assert.equal(on("2026-08-17"), "today");
  assert.equal(on("2026-08-19"), "soon");
  assert.equal(on("2026-08-25"), "later");
  assert.equal(on(undefined), "someday");
});

/* ---------------- reminders ---------------- */

const swimming: CalendarEvent = {
  id: "e-swim",
  summary: "Noor swimming lesson",
  startsAt: "2026-08-20T17:30:00+01:00",
  endsAt: "2026-08-20T18:30:00+01:00",
};

test("an event-anchored reminder fires the evening before the real event", () => {
  const agenda = assessWeek(WEEK, [swimming]);
  const kit = task({
    id: "swim-kit",
    title: "Pack the swimming kit",
    beforeEvent: { match: "swim", lead: "evening-before" },
  });

  const reminders = remindersFor([kit], agenda, "2026-08-17");
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].date, "2026-08-19");
  assert.equal(reminders[0].kind, "before-event");
  assert.match(reminders[0].message, /Thursday is Noor swimming lesson/);
});

test("no matching event means no reminder at all", () => {
  // The week swimming is cancelled, the task says nothing. A weekly repeat
  // would have nagged regardless, which is how people learn to ignore them.
  const agenda = assessWeek(WEEK, []);
  const kit = task({ beforeEvent: { match: "swim", lead: "evening-before" } });
  assert.deepEqual(remindersFor([kit], agenda, "2026-08-17"), []);
});

test("event reminders match all-day entries too, and ignore case", () => {
  const agenda = assessWeek(WEEK, [
    { id: "e", summary: "SWIMMING GALA", onDate: "2026-08-22" },
  ]);
  const kit = task({ beforeEvent: { match: "swimming", lead: "same-day" } });
  const reminders = remindersFor([kit], agenda, "2026-08-17");
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].date, "2026-08-22");
});

test("overdue and imminent tasks produce dated reminders", () => {
  const agenda = assessWeek(WEEK, []);
  const reminders = remindersFor(
    [
      task({ id: "late", dueOn: "2026-08-13" }),
      task({ id: "now", dueOn: "2026-08-17" }),
      task({ id: "tomorrow", dueOn: "2026-08-18" }),
      task({ id: "quiet", dueOn: "2026-08-23" }),
      task({ id: "finished", dueOn: "2026-08-13", done: true }),
    ],
    agenda,
    "2026-08-17",
  );

  const byId = new Map(reminders.map((r) => [r.taskId, r]));
  assert.equal(byId.get("late")!.message, "4 days late.");
  assert.equal(byId.get("now")!.message, "Due today.");
  assert.equal(byId.get("tomorrow")!.message, "Due tomorrow.");
  assert.equal(byId.has("quiet"), false, "still four days off");
  assert.equal(byId.has("finished"), false, "already done");
});

/* ---------------- fitting the week ---------------- */

const PEOPLE = ["Tom", "Priya"];

test("a busy evening takes no jobs and the next one picks them up", () => {
  // Monday is wiped out from 17:00 to 21:00.
  const agenda = assessWeek(WEEK, [
    {
      id: "e1",
      summary: "Work call",
      startsAt: "2026-08-17T17:00:00+01:00",
      endsAt: "2026-08-17T21:00:00+01:00",
    },
  ]);

  const schedule = scheduleTasks(
    [task({ id: "a", dueOn: "2026-08-17", effortMinutes: 30 })],
    agenda,
    { people: PEOPLE, today: "2026-08-17" },
  );

  const monday = schedule.days.find((d) => d.date === "2026-08-17")!;
  assert.equal(monday.placed.length, 0);
  assert.equal(monday.remainingByPerson.Tom, 0);

  const placed = schedule.days.flatMap((d) => d.placed);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].date, "2026-08-18");
  assert.equal(placed[0].late, true, "it went in after it was due");
});

test("cooking comes out of one person's evening, not everyone's", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks([], agenda, {
    people: PEOPLE,
    today: "2026-08-17",
    mealMinutes: { "2026-08-17": 45 },
  });

  const monday = schedule.days.find((d) => d.date === "2026-08-17")!;
  assert.equal(monday.cook!.minutes, 45);
  const cook = monday.cook!.person;
  const other = PEOPLE.find((p) => p !== cook)!;
  assert.equal(
    monday.remainingByPerson[other] - monday.remainingByPerson[cook],
    45,
    "only the cook pays for dinner",
  );
});

test("the cooking rota alternates rather than landing on one person", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks([], agenda, {
    people: PEOPLE,
    today: "2026-08-17",
    mealMinutes: Object.fromEntries(WEEK.map((d) => [d, 40])),
  });

  const cooks = schedule.days.map((d) => d.cook!.person);
  assert.equal(cooks.length, 7);
  for (const person of PEOPLE) {
    assert.ok(
      cooks.filter((c) => c === person).length >= 3,
      `${person} cooks ${cooks.filter((c) => c === person).length} nights of 7`,
    );
  }
});

test("unassigned work goes to whoever has the most evening left", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks(
    [
      task({ id: "big", assignee: "Tom", dueOn: "2026-08-17", effortMinutes: 60 }),
      task({ id: "spare", dueOn: "2026-08-17", effortMinutes: 30 }),
    ],
    agenda,
    { people: PEOPLE, today: "2026-08-17" },
  );

  const monday = schedule.days.find((d) => d.date === "2026-08-17")!;
  const spare = monday.placed.find((p) => p.taskId === "spare")!;
  assert.equal(spare.assignee, "Priya", "Tom is already loaded up");
});

test("an assigned job waits for its person rather than being handed over", () => {
  const agenda = assessWeek(WEEK, [
    {
      id: "e1",
      summary: "Tom is out",
      startsAt: "2026-08-17T17:00:00+01:00",
      endsAt: "2026-08-17T21:00:00+01:00",
    },
  ]);
  // The evening is gone for both of them here, so the only thing being tested
  // is that Priya's name never appears on Tom's job.
  const schedule = scheduleTasks(
    [task({ id: "a", assignee: "Tom", dueOn: "2026-08-18", effortMinutes: 30 })],
    agenda,
    { people: PEOPLE, today: "2026-08-17" },
  );
  const placed = schedule.days.flatMap((d) => d.placed);
  assert.equal(placed[0].assignee, "Tom");
});

test("jobs are not pulled forward past their lead time", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks(
    [task({ id: "hoover", dueOn: "2026-08-22", effortMinutes: 25 })],
    agenda,
    { people: PEOPLE, today: "2026-08-17", leadDays: 2 },
  );
  const placed = schedule.days.flatMap((d) => d.placed);
  assert.equal(placed[0].date, "2026-08-20", "two days before, and no earlier");
  assert.equal(placed[0].late, false);
});

test("undated work fills what is left and never counts as late", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks(
    [task({ id: "loft", effortMinutes: 90 })],
    agenda,
    { people: PEOPLE, today: "2026-08-17" },
  );
  const placed = schedule.days.flatMap((d) => d.placed);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].opportunistic, true);
  assert.equal(placed[0].late, false);
  // 90 minutes does not fit inside a weekday ceiling of 75, so it waits for
  // Saturday — which is exactly the answer a person would give.
  assert.equal(placed[0].date, "2026-08-22");
});

test("work that cannot fit anywhere is said out loud", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks(
    [task({ id: "epic", dueOn: "2026-08-18", effortMinutes: 400 })],
    agenda,
    { people: PEOPLE, today: "2026-08-17" },
  );
  assert.equal(schedule.unplaced.length, 1);
  assert.equal(schedule.unplaced[0].taskId, "epic");
  assert.equal(schedule.unplacedMinutes, 400);
  assert.match(schedule.unplaced[0].reason, /400 free minutes/);
});

test("an undated job that will not fit waits quietly instead of raising an alarm", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks(
    [task({ id: "epic", effortMinutes: 400 })],
    agenda,
    { people: PEOPLE, today: "2026-08-17" },
  );
  assert.deepEqual(schedule.unplaced, []);
  assert.equal(schedule.unplacedMinutes, 0);
  assert.equal(schedule.placedMinutes, 0);
});

test("the past is not scheduled", () => {
  const agenda = assessWeek(WEEK, []);
  const schedule = scheduleTasks([], agenda, {
    people: PEOPLE,
    today: "2026-08-20",
  });
  assert.deepEqual(
    schedule.days.map((d) => d.date),
    ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23"],
  );
});

test("event-anchored tasks are reminders, not scheduled work", () => {
  const agenda = assessWeek(WEEK, [swimming]);
  const schedule = scheduleTasks(
    [task({ id: "kit", beforeEvent: { match: "swim", lead: "evening-before" } })],
    agenda,
    { people: PEOPLE, today: "2026-08-17" },
  );
  assert.equal(schedule.days.flatMap((d) => d.placed).length, 0);
});

test("the whole demo week fits, and the totals add up", () => {
  const agenda = assessWeek(WEEK, [swimming]);
  const schedule = scheduleTasks(
    [
      task({ id: "a", dueOn: "2026-08-18", effortMinutes: 5 }),
      task({ id: "b", dueOn: "2026-08-19", effortMinutes: 20 }),
      task({ id: "c", dueOn: "2026-08-12", effortMinutes: 30 }),
      task({ id: "d", dueOn: "2026-08-22", effortMinutes: 25 }),
      task({ id: "e", effortMinutes: 90 }),
    ],
    agenda,
    {
      people: PEOPLE,
      today: "2026-08-17",
      mealMinutes: { "2026-08-17": 45, "2026-08-22": 60 },
    },
  );

  const placed = schedule.days.flatMap((d) => d.placed);
  assert.equal(placed.length, 5, "everything found a home");
  assert.equal(schedule.placedMinutes, 170);
  assert.deepEqual(schedule.unplaced, []);

  // Nobody is ever committed to more time than they have.
  for (const day of schedule.days) {
    for (const person of PEOPLE) {
      assert.ok(
        day.remainingByPerson[person] >= 0,
        `${person} is over-committed on ${day.date}`,
      );
    }
  }
});
