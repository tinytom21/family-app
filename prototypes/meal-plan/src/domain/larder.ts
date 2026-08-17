/**
 * The larder: what is actually in the house.
 *
 * Every inventory app dies the same death. Entering data costs effort every
 * single time; the payoff arrives occasionally. Worse, depletion is invisible —
 * you know when you bought the onions, you never record using half of one — so
 * the count drifts wrong within days. And a confidently wrong larder is worse
 * than no larder at all, because it tells you that you have flour when you do
 * not, and you find out at the point of no return.
 *
 * So this does not try to be an inventory. Three ideas do the work:
 *
 *   1. DERIVE, DON'T ASK. The shopping list already knows what came in and the
 *      meal plan already knows what goes out. Stock is mostly arithmetic on two
 *      things the app has anyway. Manual entry exists to correct drift, not to
 *      create the record.
 *
 *   2. DIFFERENT THINGS DESERVE DIFFERENT TREATMENT. Nobody wants to track
 *      grams of flour, and everybody wants to know what is buried in the
 *      freezer. See `StockClass` below.
 *
 *   3. SAY WHEN YOU DO NOT KNOW. Every figure carries a confidence. A number
 *      the app guessed a fortnight ago is shown as a guess, and once it goes
 *      stale it stops being subtracted from the shopping list entirely — buying
 *      a spare 95p bag of onions is far cheaper than discovering at 18:30 that
 *      the prediction was wrong.
 */

import { getIngredient } from "./catalogue.ts";
import { planRequirements } from "./aggregate.ts";
import { formatBase } from "./units.ts";
import type {
  CanonicalIngredient,
  Dimension,
  MealPlan,
  PantryItem,
} from "./types.ts";

/**
 * How a thing wants to be tracked. The classes differ in what question the
 * household actually asks about them.
 *
 *   staple  "have I got any?"        — flour, oil, spices. Binary, not counted.
 *   ambient "how many left?"         — tins, pasta, rice. Counted, never rots.
 *   fresh   "will it go off first?"  — veg, meat, dairy. Counted and dated.
 *   frozen  "what's even in there?"  — opaque box. Needs a real list.
 */
export type StockClass = "staple" | "ambient" | "fresh" | "frozen";

export type Confidence = "confirmed" | "predicted" | "stale";

export interface LarderItem {
  readonly ingredientId: string;
  /** In the ingredient's base unit. */
  readonly amount: number;
  /** ISO date a human last actually looked. */
  readonly confirmedOn: string;
  /** ISO date, for fresh things that were given one. */
  readonly bestBefore?: string;
}

/** The freezer mostly holds cooked meals, not ingredients. */
export interface FreezerMeal {
  readonly id: string;
  readonly label: string;
  readonly portions: number;
  readonly frozenOn: string;
  readonly fromRecipeId?: string;
}

export interface Larder {
  readonly items: readonly LarderItem[];
  readonly freezer: readonly FreezerMeal[];
}

export interface ProjectedItem {
  readonly ingredientId: string;
  readonly name: string;
  readonly stockClass: StockClass;
  readonly base: Dimension;
  /** What the human last confirmed. */
  readonly confirmedAmount: number;
  /** What the plan will eat. */
  readonly consumedByPlan: number;
  /** Confirmed minus consumed, floored at zero. */
  readonly projectedAmount: number;
  readonly confidence: Confidence;
  readonly daysSinceConfirmed: number;
  readonly bestBefore?: string;
  /** Dated to expire during the plan and not fully used by it. */
  readonly wasteRisk: boolean;
  readonly display: string;
}

export interface LarderProjection {
  readonly items: readonly ProjectedItem[];
  readonly freezer: readonly FreezerMeal[];
  /** Things that will go off unless a meal uses them. */
  readonly useUpFirst: readonly ProjectedItem[];
  /** Spare portions the plan will produce, worth freezing. */
  readonly freezerCandidates: readonly FreezerCandidate[];
}

export interface FreezerCandidate {
  readonly recipeId: string;
  readonly label: string;
  readonly date: string;
  readonly sparePortions: number;
}

/* ------------------------------------------------------------------ */

export function classifyStock(ingredient: CanonicalIngredient): StockClass {
  if (ingredient.aisle === "frozen") return "frozen";
  if (ingredient.staple) return "staple";
  if (
    ingredient.aisle === "produce" ||
    ingredient.aisle === "meat-fish" ||
    ingredient.aisle === "dairy-eggs" ||
    ingredient.aisle === "bakery"
  ) {
    return "fresh";
  }
  return "ambient";
}

/**
 * Sensible default rather than 45 hand-entered numbers. Per-ingredient values
 * in the catalogue win where the default is badly wrong (fish, bread, herbs).
 */
export function shelfLifeDays(ingredient: CanonicalIngredient): number {
  if (ingredient.shelfLifeDays !== undefined) return ingredient.shelfLifeDays;
  switch (classifyStock(ingredient)) {
    case "frozen":
      return 90;
    case "fresh":
      switch (ingredient.aisle) {
        case "meat-fish":
          return 3;
        case "bakery":
          return 4;
        case "produce":
          return 7;
        default:
          return 10;
      }
    default:
      return 365;
  }
}

