import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIDENT,
  parseSize,
  planBasket,
  rankCandidates,
  scoreMatch,
} from "../src/domain/basket.ts";
import type { ProductLink, RetailerProduct } from "../src/domain/basket.ts";
import { requireIngredient } from "../src/domain/catalogue.ts";
import type { ShoppingLine } from "../src/domain/types.ts";

/* ---------------- reading a size off a shelf label ---------------- */

test("sizes are read however the retailer writes them", () => {
  assert.deepEqual(parseSize("Tesco Baby Spinach 240G"), {
    amount: 240,
    base: "mass",
    units: 1,
  });
  assert.deepEqual(parseSize("Tesco British Semi Skimmed Milk 2.27L"), {
    amount: 2270,
    base: "volume",
    units: 1,
  });
  assert.deepEqual(parseSize("Tesco Beef Mince 1kg"), {
    amount: 1000,
    base: "mass",
    units: 1,
  });
});

test("a multipack is its total, not the size of one", () => {
  // "4 x 400g" read as 400 g is how you end up ordering a quarter of the food.
  assert.deepEqual(parseSize("Tesco Chopped Tomatoes 4 x 400g"), {
    amount: 1600,
    base: "mass",
    units: 4,
  });
});

test("counted packs are counted", () => {
  assert.deepEqual(parseSize("Tesco Large Free Range Eggs 6 Pack"), {
    amount: 6,
    base: "count",
    units: 6,
  });
});

test("a title with no size says so rather than inventing one", () => {
  assert.equal(parseSize("Tesco Garlic"), null);
  assert.equal(parseSize("Tesco Finest Sourdough"), null);
});

/* ---------------- scoring a candidate ---------------- */

const product = (title: string, sku = "sku"): RetailerProduct => ({ sku, title });

test("the right product at the right size scores highest", () => {
  const mince = requireIngredient("beef-mince"); // "Beef mince, 5% fat", 500 g pack
  const ranked = rankCandidates(mince, 500, [
    product("Tesco Chicken Breast Fillets 500G", "wrong-thing"),
    product("Tesco Beef Mince 20% Fat 1kg", "wrong-size"),
    product("Tesco Lean Beef Steak Mince 5% Fat 500g", "right"),
  ]);

  assert.equal(ranked[0].product.sku, "right");
  assert.ok(ranked[0].score >= CONFIDENT, `scored only ${ranked[0].score}`);
  assert.match(ranked[0].why, /size matches/);
});

test("the same product in the wrong size is demoted, not discarded", () => {
  // Still offered — sometimes the big one is what you want — but never the
  // default, because a 2 kg tin arriving instead of a 400 g one is a real cost.
  const mince = requireIngredient("beef-mince");
  const ranked = rankCandidates(mince, 500, [
    product("Tesco Beef Mince 5% Fat 1kg", "big"),
    product("Tesco Beef Mince 5% Fat 500g", "right"),
  ]);
  assert.equal(ranked[0].product.sku, "right");
  assert.equal(ranked[1].product.sku, "big");
  assert.ok(ranked[1].score < ranked[0].score);
  assert.match(ranked[1].why, /different size/);
});

test("own-brand words do not count towards a match", () => {
  // Otherwise "Tesco" matching "Tesco" makes every product look plausible.
  const garlic = requireIngredient("garlic");
  const good = scoreMatch(garlic, 1, product("Tesco Garlic"));
  const bad = scoreMatch(garlic, 1, product("Tesco Finest British Fresh Cream"));
  assert.ok(good.score > bad.score);
  assert.equal(bad.why.startsWith("0/"), true, `got "${bad.why}"`);
});

test("nothing plausible means nothing is confident", () => {
  const mince = requireIngredient("beef-mince");
  const ranked = rankCandidates(mince, 500, [
    product("Tesco Toilet Tissue 9 Roll"),
    product("Tesco Washing Up Liquid 500ml"),
  ]);
  assert.ok(
    ranked.every((r) => r.score < CONFIDENT),
    `something scored ${ranked[0].score}`,
  );
});

/* ---------------- turning a list into a basket ---------------- */

const line = (
  ingredientId: string,
  name: string,
  packs: { size: number; label: string; count: number }[],
): ShoppingLine => ({
  ingredientId,
  name,
  aisle: "ambient",
  requiredBase: 0,
  base: "mass",
  packs: packs.map((p) => ({ pack: { size: p.size, label: p.label }, count: p.count })),
  boughtBase: 0,
  surplusBase: 0,
  usedBy: [],
});

const link = (ingredientId: string, packSize: number, sku: string): ProductLink => ({
  ingredientId,
  packSize,
  sku,
  title: `A ${ingredientId}`,
  confirmedOn: "2026-09-08",
});

