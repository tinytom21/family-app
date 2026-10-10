/**
 * Every meal the family has agreed to, what they thought of it, and what that
 * says about next week.
 *
 * The log is the memory a meal planner otherwise lacks. Without it the model
 * starts cold every week: it can suggest the stew everybody hated twice, or
 * never again suggest the traybake everybody asks for. With it, three things
 * become possible, and only three, because each has to be explainable:
 *
 *   1. **Avoid** what the family disliked, and anything they had last week.
 *   2. **Bring back** a favourite now and then — as the same recipe, not a
 *      reinvention of it — on a spacing that grows the more it has been had,
 *      and never more than two a week. A planner that only ever repeats what
 *      was liked is a planner that stops finding new things to like.
 *   3. **Notice patterns** — chicken always liked, fish rarely — once there
 *      are enough ratings for a pattern to be one, and say them in words the
 *      model can weigh rather than rules it must obey.
 *
 * Ratings are thumbs, not stars. A five-point scale invites a debate at the
 * dinner table; "would you have it again?" does not.
 */

import { addDays } from "./tasks.ts";
import type { MealPlan, MealSlot, Recipe } from "./types.ts";

export type Rating = "up" | "down";

export interface MealLogEntry {
  readonly weekStarting: string;
  readonly date: string;
  readonly slot: MealSlot;
  readonly title: string;
  /** The dish's identity across weeks: its title, normalised. */
  readonly key: string;
  readonly protein: string | null;
  /** Catalogue ids, for noticing that it is the mushrooms they object to. */
  readonly ingredients: readonly string[];
  readonly minutes: number | null;
  readonly cookName: string | null;
  /** Leftover nights are logged so the week is complete, but never rated. */
  readonly leftover: boolean;
  readonly rating?: Rating;
}

export interface MealLog {
  readonly entries: readonly MealLogEntry[];
  /** The latest recipe for each dish, by key, so a favourite returns as itself. */
  readonly recipes: Readonly<Record<string, Recipe>>;
}

export const emptyLog = (): MealLog => ({ entries: [], recipes: {} });

/** "Sticky Chicken Traybake!" and "sticky chicken traybake" are one dish. */
export function dishKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Writing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Put a week into the log, replacing whatever was there for that week.
 *
 * Replace rather than append, so agreeing the same week twice — after a late
 * change — leaves one copy. A rating already given to a meal that survives
 * the change is kept.
 */
export function recordWeek(
  log: MealLog,
  plan: MealPlan,
  cooks: Readonly<Record<string, string | null>> = {},
): MealLog {
  const recipes = new Map(plan.recipes.map((r) => [r.id, r]));
  const previous = log.entries.filter((e) => e.weekStarting === plan.weekStarting);
  const ratingFor = (date: string, slot: MealSlot, key: string) =>
    previous.find((e) => e.date === date && e.slot === slot && e.key === key)?.rating;

  const added: MealLogEntry[] = plan.meals.map((meal) => {
    const recipe = recipes.get(meal.recipeId);
    const title = recipe?.title ?? meal.recipeId;
    const key = dishKey(title);
    const rating = ratingFor(meal.date, meal.slot, key);
    return {
      weekStarting: plan.weekStarting,
      date: meal.date,
      slot: meal.slot,
      title,
      key,
      protein: recipe?.protein ?? null,
      ingredients: recipe ? [...new Set(recipe.lines.map((l) => l.ingredientId))] : [],
      minutes: recipe ? recipe.prepMinutes + recipe.cookMinutes : null,
      cookName: cooks[meal.date] ?? null,
      leftover: Boolean(meal.leftoverOf),
      ...(rating ? { rating } : {}),
    };
  });

  const book = { ...log.recipes };
  for (const recipe of plan.recipes) book[dishKey(recipe.title)] = recipe;

  return {
    entries: [
      ...log.entries.filter((e) => e.weekStarting !== plan.weekStarting),
      ...added,
    ].sort((a, b) => a.date.localeCompare(b.date)),
    recipes: book,
  };
}

/** Take a week back out, when an agreed plan is replanned. */
export function forgetWeek(log: MealLog, weekStarting: string): MealLog {
  return { ...log, entries: log.entries.filter((e) => e.weekStarting !== weekStarting) };
}

