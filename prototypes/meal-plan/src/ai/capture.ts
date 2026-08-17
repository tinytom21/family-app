/**
 * Turning what a person actually says into tasks.
 *
 * "bins tuesdays, need to ring the dentist before the girls go back, and the
 * bloody car insurance runs out on the 12th" is how jobs really arrive — in a
 * lump, at the end of a day, half of it recurring and none of it dated
 * properly. Every list app makes you type this in one field at a time, which
 * is exactly why the fridge door still wins.
 *
 * The same trick as the meal planner does the work here: the schema constrains
 * `assignee` to the household and `category` to the five we render, so the
 * model cannot invent a person or a list that the UI has nowhere to put. What
 * it *can* do is the genuinely hard part — noticing that "tuesdays" is a fixed
 * weekly schedule while "every couple of weeks" is measured from when you last
 * managed it.
 */

import type { Task } from "../domain/tasks.ts";
import {
  addDays,
  weekdayOf,
  type Anchor,
  type RecurrenceUnit,
  type TaskCategory,
} from "../domain/tasks.ts";
import {
  addUsage,
  emptyUsage,
  selectProvider,
  type PlanProvider,
  type Usage,
} from "./providers.ts";

const CATEGORIES: TaskCategory[] = [
  "household",
  "admin",
  "kids",
  "errand",
  "self",
];

export interface CaptureContext {
  /** Household members who can be given a job. */
  readonly people: readonly string[];
  readonly today: string;
}

export interface CaptureRun {
  readonly tasks: Task[];
  readonly note: string;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly provider: string;
  readonly model: string;
}

/* ------------------------------------------------------------------ */

/**
 * Deliberately flat, and every field required.
 *
 * The nested shape a `Task` actually has — an optional `recurrence` object, an
 * optional `beforeEvent` — would need nullable objects, and a nullable object
 * is the one construct the two providers' schema dialects disagree about most
 * awkwardly. Flat enums with an explicit "none" member behave identically in
 * both, cost nothing, and move the assembling into `reconcile` where it can be
 * tested without a network. The model never sees the difference.
 */
export function captureSchema(people: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["note", "tasks"],
    properties: {
      note: {
        type: "string",
        description:
          "One short sentence on anything you had to assume, or an empty string if nothing was ambiguous.",
      },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "category",
            "assignee",
            "dueOn",
            "effortMinutes",
            "repeatEvery",
            "repeatUnit",
            "repeatWeekdays",
            "repeatAnchor",
            "eventMatch",
            "eventLead",
            "notes",
          ],
          properties: {
            title: {
              type: "string",
              description:
                "Imperative and short, as a person would write it on a list: 'Ring the dentist', not 'Dentist appointment needs booking'.",
            },
            category: { type: "string", enum: CATEGORIES },
            assignee: {
              type: "string",
              enum: [...people, "anyone"],
              description:
                "Only name someone if the text does. 'anyone' is usually right.",
            },
            dueOn: nullableString(
              "YYYY-MM-DD. Resolve relative dates against today. Null when the text gives no deadline at all — an invented deadline goes red for no reason.",
            ),
            effortMinutes: {
              type: "integer",
              minimum: 5,
              maximum: 240,
              description:
                "How long the job actually takes, to the nearest five minutes. Be realistic: ringing a dentist is 10, sorting a loft is 120.",
            },
            repeatUnit: {
              type: "string",
              enum: ["none", "day", "week", "month"],
              description: "'none' for a one-off job.",
            },
            repeatEvery: {
              type: "integer",
              minimum: 0,
              maximum: 52,
              description: "Interval count; 0 when repeatUnit is 'none'.",
            },
            repeatWeekdays: {
              type: "array",
              maxItems: 7,
              items: { type: "integer", minimum: 0, maximum: 6 },
              description:
                "Weekly repeats only, 0 = Sunday. Fill this in whenever the text names a day. Empty otherwise.",
            },
            repeatAnchor: {
              type: "string",
              enum: ["none", "schedule", "completion"],
              description:
                "'schedule' when the world sets the date and being late does not move the next one (bin day, a standing class). 'completion' when the interval restarts from when the job was last done (bedding, cleaning, watering). 'none' for a one-off.",
            },
            eventMatch: {
              type: "string",
              description:
                "A lowercase word to look for in calendar entries, e.g. 'swim'. Use this instead of a weekly repeat when the job only matters because something is in the diary — it then stays silent on the weeks that thing is not on. Empty string when not applicable.",
            },
            eventLead: {
              type: "string",
              enum: ["none", "evening-before", "same-day"],
            },
            notes: nullableString(
              "Anything from the text that matters but is not the title. Null if there is nothing.",
            ),
          },
        },
      },
    },
  };
}

const nullableString = (description: string) => ({
  type: ["string", "null"],
  description,
});

