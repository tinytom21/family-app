/**
 * Core domain types for meal planning -> shopping list.
 *
 * Design rule that everything else depends on:
 *   The LLM never invents ingredient strings. It selects canonical ingredients
 *   by `id` from a catalogue we control. That turns a fuzzy NLP problem
 *   ("is 'spring onion' the same as 'scallion'?") into constrained selection,
 *   which is the difference between a demo and a product.
 */

/** The three physical dimensions a quantity can live in. */
export type Dimension = "mass" | "volume" | "count";

/** Units we accept from recipes. Everything normalises to g / ml / unit. */
export type Unit =
  // mass
  | "g"
  | "kg"
  | "oz"
  | "lb"
  // volume
  | "ml"
  | "l"
  | "tsp"
  | "tbsp"
  | "cup"
  // count
  | "unit"
  | "clove"
  | "slice"
  | "tin"
  | "pack"
  // vague — contributes nothing to the list, but is tracked
  | "pinch"
  | "drizzle"
  | "to_taste";

export type Aisle =
  | "produce"
  | "meat-fish"
  | "dairy-eggs"
  | "bakery"
  | "ambient"
  | "frozen"
  | "household";

/** Dietary / allergen tags used for hard constraint checking. */
export type DietTag =
  | "meat"
  | "poultry"
  | "pork"
  | "beef"
  | "fish"
  | "shellfish"
  | "dairy"
  | "egg"
  | "gluten"
  | "nuts"
  | "peanut"
  | "soy"
  | "sesame"
  | "alcohol";

/**
 * A retail pack the shopper can actually put in the trolley.
 *
 * Deliberately no price. Pack sizes are stable enough across shops to be worth
 * modelling; prices are not, and a wrong total is worse than no total.
 */
export interface Pack {
  /** Size expressed in the ingredient's base unit (g, ml, or count). */
  readonly size: number;
  readonly label: string;
}

export interface CanonicalIngredient {
  readonly id: string;
  readonly name: string;
  readonly aisle: Aisle;
  /** Dimension the pack sizes are expressed in. */
  readonly base: Dimension;
  /** Mass of one countable unit, e.g. 1 onion = 150 g. Enables count <-> mass. */
  readonly gramsPerUnit?: number;
  /** Density in g/ml. Enables volume <-> mass, e.g. olive oil = 0.92. */
  readonly gramsPerMl?: number;
  readonly packs: readonly Pack[];
  /** Cupboard stocks assumed present; excluded from the list unless asked for. */
  readonly staple?: boolean;
  /**
   * Days from purchase to bin, once opened or unpacked. Only worth setting
   * where it differs from the sensible default for the aisle — see
   * `shelfLifeDays()` in larder.ts.
   */
  readonly shelfLifeDays?: number;
  readonly tags?: readonly DietTag[];
  /** Only used for importing third-party recipes; the LLM uses `id`. */
  readonly aliases?: readonly string[];
}

/** One line of a recipe, referencing the catalogue. */
export interface RecipeLine {
  readonly ingredientId: string;
  readonly amount: number;
  readonly unit: Unit;
  /** Free text like "finely chopped" — display only, never parsed. */
  readonly note?: string;
}

export interface Recipe {
  readonly id: string;
  readonly title: string;
  /** Servings this ingredient list produces, before scaling. */
  readonly serves: number;
  readonly prepMinutes: number;
  readonly cookMinutes: number;
  readonly lines: readonly RecipeLine[];
  /** Dominant protein, used for the variety constraint. */
  readonly protein?: string;
  readonly steps?: readonly string[];
}

export type MealSlot = "breakfast" | "lunch" | "dinner";

export interface PlannedMeal {
  /** ISO date, YYYY-MM-DD. */
  readonly date: string;
  readonly slot: MealSlot;
  readonly recipeId: string;
  /** How many people this sitting must feed. */
  readonly servings: number;
  /** Set when this meal is deliberately eating a previous cook's leftovers. */
  readonly leftoverOf?: string;
}

export interface MealPlan {
  readonly weekStarting: string;
  readonly meals: readonly PlannedMeal[];
  readonly recipes: readonly Recipe[];
}

/** What the household already has, in the ingredient's base unit. */
export interface PantryItem {
  readonly ingredientId: string;
  readonly amount: number;
}

export interface PlanConstraints {
  /** Profiles, not just names — see `people.ts`. */
  readonly people: readonly import("./people.ts").Person[];
  readonly weekStarting: string;
  /**
   * Default prep+cook ceilings. The reviewed week can lower these per day —
   * see `week` — but never raises them.
   */
  readonly maxWeeknightMinutes: number;
  readonly maxWeekendMinutes: number;
  /**
   * The week's grid: who is in for dinner each day, who is cooking, and how
   * long they have. Absent before anyone has set a week up, in which case the
   * blanket ceilings above apply and everyone is assumed to be in.
   */
  readonly week?: readonly import("./sitting.ts").DaySitting[];
  /** A protein may not appear as the dinner star more than this many times. */
  readonly maxSameProteinPerWeek: number;
  readonly pantry: readonly PantryItem[];
  /** Free-text steer, e.g. "we're trying to eat less red meat". */
  readonly notes?: string;
}

/* ---------- Shopping list output ---------- */

export interface ShoppingLine {
  readonly ingredientId: string;
  readonly name: string;
  readonly aisle: Aisle;
  /** What the recipes actually need, in base units, after pantry subtraction. */
  readonly requiredBase: number;
  readonly base: Dimension;
  /** Packs to actually buy. */
  readonly packs: readonly { pack: Pack; count: number }[];
  readonly boughtBase: number;
  /** boughtBase - requiredBase. The bit that rots in the fridge. */
  readonly surplusBase: number;
  /** Recipes that drove this line, for "why am I buying this?". */
  readonly usedBy: readonly string[];
}

export interface ShoppingList {
  readonly lines: readonly ShoppingLine[];
  /** Lines carrying leftover, and how much — the thing the solver minimises. */
  readonly linesWithSurplus: number;
  /** Staples assumed present rather than bought. */
  readonly assumedInPantry: readonly string[];
  /** Fully covered by pantry stock. */
  readonly coveredByPantry: readonly string[];
  readonly warnings: readonly string[];
}
