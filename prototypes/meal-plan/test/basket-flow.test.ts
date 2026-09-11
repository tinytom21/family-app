import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app-state.ts";
import type { BasketProvider, RetailerProduct } from "../src/domain/basket.ts";
import { requireIngredient } from "../src/domain/catalogue.ts";

const DRAFT = {
  householdName: "The Hardys",
  people: [
    { name: "Tom", ageBracket: "adult" },
    { name: "Priya", ageBracket: "adult" },
  ],
};

/** A shop whose shelf each test stocks, once it knows what the list needs. */
function fakeShop() {
  const shelf: RetailerProduct[] = [];
  const provider: BasketProvider = {
    id: "fake",
    async search() {
      return shelf;
    },
    async set() {},
    async basket() {
      return [];
    },
    async checkoutUrl() {
      return "https://www.tesco.com/groceries/en-GB/trolley";
    },
  };
  return { shelf, provider };
}

async function setUp() {
  const shop = fakeShop();
  const app = createApp({
    today: "2026-09-11",
    basket: { available: true, provider: shop.provider, signedIn: async () => true },
  });
  await app.handle("/api/household/create", DRAFT);
  const plan: any = (await app.handle("/api/basket/plan", {})).body;

  // Any line bought by weight will do, because its size can go on a label.
  const need = plan.needsChoosing.find(
    (n: any) => requireIngredient(n.ingredientId).base === "mass",
  );
  assert.ok(need, "the starter week buys something by weight");
  const name = requireIngredient(need.ingredientId).name.replace(/,/g, "");
  const label = (grams: number) => `Tesco ${name} ${grams}g`;

  const lookup = async () => {
    const now: any = (await app.handle("/api/basket/plan", {})).body;
    const same = (l: any) =>
      l.ingredientId === need.ingredientId && l.packSize === need.packSize;
    return { item: now.items.find(same), stillNeeded: now.needsChoosing.some(same) };
  };
  const ask = (path: string, extra = {}) =>
    app.handle(path, { ingredientId: need.ingredientId, packSize: need.packSize, ...extra });

  return { app, shop, need, label, lookup, ask };
}

const PAGE = "https://www.tesco.com/groceries/en-GB/products/254656543";

test("Find all puts a 100% match straight in, and marks it as not a person's choice", async () => {
  const { shop, need, label, lookup, ask } = await setUp();
  shop.shelf.push({
    sku: "exact",
    title: label(need.packSize),
    price: { each: 3.5, perUnit: 7, unit: "kg" },
    url: PAGE,
  });

  const res: any = (await ask("/api/basket/match")).body;
  assert.equal(res.linked?.sku, "exact");

  const { item, stillNeeded } = await lookup();
  assert.equal(stillNeeded, false);
  assert.equal(item.sku, "exact");
  assert.equal(item.auto, true);
  assert.equal(item.url, PAGE);
  assert.deepEqual(item.price, { each: 3.5, perUnit: 7, unit: "kg" });
  assert.equal(item.chosenOn, "2026-09-11");
});

test("anything short of a 100% match is shown, not chosen", async () => {
  const { shop, need, label, lookup, ask } = await setUp();
  shop.shelf.push(
    { sku: "big", title: label(need.packSize * 2) },
    { sku: "near", title: label(Math.round(need.packSize * 0.9)) },
  );

  const res: any = (await ask("/api/basket/match")).body;
  assert.equal(res.linked, null);
  assert.deepEqual(
    res.candidates.map((c: any) => c.product.sku),
    ["near", "big"],
  );
  assert.equal((await lookup()).stillNeeded, true);
});

test("an exact match that is out of stock is shown, not chosen", async () => {
  const { shop, need, label, lookup, ask } = await setUp();
  shop.shelf.push({ sku: "gone", title: label(need.packSize), available: false });

  const res: any = (await ask("/api/basket/match")).body;
  assert.equal(res.linked, null);
  assert.equal((await lookup()).stillNeeded, true);
});

test("looking at the options for one line never chooses for you", async () => {
  const { shop, need, label, lookup, ask } = await setUp();
  shop.shelf.push({ sku: "exact", title: label(need.packSize) });

  const res: any = (await ask("/api/basket/candidates")).body;
  assert.equal(res.candidates[0].perfect, true);
  assert.equal(res.linked, null);
  assert.equal((await lookup()).stillNeeded, true);
});

test("choosing by hand replaces an automatic match and is not marked automatic", async () => {
  const { shop, need, label, lookup, ask } = await setUp();
  shop.shelf.push({ sku: "exact", title: label(need.packSize) });
  await ask("/api/basket/match");

  await ask("/api/basket/link", {
    sku: "other",
    title: "Something the family prefers",
    url: PAGE,
    price: { each: 4, perUnit: 8, unit: "kg" },
  });

  const { item } = await lookup();
  assert.equal(item.sku, "other");
  assert.equal(item.auto, undefined);
  assert.deepEqual(item.price, { each: 4, perUnit: 8, unit: "kg" });
});

test("a link that is not https, or a price that is not a price, is dropped", async () => {
  const { lookup, ask } = await setUp();
  await ask("/api/basket/link", {
    sku: "sneaky",
    title: "Looks fine",
    url: "javascript:alert(document.cookie)",
    price: { each: "free" },
  });

  const { item } = await lookup();
  assert.equal(item.sku, "sneaky", "the choice itself still stands");
  assert.equal(item.url, undefined);
  assert.equal(item.price, undefined);
});

test("with no shop switched on there is nothing to match against", async () => {
  const app = createApp({ today: "2026-09-11" });
  const res = await app.handle("/api/basket/match", {
    ingredientId: "beef-mince",
    packSize: 500,
  });
  assert.equal(res.status, 400);
});