/**
 * How long a predicted figure stays believable. After this, the app admits it
 * is guessing and stops letting the guess reduce the shopping list.
 */
function staleAfterDays(stockClass: StockClass): number {
  switch (stockClass) {
    case "fresh":
      return 5;
    case "frozen":
      return 60;
    case "ambient":
      return 30;
    case "staple":
      return 45;
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T12:00:00Z`);
  const to = Date.parse(`${toIso}T12:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/* ------------------------------------------------------------------ */

/**
 * Confirmed stock, less what the week's cooking will eat, plus an honest
 * account of how much any of it should be believed.
 */
export function projectLarder(
  larder: Larder,
  plan: MealPlan,
  asOf: string,
  householdPortions: number,
): LarderProjection {
  const { totals } = planRequirements(plan);
  const planEnd = [...plan.meals.map((m) => m.date)].sort().at(-1) ?? asOf;

  const items: ProjectedItem[] = [];

  for (const entry of larder.items) {
    const ingredient = getIngredient(entry.ingredientId);
    if (!ingredient) continue;

    const stockClass = classifyStock(ingredient);
    const consumed = totals.get(entry.ingredientId)?.base ?? 0;
    const projected = Math.max(0, entry.amount - consumed);
    const age = daysBetween(entry.confirmedOn, asOf);

    const confidence: Confidence =
      age > staleAfterDays(stockClass)
        ? "stale"
        : consumed > 0 || age > 0
          ? "predicted"
          : "confirmed";

    const bestBefore =
      entry.bestBefore ??
      addDays(entry.confirmedOn, shelfLifeDays(ingredient));

    // Only a worry if it expires during the plan AND the plan leaves some.
    const wasteRisk =
      stockClass === "fresh" &&
      bestBefore <= planEnd &&
      projected > 0 &&
      confidence !== "stale";

    items.push({
      ingredientId: entry.ingredientId,
      name: ingredient.name,
      stockClass,
      base: ingredient.base,
      confirmedAmount: entry.amount,
      consumedByPlan: consumed,
      projectedAmount: projected,
      confidence,
      daysSinceConfirmed: age,
      bestBefore,
      wasteRisk,
      display: formatBase(projected, ingredient.base),
    });
  }

  items.sort(
    (a, b) =>
      Number(b.wasteRisk) - Number(a.wasteRisk) || a.name.localeCompare(b.name),
  );

  return {
    items,
    freezer: [...larder.freezer].sort((a, b) =>
      a.frozenOn.localeCompare(b.frozenOn),
    ),
    useUpFirst: items.filter((i) => i.wasteRisk),
    freezerCandidates: freezerCandidates(plan, householdPortions),
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Feed the projection to the shopping list.
 *
 * A stale figure is deliberately not subtracted. The asymmetry is the whole
 * argument: over-buying a cheap ingredient wastes pennies, while trusting a
 * two-week-old guess and being wrong wastes the meal.
 */
export function larderToPantry(
  projection: LarderProjection,
): PantryItem[] {
  return projection.items
    .filter((i) => i.confidence !== "stale" && i.confirmedAmount > 0)
    .map((i) => ({ ingredientId: i.ingredientId, amount: i.confirmedAmount }));
}

/**
 * Spare portions the week will produce.
 *
 * This is the payoff for deriving rather than asking: the planner already knows
 * Tuesday cooks eight portions and only six get eaten, so the freezer log can
 * offer to write itself. Nobody types anything.
 */
export function freezerCandidates(
  plan: MealPlan,
  householdPortions: number,
): FreezerCandidate[] {
  const recipesById = new Map(plan.recipes.map((r) => [r.id, r]));

  // How many later sittings eat from each cook.
  const laterSittings = new Map<string, number>();
  for (const meal of plan.meals) {
    if (!meal.leftoverOf) continue;
    const key = `${meal.leftoverOf}|${meal.recipeId}`;
    laterSittings.set(key, (laterSittings.get(key) ?? 0) + 1);
  }

  const out: FreezerCandidate[] = [];
  for (const meal of plan.meals) {
    if (meal.leftoverOf) continue;
    if (!recipesById.has(meal.recipeId)) continue;

    const sittings = 1 + (laterSittings.get(`${meal.date}|${meal.recipeId}`) ?? 0);
    const spare = meal.servings - householdPortions * sittings;

    // One spare portion is tomorrow's lunch, not a freezer job. Two is worth
    // the container and the label.
    if (spare >= 2) {
      out.push({
        recipeId: meal.recipeId,
        label: recipesById.get(meal.recipeId)!.title,
        date: meal.date,
        sparePortions: Math.floor(spare),
      });
    }
  }
  return out;
}

/** Compact lines for the model prompt, so it cooks what is about to go off. */
export function larderForPrompt(projection: LarderProjection): string[] {
  const lines = projection.items
    .filter((i) => i.confidence !== "stale" && i.confirmedAmount > 0)
    .map((i) => {
      const dated = i.wasteRisk ? `, USE BY ${i.bestBefore}` : "";
      return `${i.ingredientId}: ${formatBase(i.confirmedAmount, i.base)}${dated}`;
    });

  for (const meal of projection.freezer) {
    lines.push(`freezer: ${meal.portions} portions of ${meal.label}`);
  }
  return lines;
}
