/**
 * Who is at the table, who is cooking, and how long they have.
 *
 * This is the grid the family actually reviews on a Sunday evening, and it is
 * the join between three things that used to be guesses:
 *
 *   - Portions were a fixed household total. They are now the sum of whoever
 *     is actually in, so the Thursday one child is at a friend's house buys
 *     less food rather than the same food.
 *   - The cooking budget was a property of the *evening*. It is now a property
 *     of the *person cooking*, which is the only version that makes sense —
 *     one adult being out until eight says nothing about the other adult's
 *     ability to cook at six.
 *   - Whether anyone is free to cook at all was never asked. A day with nobody
 *     available is a real answer, and one the planner needs, because the right
 *     response is leftovers rather than a faster recipe.
 *
 * Everything here is a *proposal*. The calendar fills it in, the family
 * overrides whatever it got wrong, and an override always wins — including an
 * override that puts things back the way the calendar had them. Nothing is
 * inferred a second time on top of a human's answer.
 */

import { assessDay, dayIntervals } from "./agenda.ts";
import type { CalendarEvent } from "./agenda.ts";
import { portionFor } from "./people.ts";
import type { Person } from "./people.ts";

/** Where a cell's value came from, so the UI can show its working. */
export type CellSource = "calendar" | "assumed" | "override";

export interface Attendance {
  readonly personId: string;
  readonly name: string;
  readonly present: boolean;
  readonly portion: number;
  /** Longest unbroken stretch this person has in the cooking window. */
  readonly freeMinutes: number;
  /** Whether this person could be put down to cook at all. */
  readonly canCook: boolean;
  readonly source: CellSource;
  /** One line explaining the value, for the review screen. */
  readonly why: string;
}

export interface DaySitting {
  readonly date: string;
  readonly attendance: readonly Attendance[];
  readonly cookId: string | null;
  readonly cookName: string | null;
  /** Prep-plus-cook budget for whoever is cooking. Zero when nobody is. */
  readonly cookMinutes: number;
  readonly cookSource: CellSource;
  readonly minutesSource: CellSource;
  /** Portions the meal must produce: the sum of who is in. */
  readonly portions: number;
  readonly note: string;
}

/**
 * Human answers, keyed so they survive a fresh read of the calendar.
 *
 * Stored separately from the proposal rather than baked into it, because the
 * calendar is re-read constantly and a correction that a refresh could wipe out
 * is worse than no correction at all.
 */
export interface SittingOverrides {
  /** `date|personId` -> present. */
  readonly present?: Readonly<Record<string, boolean>>;
  /** date -> personId, or null for "nobody is cooking". */
  readonly cook?: Readonly<Record<string, string | null>>;
  /** date -> minutes the cook has. */
  readonly minutes?: Readonly<Record<string, number>>;
}

export interface SittingOptions {
  readonly timeZone?: string;
  readonly maxWeeknightMinutes?: number;
  readonly maxWeekendMinutes?: number;
  /** The slot someone has to be free for to count as eating at home. */
  readonly dinnerFrom?: string;
  readonly dinnerTo?: string;
  /** Below this there is no point calling someone the cook. */
  readonly minCookMinutes?: number;
}

const DEFAULTS = {
  timeZone: "Europe/London",
  maxWeeknightMinutes: 45,
  maxWeekendMinutes: 90,
  dinnerFrom: "18:00",
  dinnerTo: "19:30",
  minCookMinutes: 15,
};

/** All-day entries that mean somebody is not in the house at all. */
const AWAY_WORDS = [
  "away",
  "holiday",
  "trip",
  "staying at",
  "sleepover",
  "camp",
  "conference",
  "abroad",
];

/**
 * Entries that merely describe the shape of the day rather than the person's
 * whereabouts.
 *
 * "Charlton school holidays" contains the word holiday and means the exact
 * opposite of absence — the children are at home all week. Substring matching
 * on optimistic keyword lists is how these features quietly go wrong, so the
 * false positives get named rather than hoped away.
 */
const CONTEXT_WORDS = [
  "school",
  "bank holiday",
  "term",
  "inset",
  "half term",
  "public holiday",
];

