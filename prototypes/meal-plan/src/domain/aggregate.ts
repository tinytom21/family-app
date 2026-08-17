/**
 * Meal plan -> shopping list.
 *
 * Four things happen here, and each one is a place real apps get it wrong:
 *   1. Scale every recipe to the servings actually planned.
 *   2. Reconcile units so "2 tbsp oil" and "60 ml oil" become one number.
 *   3. Subtract what's already in the cupboard.
 *   4. Solve for real pack sizes, because shops don't sell 340 g of chicken.
 *
 * Step 4 is the one users notice. A list that says "buy 340 g chicken breast"
 * is a spreadsheet; a list that says "1 x 650 g pack, 310 g spare" is a tool.
 */

import { getIngredient } from "./catalogue.ts";
import { formatBase, isVague, toBase } from "./units.ts";
import type {
  MealPlan,
  Pack,
  PantryItem,
  Recipe,
  ShoppingLine,
  ShoppingList,
} from "./types.ts";

export interface Accumulator {
  base: number;
  usedBy: Set<string>;
  vagueOnly: boolean;
}

export interface AggregateOptions {
  /** Include staples (oil, salt, spices) in the list instead of assuming them. */
  readonly restockStaples?: boolean;
}

/**
 * Steps 1 and 2 on their own: what the week actually consumes, per ingredient,
 * in base units, before anyone looks in a cupboard.
 *
 * Split out because the larder needs exactly the same number to predict what
 * will be left on Sunday. Computing it twice in two places is how the two
 * screens end up disagreeing.
 */
export function planRequirements(plan: MealPlan): {
  totals: Map<string, Accumulator>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const totals = new Map<string, Accumulator>();
  const recipesById = new Map(plan.recipes.map((r) => [r.id, r]));

  for (const meal of plan.meals) {
    // Eating Tuesday's leftovers on Wednesday must not buy the food twice.
    if (meal.leftoverOf) continue;

    const recipe = recipesById.get(meal.recipeId);
    if (!recipe) {
      warnings.push(
        `${meal.date} ${meal.slot}: no recipe found for "${meal.recipeId}" — skipped`,
      );
      continue;
    }
    const scale = meal.servings / recipe.serves;
    if (!Number.isFinite(scale) || scale <= 0) {
      warnings.push(`"${recipe.title}": bad serving scale — skipped`);
      continue;
    }

    for (const line of recipe.lines) {
      const ingredient = getIngredient(line.ingredientId);
      if (!ingredient) {
        warnings.push(
          `"${recipe.title}": unknown ingredient "${line.ingredientId}" — not added to list`,
        );
        continue;
      }

      const entry = totals.get(ingredient.id) ?? {
        base: 0,
        usedBy: new Set<string>(),
        vagueOnly: true,
      };
      entry.usedBy.add(recipe.title);

      if (isVague(line.unit)) {
        // "a pinch of salt" — real, but not a quantity. Keep the ingredient
        // visible so it can still be flagged if the cupboard is empty.
        totals.set(ingredient.id, entry);
        continue;
      }

      const converted = toBase(line.amount * scale, line.unit, ingredient);
      if (!converted.ok) {
        warnings.push(`"${recipe.title}": ${converted.reason}`);
        totals.set(ingredient.id, entry);
        continue;
      }
      entry.base += converted.value;
      entry.vagueOnly = false;
      totals.set(ingredient.id, entry);
    }
  }

  return { totals, warnings };
}

export function buildShoppingList(
  plan: MealPlan,
  pantry: readonly PantryItem[] = [],
  options: AggregateOptions = {},
): ShoppingList {
  /* ---- 1 & 2: scale and reconcile ---- */
  const { totals, warnings } = planRequirements(plan);

  /* ---- 3: subtract the cupboard ---- */
  const pantryById = new Map(pantry.map((p) => [p.ingredientId, p.amount]));

  const lines: ShoppingLine[] = [];
  const assumedInPantry: string[] = [];
  const coveredByPantry: string[] = [];

  for (const [id, entry] of totals) {
    const ingredient = getIngredient(id)!;

    if (ingredient.staple && !options.restockStaples) {
      assumedInPantry.push(ingredient.name);
      continue;
    }
    if (entry.vagueOnly) {
      assumedInPantry.push(`${ingredient.name} (to taste)`);
      continue;
    }

    const have = pantryById.get(id) ?? 0;
    const required = roundBase(entry.base - have, ingredient.base);
    if (required <= 0) {
      coveredByPantry.push(ingredient.name);
      continue;
    }

    /* ---- 4: solve for packs ---- */
    if (ingredient.packs.length === 0) {
      warnings.push(`"${ingredient.name}": no pack sizes defined — cannot price`);
      continue;
    }
    const solution = solvePacks(required, ingredient.packs);
    lines.push({
      ingredientId: id,
      name: ingredient.name,
      aisle: ingredient.aisle,
      requiredBase: required,
      base: ingredient.base,
      packs: solution.packs,
      boughtBase: solution.bought,
      surplusBase: roundBase(solution.bought - required, ingredient.base),
      usedBy: [...entry.usedBy].sort(),
    });
  }

  const AISLE_ORDER = [
    "produce",
    "meat-fish",
    "dairy-eggs",
    "bakery",
    "ambient",
    "frozen",
    "household",
  ];
  lines.sort(
    (a, b) =>
      AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle) ||
      a.name.localeCompare(b.name),
  );

  return {
    lines,
    linesWithSurplus: lines.filter((l) => l.surplusBase > 0).length,
    assumedInPantry: assumedInPantry.sort(),
    coveredByPantry: coveredByPantry.sort(),
    warnings,
  };
}

