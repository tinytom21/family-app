import { test } from "node:test";
import assert from "node:assert/strict";

import { buildShoppingList, solvePacks } from "../src/domain/aggregate.ts";
import { requireIngredient } from "../src/domain/catalogue.ts";
import { validatePlan } from "../src/validate.ts";
import { BAD_PLAN, CONSTRAINTS, GOOD_PLAN } from "../src/demo-data.ts";
import type { ShoppingList } from "../src/domain/types.ts";

const list = (): ShoppingList => buildShoppingList(GOOD_PLAN, CONSTRAINTS.pantry);
const lineFor = (l: ShoppingList, id: string) =>
  l.lines.find((x) => x.ingredientId === id);

/* ---------------- pack solving ---------------- */

test("pack solver buys the least food that covers the week", () => {
  const chicken = requireIngredient("chicken-breast"); // 300 g and 650 g packs

  // 800 g: one of each is 950 g, three small packs is 900 g. Without prices to
  // weigh against, the 50 g that does not get eaten is the thing to minimise.
  const eightHundred = solvePacks(800, chicken.packs);
  assert.equal(eightHundred.bought, 900);

  // 340 g: two small packs leave less over than one large one.
  const korma = solvePacks(340, chicken.packs);
  assert.equal(korma.bought, 600);
});

test("ties break towards fewer packs", () => {
  const tins = requireIngredient("tomato-tinned"); // singles and a 4-pack

  // Four tins either way, so take the one that is a single item to carry.
  const four = solvePacks(4, tins.packs);
  assert.equal(four.bought, 4);
  assert.equal(four.packs.reduce((n, p) => n + p.count, 0), 1);
  assert.equal(four.packs[0].pack.label, "4-tin multipack");
});

test("a multipack is not taken when it overshoots", () => {
  const tins = requireIngredient("tomato-tinned");
  // Three singles beat a four-pack: same job, one less tin left in the cupboard.
  const three = solvePacks(3, tins.packs);
  assert.equal(three.bought, 3);
  assert.equal(three.packs.reduce((n, p) => n + p.count, 0), 3);
});

test("pack solver never buys less than required", () => {
  const chicken = requireIngredient("chicken-breast");
  for (const need of [1, 50, 299, 300, 301, 649, 651, 1234, 5000]) {
    const solution = solvePacks(need, chicken.packs);
    assert.ok(
      solution.bought >= need,
      `bought ${solution.bought} for a requirement of ${need}`,
    );
  }
});

test("the solver never leaves the shopper short", () => {
  const chicken = requireIngredient("chicken-breast");
  for (const need of [1, 50, 299, 300, 301, 649, 651, 1234, 5000]) {
    const solution = solvePacks(need, chicken.packs);
    assert.ok(solution.bought >= need, `bought ${solution.bought} for ${need}`);
  }
});

/* ---------------- aggregation ---------------- */

test("the same ingredient in different units becomes one line", () => {
  const onion = lineFor(list(), "onion");
  assert.ok(onion, "expected an onion line");
  // Whole onions from three recipes plus 200 g from the ragù.
  const expected = 1 * (8 / 6) + 200 / 150 + 2 + 1;
  assert.equal(Number(onion.requiredBase.toFixed(1)), Number(expected.toFixed(1)));
  // Two 3-packs is six onions; the 1 kg bag is seven. Six covers it with less
  // left to go soft in the rack.
  assert.equal(onion.boughtBase, 6);
});

test("cloves aggregate across recipes and are bought as bulbs", () => {
  const garlic = lineFor(list(), "garlic");
  assert.ok(garlic, "expected a garlic line");
  const expected = 3 * (8 / 6) + 2 + 3 + 2; // stew scaled, ragù, korma, curry
  assert.equal(Number(garlic.requiredBase.toFixed(2)), Number(expected.toFixed(2)));
  assert.ok(garlic.boughtBase >= garlic.requiredBase);
  // 11 cloves is exactly one bulb — no reason to buy two.
  assert.equal(garlic.packs.reduce((n, p) => n + p.count, 0), 1);
});

test("leftovers are eaten twice and bought once", () => {
  const withLeftovers = list();
  const chorizo = lineFor(withLeftovers, "chorizo");
  assert.ok(chorizo);

  // Tuesday cooks 8 portions of a 6-portion recipe: 200 g x 8/6 = 266.7 g.
  // Wednesday eats the same pot, so it must not add anything.
  assert.equal(Number(chorizo.requiredBase.toFixed(1)), 266.7);

  // Sanity check the mechanism itself: drop the leftover marker and the
  // requirement goes up.
  const doubleCounted = buildShoppingList(
    {
      ...GOOD_PLAN,
      meals: GOOD_PLAN.meals.map((m) => ({ ...m, leftoverOf: undefined })),
    },
    CONSTRAINTS.pantry,
  );
  const naive = lineFor(doubleCounted, "chorizo")!;
  assert.ok(naive.requiredBase > chorizo.requiredBase);
});

