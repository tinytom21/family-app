/**
 * What the family's calendar means for cooking.
 *
 * The blanket rule — "45 minutes on a weeknight" — is a guess standing in for
 * information we can now actually have. Some Tuesdays are wide open and some
 * have a swimming lesson wedged through the middle of dinner, and treating
 * those the same is exactly the sort of thing that makes a meal plan get
 * ignored by week three.
 *
 * The model here is deliberately simple and explainable: find the longest
 * uninterrupted stretch inside the evening cooking window, and let that be the
 * day's time budget. A user should be able to look at any number this produces
 * and see immediately where it came from.
 */

export interface CalendarEvent {
  readonly id: string;
  readonly summary: string;
  /** ISO datetime for timed events. */
  readonly startsAt?: string;
  readonly endsAt?: string;
  /** YYYY-MM-DD for all-day events, which take no evening time. */
  readonly onDate?: string;
}

export type Availability = "clear" | "tight" | "out";

export interface DayAgenda {
  readonly date: string;
  /** Events touching the cooking window, in order. */
  readonly events: readonly CalendarEvent[];
  /** All-day entries — context, not a time cost. */
  readonly allDay: readonly CalendarEvent[];
  /** Longest uninterrupted stretch in the window, in minutes. */
  readonly freeMinutes: number;
  /** Cooking budget for the day: the free stretch, capped by the usual limit. */
  readonly cookingMinutes: number;
  /**
   * Total uncommitted minutes in the wider chore window.
   *
   * Deliberately a different measure from `freeMinutes`. Cooking needs one
   * unbroken run — you cannot stop halfway through a risotto — so it gets the
   * longest stretch. Jobs are not like that: ten minutes before the school run
   * and ten minutes after is twenty minutes of emptying the dishwasher.
   */
  readonly choreMinutes: number;
  readonly availability: Availability;
  /** One line explaining the number, for the user and for the model. */
  readonly note: string;
}

export interface AgendaOptions {
  /** Wall-clock window in which cooking and eating realistically happen. */
  readonly windowStart?: string; // "17:00"
  readonly windowEnd?: string; // "20:30"
  readonly timeZone?: string;
  /** Usual ceilings, which the calendar can lower but never raise. */
  readonly maxWeeknightMinutes?: number;
  readonly maxWeekendMinutes?: number;
  /** Below this, an evening counts as effectively lost. */
  readonly outBelowMinutes?: number;
  /** Wider window in which jobs, as opposed to cooking, can happen. */
  readonly choreStart?: string;
  readonly choreEnd?: string;
  readonly weekendChoreStart?: string;
  readonly weekendChoreEnd?: string;
}

const DEFAULTS = {
  windowStart: "17:00",
  windowEnd: "20:30",
  timeZone: "Europe/London",
  maxWeeknightMinutes: 45,
  maxWeekendMinutes: 90,
  outBelowMinutes: 20,
  choreStart: "17:00",
  choreEnd: "21:00",
  // Saturday morning is when the jobs actually get done, and pretending
  // otherwise makes the whole week look impossible.
  weekendChoreStart: "09:00",
  weekendChoreEnd: "20:00",
};

/* ------------------------------------------------------------------ */

/** Minutes from midnight for "HH:MM". */
function clockToMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
}

/**
 * The local date and time-of-day of an instant, in a named zone.
 *
 * Doing this with Intl rather than getHours() matters: the server, the family
 * and the calendar can all be in different zones, and a British Summer Time
 * offset would otherwise shift every evening by an hour for half the year.
 */
export function localParts(
  iso: string,
  timeZone: string,
): { date: string; minutes: number } | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(hour) * 60 + Number(get("minute")),
  };
}

