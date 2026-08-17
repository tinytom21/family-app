/**
 * Hard validation of a generated plan.
 *
 * The model is good at proposing meals and bad at guaranteeing invariants.
 * Anything a family would actually be upset about — an allergen on the plate,
 * a 90-minute recipe on a Tuesday, chicken five nights running, blowing the
 * budget — is checked here in deterministic code, and any violation is fed
 * back for a targeted repair. Never ship an LLM plan straight to the user.
 */

import { getIngredient } from "./domain/catalogue.ts";
import { householdExclusions, portionFor, whoExcludes } from "./domain/people.ts";
import type { MealPlan, PlanConstraints, Recipe } from "./domain/types.ts";

export type ViolationCode =
  | "unknown-recipe"
  | "unknown-ingredient"
  | "diet-conflict"
  | "too-slow-weeknight"
  | "too-slow-weekend"
  | "too-slow-for-the-day"
  | "nobody-to-cook"
  | "protein-repetition"
  | "duplicate-recipe"
  | "missing-slot"
  | "under-portioned";

export interface Violation {
  readonly code: ViolationCode;
  /** Written for the model to act on: says what is wrong and what to change. */
  readonly message: string;
  readonly recipeId?: string;
  readonly date?: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
}

export function validatePlan(
  plan: MealPlan,
  constraints: PlanConstraints,
  expectedSlots: readonly { date: string; slot: string }[],
): ValidationResult {
  const violations: Violation[] = [];
  const recipesById = new Map(plan.recipes.map((r) => [r.id, r]));

  // Allergies are household-wide whoever is at the table that night; see
  // `householdExclusions` for why relaxing them per sitting is unsafe.
  const excluded = householdExclusions(constraints.people);
  const everyone = constraints.people.reduce((sum, p) => sum + portionFor(p), 0);

  const weekByDate = new Map(
    (constraints.week ?? []).map((day) => [day.date, day]),
  );
  /** Portions needed on a given day: who is actually in, if we know. */
  const portionsOn = (date: string): number =>
    weekByDate.get(date)?.portions ?? everyone;

  /* ---- structure ---- */
  for (const meal of plan.meals) {
    if (!recipesById.has(meal.recipeId)) {
      violations.push({
        code: "unknown-recipe",
        date: meal.date,
        recipeId: meal.recipeId,
        message: `Meal on ${meal.date} (${meal.slot}) references recipe "${meal.recipeId}", which is not in the recipes array. Add the full recipe or use a different one.`,
      });
    }
    const needed = portionsOn(meal.date);
    if (meal.servings + 1e-6 < needed && !meal.leftoverOf) {
      const day = weekByDate.get(meal.date);
      const who = day
        ? ` (${day.attendance.filter((a) => a.present).map((a) => a.name).join(", ")})`
        : "";
      violations.push({
        code: "under-portioned",
        date: meal.date,
        recipeId: meal.recipeId,
        message: `Meal on ${meal.date} (${meal.slot}) serves ${meal.servings} but ${needed} portions are needed that day${who}. Increase servings.`,
      });
    }
  }

  for (const recipe of plan.recipes) {
    for (const line of recipe.lines) {
      const ingredient = getIngredient(line.ingredientId);
      if (!ingredient) {
        violations.push({
          code: "unknown-ingredient",
          recipeId: recipe.id,
          message: `Recipe "${recipe.title}" uses ingredient id "${line.ingredientId}", which is not in the catalogue. Replace it with a catalogue id.`,
        });
        continue;
      }
      /* ---- diet ---- */
      const clash = (ingredient.tags ?? []).filter((t) => excluded.has(t));
      if (clash.length > 0) {
        const who = whoExcludes(constraints.people, clash).join(", ");
        violations.push({
          code: "diet-conflict",
          recipeId: recipe.id,
          message: `Recipe "${recipe.title}" contains ${ingredient.name} (${clash.join(", ")}), which ${who} cannot eat. Replace this recipe entirely.`,
        });
      }
    }
  }

  /* ---- time ---- */
  for (const meal of plan.meals) {
    const recipe = recipesById.get(meal.recipeId);
    if (!recipe || meal.slot !== "dinner" || meal.leftoverOf) continue;

    const total = recipe.prepMinutes + recipe.cookMinutes;
    const weekend = isWeekend(meal.date);
    const blanket = weekend
      ? constraints.maxWeekendMinutes
      : constraints.maxWeeknightMinutes;

    const day = weekByDate.get(meal.date);

    // A day with nobody free to cook is not a day for a faster recipe; it is a
    // day for something that needs no cooking at all.
    if (day && !day.cookId) {
      violations.push({
        code: "nobody-to-cook",
        date: meal.date,
        recipeId: recipe.id,
        message: `"${recipe.title}" is planned for ${meal.date}, but nobody is free to cook that evening. ${day.note} Mark this meal as leftovers from an earlier day, or replace it with something that needs no cooking.`,
      });
      continue;
    }

    // The person cooking knows better than the rule of thumb.
    const limit = day ? day.cookMinutes : blanket;
    if (total <= limit) continue;

    if (day && day.cookMinutes < blanket) {
      violations.push({
        code: "too-slow-for-the-day",
        date: meal.date,
        recipeId: recipe.id,
        message: `"${recipe.title}" on ${meal.date} takes ${total} min, but ${day.cookName} only has ${limit} min to cook that evening. ${day.note} Use a faster recipe, plan leftovers from another night, or move this meal.`,
      });
    } else {
      violations.push({
        code: weekend ? "too-slow-weekend" : "too-slow-weeknight",
        date: meal.date,
        recipeId: recipe.id,
        message: `"${recipe.title}" on ${meal.date} takes ${total} min (prep ${recipe.prepMinutes} + cook ${recipe.cookMinutes}) but the limit for that day is ${limit} min. Swap it for something faster, or move it to a weekend.`,
      });
    }
  }

  /* ---- variety ---- */
  const proteinCount = new Map<string, number>();
  const recipeCount = new Map<string, number>();
  for (const meal of plan.meals) {
    if (meal.slot !== "dinner" || meal.leftoverOf) continue;
    const recipe = recipesById.get(meal.recipeId);
    if (!recipe) continue;
    recipeCount.set(recipe.id, (recipeCount.get(recipe.id) ?? 0) + 1);
    if (recipe.protein) {
      proteinCount.set(
        recipe.protein,
        (proteinCount.get(recipe.protein) ?? 0) + 1,
      );
    }
  }
  for (const [protein, count] of proteinCount) {
    if (count > constraints.maxSameProteinPerWeek) {
      violations.push({
        code: "protein-repetition",
        message: `${protein} is the main protein at ${count} dinners; the limit is ${constraints.maxSameProteinPerWeek}. Replace ${count - constraints.maxSameProteinPerWeek} of them with a different protein.`,
      });
    }
  }
  for (const [recipeId, count] of recipeCount) {
    if (count > 1) {
      const title = recipesById.get(recipeId)?.title ?? recipeId;
      violations.push({
        code: "duplicate-recipe",
        recipeId,
        message: `"${title}" is cooked ${count} times this week. If that is intentional, mark the later ones with leftoverOf; otherwise replace them.`,
      });
    }
  }

  /* ---- coverage ---- */
  const filled = new Set(plan.meals.map((m) => `${m.date}|${m.slot}`));
  for (const want of expectedSlots) {
    if (!filled.has(`${want.date}|${want.slot}`)) {
      violations.push({
        code: "missing-slot",
        date: want.date,
        message: `No meal planned for ${want.date} ${want.slot}. Every requested slot must be filled.`,
      });
    }
  }

  // There is deliberately no budget check. Prices vary too much between shops
  // to assert one, and a hard constraint built on a number we cannot trust
  // would fail plans for the wrong reason. Frugality is steered in the prompt
  // instead, where being approximately right is good enough.

  return { ok: violations.length === 0, violations };
}

export function isWeekend(isoDate: string): boolean {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Recipes whose ingredients are all in the catalogue — for a quick sanity pass. */
export function unknownIngredientIds(recipes: readonly Recipe[]): string[] {
  const bad = new Set<string>();
  for (const r of recipes) {
    for (const l of r.lines) {
      if (!getIngredient(l.ingredientId)) bad.add(l.ingredientId);
    }
  }
  return [...bad].sort();
}
