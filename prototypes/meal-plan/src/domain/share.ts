/**
 * The week, written as a WhatsApp message.
 *
 * Plain text on purpose. A PDF has to be downloaded, opened, and pinched at,
 * and WhatsApp cannot search inside one; a message is a few kilobytes, reads
 * in the chat, and turns up when somebody searches "Thursday" or "chicken" in
 * a fortnight. WhatsApp's own markup — *bold*, _italic_ — is the only styling
 * there is, so the structure has to come from the layout: a menu first, then
 * one block per day that can be read standing at the hob.
 *
 * Everything here is derived from the plan and the week's table. Nothing is
 * new information, which is why it can never disagree with the screen.
 */

import { getIngredient } from "./catalogue.ts";
import type { MealPlan, PlannedMeal, Recipe, RecipeLine } from "./types.ts";
import { weekDates } from "./week.ts";

/** Who is cooking and who is out, per day — from the week's table. */
export interface ShareDay {
  readonly date: string;
  readonly cookName: string | null;
  readonly away: readonly string[];
}

export interface ShareInput {
  readonly householdName: string;
  readonly plan: MealPlan;
  readonly days: readonly ShareDay[];
  /** This week's notes, which the cook should see as well as the planner. */
  readonly weekNote?: string;
}

/** One evening, ready to print in any form. */
export interface DayCard {
  readonly date: string;
  readonly cookName: string | null;
  readonly away: readonly string[];
  readonly meals: readonly MealCard[];
}

export interface MealCard {
  readonly title: string;
  readonly portions: number;
  readonly minutes: number | null;
  /** The date whose cook this eats, when it is leftovers. */
  readonly leftoverOf: string | null;
  /** Later dates that eat this cook's leftovers — so make enough. */
  readonly feeds: readonly string[];
  readonly ingredients: readonly string[];
  readonly steps: readonly string[];
  /** Steps from tomorrow's recipe that have to start tonight. */
  readonly tonightForTomorrow: readonly string[];
}

const SLOT_ORDER = { breakfast: 0, lunch: 1, dinner: 2 } as const;

/** "Overnight", "the night before": the steps that cannot wait for tomorrow. */
const AHEAD = /\b(overnight|the night before|the day before|ahead of time|in advance)\b/i;

export function dayCards(input: ShareInput): DayCard[] {
  const recipes = new Map(input.plan.recipes.map((r) => [r.id, r]));
  const byDate = new Map<string, PlannedMeal[]>();
  for (const meal of input.plan.meals) {
    byDate.set(meal.date, [...(byDate.get(meal.date) ?? []), meal]);
  }
  const days = new Map(input.days.map((d) => [d.date, d]));

  return weekDates(input.plan.weekStarting).map((date, index, all) => {
    const tomorrow = all[index + 1];
    const meals = [...(byDate.get(date) ?? [])].sort(
      (a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot],
    );

    return {
      date,
      cookName: days.get(date)?.cookName ?? null,
      away: days.get(date)?.away ?? [],
      meals: meals.map((meal) => {
        const recipe = recipes.get(meal.recipeId);
        const leftover = Boolean(meal.leftoverOf);
        return {
          title: clean(recipe?.title ?? meal.recipeId),
          portions: meal.servings,
          minutes: recipe && !leftover ? recipe.prepMinutes + recipe.cookMinutes : null,
          leftoverOf: meal.leftoverOf ?? null,
          feeds: input.plan.meals
            .filter((m) => m.leftoverOf === date && m.recipeId === meal.recipeId)
            .map((m) => m.date)
            .sort(),
          // Leftovers need no shopping and no method beyond the reheat line,
          // and repeating the whole recipe would bury the one useful sentence.
          ingredients: recipe && !leftover ? ingredientLines(recipe, meal.servings) : [],
          steps: recipe && !leftover ? (recipe.steps ?? []).map(clean) : [],
          tonightForTomorrow: tomorrow
            ? (byDate.get(tomorrow) ?? [])
                .filter((m) => !m.leftoverOf)
                .flatMap((m) => recipes.get(m.recipeId)?.steps ?? [])
                .filter((step) => AHEAD.test(step))
                .map(clean)
            : [],
        };
      }),
    };
  });
}

/* ------------------------------------------------------------------ */
/* The message                                                          */
/* ------------------------------------------------------------------ */

export function weekMessage(input: ShareInput): string {
  const cards = dayCards(input);
  return [weekHead(input, cards, null), ...cards.map(dayChunk)].join("\n\n").trim();
}

/**
 * The largest single message, in characters.
 *
 * WhatsApp's documented ceiling is far higher, but long texts handed over by
 * a phone's share sheet have been refused well below it, and a week of real
 * recipes outgrew one message in practice. 4,000 sits under every limit we
 * know of — including the 4,096 WhatsApp sets for business messages — with
 * room for the "2 of 3" label.
 */
export const MESSAGE_LIMIT = 4000;

