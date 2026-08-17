/**
 * Tasks, chores and reminders.
 *
 * A to-do list is easy. What makes a *family* to-do list get abandoned is
 * always one of three things, and this module exists to handle those three:
 *
 *   1. Recurrence gets it wrong. The bins go out on a Tuesday whether or not
 *      you managed it last week; the bedsheets are due two weeks after you
 *      last actually changed them, not two weeks after some notional date you
 *      missed. Apps that use one rule for both are the reason people stop
 *      trusting the little red badge. See `Anchor`.
 *
 *   2. It nags without looking at the week. Twelve jobs land on a Thursday
 *      that already has swimming in it, so all twelve get dismissed together
 *      and the good ones go down with the bad. Here the calendar is a first
 *      class input: every evening has a real number of free minutes and the
 *      jobs are laid into it until it is full. Anything that will not fit is
 *      said out loud rather than quietly rolled to tomorrow.
 *
 *   3. One person ends up holding everything. Unassigned jobs go to whoever
 *      has the most room left that evening, so a full Tuesday for one adult
 *      does not become a full Tuesday for both.
 *
 * All dates are plain YYYY-MM-DD and all arithmetic is anchored at midday UTC,
 * which keeps a clock change from ever moving a date by one.
 */

import type { CalendarEvent, DayAgenda } from "./agenda.ts";

export type TaskCategory =
  | "household"
  | "admin"
  | "kids"
  | "errand"
  | "self";

export type RecurrenceUnit = "day" | "week" | "month";

/**
 * What the next occurrence is measured from.
 *
 * `schedule` — the world sets the date. Bin day is Tuesday. Doing it late on
 * Wednesday does not move next week's collection.
 *
 * `completion` — the clock starts when you finish. Change the sheets every two
 * weeks; if you did it four days late, the next one is two weeks from *then*,
 * because the sheets do not know what the calendar said.
 */
export type Anchor = "schedule" | "completion";

export interface Recurrence {
  readonly every: number;
  readonly unit: RecurrenceUnit;
  /** Weekly only: which days, 0 = Sunday. */
  readonly weekdays?: readonly number[];
  readonly anchor: Anchor;
}

/** A reminder pinned to whatever the calendar says, rather than to a date. */
export interface EventTrigger {
  /** Case-insensitive substring of the event title. */
  readonly match: string;
  readonly lead: "evening-before" | "same-day";
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly category: TaskCategory;
  /** A household member's name, or absent for "whoever has room". */
  readonly assignee?: string;
  readonly dueOn?: string;
  readonly effortMinutes: number;
  readonly recurrence?: Recurrence;
  readonly beforeEvent?: EventTrigger;
  readonly lastCompletedOn?: string;
  readonly notes?: string;
  /** One-off tasks that are finished. Recurring ones are never done. */
  readonly done?: boolean;
}

/* ---------------- dates ---------------- */

const DAY_MS = 86_400_000;

/** Midday UTC, so a British clock change can never shift the date. */
function asInstant(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIso(new Date(asInstant(iso).getTime() + days * DAY_MS));
}

/**
 * Add months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. Getting this wrong is
 * how a monthly task slowly walks forward through the calendar.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = m - 1 + months;
  const year = y + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((asInstant(to).getTime() - asInstant(from).getTime()) / DAY_MS);
}

export function weekdayOf(iso: string): number {
  return asInstant(iso).getUTCDay();
}

const maxIso = (a: string, b: string): string => (a > b ? a : b);

function isWeekendIso(iso: string): boolean {
  const day = weekdayOf(iso);
  return day === 0 || day === 6;
}

/* ---------------- recurrence ---------------- */

/** The first occurrence strictly after `from`. */
export function nextOccurrence(rec: Recurrence, from: string): string {
  const every = Math.max(1, Math.round(rec.every));

  if (rec.unit === "day") return addDays(from, every);
  if (rec.unit === "month") return addMonths(from, every);
  if (!rec.weekdays?.length) return addDays(from, every * 7);

  // "Every other Tuesday" means the next Tuesday that is at least a whole
  // interval away — so a fortnightly job skips the Tuesday in between.
  const minGap = every === 1 ? 1 : (every - 1) * 7 + 1;
  const wanted = new Set(rec.weekdays);
  for (let step = 1; step <= every * 7 + 7; step++) {
    const candidate = addDays(from, step);
    if (step >= minGap && wanted.has(weekdayOf(candidate))) return candidate;
  }
  return addDays(from, every * 7);
}

