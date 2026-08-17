import { test } from "node:test";
import assert from "node:assert/strict";

import { validatePlan } from "../src/validate.ts";
import { proposeWeek } from "../src/domain/sitting.ts";
import { makePerson } from "../src/domain/people.ts";
import { CONSTRAINTS, GOOD_PLAN } from "../src/demo-data.ts";
import type { MealPlan } from "../src/domain/types.ts";

const PEOPLE = [
  makePerson({ name: "Tom", ageBracket: "adult" }),
  makePerson({ name: "Priya", ageBracket: "adult" }),
  makePerson({ name: "Aria", ageBracket: "child", excludes: ["nuts"] }),
  makePerson({ name: "Noor", ageBracket: "child" }),
];

const DATES = ["2026-08-17", "2026-08-18"];

const planWith = (meals: MealPlan["meals"]): MealPlan => ({
  weekStarting: "2026-08-17",
  recipes: GOOD_PLAN.recipes,
  meals,
});

const codes = (plan: MealPlan, week: ReturnType<typeof proposeWeek>) =>
  validatePlan(
    plan,
    { ...CONSTRAINTS, people: PEOPLE, week },
    week.map((d) => ({ date: d.date, slot: "dinner" })),
  ).violations.map((v) => v.code);

test("servings are checked against who is actually in that day", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: DATES,
    eventsByPerson: {
      aria: [{ id: "a", summary: "Staying at Grandma's", onDate: "2026-08-18" }],
      noor: [{ id: "n", summary: "Sleepover at Ellie's", onDate: "2026-08-18" }],
    },
    connected: ["aria", "noor"],
  });

  // Tuesday needs 2 portions, not 3.2, because both children are away.
  assert.equal(week[1].portions, 2);

  const plan = planWith([
    { date: "2026-08-17", slot: "dinner", recipeId: "sticky-chicken-traybake", servings: 3.2 },
    { date: "2026-08-18", slot: "dinner", recipeId: "salmon-new-potatoes", servings: 2 },
  ]);
  assert.deepEqual(codes(plan, week), []);
});

test("a meal too small for the people present is caught, and names them", () => {
  const week = proposeWeek({ people: PEOPLE, dates: DATES });
  const plan = planWith([
    { date: "2026-08-17", slot: "dinner", recipeId: "sticky-chicken-traybake", servings: 2 },
    { date: "2026-08-18", slot: "dinner", recipeId: "salmon-new-potatoes", servings: 3.2 },
  ]);

  const result = validatePlan(
    plan,
    { ...CONSTRAINTS, people: PEOPLE, week },
    week.map((d) => ({ date: d.date, slot: "dinner" })),
  );
  const violation = result.violations.find((v) => v.code === "under-portioned")!;
  assert.ok(violation, "should be short");
  assert.match(violation.message, /3\.2 portions are needed/);
  assert.match(violation.message, /Tom, Priya, Aria, Noor/);
});

test("the cook's time is the limit, and the message names the cook", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: DATES,
    eventsByPerson: {
      // Tom's evening is gone entirely, so he is not eligible to cook.
      tom: [
        { id: "t", summary: "Late meeting", startsAt: "2026-08-17T17:00:00+01:00", endsAt: "2026-08-17T20:30:00+01:00" },
      ],
      // Priya has one 30-minute gap between the school run and bath time.
      priya: [
        { id: "p1", summary: "Pick-up run", startsAt: "2026-08-17T17:00:00+01:00", endsAt: "2026-08-17T18:30:00+01:00" },
        { id: "p2", summary: "Bath and bed", startsAt: "2026-08-17T19:00:00+01:00", endsAt: "2026-08-17T20:30:00+01:00" },
      ],
    },
    connected: ["tom", "priya"],
  });

  assert.equal(week[0].cookName, "Priya");
  assert.equal(week[0].cookMinutes, 30);

  const plan = planWith([
    { date: "2026-08-17", slot: "dinner", recipeId: "chicken-korma", servings: 3.2 },
    { date: "2026-08-18", slot: "dinner", recipeId: "salmon-new-potatoes", servings: 3.2 },
  ]);

  const result = validatePlan(
    plan,
    { ...CONSTRAINTS, people: PEOPLE, week },
    week.map((d) => ({ date: d.date, slot: "dinner" })),
  );
  const violation = result.violations.find((v) => v.code === "too-slow-for-the-day")!;
  assert.ok(violation, "the korma takes 60 minutes");
  assert.match(violation.message, /Priya only has 30 min/);
});