test("confirmed products become basket quantities from the pack solver", () => {
  const plan = planBasket(
    [line("tomato-tinned", "Chopped tomatoes", [{ size: 400, label: "400 g tin", count: 4 }])],
    [link("tomato-tinned", 400, "tesco-123")],
  );

  assert.deepEqual(plan.items, [
    {
      sku: "tesco-123",
      title: "A tomato-tinned",
      quantity: 4,
      ingredientId: "tomato-tinned",
      packSize: 400,
      packLabel: "400 g tin",
    },
  ]);
  assert.deepEqual(plan.needsChoosing, []);
});

test("an unmatched line asks rather than guesses", () => {
  // A wrong guess turns up in a delivery; a missing one turns up in this list.
  const plan = planBasket(
    [line("spinach", "Baby spinach", [{ size: 240, label: "240 g bag", count: 1 }])],
    [],
  );

  assert.deepEqual(plan.items, []);
  assert.equal(plan.needsChoosing.length, 1);
  assert.deepEqual(plan.needsChoosing[0], {
    ingredientId: "spinach",
    name: "Baby spinach",
    packSize: 240,
    packLabel: "240 g bag",
    quantity: 1,
  });
});

test("a link for one pack size does not satisfy another", () => {
  // The 650 g chicken and the 300 g chicken are different products; reusing the
  // mapping would order the wrong weight and never mention it.
  const plan = planBasket(
    [
      line("chicken-breast", "Chicken breast", [
        { size: 300, label: "300 g pack", count: 1 },
        { size: 650, label: "650 g pack", count: 1 },
      ]),
    ],
    [link("chicken-breast", 300, "small-pack")],
  );

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].sku, "small-pack");
  assert.equal(plan.needsChoosing.length, 1);
  assert.equal(plan.needsChoosing[0].packSize, 650);
});

test("a week of confirmed links produces a complete basket", () => {
  const lines = [
    line("tomato-tinned", "Chopped tomatoes", [{ size: 400, label: "400 g tin", count: 4 }]),
    line("spinach", "Baby spinach", [{ size: 240, label: "240 g bag", count: 1 }]),
  ];
  const plan = planBasket(lines, [
    link("tomato-tinned", 400, "a"),
    link("spinach", 240, "b"),
  ]);

  assert.deepEqual(plan.needsChoosing, [], "nothing left to decide");
  assert.equal(plan.items.reduce((n, i) => n + i.quantity, 0), 5);
});

test("a specification like 5% fat separates two otherwise identical products", () => {
  // Real Tesco results. Scored on the search term alone these tie, because the
  // search term drops everything after the comma — so the wrong fat content
  // would have been pre-selected every week, silently, forever.
  const mince = requireIngredient("beef-mince"); // "Beef mince, 5% fat"
  const ranked = rankCandidates(mince, 500, [
    product("Tesco Beef Mince 20% Fat 500g", "fatty"),
    product("Tesco Lean Beef Steak Mince 5% Fat 500g", "lean"),
  ]);

  assert.equal(ranked[0].product.sku, "lean");
  assert.ok(
    ranked[0].score > ranked[1].score,
    `tied at ${ranked[0].score} — the percentage is being thrown away again`,
  );
});

test("a bare number is a size and does not count as a match", () => {
  // Otherwise "500g" in a title matches "500 g pack" and every product looks
  // right. Sizes are compared numerically, not as words.
  const mince = requireIngredient("beef-mince");
  const irrelevant = scoreMatch(mince, 500, product("Tesco Kitchen Foil 500g"));
  assert.ok(irrelevant.score < CONFIDENT, `scored ${irrelevant.score}`);
});

test("only a whole-name, right-size match is ticked on the family's behalf", () => {
  const mince = requireIngredient("beef-mince");
  const ranked = rankCandidates(mince, 500, [
    product("Tesco Lean Beef Mince 5% Fat 500g", "right"),
    product("Tesco Beef Mince 20% Fat 500g", "wrong-spec"),
    product("Tesco Lean Beef Mince 5% Fat 1.5kg", "wrong-size"),
  ]);
  const by = (sku: string) => ranked.find((r) => r.product.sku === sku)!;

  assert.equal(by("right").preselect, true);
  // Both of these clear the score threshold comfortably, and both would turn
  // up in a delivery as the wrong thing if they were ticked by default.
  assert.equal(by("wrong-spec").preselect, false, `scored ${by("wrong-spec").score}`);
  assert.equal(by("wrong-size").preselect, false, `scored ${by("wrong-size").score}`);
});

test("when the right size is not in the results, nothing is ticked", () => {
  // The top result is then a wrong size, and pre-selecting "the best we have"
  // is how 1.5 kg of mince replaces 500 g without anyone noticing.
  const mince = requireIngredient("beef-mince");
  const ranked = rankCandidates(mince, 500, [
    product("Tesco Lean Beef Mince 5% Fat 1.5kg"),
    product("Tesco Lean Beef Mince 5% Fat 250g"),
  ]);
  assert.equal(ranked.some((r) => r.preselect), false);
});
