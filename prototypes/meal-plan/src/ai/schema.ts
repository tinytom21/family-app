/**
 * Response schema for the model's plan output (Gemini `response_format`).
 *
 * The load-bearing line in this file is the `enum` on `ingredientId`. By
 * constraining it to the catalogue, inventing "spring onions (or scallions)"
 * stops being possible rather than merely discouraged — constrained decoding
 * cannot emit a token outside the enum. Every downstream unit conversion then
 * has a guaranteed density and pack size to work with.
 *
 * Gemini's schema dialect (verified against the docs, Aug 2026):
 *   supported — type, properties, required, additionalProperties, enum, format,
 *               description, minimum, maximum, items, prefixItems, minItems,
 *               maxItems, and `null` as a type
 *   avoid     — anyOf. Nullable fields use a type union instead, e.g.
 *               `type: ["string", "null"]`.
 * Google also warns off very large or deeply nested schemas; a flat string enum
 * of a few dozen ids is well within what it handles happily.
 */

import { allIngredientIds } from "../domain/catalogue.ts";

const UNITS = [
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "tsp",
  "tbsp",
  "cup",
  "unit",
  "clove",
  "slice",
  "tin",
  "pack",
  "pinch",
  "drizzle",
  "to_taste",
];

/** Nullable string, spelled the way Gemini expects. */
const nullableString = (description: string) => ({
  type: ["string", "null"],
  description,
});

export function planResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reasoning", "recipes", "meals"],
    properties: {
      reasoning: {
        type: "string",
        description:
          "Two or three sentences on how this plan meets the budget, time and variety constraints. Shown to the user.",
      },
      recipes: {
        type: "array",
        minItems: 1,
        description: "Every recipe referenced by meals, defined exactly once.",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "title",
            "serves",
            "prepMinutes",
            "cookMinutes",
            "protein",
            "lines",
            "steps",
          ],
          properties: {
            id: {
              type: "string",
              description: "kebab-case, unique within this plan.",
            },
            title: { type: "string" },
            serves: {
              type: "integer",
              minimum: 1,
              description: "Portions this ingredient list produces.",
            },
            prepMinutes: { type: "integer", minimum: 0 },
            cookMinutes: {
              type: "integer",
              minimum: 0,
              description:
                "Hands-off time counts. A 40-minute oven bake is 40 minutes.",
            },
            protein: nullableString(
              "Dominant protein for variety checks: chicken, beef, pork, fish, eggs, pulses, or null.",
            ),
            lines: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["ingredientId", "amount", "unit", "note"],
                properties: {
                  ingredientId: {
                    type: "string",
                    enum: [...allIngredientIds()],
                    description:
                      "Must be a catalogue id. If an ingredient you want is absent, redesign the dish around what is listed.",
                  },
                  amount: { type: "number", minimum: 0 },
                  unit: { type: "string", enum: UNITS },
                  note: nullableString(
                    "Preparation note such as 'finely sliced'. Never a quantity.",
                  ),
                },
              },
            },
            steps: {
              type: "array",
              minItems: 2,
              items: { type: "string" },
              description: "Four to eight short imperative steps.",
            },
          },
        },
      },
      meals: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["date", "slot", "recipeId", "servings", "leftoverOf"],
          properties: {
            date: { type: "string", description: "YYYY-MM-DD." },
            slot: { type: "string", enum: ["breakfast", "lunch", "dinner"] },
            recipeId: { type: "string" },
            servings: {
              type: "number",
              minimum: 0,
              description: "Portions this sitting must produce.",
            },
            leftoverOf: nullableString(
              "Set to an earlier date (YYYY-MM-DD) when this meal eats that day's leftovers. Ingredients are then not bought twice.",
            ),
          },
        },
      },
    },
  };
}
