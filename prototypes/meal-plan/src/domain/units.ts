/**
 * Unit normalisation and cross-dimension conversion.
 *
 * This is where most meal-planner apps quietly go wrong. Recipe A says
 * "2 tbsp olive oil", recipe B says "60 ml", recipe C says "a drizzle".
 * Adding those needs a density; adding "2 onions" to "300 g onion" needs a
 * per-unit mass. When a conversion is impossible we return an explicit
 * failure rather than a plausible-looking number, because a silently wrong
 * shopping list is worse than a visibly incomplete one.
 */

import type { CanonicalIngredient, Dimension, Unit } from "./types.ts";

/** Units carrying no measurable quantity. Tracked, never added. */
export const VAGUE_UNITS: readonly Unit[] = ["pinch", "drizzle", "to_taste"];

const UNIT_DIMENSION: Record<Unit, Dimension | "vague"> = {
  g: "mass",
  kg: "mass",
  oz: "mass",
  lb: "mass",
  ml: "volume",
  l: "volume",
  tsp: "volume",
  tbsp: "volume",
  cup: "volume",
  unit: "count",
  clove: "count",
  slice: "count",
  tin: "count",
  pack: "count",
  pinch: "vague",
  drizzle: "vague",
  to_taste: "vague",
};

/** Multiplier to the dimension's base unit: g, ml, or a single item. */
const TO_BASE: Record<Unit, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
  ml: 1,
  l: 1000,
  tsp: 5,
  tbsp: 15,
  // Recipes on the internet are overwhelmingly US-cup; a UK cup is 250 ml.
  // Getting this wrong is a 4% error, which is invisible and therefore nasty.
  cup: 240,
  unit: 1,
  clove: 1,
  slice: 1,
  tin: 1,
  pack: 1,
  pinch: 0,
  drizzle: 0,
  to_taste: 0,
};

export function dimensionOf(unit: Unit): Dimension | "vague" {
  return UNIT_DIMENSION[unit];
}

export function isVague(unit: Unit): boolean {
  return UNIT_DIMENSION[unit] === "vague";
}

export type ConversionResult =
  | { readonly ok: true; readonly value: number; readonly dimension: Dimension }
  | { readonly ok: false; readonly reason: string };

/**
 * Convert `amount` of `unit` into `ingredient`'s base dimension.
 *
 * Cross-dimension hops need a bridging constant on the ingredient:
 *   volume <-> mass  needs gramsPerMl
 *   count  <-> mass  needs gramsPerUnit
 *   count  <-> volume needs both
 */
export function toBase(
  amount: number,
  unit: Unit,
  ingredient: CanonicalIngredient,
): ConversionResult {
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, reason: `invalid amount ${amount}` };
  }
  const from = UNIT_DIMENSION[unit];
  if (from === "vague") {
    return { ok: true, value: 0, dimension: ingredient.base };
  }

  const inFromBase = amount * TO_BASE[unit];
  const target = ingredient.base;
  if (from === target) {
    return { ok: true, value: inFromBase, dimension: target };
  }

  const { gramsPerMl, gramsPerUnit } = ingredient;
  const need = (what: string) =>
    ({
      ok: false as const,
      reason: `cannot convert ${unit} -> ${target} for "${ingredient.id}": missing ${what}`,
    });

  // Everything routes through grams, which is the only dimension both
  // bridging constants are defined against.
  let grams: number;
  switch (from) {
    case "mass":
      grams = inFromBase;
      break;
    case "volume":
      if (gramsPerMl === undefined) return need("gramsPerMl");
      grams = inFromBase * gramsPerMl;
      break;
    case "count":
      if (gramsPerUnit === undefined) return need("gramsPerUnit");
      grams = inFromBase * gramsPerUnit;
      break;
  }

  switch (target) {
    case "mass":
      return { ok: true, value: grams, dimension: "mass" };
    case "volume":
      if (gramsPerMl === undefined) return need("gramsPerMl");
      return { ok: true, value: grams / gramsPerMl, dimension: "volume" };
    case "count":
      if (gramsPerUnit === undefined) return need("gramsPerUnit");
      return { ok: true, value: grams / gramsPerUnit, dimension: "count" };
  }
}

/** Render a base-unit amount the way a human would write it on a list. */
export function formatBase(value: number, dimension: Dimension): string {
  switch (dimension) {
    case "mass":
      return value >= 1000
        ? `${trim(value / 1000)} kg`
        : `${trim(round(value, 0))} g`;
    case "volume":
      return value >= 1000
        ? `${trim(value / 1000)} L`
        : `${trim(round(value, 0))} ml`;
    case "count": {
      const n = round(value, 1);
      return n === 1 ? "1" : `${trim(n)}`;
    }
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function trim(n: number): string {
  return Number(n.toFixed(2)).toString();
}