export function captureSystem(context: CaptureContext): string {
  const dayName = new Date(`${context.today}T12:00:00Z`).toLocaleDateString(
    "en-GB",
    { weekday: "long", timeZone: "UTC" },
  );

  return `You turn a family's brain-dump into a structured task list.

Today is ${context.today}, a ${dayName}. Household: ${context.people.join(", ")}.

Rules:
1. One task per job. Split a sentence that contains two jobs; never merge two
   sentences into one task.
2. Resolve every relative date against today. "Next Tuesday" and "the 12th"
   become real dates. If there is genuinely no deadline, leave dueOn null —
   an invented deadline is worse than none, because it goes red for no reason.
3. Choose the recurrence anchor carefully; it is the difference between a list
   people trust and one they mute. Ask yourself whether being a day late should
   move the next one. Bin day: no, it is fixed. Clean sheets: yes, the interval
   starts again from when you did it.
4. If a job only matters because of something in the diary — kit for a lesson,
   a form for a trip — use beforeEvent rather than a weekly repeat, so it stays
   quiet on the weeks that thing is not happening.
5. Only assign a person when the text names one.
6. effortMinutes is the honest length of the job, not how long it feels.`;
}

/* ------------------------------------------------------------------ */

export interface RawTask {
  title: string;
  category: TaskCategory;
  assignee: string;
  dueOn: string | null;
  effortMinutes: number;
  repeatEvery: number;
  repeatUnit: "none" | RecurrenceUnit;
  repeatWeekdays: number[];
  repeatAnchor: "none" | Anchor;
  eventMatch: string;
  eventLead: "none" | "evening-before" | "same-day";
  notes: string | null;
}

/**
 * Assemble a real Task, and quietly fix the two things models get wrong here.
 *
 * A weekly job that names a weekday but carries a due date falling on a
 * different one is contradicting itself, and the weekday is the more reliable
 * half — it came straight from the words "on Tuesdays", where the date came
 * from arithmetic. And a recurring job with no due date cannot be scheduled at
 * all, so it starts today. Both are cheaper to correct here than to spend a
 * repair round on.
 */
export function reconcile(
  raw: RawTask,
  index: number,
  context: CaptureContext,
): Task {
  const { today, people } = context;
  const repeats = raw.repeatUnit !== "none" && raw.repeatEvery > 0;

  const rec = repeats
    ? {
        every: raw.repeatEvery,
        unit: raw.repeatUnit as RecurrenceUnit,
        anchor: (raw.repeatAnchor === "none"
          ? "schedule"
          : raw.repeatAnchor) as Anchor,
        ...(raw.repeatUnit === "week" && raw.repeatWeekdays?.length
          ? { weekdays: raw.repeatWeekdays }
          : {}),
      }
    : undefined;

  let dueOn = raw.dueOn ?? undefined;
  if (rec?.weekdays?.length) {
    const wanted = new Set(rec.weekdays);
    if (!dueOn || !wanted.has(weekdayOf(dueOn))) {
      dueOn = nextMatchingWeekday(today, wanted);
    }
  } else if (rec && !dueOn) {
    dueOn = today;
  }

  // An event trigger and a repeat are alternatives, not a pair; the trigger
  // wins because it is the more specific claim.
  const beforeEvent =
    raw.eventMatch && raw.eventLead !== "none"
      ? { match: raw.eventMatch.toLowerCase(), lead: raw.eventLead }
      : undefined;

  const assignee =
    raw.assignee && people.includes(raw.assignee) ? raw.assignee : undefined;

  return {
    id: `t-${today.replace(/-/g, "")}-${index}`,
    title: raw.title,
    category: raw.category,
    effortMinutes: raw.effortMinutes,
    ...(assignee ? { assignee } : {}),
    ...(beforeEvent
      ? { beforeEvent }
      : { ...(dueOn ? { dueOn } : {}), ...(rec ? { recurrence: rec } : {}) }),
    ...(raw.notes ? { notes: raw.notes } : {}),
  };
}

function nextMatchingWeekday(today: string, wanted: Set<number>): string {
  for (let step = 0; step < 7; step++) {
    const candidate = addDays(today, step);
    if (wanted.has(weekdayOf(candidate))) return candidate;
  }
  return today;
}

export async function captureTasks(
  text: string,
  context: CaptureContext,
  options: { provider?: PlanProvider } = {},
): Promise<CaptureRun> {
  const provider = options.provider ?? selectProvider();
  const usage = emptyUsage();

  const result = await provider.generate({
    system: captureSystem(context),
    turns: [{ role: "user", text }],
    schema: captureSchema(context.people),
  });
  addUsage(usage, result.usage);

  const parsed = JSON.parse(result.text) as { note: string; tasks: RawTask[] };

  return {
    tasks: parsed.tasks.map((raw, i) => reconcile(raw, i, context)),
    note: parsed.note ?? "",
    usage,
    costUsd: provider.costUsd(usage),
    provider: provider.id,
    model: provider.model,
  };
}