/**
 * Mark a task done and produce whatever comes next.
 *
 * A one-off task is simply finished. A recurring one is never finished — it
 * moves, and where it moves to is the whole point of `Anchor`.
 */
export function completeTask(task: Task, onDate: string): Task {
  if (!task.recurrence) {
    return { ...task, done: true, lastCompletedOn: onDate };
  }

  if (task.recurrence.anchor === "completion") {
    return {
      ...task,
      lastCompletedOn: onDate,
      dueOn: nextOccurrence(task.recurrence, onDate),
    };
  }

  // Schedule-anchored: keep stepping the fixed schedule until it is in front
  // of us again, so finishing a job late does not immediately show it as due.
  let next = nextOccurrence(task.recurrence, task.dueOn ?? onDate);
  while (next <= onDate) next = nextOccurrence(task.recurrence, next);
  return { ...task, lastCompletedOn: onDate, dueOn: next };
}

/**
 * Drop the occurrences nobody did.
 *
 * If the bins were missed three weeks running, the useful thing to show is
 * "due last Tuesday", not "due 21 days ago" — the older ones are gone and no
 * amount of red text brings that Tuesday back. Only fixed schedules roll;
 * a completion-anchored job that is a month late really is a month late.
 */
export function rollForward(task: Task, today: string): Task {
  const rec = task.recurrence;
  if (!rec || rec.anchor !== "schedule" || !task.dueOn) return task;

  let dueOn = task.dueOn;
  let guard = 0;
  while (guard++ < 400) {
    const next = nextOccurrence(rec, dueOn);
    if (next > today) break;
    dueOn = next;
  }
  return dueOn === task.dueOn ? task : { ...task, dueOn };
}

/* ---------------- status ---------------- */

export type TaskStatus = "done" | "overdue" | "today" | "soon" | "later" | "someday";

export function statusOf(task: Task, today: string): TaskStatus {
  if (task.done) return "done";
  if (!task.dueOn) return "someday";
  const days = daysBetween(today, task.dueOn);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 2) return "soon";
  return "later";
}

/* ---------------- reminders ---------------- */

export type ReminderKind = "overdue" | "due" | "before-event";

export interface Reminder {
  readonly taskId: string;
  readonly title: string;
  /** The day the reminder should surface. */
  readonly date: string;
  readonly kind: ReminderKind;
  readonly message: string;
  readonly assignee?: string;
}

function matchingEvents(day: DayAgenda, match: string): CalendarEvent[] {
  const needle = match.toLowerCase();
  return [...day.events, ...day.allDay].filter((e) =>
    e.summary.toLowerCase().includes(needle),
  );
}

function dayName(iso: string): string {
  return asInstant(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    timeZone: "UTC",
  });
}

/**
 * What to say, and when to say it.
 *
 * Event-anchored reminders are the ones worth having. "Pack the swimming kit"
 * is useless as a weekly repeat — the week swimming is cancelled it is noise,
 * and noise is what teaches people to swipe reminders away without reading
 * them. Pinned to the actual calendar entry it only ever fires when it is true.
 */