test("the cupboard is subtracted, and fully covered items drop off the list", () => {
  const l = list();
  // 300 g of peas needed, 400 g already in the freezer.
  assert.equal(lineFor(l, "peas-frozen"), undefined);
  assert.ok(l.coveredByPantry.includes("Frozen peas"));

  // 550 g of rice needed against 500 g in the cupboard: 50 g still to buy.
  const rice = lineFor(l, "rice-basmati");
  assert.ok(rice, "expected a rice line");
  assert.equal(rice.requiredBase, 50);
});

test("staples are assumed present rather than bought every week", () => {
  const l = list();
  assert.equal(lineFor(l, "olive-oil"), undefined);
  assert.equal(lineFor(l, "salt"), undefined);
  assert.ok(l.assumedInPantry.some((s) => s.startsWith("Olive oil")));

  // Unless the shopper explicitly asks to restock.
  const restocked = buildShoppingList(GOOD_PLAN, CONSTRAINTS.pantry, {
    restockStaples: true,
  });
  assert.ok(lineFor(restocked, "olive-oil"));
});

test("surplus is reported so waste is visible", () => {
  const l = list();
  const chicken = lineFor(l, "chicken-breast");
  assert.ok(chicken);
  assert.equal(chicken.requiredBase, 340);
  assert.equal(chicken.boughtBase, 600);
  assert.equal(chicken.surplusBase, 260);

  // And counted, since it is now the number the solver optimises against.
  assert.equal(
    l.linesWithSurplus,
    l.lines.filter((line) => line.surplusBase > 0).length,
  );
  assert.ok(l.linesWithSurplus > 0);
});

test("the shopping list carries no prices at all", () => {
  // Prices vary too much between shops to be worth asserting, so nothing in
  // the output should imply we know one.
  const serialised = JSON.stringify(list());
  for (const word of ["cost", "price", "pence", "total"]) {
    assert.ok(
      !serialised.toLowerCase().includes(word),
      `"${word}" should not appear in a shopping list`,
    );
  }
});

test("every line knows which meals drove it", () => {
  const l = list();
  for (const line of l.lines) {
    assert.ok(line.usedBy.length > 0, `${line.ingredientId} has no source recipe`);
  }
  assert.deepEqual(lineFor(l, "beef-mince")!.usedBy, ["Beef ragù with penne"]);
});

test("a clean plan produces no warnings", () => {
  assert.deepEqual(list().warnings, []);
});

/* ---------------- validation ---------------- */

const weekSlots = [
  "2026-08-17",
  "2026-08-18",
  "2026-08-19",
  "2026-08-20",
  "2026-08-21",
  "2026-08-22",
  "2026-08-23",
].map((date) => ({ date, slot: "dinner" }));

test("the good plan passes every check", () => {
  const result = validatePlan(GOOD_PLAN, CONSTRAINTS, weekSlots);
  assert.deepEqual(
    result.violations.map((v) => v.code),
    [],
  );
});

test("there is no budget check, because there is no trustworthy total", () => {
  const codes = validatePlan(BAD_PLAN, CONSTRAINTS, weekSlots).violations.map(
    (v) => v.code,
  );
  assert.ok(!codes.includes("over-budget" as never));
});

test("the bad plan is caught on every axis that matters", () => {
  const codes = new Set(
    validatePlan(BAD_PLAN, CONSTRAINTS, weekSlots).violations.map((v) => v.code),
  );
  for (const expected of [
    "diet-conflict", // peanut butter, and Aria is allergic
    "too-slow-weeknight", // a four-hour braise on a Wednesday
    "protein-repetition", // chicken four nights
    "duplicate-recipe", // korma twice, unmarked
    "missing-slot", // no Sunday
    "unknown-recipe", // roast-partridge does not exist
    "unknown-ingredient", // red-wine is not in the catalogue
  ]) {
    assert.ok(codes.has(expected as never), `expected a ${expected} violation`);
  }
});

test("an allergen anywhere in a recipe fails the whole plan", () => {
  const violations = validatePlan(BAD_PLAN, CONSTRAINTS, weekSlots).violations;
  const allergy = violations.find((v) => v.code === "diet-conflict");
  assert.ok(allergy);
  assert.match(allergy.message, /Aria/);
  assert.match(allergy.message, /Peanut butter/i);
});

test("unknown ingredients warn instead of silently vanishing from the list", () => {
  const l = buildShoppingList(BAD_PLAN, CONSTRAINTS.pantry);
  assert.ok(l.warnings.some((w) => w.includes("red-wine")));
});
