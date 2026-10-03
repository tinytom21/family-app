/**
 * Which seven days the plan is actually for.
 *
 * The fixtures are pinned to a week in August 2026 so the tests can assert real
 * numbers against a real calendar. That is right for a fixture and wrong for a
 * household: a family setting the app up in September wants September, and a
 * plan whose dates are all in the past fails in ways that look like unrelated
 * bugs — the calendar fetches nothing, every job reads as overdue, and the
 * scheduler places none of them because it will not schedule the past.
 *
 * So the example household keeps the fixture week, and a real one gets the week
 * in front of it. Everything here is pure and takes "today" as an argument,
 * which is what keeps the tests deterministic while the app moves with the
 * clock.
 */

import { addDays } from "./tasks.ts";
import type { MealPlan } from "./types.ts";

/** Today, in the household's zone rather than the server's. */
export function todayIn(timeZone = "Europe/London", now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Planning starts tomorrow.
 *
 * Not "next Monday": somebody who sets this up on a Wednesday wants a plan for
 * Thursday onwards, not a five-day wait. Tonight's dinner is already decided by
 * the time anyone is filling in a form about it.
 */
export function nextWeekStart(today: string): string {
  return addDays(today, 1);
}

/** 0 = Sunday … 6 = Saturday, read off the date itself rather than any clock. */
export function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * The next week, for a family whose weeks begin on `weekday`.
 *
 * Strictly after today, because tonight's dinner is decided by the time
 * anybody is filling in a plan. "Tomorrow" was the old answer and it was
 * wrong for nearly everyone: people shop for a week that starts on a
 * particular day, and a plan that starts on a Sunday because the app was
 * opened on a Saturday is a plan that has to be moved before it is used.
 */
export function nextStartOn(today: string, weekday = 1): string {
  const ahead = (weekday - weekdayIndex(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}

export function weekDates(start: string, days = 7): string[] {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

/**
 * Move a plan onto a different week, keeping its shape.
 *
 * The starter plan is a fixture with a Tuesday batch cook that Thursday eats,
 * so the leftover links are dates pointing at other dates. Shifting the meals
 * without remapping those would leave Thursday claiming leftovers from a day
 * that is no longer in the plan, and the shopping list would quietly buy the
 * ingredients twice.
 */
export function redatePlan(plan: MealPlan, newStart: string): MealPlan {
  const oldDates = [...new Set(plan.meals.map((m) => m.date))].sort();
  const mapping = new Map(
    oldDates.map((date, index) => [date, addDays(newStart, index)]),
  );

  return {
    ...plan,
    weekStarting: newStart,
    meals: plan.meals.map((meal) => ({
      ...meal,
      date: mapping.get(meal.date) ?? meal.date,
      ...(meal.leftoverOf
        ? { leftoverOf: mapping.get(meal.leftoverOf) ?? meal.leftoverOf }
        : {}),
    })),
  };
}