export function remindersFor(
  tasks: readonly Task[],
  days: readonly DayAgenda[],
  today: string,
): Reminder[] {
  const out: Reminder[] = [];

  for (const task of tasks) {
    if (task.done) continue;

    if (task.beforeEvent) {
      for (const day of days) {
        if (matchingEvents(day, task.beforeEvent.match).length === 0) continue;
        const date =
          task.beforeEvent.lead === "evening-before"
            ? addDays(day.date, -1)
            : day.date;
        if (date < today) continue;
        out.push({
          taskId: task.id,
          title: task.title,
          date,
          kind: "before-event",
          assignee: task.assignee,
          message:
            task.beforeEvent.lead === "evening-before"
              ? `${dayName(day.date)} is ${matchingEvents(day, task.beforeEvent.match)[0].summary} — do this tonight.`
              : `${matchingEvents(day, task.beforeEvent.match)[0].summary} today.`,
        });
      }
      continue;
    }

    if (!task.dueOn) continue;
    const days_ = daysBetween(today, task.dueOn);
    if (days_ < 0) {
      out.push({
        taskId: task.id,
        title: task.title,
        date: today,
        kind: "overdue",
        assignee: task.assignee,
        message: `${-days_} day${days_ === -1 ? "" : "s"} late.`,
      });
    } else if (days_ <= 1) {
      out.push({
        taskId: task.id,
        title: task.title,
        date: task.dueOn,
        kind: "due",
        assignee: task.assignee,
        message: days_ === 0 ? "Due today." : "Due tomorrow.",
      });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------------- fitting jobs into the week ---------------- */

export interface Placement {
  readonly taskId: string;
  readonly title: string;
  readonly category: TaskCategory;
  readonly date: string;
  readonly assignee: string;
  readonly effortMinutes: number;
  /** True when the only room left was after the task was due. */
  readonly late: boolean;
  /** True when this had no due date and simply filled a gap. */
  readonly opportunistic: boolean;
}

export interface DayLoad {
  readonly date: string;
  /** Minutes each person has left after cooking and the jobs below. */
  readonly remainingByPerson: Readonly<Record<string, number>>;
  readonly placed: readonly Placement[];
  readonly committedMinutes: number;
  /** Who is down to cook, and for how long. */
  readonly cook: { readonly person: string; readonly minutes: number } | null;
}

export interface Unplaced {
  readonly taskId: string;
  readonly title: string;
  readonly reason: string;
}

export interface TaskSchedule {
  readonly days: readonly DayLoad[];
  readonly unplaced: readonly Unplaced[];
  /** Minutes of work that found a home, and minutes that did not. */
  readonly placedMinutes: number;
  readonly unplacedMinutes: number;
}

export interface ScheduleOptions {
  readonly people: readonly string[];
  /** Minutes of cooking per date, from the meal plan. */
  readonly mealMinutes?: Readonly<Record<string, number>>;
  readonly today: string;
  /**
   * How far ahead of its due date a job may be pulled forward.
   *
   * Without this the scheduler cheerfully puts Saturday's hoovering on Monday,
   * because Monday had room. Nobody does that, and a plan nobody would follow
   * is not a plan.
   */
  readonly leadDays?: number;
  /** A realistic ceiling on jobs per person per day, free time notwithstanding. */
  readonly maxPerDayMinutes?: number;
  readonly maxPerWeekendDayMinutes?: number;
}

const SCHEDULE_DEFAULTS = {
  leadDays: 2,
  maxPerDayMinutes: 75,
  maxPerWeekendDayMinutes: 180,
};

/**
 * Lay this week's jobs into the evenings the calendar actually leaves.
 *
 * Deliberately a greedy pass rather than anything clever. The schedule is a
 * suggestion a person will overrule within seconds, so being explainable —
 * "Tuesday was full, so it went to Wednesday" — is worth more than being
 * optimal. It also means the answer never changes for reasons nobody can see.
 */
export function scheduleTasks(
  tasks: readonly Task[],
  days: readonly DayAgenda[],
  options: ScheduleOptions,
): TaskSchedule {
  const o = { ...SCHEDULE_DEFAULTS, ...options };
  const people = options.people.length ? [...options.people] : ["anyone"];
  const mealMinutes = options.mealMinutes ?? {};

  const horizon = days.filter((d) => d.date >= options.today);
  const remaining = new Map<string, Map<string, number>>();
  const placedByDate = new Map<string, Placement[]>();
  const cookByDate = new Map<string, { person: string; minutes: number }>();

  for (const day of horizon) {
    const ceiling = isWeekendIso(day.date)
      ? o.maxPerWeekendDayMinutes
      : o.maxPerDayMinutes;
    const budget = Math.min(day.choreMinutes, ceiling);
    const budgets = new Map(people.map((p) => [p, budget]));

    // Somebody has to cook, and it comes out of one person's evening rather
    // than everyone's — two adults in a kitchen is not two dinners.
    const minutes = mealMinutes[day.date] ?? 0;
    if (minutes > 0) {
      // Whoever has the most evening cooks — but on an ordinary week everyone
      // has the same evening, and a straight "first name wins" would put the
      // same person at the hob seven nights running. Rotating the tie-break by
      // the day makes the default fair instead of alphabetical.
      const offset = Math.abs(daysBetween(options.today, day.date)) % people.length;
      const rota = [...people.slice(offset), ...people.slice(0, offset)];
      const cook = rota.reduce((a, b) =>
        (budgets.get(b) ?? 0) > (budgets.get(a) ?? 0) ? b : a,
      );
      budgets.set(cook, Math.max(0, (budgets.get(cook) ?? 0) - minutes));
      cookByDate.set(day.date, { person: cook, minutes });
    }

    remaining.set(day.date, budgets);
    placedByDate.set(day.date, []);
  }

  const live = tasks.filter((t) => !t.done && !t.beforeEvent);
  // Dated work first, most urgent first; the undated backlog fills what is
  // left over, which is what makes a quiet Sunday useful rather than empty.
  const dated = live
    .filter((t) => t.dueOn)
    .sort(
      (a, b) =>
        a.dueOn!.localeCompare(b.dueOn!) || b.effortMinutes - a.effortMinutes,
    );
  const undated = live
    .filter((t) => !t.dueOn)
    .sort((a, b) => b.effortMinutes - a.effortMinutes);

  const unplaced: Unplaced[] = [];
  let placedMinutes = 0;
  let unplacedMinutes = 0;

  const place = (task: Task, opportunistic: boolean): void => {
    // Overdue work starts today; work due later is not pulled forward past
    // its lead time, because nobody hoovers on Monday for a Saturday job.
    const earliest =
      task.dueOn && task.dueOn > options.today
        ? maxIso(options.today, addDays(task.dueOn, -o.leadDays))
        : options.today;

    for (const day of horizon) {
      if (day.date < earliest) continue;
      const budgets = remaining.get(day.date)!;
      // An unassigned job goes to whoever has the most evening left.
      const candidates = task.assignee
        ? [task.assignee]
        : [...people].sort((a, b) => (budgets.get(b) ?? 0) - (budgets.get(a) ?? 0));

      for (const person of candidates) {
        const left = budgets.get(person) ?? 0;
        if (left < task.effortMinutes) continue;
        budgets.set(person, left - task.effortMinutes);
        placedByDate.get(day.date)!.push({
          taskId: task.id,
          title: task.title,
          category: task.category,
          date: day.date,
          assignee: person,
          effortMinutes: task.effortMinutes,
          late: Boolean(task.dueOn && day.date > task.dueOn),
          opportunistic,
        });
        placedMinutes += task.effortMinutes;
        return;
      }
    }

    unplacedMinutes += task.effortMinutes;
    unplaced.push({
      taskId: task.id,
      title: task.title,
      reason: task.assignee
        ? `No evening this week leaves ${task.assignee} ${task.effortMinutes} free minutes.`
        : `No evening this week has ${task.effortMinutes} free minutes.`,
    });
  };

  for (const task of dated) place(task, false);
  // The backlog is optional, so a full week simply means it waits.
  for (const task of undated) {
    const before = unplaced.length;
    place(task, true);
    if (unplaced.length > before) {
      unplaced.pop();
      unplacedMinutes -= task.effortMinutes;
    }
  }

  return {
    days: horizon.map((day) => {
      const budgets = remaining.get(day.date)!;
      const placed = placedByDate.get(day.date)!;
      return {
        date: day.date,
        remainingByPerson: Object.fromEntries(budgets),
        placed,
        committedMinutes: placed.reduce((s, p) => s + p.effortMinutes, 0),
        cook: cookByDate.get(day.date) ?? null,
      };
    }),
    unplaced,
    placedMinutes,
    unplacedMinutes,
  };
}