/** Timed entries that mean somebody is eating somewhere else. */
const EATING_OUT_WORDS = [
  "dinner",
  "supper",
  "meal out",
  "restaurant",
  "takeaway",
  "party",
  "wedding",
  "birthday tea",
  "curry night",
  "pub",
];

const clockToMinutes = (clock: string): number => {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
};

const isWeekendDate = (iso: string): boolean => {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

/* ------------------------------------------------------------------ */

export interface DinnerVerdict {
  readonly out: boolean;
  readonly why: string;
}

/**
 * Is this person out for dinner?
 *
 * The tempting rule — "their calendar covers dinner, so they are out" — is
 * wrong, and wrong in the way that costs trust. A work call from 18:00 to
 * 20:30 blocks the whole evening while the person sits at home, hungry, in the
 * next room. Being busy means somebody cannot *cook*; it says nothing at all
 * about whether they will *eat*. Those are separate questions and this app
 * answers them separately: a full evening lands as zero free minutes, which
 * takes them off the rota, and leaves them at the table where they belong.
 *
 * So absence needs saying, not inferring: an all-day entry that puts them
 * elsewhere, or a timed entry that is plainly a meal somewhere else. Everything
 * else is "in", because being wrong that way costs one extra portion, and being
 * wrong the other way means somebody comes home to no dinner.
 */
export function outForDinner(
  date: string,
  events: readonly CalendarEvent[],
  options: SittingOptions = {},
): DinnerVerdict {
  const o = { ...DEFAULTS, ...options };

  const away = events.find((e) => {
    if (e.onDate !== date || e.startsAt) return false;
    const summary = e.summary.toLowerCase();
    if (CONTEXT_WORDS.some((w) => summary.includes(w))) return false;
    return AWAY_WORDS.some((w) => summary.includes(w));
  });
  if (away) return { out: true, why: away.summary };

  const core = {
    from: clockToMinutes(o.dinnerFrom),
    to: clockToMinutes(o.dinnerTo),
  };
  const eatingOut = dayIntervals(date, events, o.timeZone).find(
    (b) =>
      b.to > core.from &&
      b.from < core.to &&
      EATING_OUT_WORDS.some((w) => b.event.summary.toLowerCase().includes(w)),
  );
  if (eatingOut) return { out: true, why: eatingOut.event.summary };

  return { out: false, why: "" };
}

/* ------------------------------------------------------------------ */

export interface ProposeInput {
  readonly people: readonly Person[];
  readonly dates: readonly string[];
  /** Events per person id. A person with no entry simply has a clear diary. */
  readonly eventsByPerson?: Readonly<Record<string, readonly CalendarEvent[]>>;
  /** Whose calendars have actually been connected. */
  readonly connected?: readonly string[];
  readonly overrides?: SittingOverrides;
  readonly options?: SittingOptions;
}

/**
 * Build the week's grid from the calendars, then let the family's answers win.
 */
export function proposeWeek(input: ProposeInput): DaySitting[] {
  const o = { ...DEFAULTS, ...(input.options ?? {}) };
  const overrides = input.overrides ?? {};
  const eventsByPerson = input.eventsByPerson ?? {};
  // Having somebody's events *is* having their calendar. The explicit list
  // exists only to say "connected, and genuinely clear this week", which is a
  // different claim from "we have no idea".
  const connected = new Set([
    ...(input.connected ?? []),
    ...Object.keys(eventsByPerson),
  ]);

  return input.dates.map((date, dayIndex) => {
    const attendance: Attendance[] = input.people.map((person) => {
      const events = eventsByPerson[person.id] ?? [];
      const known = connected.has(person.id);
      const day = assessDay(date, events, {
        timeZone: o.timeZone,
        maxWeeknightMinutes: o.maxWeeknightMinutes,
        maxWeekendMinutes: o.maxWeekendMinutes,
      });

      const verdict = known
        ? outForDinner(date, events, o)
        : { out: false, why: "" };

      const key = `${date}|${person.id}`;
      const overridden = overrides.present?.[key];
      const present = overridden ?? !verdict.out;

      return {
        personId: person.id,
        name: person.name,
        present,
        portion: present ? portionFor(person) : 0,
        freeMinutes: day.cookingMinutes,
        canCook: person.canCook,
        source:
          overridden !== undefined ? "override" : known ? "calendar" : "assumed",
        why:
          overridden !== undefined
            ? "You said so"
            : verdict.out
              ? verdict.why
              : known
                ? day.note
                : "No calendar connected — assumed in",
      };
    });

    /* ---- who cooks ---- */
    const eligible = attendance.filter(
      (a) => a.present && a.canCook && a.freeMinutes >= o.minCookMinutes,
    );
    // Most time wins; an ordinary week is a tie, so rotate the tie-break by the
    // day to keep the same person off the hob seven nights running.
    const rotated = eligible.length
      ? [...eligible.slice(dayIndex % eligible.length), ...eligible.slice(0, dayIndex % eligible.length)]
      : [];
    const proposedCook =
      rotated.reduce<Attendance | null>(
        (best, a) => (best === null || a.freeMinutes > best.freeMinutes ? a : best),
        null,
      ) ?? null;

    const cookOverride = overrides.cook?.[date];
    const cookId =
      cookOverride !== undefined ? cookOverride : (proposedCook?.personId ?? null);
    const cook = attendance.find((a) => a.personId === cookId) ?? null;

    const ceiling = isWeekendDate(date)
      ? o.maxWeekendMinutes
      : o.maxWeeknightMinutes;
    const proposedMinutes = cook ? Math.min(ceiling, cook.freeMinutes) : 0;
    const minutesOverride = overrides.minutes?.[date];
    const cookMinutes =
      minutesOverride !== undefined ? minutesOverride : proposedMinutes;

    return {
      date,
      attendance,
      cookId: cook ? cook.personId : null,
      cookName: cook ? cook.name : null,
      cookMinutes,
      cookSource: cookOverride !== undefined ? "override" : cook ? cook.source : "assumed",
      minutesSource:
        minutesOverride !== undefined ? "override" : cook ? cook.source : "assumed",
      portions: round(attendance.reduce((sum, a) => sum + a.portion, 0)),
      note: describe(attendance, cook, cookMinutes),
    };
  });
}

const round = (n: number): number => Math.round(n * 100) / 100;

function describe(
  attendance: readonly Attendance[],
  cook: Attendance | null,
  cookMinutes: number,
): string {
  const out = attendance.filter((a) => !a.present);
  const bits: string[] = [];

  if (out.length === attendance.length) return "Nobody in for dinner.";
  if (out.length) {
    bits.push(`${out.map((a) => a.name).join(" and ")} out`);
  }
  bits.push(
    cook
      ? `${cook.name} cooking, ${cookMinutes} min`
      : "nobody free to cook — plan leftovers or something from the freezer",
  );
  return `${bits.join("; ")}.`;
}

/* ------------------------------------------------------------------ */

/** Days worth asking the model to fill. A day with nobody in is not one. */
export function slotsFromWeek(
  week: readonly DaySitting[],
  slot = "dinner",
): { date: string; slot: string }[] {
  return week
    .filter((day) => day.portions > 0)
    .map((day) => ({ date: day.date, slot }));
}

/** Compact per-day lines for the model prompt. */
export function weekForPrompt(week: readonly DaySitting[]): string[] {
  return week.map((day) => {
    const inFor = day.attendance.filter((a) => a.present).map((a) => a.name);
    const away = day.attendance.filter((a) => !a.present).map((a) => a.name);

    const bits = [
      `${day.portions} portions (${inFor.join(", ") || "nobody"})`,
      away.length ? `away: ${away.join(", ")}` : "",
      day.cookName
        ? `${day.cookName} cooks, ${day.cookMinutes} min for prep and cook`
        : "NOBODY CAN COOK — this must be leftovers, the freezer, or something assembled cold",
    ].filter(Boolean);

    return `- ${day.date}: ${bits.join("; ")}`;
  });
}

/** Has the family looked at and accepted this week yet? */
export function isReviewed(
  week: readonly DaySitting[],
  confirmedFor: string | null,
): boolean {
  return confirmedFor !== null && confirmedFor === (week[0]?.date ?? null);
}