/** Thumbs up, thumbs down, or null to take a rating back. */
export function rateMeal(
  log: MealLog,
  date: string,
  slot: MealSlot,
  rating: Rating | null,
): MealLog {
  return {
    ...log,
    entries: log.entries.map((e) => {
      if (e.date !== date || e.slot !== slot || e.leftover) return e;
      const { rating: _old, ...rest } = e;
      return rating ? { ...rest, rating } : rest;
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Reading                                                              */
/* ------------------------------------------------------------------ */

export interface DishStats {
  readonly key: string;
  readonly title: string;
  readonly protein: string | null;
  /** Times it was cooked — leftover nights do not count twice. */
  readonly times: number;
  readonly ups: number;
  readonly downs: number;
  readonly last: string;
  /** The most recent rating, which beats an old one when the two disagree. */
  readonly lastRating: Rating | null;
}

export function dishStats(log: MealLog): DishStats[] {
  const byKey = new Map<string, MealLogEntry[]>();
  for (const entry of log.entries) {
    if (entry.leftover) continue;
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  }
  return [...byKey.values()]
    .map((entries) => {
      const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
      const latest = sorted.at(-1)!;
      const rated = sorted.filter((e) => e.rating);
      return {
        key: latest.key,
        title: latest.title,
        protein: latest.protein,
        times: sorted.length,
        ups: sorted.filter((e) => e.rating === "up").length,
        downs: sorted.filter((e) => e.rating === "down").length,
        last: latest.date,
        lastRating: rated.at(-1)?.rating ?? null,
      };
    })
    .sort((a, b) => b.ups - b.downs - (a.ups - a.downs) || b.last.localeCompare(a.last));
}

/** Liked, on balance, and not let down the last time it was had. */
const isFavourite = (d: DishStats) => d.ups > d.downs && d.lastRating !== "down";
/** Disliked, on balance — or disliked the last time and never liked. */
const isDisliked = (d: DishStats) => d.downs > d.ups || (d.lastRating === "down" && d.ups === 0);

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * How long a favourite rests before coming back: three weeks after the first
 * time, a week longer for each time since, up to six. Something the family has
 * had five times is a fixture already and needs less help being remembered.
 */
export function restDays(times: number): number {
  return Math.min(42, 14 + 7 * Math.max(1, times));
}

export interface Repeat {
  readonly key: string;
  readonly title: string;
  readonly recipe: Recipe;
  readonly ups: number;
  readonly weeksSince: number;
}

/**
 * Which favourites to bring back this week: at most `max`, and only those
 * whose rest is over, most overdue first.
 *
 * Usually one or none. The cap is the guard against the failure mode the
 * family asked to avoid — a planner that, once it knows what is liked, serves
 * nothing else.
 */
export function chooseRepeats(log: MealLog, weekStarting: string, max = 2): Repeat[] {
  return dishStats(log)
    .filter(isFavourite)
    .filter((d) => log.recipes[d.key])
    .map((d) => ({ d, since: daysBetween(d.last, weekStarting) }))
    .filter(({ d, since }) => since >= restDays(d.times))
    .sort((a, b) => b.since / restDays(b.d.times) - a.since / restDays(a.d.times))
    .slice(0, max)
    .map(({ d, since }) => ({
      key: d.key,
      title: d.title,
      recipe: log.recipes[d.key],
      ups: d.ups,
      weeksSince: Math.floor(since / 7),
    }));
}

/** The id a brought-back recipe goes by in the plan, stable week to week. */
export const repeatId = (key: string) => `again-${key.replace(/ /g, "-")}`;

/* ------------------------------------------------------------------ */
/* Patterns                                                             */
/* ------------------------------------------------------------------ */

/** Below this many ratings, a "pattern" is an anecdote. */
const ENOUGH = 3;

interface Tally {
  ups: number;
  downs: number;
}

function tally(entries: readonly MealLogEntry[], keyOf: (e: MealLogEntry) => string[]) {
  const out = new Map<string, Tally>();
  for (const e of entries) {
    if (!e.rating || e.leftover) continue;
    for (const key of keyOf(e)) {
      const t = out.get(key) ?? { ups: 0, downs: 0 };
      t[e.rating === "up" ? "ups" : "downs"]++;
      out.set(key, t);
    }
  }
  return out;
}

const verdict = ({ ups, downs }: Tally): "liked" | "not keen" | null => {
  const total = ups + downs;
  if (total < ENOUGH) return null;
  if (ups / total >= 0.75) return "liked";
  if (ups / total <= 1 / 3) return "not keen";
  return null;
};

/**
 * What the ratings say beyond single dishes, in plain sentences.
 *
 * Only clear leanings — three-quarters one way, from at least three ratings —
 * because a pattern read from two dinners is how a family that disliked one
 * fish pie never sees fish again.
 */
export function patterns(log: MealLog, nameOf: (id: string) => string = (id) => id): string[] {
  const lines: string[] = [];
  const describe = (label: string, t: Tally) =>
    `${label}: liked ${t.ups} of ${t.ups + t.downs}`;

  const proteins = tally(log.entries, (e) => (e.protein ? [e.protein] : []));
  const liked = [...proteins].filter(([, t]) => verdict(t) === "liked");
  const notKeen = [...proteins].filter(([, t]) => verdict(t) === "not keen");
  if (liked.length) lines.push(`Proteins that go down well — ${liked.map(([p, t]) => describe(p, t)).join("; ")}.`);
  if (notKeen.length) lines.push(`Proteins they are not keen on — ${notKeen.map(([p, t]) => describe(p, t)).join("; ")}.`);

  const speed = tally(log.entries, (e) =>
    e.minutes == null ? [] : [e.minutes <= 30 ? "quick (30 min or less)" : "longer cooks"],
  );
  for (const [label, t] of speed) {
    const v = verdict(t);
    if (v) lines.push(`${label[0].toUpperCase()}${label.slice(1)} — ${v}, ${t.ups} of ${t.ups + t.downs}.`);
  }

  // Ingredients last, and only the strongest few each way: they are the most
  // tempting to over-read, since every dish has a dozen of them.
  const ingredients = [...tally(log.entries, (e) => [...e.ingredients])]
    .filter(([, t]) => t.ups + t.downs >= ENOUGH + 1)
    .map(([id, t]) => ({ id, t, v: verdict(t) }))
    .filter((x) => x.v === "not keen");
  if (ingredients.length) {
    lines.push(
      `Ingredients in meals they mostly disliked — ${ingredients
        .slice(0, 3)
        .map((x) => describe(nameOf(x.id), x.t))
        .join("; ")}. Possibly the ingredient, possibly the dishes; weigh it.`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* For the planner                                                      */
/* ------------------------------------------------------------------ */

/**
 * The log, as the planner needs it: what to bring back, what to avoid, what
 * was just had, and what the ratings suggest. Empty when there is nothing yet
 * worth saying, so a new household's prompt is not padded with nothing.
 */
export function historyForPrompt(
  log: MealLog,
  weekStarting: string,
  repeats: readonly Repeat[],
  nameOf?: (id: string) => string,
): string {
  const stats = dishStats(log);
  if (stats.length === 0) return "";

  const parts: string[] = [];

  if (repeats.length) {
    parts.push(
      [
        "Bring back this week — the family liked these and it has been a while. Use each exactly as it was: put the recipeId below on the meal and do not define that recipe again.",
        ...repeats.map(
          (r) =>
            `- ${repeatId(r.key)}: ${r.title} (liked ${r.ups} time${r.ups === 1 ? "" : "s"}, last had ${r.weeksSince} week${r.weeksSince === 1 ? "" : "s"} ago, ${r.recipe.prepMinutes + r.recipe.cookMinutes} min, serves ${r.recipe.serves})`,
        ),
        "Put each on a day where its time fits the cook. If one cannot fit any day this week, leave it out.",
      ].join("\n"),
    );
  }

  const disliked = stats.filter(isDisliked);
  if (disliked.length) {
    parts.push(
      ["Do not suggest — the family did not like these:", ...disliked.map((d) => `- ${d.title}`)].join("\n"),
    );
  }

  const fortnight = addDays(weekStarting, -14);
  // Disliked dishes are already ruled out above; saying so twice wastes the
  // model's attention on the one list that did not need it.
  const recent = stats.filter(
    (d) =>
      d.last >= fortnight &&
      d.last < weekStarting &&
      !repeats.some((r) => r.key === d.key) &&
      !isDisliked(d),
  );
  if (recent.length) {
    parts.push(
      ["Had in the last fortnight — do not repeat this week:", ...recent.map((d) => `- ${d.title}`)].join("\n"),
    );
  }

  const seen = patterns(log, nameOf);
  if (seen.length) {
    parts.push(["What the ratings suggest — leanings to weigh, not rules:", ...seen.map((l) => `- ${l}`)].join("\n"));
  }

  parts.push(
    "Apart from anything brought back above, every dish should be one this family has not had before. Finding new favourites is part of the job.",
  );

  return `PAST MEALS AND WHAT THE FAMILY THOUGHT OF THEM\n${parts.join("\n\n")}`;
}