/** Merge overlapping or touching intervals so gaps can be measured. */
function mergeIntervals(
  intervals: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) {
      last.to = Math.max(last.to, interval.to);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** The longest stretch of `window` not covered by `busy`. */
export function longestFreeStretch(
  window: { from: number; to: number },
  busy: readonly { from: number; to: number }[],
): number {
  const clipped = mergeIntervals(
    busy
      .map((b) => ({
        from: Math.max(b.from, window.from),
        to: Math.min(b.to, window.to),
      }))
      .filter((b) => b.to > b.from),
  );

  let longest = 0;
  let cursor = window.from;
  for (const block of clipped) {
    longest = Math.max(longest, block.from - cursor);
    cursor = Math.max(cursor, block.to);
  }
  return Math.max(longest, window.to - cursor);
}

/** The sum of every gap in `window` not covered by `busy`. */
export function totalFreeMinutes(
  window: { from: number; to: number },
  busy: readonly { from: number; to: number }[],
): number {
  const clipped = mergeIntervals(
    busy
      .map((b) => ({
        from: Math.max(b.from, window.from),
        to: Math.min(b.to, window.to),
      }))
      .filter((b) => b.to > b.from),
  );
  const taken = clipped.reduce((sum, b) => sum + (b.to - b.from), 0);
  return Math.max(0, window.to - window.from - taken);
}

/* ------------------------------------------------------------------ */

export interface DayInterval {
  readonly event: CalendarEvent;
  readonly from: number;
  readonly to: number;
}

/**
 * Everything committed on a given local day, in minutes from midnight.
 *
 * Extracted because two different questions need it — how long is the longest
 * gap, and is a particular slot covered — and they must agree about what
 * "busy" means down to the minute.
 */
export function dayIntervals(
  date: string,
  events: readonly CalendarEvent[],
  timeZone = DEFAULTS.timeZone,
): DayInterval[] {
  const out: DayInterval[] = [];
  for (const event of events) {
    if (!event.startsAt) continue;
    const start = localParts(event.startsAt, timeZone);
    if (!start || start.date !== date) continue;

    const end = event.endsAt ? localParts(event.endsAt, timeZone) : null;
    // No end time, or one that runs past midnight: assume an hour, which is
    // the honest default for a calendar entry that did not say.
    const to =
      end && end.date === date && end.minutes > start.minutes
        ? end.minutes
        : start.minutes + 60;

    out.push({ event, from: start.minutes, to });
  }
  return out.sort((a, b) => a.from - b.from);
}

export function assessDay(
  date: string,
  events: readonly CalendarEvent[],
  options: AgendaOptions = {},
): DayAgenda {
  const o = { ...DEFAULTS, ...options };
  const window = {
    from: clockToMinutes(o.windowStart),
    to: clockToMinutes(o.windowEnd),
  };

  const allDay = events.filter((e) => e.onDate === date && !e.startsAt);
  const isWeekend = isWeekendDate(date);

  const onDay = dayIntervals(date, events, o.timeZone);
  const timed = onDay.filter((t) => t.to > window.from && t.from < window.to);

  const freeMinutes = longestFreeStretch(window, timed);
  const ceiling = isWeekend ? o.maxWeekendMinutes : o.maxWeeknightMinutes;
  const cookingMinutes = Math.min(ceiling, freeMinutes);

  const choreWindow = {
    from: clockToMinutes(isWeekend ? o.weekendChoreStart : o.choreStart),
    to: clockToMinutes(isWeekend ? o.weekendChoreEnd : o.choreEnd),
  };
  const choreMinutes = totalFreeMinutes(choreWindow, onDay);

  const availability: Availability =
    freeMinutes < o.outBelowMinutes
      ? "out"
      : cookingMinutes < ceiling
        ? "tight"
        : "clear";

  return {
    date,
    events: timed.map((t) => t.event),
    allDay,
    freeMinutes,
    cookingMinutes,
    choreMinutes,
    availability,
    note: describe(timed, freeMinutes, cookingMinutes, availability, o.timeZone),
  };
}

function describe(
  timed: readonly { event: CalendarEvent; from: number; to: number }[],
  freeMinutes: number,
  cookingMinutes: number,
  availability: Availability,
  timeZone: string,
): string {
  if (timed.length === 0) return "Evening is clear.";

  const list = timed
    .map((t) => `${t.event.summary} ${formatClock(t.from)}–${formatClock(t.to)}`)
    .join(", ");

  if (availability === "out") {
    return `${list}. Barely ${freeMinutes} minutes free — plan leftovers or something that only needs reheating.`;
  }
  if (availability === "tight") {
    return `${list}. About ${cookingMinutes} minutes to cook in.`;
  }
  return `${list}. Still ${cookingMinutes} minutes clear.`;
}

function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function isWeekendDate(isoDate: string): boolean {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function assessWeek(
  dates: readonly string[],
  events: readonly CalendarEvent[],
  options: AgendaOptions = {},
): DayAgenda[] {
  return dates.map((date) => assessDay(date, events, options));
}

/** Compact lines for the model prompt. */
export function agendaForPrompt(days: readonly DayAgenda[]): string[] {
  return days.map((day) => {
    const context = day.allDay.length
      ? ` (${day.allDay.map((e) => e.summary).join("; ")})`
      : "";
    return `${day.date}: ${day.cookingMinutes} min to cook. ${day.note}${context}`;
  });
}

/* ------------------------------------------------------------------ */

/** Map the Google Calendar API's event shape onto ours. */
export function fromGoogleEvent(raw: any): CalendarEvent | null {
  if (!raw?.id) return null;
  const summary = raw.summary ?? "(busy)";

  if (raw.start?.dateTime) {
    return {
      id: raw.id,
      summary,
      startsAt: raw.start.dateTime,
      endsAt: raw.end?.dateTime,
    };
  }
  if (raw.start?.date) {
    return { id: raw.id, summary, onDate: raw.start.date };
  }
  return null;
}