test("an evening with nobody free to cook rejects a cooked meal outright", () => {
  const week = proposeWeek({
    people: PEOPLE,
    dates: DATES,
    eventsByPerson: {
      tom: [
        { id: "t", summary: "Work", startsAt: "2026-08-17T17:00:00+01:00", endsAt: "2026-08-17T21:00:00+01:00" },
      ],
      priya: [
        { id: "p", summary: "Work", startsAt: "2026-08-17T17:00:00+01:00", endsAt: "2026-08-17T21:00:00+01:00" },
      ],
    },
    connected: ["tom", "priya"],
  });
  assert.equal(week[0].cookId, null);

  const plan = planWith([
    { date: "2026-08-17", slot: "dinner", recipeId: "sticky-chicken-traybake", servings: 3.2 },
    { date: "2026-08-18", slot: "dinner", recipeId: "salmon-new-potatoes", servings: 3.2 },
  ]);

  const result = validatePlan(
    plan,
    { ...CONSTRAINTS, people: PEOPLE, week },
    week.map((d) => ({ date: d.date, slot: "dinner" })),
  );
  const violation = result.violations.find((v) => v.code === "nobody-to-cook")!;
  assert.ok(violation);
  assert.match(violation.message, /nobody is free to cook/);
  // And it does not also complain about the speed — one problem, one message.
  assert.equal(
    result.violations.some((v) => v.code === "too-slow-for-the-day"),
    false,
  );

  // Leftovers on that evening are fine.
  const withLeftovers = planWith([
    { date: "2026-08-17", slot: "dinner", recipeId: "salmon-new-potatoes", servings: 3.2, leftoverOf: "2026-08-16" },
    { date: "2026-08-18", slot: "dinner", recipeId: "salmon-new-potatoes", servings: 3.2 },
  ]);
  assert.equal(
    validatePlan(
      withLeftovers,
      { ...CONSTRAINTS, people: PEOPLE, week },
      week.map((d) => ({ date: d.date, slot: "dinner" })),
    ).violations.some((v) => v.code === "nobody-to-cook"),
    false,
  );
});

test("an allergy still applies on a night that person is out", () => {
  // Tuesday's dinner is Thursday's leftovers, and the fridge does not know
  // who was at the table when it was cooked.
  const week = proposeWeek({
    people: PEOPLE,
    dates: DATES,
    eventsByPerson: {
      aria: [{ id: "a", summary: "Staying at Grandma's", onDate: "2026-08-18" }],
    },
    connected: ["aria"],
  });
  assert.equal(
    week[1].attendance.find((a) => a.personId === "aria")!.present,
    false,
  );

  const satay = {
    id: "satay",
    title: "Peanut satay noodles",
    serves: 4,
    prepMinutes: 5,
    cookMinutes: 10,
    protein: "chicken",
    lines: [{ ingredientId: "peanut-butter", amount: 90, unit: "g" as const }],
    steps: ["Toss together."],
  };

  const plan: MealPlan = {
    weekStarting: "2026-08-17",
    recipes: [...GOOD_PLAN.recipes, satay],
    meals: [
      { date: "2026-08-17", slot: "dinner", recipeId: "sticky-chicken-traybake", servings: 3.2 },
      { date: "2026-08-18", slot: "dinner", recipeId: "satay", servings: 2.6 },
    ],
  };

  const result = validatePlan(
    plan,
    { ...CONSTRAINTS, people: PEOPLE, week },
    week.map((d) => ({ date: d.date, slot: "dinner" })),
  );
  const violation = result.violations.find((v) => v.code === "diet-conflict")!;
  assert.ok(violation, "the allergy does not take the night off");
  assert.match(violation.message, /Aria cannot eat/);
});

test("with no week set up the blanket rules still apply", () => {
  const plan = planWith([
    { date: "2026-08-17", slot: "dinner", recipeId: "sticky-chicken-traybake", servings: 3.2 },
  ]);
  const result = validatePlan(
    plan,
    { ...CONSTRAINTS, people: PEOPLE },
    [{ date: "2026-08-17", slot: "dinner" }],
  );
  assert.deepEqual(result.violations, []);
});
