import { test } from "node:test";
import assert from "node:assert/strict";

import { planResponseSchema } from "../src/ai/schema.ts";
import { toAnthropicDialect, toGeminiDialect } from "../src/ai/dialect.ts";
import { allIngredientIds } from "../src/domain/catalogue.ts";
import { slotsForWeek } from "../src/ai/planner.ts";

const schema = planResponseSchema() as Record<string, any>;

const collectObjects = (root: unknown): Record<string, any>[] => {
  const found: Record<string, any>[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, any>;
    if (n.type === "object") found.push(n);
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(root);
  return found;
};

test("ingredientId is constrained to the catalogue, not free text", () => {
  const ids =
    schema.properties.recipes.items.properties.lines.items.properties
      .ingredientId.enum;
  assert.deepEqual([...ids].sort(), [...allIngredientIds()].sort());
  assert.ok(ids.length > 20, "catalogue looks suspiciously small");
});

test("every object is closed and fully required", () => {
  const objects = collectObjects(schema);
  assert.ok(objects.length >= 4, "expected several object schemas");
  for (const obj of objects) {
    assert.equal(obj.additionalProperties, false);
    assert.deepEqual(
      [...(obj.required ?? [])].sort(),
      Object.keys(obj.properties ?? {}).sort(),
      "required must list every property; optional fields are nullable instead",
    );
  }
});

/* ---------------- dialect adapters ---------------- */

test("the Gemini dialect is the canonical form, unchanged", () => {
  assert.deepEqual(toGeminiDialect(schema), schema);
});

test("the Anthropic dialect drops the keywords Anthropic rejects", () => {
  const converted = toAnthropicDialect(schema);
  const json = JSON.stringify(converted);
  for (const keyword of [
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "pattern",
  ]) {
    assert.ok(
      !json.includes(`"${keyword}"`),
      `"${keyword}" is not supported by Anthropic structured outputs`,
    );
  }
});

test("the Anthropic dialect rewrites nullable unions as anyOf", () => {
  const converted = toAnthropicDialect(schema) as Record<string, any>;
  const protein = converted.properties.recipes.items.properties.protein;

  assert.ok(Array.isArray(protein.anyOf), "expected an anyOf branch");
  assert.deepEqual(
    protein.anyOf.map((b: any) => b.type).sort(),
    ["null", "string"],
  );
  assert.ok(!("type" in protein), "the type array should be gone");
  assert.ok(protein.description, "the description should survive the rewrite");
});

test("the canonical schema keeps the bounds Gemini can enforce", () => {
  const recipe = schema.properties.recipes.items.properties;
  assert.equal(recipe.serves.minimum, 1);
  assert.equal(recipe.lines.items.properties.amount.minimum, 0);
  assert.equal(schema.properties.recipes.minItems, 1);
});

test("dropping bounds for Anthropic is safe because code re-checks them", () => {
  // The schema is a fast path, never the guarantee. Anything stripped here is
  // still enforced by validate.ts on the parsed plan, so both providers are
  // held to the same standard.
  const converted = toAnthropicDialect(schema) as Record<string, any>;
  assert.equal(
    converted.properties.recipes.items.properties.serves.minimum,
    undefined,
  );
  assert.equal(
    converted.properties.recipes.items.properties.serves.type,
    "integer",
    "the type itself must survive",
  );
});

test("converting twice changes nothing further", () => {
  const once = toAnthropicDialect(schema);
  const twice = toAnthropicDialect(once as Record<string, any>);
  assert.deepEqual(twice, once);
});

test("the canonical schema is untouched by conversion", () => {
  const before = JSON.stringify(schema);
  toAnthropicDialect(schema);
  assert.equal(JSON.stringify(schema), before, "conversion must not mutate");
});

test("both dialects serialise to plain JSON", () => {
  for (const s of [toGeminiDialect(schema), toAnthropicDialect(schema)]) {
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
    assert.ok(JSON.stringify(s).length > 500);
  }
});

test("a week of dinner slots is seven consecutive days", () => {
  const slots = slotsForWeek("2026-08-17");
  assert.equal(slots.length, 7);
  assert.equal(slots[0].date, "2026-08-17");
  assert.equal(slots[6].date, "2026-08-23");
});