export interface MessagePart {
  readonly text: string;
  /** First and last day this part covers, for the button that sends it. */
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * The week, as one message if it fits and as several if it does not.
 *
 * Whole days only: a recipe split across two messages is a recipe somebody
 * has to scroll between with floury hands. The menu always goes first, so
 * whoever receives only the first message still knows what is for dinner.
 */
export function weekMessages(input: ShareInput, limit = MESSAGE_LIMIT): MessagePart[] {
  const cards = dayCards(input);
  const whole = weekMessage(input);
  if (whole.length <= limit) {
    return [{ text: whole, from: cards[0]?.date ?? null, to: cards.at(-1)?.date ?? null }];
  }

  // Pack greedily, leaving room for the label added once the count is known.
  const room = limit - 60;
  const packs: { cards: DayCard[]; chunks: string[] }[] = [];
  let current = { cards: [] as DayCard[], chunks: [] as string[] };
  let size = weekHead(input, cards, null).length;

  for (const card of cards) {
    // An oversized day starts by filling what is left of the current
    // message, menu and all, rather than assuming it has a message to itself.
    for (const chunk of fitted(dayChunk(card), room - size - 2, room)) {
      if (current.chunks.length && size + 2 + chunk.length > room) {
        packs.push(current);
        current = { cards: [], chunks: [] };
        size = 0;
      }
      current.chunks.push(chunk);
      if (!current.cards.includes(card)) current.cards.push(card);
      size += 2 + chunk.length;
    }
  }
  if (current.chunks.length) packs.push(current);

  const total = packs.length;
  return packs.map((pack, index) => {
    const label = `${index + 1} of ${total}`;
    const head =
      index === 0
        ? weekHead(input, cards, label)
        : `*${householdLabel(input)} · week of ${dayLabel(cards[0].date)}* (${label})`;
    return {
      text: [head, ...pack.chunks].join("\n\n").trim(),
      from: pack.cards[0]?.date ?? null,
      to: pack.cards.at(-1)?.date ?? null,
    };
  });
}

function householdLabel(input: ShareInput): string {
  return clean(input.householdName) || "Our week";
}

/** The title, the seven-line menu, and this week's notes. */
function weekHead(input: ShareInput, cards: readonly DayCard[], label: string | null): string {
  const first = cards[0]?.date ?? input.plan.weekStarting;
  const out = [
    `*${householdLabel(input)} · week of ${dayLabel(first)}*${label ? ` (${label})` : ""}`,
    "",
    "*Menu*",
    ...cards.map((card) => `${shortDay(card.date)}  ${menuLine(card)}`),
  ];
  if (input.weekNote?.trim()) {
    out.push("", `_This week: ${clean(input.weekNote.trim())}_`);
  }
  return out.join("\n");
}

function dayChunk(card: DayCard): string {
  return ["━━━━━━━━━━", ...dayBlock(card)].join("\n");
}

/**
 * A single day longer than a whole message — implausible, but a share that
 * fails outright is worse than one that breaks a recipe at a line. Split at
 * line ends, never mid-word.
 */
function fitted(chunk: string, firstRoom: number, room: number): string[] {
  if (chunk.length <= room) return [chunk];
  const out: string[] = [];
  let piece = "";
  // Too little left to be worth starting in: begin a fresh message instead.
  let limit = firstRoom >= 200 ? firstRoom : room;
  for (const line of chunk.split("\n")) {
    const next = piece ? `${piece}\n${line}` : line;
    if (next.length > limit && piece) {
      out.push(piece);
      piece = line;
      limit = room;
    } else {
      piece = next;
    }
  }
  if (piece) out.push(piece);
  return out;
}

/** One day, on its own — for "what's for dinner tonight". */
export function dayMessage(input: ShareInput, date: string): string | null {
  const card = dayCards(input).find((c) => c.date === date);
  if (!card) return null;
  return [`*${clean(input.householdName) || "Dinner"}*`, "", ...dayBlock(card)].join("\n").trim();
}

function menuLine(card: DayCard): string {
  if (card.meals.length === 0) return "—";
  return card.meals
    .map((m) => (m.leftoverOf ? `${m.title} (leftovers)` : m.title))
    .join(" + ");
}

function dayBlock(card: DayCard): string[] {
  const who = [
    card.cookName ? `${card.cookName} cooking` : null,
    card.away.length ? `${card.away.join(" and ")} out` : null,
  ].filter(Boolean);
  const out = [`*${dayLabel(card.date).toUpperCase()}*${who.length ? ` · ${who.join(" · ")}` : ""}`];

  if (card.meals.length === 0) {
    out.push("Nothing planned.");
    return out;
  }

  for (const meal of card.meals) {
    if (meal.leftoverOf) {
      out.push(
        `*${meal.title}* — leftovers from ${weekday(meal.leftoverOf)}`,
        "Reheat until piping hot all the way through.",
      );
      continue;
    }

    const facts = [
      meal.minutes ? `${meal.minutes} min` : null,
      `${trimNumber(meal.portions)} portions`,
    ].filter(Boolean);
    out.push(`*${meal.title}* · ${facts.join(" · ")}`);

    if (meal.feeds.length) {
      out.push(`➕ Makes extra: ${meal.feeds.map(weekday).join(" and ")} is leftovers of this.`);
    }
    if (meal.ingredients.length) {
      out.push("", "_Ingredients_", ...meal.ingredients.map((line) => `• ${line}`));
    }
    if (meal.steps.length) {
      out.push("", "_Method_", ...meal.steps.map((step, i) => `${i + 1}. ${step}`));
    }
    for (const step of meal.tonightForTomorrow) {
      out.push("", `🌙 Tonight, for tomorrow: ${step}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Amounts                                                              */
/* ------------------------------------------------------------------ */

/**
 * The recipe's ingredients, scaled to the portions this sitting needs.
 *
 * Rounded the way a person measures: to the nearest 5 g, or half a spoon, or
 * half an onion — not "647.3 g", which nobody weighs and everybody distrusts.
 */
export function ingredientLines(recipe: Recipe, portions: number): string[] {
  const scale = recipe.serves > 0 ? portions / recipe.serves : 1;
  return recipe.lines.map((line) => ingredientLine(line, scale));
}

function ingredientLine(line: RecipeLine, scale: number): string {
  const name = lowerFirst(clean(getIngredient(line.ingredientId)?.name ?? line.ingredientId));
  const note = line.note ? `, ${clean(line.note)}` : "";
  const amount = line.amount * scale;

  switch (line.unit) {
    case "g":
    case "ml":
      return `${metric(amount, line.unit)} ${name}${note}`;
    case "kg":
      return `${metric(amount * 1000, "g")} ${name}${note}`;
    case "l":
      return `${metric(amount * 1000, "ml")} ${name}${note}`;
    case "tsp":
    case "tbsp":
    case "cup":
      return `${fraction(amount)} ${line.unit} ${name}${note}`;
    case "oz":
    case "lb":
      return `${trimNumber(Math.round(amount * 10) / 10)} ${line.unit} ${name}${note}`;
    case "clove":
    case "slice":
    case "tin":
    case "pack": {
      const n = fraction(amount);
      return `${n} ${plural(line.unit, amount)} ${name}${note}`;
    }
    case "unit": {
      const n = fraction(amount);
      // The catalogue names things in the plural, as a list would: "1 lemons".
      return `${n} ${n === "1" || n === "½" ? singular(name) : name}${note}`;
    }
    case "pinch":
      return `a pinch of ${name}${note}`;
    case "drizzle":
      return `a drizzle of ${name}${note}`;
    case "to_taste":
      return `${name}, to taste${note}`;
  }
}

function metric(amount: number, unit: "g" | "ml"): string {
  if (amount >= 1000) {
    return `${trimNumber(Math.round(amount / 50) * 50 / 1000)} ${unit === "g" ? "kg" : "L"}`;
  }
  const step = amount >= 20 ? 5 : 1;
  return `${Math.max(step, Math.round(amount / step) * step)} ${unit}`;
}

/** Halves, because nobody measures a third of a tablespoon. */
function fraction(amount: number): string {
  const halves = Math.max(1, Math.round(amount * 2));
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 0) return "½";
  return half ? `${whole}½` : String(whole);
}

function plural(unit: string, amount: number): string {
  return Math.round(amount * 2) / 2 > 1 ? `${unit}s` : unit;
}

/* ------------------------------------------------------------------ */
/* Words                                                                */
/* ------------------------------------------------------------------ */

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

const at = (date: string) => new Date(`${date}T00:00:00Z`);
const dayLabel = (date: string) => DAY.format(at(date)).replace(",", "");
const weekday = (date: string) => WEEKDAY.format(at(date));
const shortDay = (date: string) => SHORT.format(at(date));

/**
 * The model's words, made safe for WhatsApp.
 *
 * A stray asterisk or underscore in a recipe title would switch bold or
 * italics on for the rest of the message, so they go.
 */
function clean(text: string): string {
  return text.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
}

function lowerFirst(text: string): string {
  // "Red peppers" reads as a list heading; "2 red peppers" reads as a recipe.
  // But a capitalised second word means a name — "Maris Piper potatoes" — and
  // "maris Piper" is worse than leaving it alone.
  if (!/^[A-Z][a-z]/.test(text)) return text;
  if (/^\S+\s+[A-Z]/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * "Lemons" to "lemon", for a quantity of one.
 *
 * Only the noun before any comma, and only the plural endings a shopping
 * catalogue actually uses. Anything it is unsure of is left plural, which
 * reads oddly but never wrongly.
 */
function singular(name: string): string {
  const [head, ...rest] = name.split(",");
  const tail = rest.length ? `,${rest.join(",")}` : "";
  const fixed = head
    .replace(/(\w)oes$/, "$1o") // tomatoes
    .replace(/(\w)ies$/, "$1y") // berries
    .replace(/([^s])s$/, "$1"); // lemons, courgettes — but not "hummus"-style "ss"
  return `${fixed}${tail}`;
}

function trimNumber(n: number): string {
  return Number(n.toFixed(1)).toString();
}
