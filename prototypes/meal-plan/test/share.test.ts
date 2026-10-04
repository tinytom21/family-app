import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app-state.ts";
import { GOOD_PLAN } from "../src/demo-data.ts";
import {
  dayCards,
  dayMessage,
  ingredientLines,
  weekMessage,
} from "../src/domain/share.ts";
import type { ShareInput } from "../src/domain/share.ts";
import type { MealPlan, Recipe } from "../src/domain/types.ts";

const days = (plan: MealPlan) =>
  [...new Set(plan.meals.map((m) => m.date))].map((date) => ({
    date,
    cookName: "Tom",
    away: [] as string[],
  }));

const input = (plan: MealPlan = GOOD_PLAN, extra: Partial<ShareInput> = {}): ShareInput => ({
  householdName: "The Baileys",
  plan,
  days: days(plan),
  ...extra,
});

/* ---------------- the shape of the message ---------------- */

test("the week opens with a menu: one line per day, all seven", () => {
  const text = weekMessage(input());
  const menu = text.split("*Menu*")[1].split("━━━")[0].trim().split("\n");
  assert.equal(menu.length, 7);
  assert.match(menu[0], /^Mon {2}\S/);
  assert.match(text, /^\*The Baileys · week of Mon 17 Aug\*/);
});

test("every day gets a block, in order, with who is cooking", () => {
  const text = weekMessage(input());
  const blocks = text.split("━━━━━━━━━━").slice(1);
  assert.equal(blocks.length, 7);
  assert.match(blocks[0], /\*MON 17 AUG\* · Tom cooking/);
  assert.match(blocks[6], /\*SUN 23 AUG\*/);
});

test("a cooked meal carries its ingredients and numbered method", () => {
  const monday = dayMessage(input(), "2026-08-17")!;
  assert.match(monday, /_Ingredients_\n• /);
  assert.match(monday, /_Method_\n1\. /);
});

/* ---------------- leftovers ---------------- */

test("the leftover night says where it comes from, and skips the recipe", () => {
  // Thursday eats Tuesday's stew in the fixture.
  const thursday = dayMessage(input(), "2026-08-20")!;
  assert.match(thursday, /leftovers from Tuesday/);
  assert.match(thursday, /Reheat until piping hot/);
  assert.doesNotMatch(thursday, /_Method_/);
});

test("the cook that makes the leftovers is told to make extra", () => {
  const tuesday = dayMessage(input(), "2026-08-18")!;
  assert.match(tuesday, /Makes extra: Thursday is leftovers of this/);
});

/* ---------------- what has to happen the night before ---------------- */

test("an overnight step tomorrow shows up tonight", () => {
  const plan: MealPlan = {
    ...GOOD_PLAN,
    recipes: GOOD_PLAN.recipes.map((r) =>
      r.id === GOOD_PLAN.meals.find((m) => m.date === "2026-08-19")!.recipeId
        ? { ...r, steps: ["Marinate the chicken overnight in the yoghurt.", ...(r.steps ?? [])] }
        : r,
    ),
  };
  const tuesday = dayMessage(input(plan), "2026-08-18")!;
  assert.match(tuesday, /🌙 Tonight, for tomorrow: Marinate the chicken overnight/);
});

/* ---------------- amounts a person would measure ---------------- */

const recipe = (lines: Recipe["lines"], serves = 4): Recipe => ({
  id: "r",
  title: "Test",
  serves,
  prepMinutes: 10,
  cookMinutes: 20,
  lines,
});

test("amounts are scaled to the portions and rounded the way people measure", () => {
  const lines = ingredientLines(
    recipe([
      { ingredientId: "beef-mince", amount: 500, unit: "g" },
      { ingredientId: "garlic", amount: 3, unit: "clove" },
      { ingredientId: "tomato-tinned", amount: 1, unit: "tin" },
      { ingredientId: "olive-oil", amount: 2, unit: "tbsp" },
    ]),
    3.2, // two adults and a child
  );
  assert.equal(lines[0], "400 g beef mince, 5% fat"); // 500 × 0.8
  assert.equal(lines[1], "2½ cloves garlic"); // 2.4 → nearest half
  assert.equal(lines[2], "1 tin chopped tomatoes"); // 0.8 → 1, singular
  assert.equal(lines[3], "1½ tbsp olive oil"); // 1.6 → 1½
});

test("one of something is singular, and a name keeps its capitals", () => {
  const lines = ingredientLines(
    recipe([
      { ingredientId: "courgette", amount: 1, unit: "unit" },
      { ingredientId: "potato", amount: 800, unit: "g" },
      { ingredientId: "pepper-red", amount: 2, unit: "unit" },
    ]),
    4,
  );
  assert.equal(lines[0], "1 courgette", "not '1 courgettes'");
  assert.equal(lines[1], "800 g Maris Piper potatoes", "not 'maris Piper'");
  assert.equal(lines[2], "2 red peppers", "two stays plural");
});

test("a big amount reads in kilos, a tiny one never as zero", () => {
  const [big, tiny] = ingredientLines(
    recipe([
      { ingredientId: "potato", amount: 2000, unit: "g" },
      { ingredientId: "garlic", amount: 0.1, unit: "clove" },
    ]),
    4,
  );
  assert.match(big, /^2 kg /);
  assert.match(tiny, /^½ clove /);
});

/* ---------------- safe for WhatsApp ---------------- */

test("a stray asterisk cannot turn the rest of the message bold", () => {
  const plan: MealPlan = {
    ...GOOD_PLAN,
    recipes: GOOD_PLAN.recipes.map((r, i) => (i === 0 ? { ...r, title: "*Best* _ever_ stew" } : r)),
  };
  const text = weekMessage(input(plan));
  assert.match(text, /Best ever stew/);
  assert.doesNotMatch(text, /\*Best\*|_ever_/);
});

test("this week's note is in the message, for the cook as well as the planner", () => {
  const text = weekMessage(input(GOOD_PLAN, { weekNote: "Jess away Thursday" }));
  assert.match(text, /_This week: Jess away Thursday_/);
});

test("a whole week stays a sensible size for a chat message", () => {
  // WhatsApp allows far more; this is about it being readable, not legal.
  const text = weekMessage(input());
  assert.ok(text.length < 12_000, `${text.length} characters`);
});

test("a day outside the week has no message", () => {
  assert.equal(dayMessage(input(), "2026-09-01"), null);
  assert.equal(dayCards(input()).length, 7);
});

/* ---------------- from the app ---------------- */

test("the app writes the message from the real week, cook names included", async () => {
  const app = createApp({ today: "2026-10-03" });
  await app.handle("/api/household/create", {
    householdName: "The Baileys",
    people: [
      { name: "Tom", ageBracket: "adult" },
      { name: "Jess", ageBracket: "adult" },
    ],
  });
  await app.handle("/api/week/note", { text: "Pizza night moved to Saturday" });

  const week: any = (await app.handle("/api/share/week")).body;
  assert.match(week.text, /^\*The Baileys · week of Mon 5 Oct\*/);
  assert.match(week.text, /(Tom|Jess) cooking/);
  assert.match(week.text, /Pizza night moved to Saturday/);

  const day: any = (await app.handle("/api/share/day", { date: "2026-10-05" })).body;
  assert.match(day.text, /\*MON 5 OCT\*/);

  const outside = await app.handle("/api/share/day", { date: "2027-01-01" });
  assert.equal(outside.status, 404);

  const state: any = (await app.handle("/api/state")).body;
  const cooked = state.plan.meals.find((m: any) => !m.leftoverOf);
  assert.ok(cooked.ingredients.length > 0, "the screen gets the same scaled ingredients");
});
