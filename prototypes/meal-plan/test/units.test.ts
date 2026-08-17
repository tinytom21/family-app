import { test } from "node:test";
import assert from "node:assert/strict";

import { requireIngredient } from "../src/domain/catalogue.ts";
import { formatBase, isVague, toBase } from "../src/domain/units.ts";

const oliveOil = requireIngredient("olive-oil"); // base volume, 0.92 g/ml
const onion = requireIngredient("onion"); // base count, 150 g each
const garlic = requireIngredient("garlic"); // base count, 5 g per clove
const tin = requireIngredient("tomato-tinned"); // base count, 400 g per tin
const potato = requireIngredient("potato"); // base mass, no bridges
const chicken = requireIngredient("chicken-breast"); // base mass, 170 g each

const value = (r: ReturnType<typeof toBase>): number => {
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return (r as { ok: true; value: number }).value;
};

test("same-dimension conversions", () => {
  assert.equal(value(toBase(1.5, "kg", chicken)), 1500);
  assert.equal(value(toBase(2, "tbsp", oliveOil)), 30);
  assert.equal(value(toBase(1, "l", oliveOil)), 1000);
  assert.equal(Math.round(value(toBase(1, "lb", chicken))), 454);
});

test("volume and mass reconcile through density", () => {
  // 100 ml of olive oil weighs 92 g; asked for in grams, it must come back
  // as the right number of millilitres.
  assert.equal(Math.round(value(toBase(92, "g", oliveOil))), 100);
});

test("count and mass reconcile through per-unit weight", () => {
  // The ragù asks for 200 g of onion; onions are sold by the onion.
  assert.equal(
    Number(value(toBase(200, "g", onion)).toFixed(4)),
    Number((200 / 150).toFixed(4)),
  );
  // And back the other way.
  assert.equal(value(toBase(2, "unit", onion)), 2);
});

test("cloves are counted, tins are counted, both stay whole", () => {
  assert.equal(value(toBase(3, "clove", garlic)), 3);
  assert.equal(value(toBase(2, "tin", tin)), 2);
  // 800 g of chopped tomatoes is two tins, not 800 of anything.
  assert.equal(value(toBase(800, "g", tin)), 2);
});

test("vague amounts contribute nothing but are recognised", () => {
  assert.equal(isVague("pinch"), true);
  assert.equal(isVague("g"), false);
  assert.equal(value(toBase(1, "pinch", chicken)), 0);
});

test("impossible conversions fail loudly rather than guessing", () => {
  // Potatoes are sold by weight and the catalogue gives no per-potato mass,
  // so "2 potatoes" cannot be costed. Returning a plausible number here is
  // how shopping lists end up quietly wrong.
  const result = toBase(2, "unit", potato);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /gramsPerUnit/);
});

test("negative and non-finite amounts are rejected", () => {
  assert.equal(toBase(-5, "g", chicken).ok, false);
  assert.equal(toBase(Number.NaN, "g", chicken).ok, false);
});

test("base amounts format the way a person would write them", () => {
  assert.equal(formatBase(1500, "mass"), "1.5 kg");
  assert.equal(formatBase(340, "mass"), "340 g");
  assert.equal(formatBase(2272, "volume"), "2.27 L");
  assert.equal(formatBase(1, "count"), "1");
});
