import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyStock,
  freezerCandidates,
  larderForPrompt,
  larderToPantry,
  projectLarder,
  shelfLifeDays,
} from "../src/domain/larder.ts";
import { buildShoppingList } from "../src/domain/aggregate.ts";
import { requireIngredient } from "../src/domain/catalogue.ts";
import { householdPortions } from "../src/domain/people.ts";
import { CONSTRAINTS, DEMO_LARDER, GOOD_PLAN, TODAY } from "../src/demo-data.ts";

const PORTIONS = householdPortions(CONSTRAINTS.people);
const project = () =>
  projectLarder(DEMO_LARDER, GOOD_PLAN, TODAY, PORTIONS);
const item = (id: string) =>
  project().items.find((i) => i.ingredientId === id);

test("things are classified by the question you ask about them", () => {
  assert.equal(classifyStock(requireIngredient("olive-oil")), "staple");
  assert.equal(classifyStock(requireIngredient("tomato-tinned")), "ambient");
  assert.equal(classifyStock(requireIngredient("spinach")), "fresh");
  assert.equal(classifyStock(requireIngredient("chicken-breast")), "fresh");
  assert.equal(classifyStock(requireIngredient("peas-frozen")), "frozen");
});

test("shelf life falls back to something sensible per aisle", () => {
  assert.equal(shelfLifeDays(requireIngredient("salmon-fillet")), 3);
  assert.equal(shelfLifeDays(requireIngredient("bread-wholemeal")), 4);
  assert.equal(shelfLifeDays(requireIngredient("onion")), 7);
  assert.equal(shelfLifeDays(requireIngredient("milk")), 10);
  assert.equal(shelfLifeDays(requireIngredient("rice-basmati")), 365);
});

test("stock is confirmed minus what the week will eat", () => {
  // 500 g of rice in the cupboard, 550 g needed across korma and curry.
  const rice = item("rice-basmati");
  assert.ok(rice);
  assert.equal(rice.confirmedAmount, 500);
  assert.equal(Math.round(rice.consumedByPlan), 550);
  assert.equal(rice.projectedAmount, 0, "cannot go negative");

  // 80 g of butter, 30 g used by the salmon.
  const butter = item("butter");
  assert.ok(butter);
  assert.equal(butter.projectedAmount, 50);
});

test("a figure nobody has checked recently is marked stale, not guessed at", () => {
  const carrot = item("carrot");
  assert.ok(carrot);
  assert.equal(carrot.confidence, "stale");
  assert.ok(carrot.daysSinceConfirmed > 20);
});

test("stale stock is not subtracted from the shop", () => {
  // The asymmetry: a spare 85p bag of carrots beats being wrong at 18:30.
  const pantry = larderToPantry(project());
  assert.ok(
    !pantry.some((p) => p.ingredientId === "carrot"),
    "a stale entry must not reduce the shopping list",
  );
  assert.ok(pantry.some((p) => p.ingredientId === "rice-basmati"));

  const list = buildShoppingList(GOOD_PLAN, pantry);
  assert.ok(
    list.lines.some((l) => l.ingredientId === "carrot"),
    "carrots should still be bought",
  );
});

test("food that will turn before the plan uses it is flagged", () => {
  const projection = project();
  const yoghurt = projection.items.find(
    (i) => i.ingredientId === "yoghurt-greek",
  );
  assert.ok(yoghurt);
  // 400 g in the fridge, the korma uses 100 g, best before lands mid-plan.
  assert.equal(yoghurt.projectedAmount, 300);
  assert.equal(yoghurt.wasteRisk, true);
  assert.ok(projection.useUpFirst.some((i) => i.ingredientId === "yoghurt-greek"));
});

test("nothing with a long life is treated as a waste risk", () => {
  const projection = project();
  for (const i of projection.useUpFirst) {
    assert.equal(i.stockClass, "fresh", `${i.name} should not be a waste risk`);
  }
});

test("waste risks sort to the top, because that is the useful order", () => {
  const items = project().items;
  const firstSafe = items.findIndex((i) => !i.wasteRisk);
  const lastRisk = items.map((i) => i.wasteRisk).lastIndexOf(true);
  assert.ok(lastRisk < firstSafe || firstSafe === -1);
});

/** GOOD_PLAN with a bigger Tuesday batch, without disturbing the shared fixture. */
const withBatch = (servings: number) => ({
  ...GOOD_PLAN,
  meals: GOOD_PLAN.meals.map((m) =>
    m.date === "2026-08-18" ? { ...m, servings } : m,
  ),
});

test("the freezer log writes itself from batch cooks", () => {
  // Tuesday cooks 11 portions; the family eats 3.2 that night and 3.2 again on
  // Thursday, leaving 4.6 over. Nobody had to type that. Only whole portions
  // are offered, because half a tub is not a meal.
  const candidates = freezerCandidates(withBatch(11), PORTIONS);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recipeId, "chorizo-chickpea-stew");
  assert.equal(candidates[0].sparePortions, 4);
  assert.equal(candidates[0].date, "2026-08-18");
});

test("a spare portion or two is lunch, not a freezer job", () => {
  // The fixture week leaves 1.6 portions over on Tuesday and about one on
  // every other night — real, but not worth a container and a label.
  assert.deepEqual(freezerCandidates(GOOD_PLAN, PORTIONS), []);
  assert.deepEqual(freezerCandidates(withBatch(8.3), PORTIONS), []);
});

test("the prompt view carries dates only where they matter", () => {
  const lines = larderForPrompt(project());
  assert.ok(lines.some((l) => l.includes("yoghurt-greek") && l.includes("USE BY")));
  assert.ok(lines.some((l) => l.startsWith("rice-basmati")));
  assert.ok(!lines.some((l) => l.startsWith("carrot")), "stale entries stay out");
  assert.ok(lines.some((l) => l.includes("freezer: 2 portions")));
});