/* ------------------------------------------------------------------ */

export interface PackSolution {
  readonly packs: readonly { pack: Pack; count: number }[];
  readonly bought: number;
}

/**
 * Smallest combination of packs whose total is at least `required`.
 *
 * With no prices to optimise against, the objective is the one that survives a
 * change of supermarket: buy the least food that covers the week, so the least
 * ends up in the bin. Ties break towards fewer packs, which is fewer things to
 * carry and less packaging.
 *
 * (If you would rather it preferred one big pack over two small ones even at
 * the cost of leftovers, swap the two comparisons in `better` below. That is
 * the entire change.)
 *
 * Exhaustive over a bounded count per pack. Pack lists are 1-3 entries in
 * practice, so the search space is trivial; the loop cap is only there so a
 * pathological catalogue row can't hang the request.
 */
export function solvePacks(
  required: number,
  packs: readonly Pack[],
): PackSolution {
  const usable = packs.filter((p) => p.size > 0);
  if (usable.length === 0) return { packs: [], bought: 0 };

  const limits = usable.map((p) => Math.ceil(required / p.size) + 1);
  const combos = limits.reduce((n, l) => n * (l + 1), 1);

  if (combos > 200_000) return greedy(required, usable);

  let best: { counts: number[]; bought: number; packCount: number } | null = null;
  const counts = new Array(usable.length).fill(0);

  const better = (bought: number, packCount: number): boolean =>
    best === null ||
    bought < best.bought ||
    (bought === best.bought && packCount < best.packCount);

  const walk = (index: number, bought: number, packCount: number): void => {
    if (index === usable.length) {
      if (bought < required) return;
      if (better(bought, packCount)) {
        best = { counts: [...counts], bought, packCount };
      }
      return;
    }
    for (let n = 0; n <= limits[index]; n++) {
      counts[index] = n;
      const nextBought = bought + n * usable[index].size;
      // Adding packs only ever increases the total, so once this branch has
      // overshot the incumbent it cannot recover.
      if (best !== null && nextBought > best.bought) {
        counts[index] = 0;
        break;
      }
      walk(index + 1, nextBought, packCount + n);
    }
    counts[index] = 0;
  };
  walk(0, 0, 0);

  if (best === null) return greedy(required, usable);
  const winner = best as { counts: number[]; bought: number; packCount: number };

  return {
    packs: usable
      .map((pack, i) => ({ pack, count: winner.counts[i] }))
      .filter((p) => p.count > 0)
      .sort((a, b) => b.pack.size - a.pack.size),
    bought: winner.bought,
  };
}

/** Largest-pack-first fallback for pathologically large pack lists. */
function greedy(required: number, packs: readonly Pack[]): PackSolution {
  const sorted = [...packs].sort((a, b) => b.size - a.size);
  const chosen: { pack: Pack; count: number }[] = [];
  let remaining = required;
  let bought = 0;

  for (const pack of sorted) {
    const n = Math.floor(remaining / pack.size);
    if (n > 0) {
      chosen.push({ pack, count: n });
      remaining -= n * pack.size;
      bought += n * pack.size;
    }
  }
  if (remaining > 0) {
    const smallest = sorted[sorted.length - 1];
    const existing = chosen.find((c) => c.pack === smallest);
    if (existing) existing.count += 1;
    else chosen.push({ pack: smallest, count: 1 });
    bought += smallest.size;
  }
  return { packs: chosen, bought };
}

/** Whole items for counts; a sensible precision for mass and volume. */
function roundBase(value: number, base: "mass" | "volume" | "count"): number {
  if (base === "count") return Math.round(value * 100) / 100;
  return Math.round(value * 10) / 10;
}

/* ------------------------------------------------------------------ */

export function formatShoppingList(list: ShoppingList): string {
  const out: string[] = [];
  let currentAisle = "";

  for (const line of list.lines) {
    if (line.aisle !== currentAisle) {
      currentAisle = line.aisle;
      out.push(`\n  ${currentAisle.toUpperCase()}`);
    }
    const packs = line.packs
      .map((p) => `${p.count} x ${p.pack.label}`)
      .join(" + ");
    const surplus =
      line.surplusBase > 0
        ? `  (need ${formatBase(line.requiredBase, line.base)}, ${formatBase(line.surplusBase, line.base)} spare)`
        : "";
    out.push(`    ${line.name.padEnd(28)} ${packs.padEnd(26)}${surplus}`);
  }

  out.push(
    `\n  ${list.lines.length} items, ${list.linesWithSurplus} with leftovers`,
  );
  if (list.coveredByPantry.length) {
    out.push(`\n  Already have: ${list.coveredByPantry.join(", ")}`);
  }
  if (list.assumedInPantry.length) {
    out.push(`  Assumed in cupboard: ${list.assumedInPantry.join(", ")}`);
  }
  if (list.warnings.length) {
    out.push("\n  WARNINGS");
    for (const w of list.warnings) out.push(`    ! ${w}`);
  }
  return out.join("\n");
}
