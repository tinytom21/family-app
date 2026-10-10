import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chooseRepeats,
  dishKey,
  dishStats,
  emptyLog,
  historyForPrompt,
  patterns,
  rateMeal,
  recordWeek,
  repeatId,
  restDays,
} from "../src/domain/history.ts";
import type { MealLog } from "../src/domain/history.ts";
import { generatePlan } from "../src/ai/planner.ts";
import type { PlanProvider } from "../src/ai/provider.ts";
import { emptyUsage } from "../src/ai/provider.ts";
import { createApp } from "../src/app-state.ts";
import { CONSTRAINTS, GOOD_PLAN } from "../src/demo-data.ts";
import { redatePlan } from "../src/domain/week.ts";
import type { MealPlan, Recipe } from "../src/domain/types.ts";

/* ---------------- a few weeks of history to work with ---------------- */

const recipe = (id: string, title: string, protein: string, minutes = 30): Recipe => ({
  id,
  title,
  serves: 4,
  prepMinutes: 10,
  cookMinutes: minutes - 10,
  protein,
  lines: [{ ingredientId: protein === "fish" ? "salmon" : "chicken-thigh", amount: 500, unit: "g" }],
  steps: ["Cook it."],
});

/** One dinner a day for the dates given, cycling through the recipes. */
function week(start: string, recipes: Recipe[]): MealPlan {
  return {
    weekStarting: start,
    recipes,
    meals: recipes.map((r, i) => ({
      date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
      slot: "dinner" as const,
      recipeId: r.id,
      servings: 3,
    })),
  };
}

const TRAYBAKE = recipe("traybake", "Sticky chicken traybake", "chicken");
const FISHPIE = recipe("fishpie", "Fish pie", "fish", 50);
const CURRY = recipe("curry", "Chickpea curry", "chickpeas");

/* ---------------- writing the log ---------------- */

test("an agreed week is logged meal by meal, cooks and all", () => {
  const log = recordWeek(emptyLog(), week("2026-09-07", [TRAYBAKE, CURRY]), {
    "2026-09-07": "Tom",
  });
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].title, "Sticky chicken traybake");
  assert.equal(log.entries[0].key, "sticky chicken traybake");
  assert.equal(log.entries[0].cookName, "Tom");
  assert.deepEqual(log.entries[0].ingredients, ["chicken-thigh"]);
  assert.equal(log.recipes["sticky chicken traybake"].id, "traybake", "the recipe is kept");
});

test("agreeing the same week again replaces it, keeping ratings that still apply", () => {
  let log = recordWeek(emptyLog(), week("2026-09-07", [TRAYBAKE, CURRY]));
  log = rateMeal(log, "2026-09-07", "dinner", "up");
  // A late change swaps Tuesday's curry for fish pie.
  log = recordWeek(log, week("2026-09-07", [TRAYBAKE, FISHPIE]));
  assert.equal(log.entries.length, 2, "one copy of the week, not two");
  assert.equal(log.entries[0].rating, "up", "Monday's thumbs up survives");
  assert.equal(log.entries[1].title, "Fish pie");
});

test("a leftover night is logged but cannot be rated", () => {
  const plan = redatePlan(GOOD_PLAN, "2026-09-07");
  let log = recordWeek(emptyLog(), plan);
  const leftover = log.entries.find((e) => e.leftover)!;
  log = rateMeal(log, leftover.date, leftover.slot, "down");
  assert.equal(log.entries.find((e) => e.leftover)!.rating, undefined);
});

test("one dish is one dish, however its title is written", () => {
  assert.equal(dishKey("Sticky Chicken Traybake!"), dishKey("sticky chicken traybake"));
  assert.equal(dishKey("Fish & chips"), dishKey("fish and chips"));
});

/* ---------------- what it adds up to ---------------- */

function liked(): MealLog {
  // Traybake liked twice, fish pie disliked twice, curry once each way.
  let log = emptyLog();
  for (const [start, rating] of [["2026-08-03", "up"], ["2026-08-17", "up"]] as const) {
    log = recordWeek(log, week(start, [TRAYBAKE, FISHPIE, CURRY]));
    log = rateMeal(log, start, "dinner", rating);
    log = rateMeal(log, log.entries.find((e) => e.weekStarting === start && e.key === "fish pie")!.date, "dinner", "down");
  }
  const curry1 = log.entries.find((e) => e.key === "chickpea curry")!;
  const curry2 = log.entries.filter((e) => e.key === "chickpea curry")[1];
  log = rateMeal(log, curry1.date, "dinner", "up");
  log = rateMeal(log, curry2.date, "dinner", "down");
  return log;
}

test("each dish's thumbs are added up across weeks", () => {
  const stats = dishStats(liked());
  const traybake = stats.find((d) => d.key === "sticky chicken traybake")!;
  assert.deepEqual(
    { times: traybake.times, ups: traybake.ups, downs: traybake.downs },
    { times: 2, ups: 2, downs: 0 },
  );
  assert.equal(stats[0].key, "sticky chicken traybake", "favourites first");
});

test("a favourite comes back only once it has rested", () => {
  const log = liked(); // traybake last had 17 Aug, twice
  assert.equal(restDays(2), 28);
  assert.deepEqual(chooseRepeats(log, "2026-09-07"), [], "three weeks on is too soon");
  const back = chooseRepeats(log, "2026-09-14");
  assert.deepEqual(back.map((r) => r.title), ["Sticky chicken traybake"]);
  assert.equal(back[0].recipe.id, "traybake", "as the same recipe");
});

test("never more than two favourites a week, however many are due", () => {
  let log = emptyLog();
  const many = Array.from({ length: 5 }, (_, i) => recipe(`r${i}`, `Favourite ${i}`, "chicken"));
  log = recordWeek(log, week("2026-06-01", many));
  for (const e of log.entries) log = rateMeal(log, e.date, e.slot, "up");
  assert.equal(chooseRepeats(log, "2026-09-07").length, 2);
});

test("a dish let down last time is not brought back, even if once loved", () => {
  let log = liked();
  log = recordWeek(log, week("2026-08-24", [TRAYBAKE]));
  log = rateMeal(log, "2026-08-24", "dinner", "down");
  assert.deepEqual(chooseRepeats(log, "2026-10-26"), []);
});

test("patterns are only claimed once there are enough ratings to mean something", () => {
  const few = recordWeek(emptyLog(), week("2026-09-07", [FISHPIE]));
  assert.deepEqual(patterns(rateMeal(few, "2026-09-07", "dinner", "down")), []);

  // Two thumbs each way on chicken and fish: suggestive, but not yet a pattern.
  const lines = patterns(liked());
  assert.ok(!lines.some((l) => /fish/.test(l)), `fish claimed from 2 ratings: ${lines.join(" | ")}`);
  assert.ok(!lines.some((l) => /chicken/.test(l)), `chicken claimed from 2 ratings: ${lines.join(" | ")}`);
});

test("a clear leaning is said in words", () => {
  let log = emptyLog();
  for (const start of ["2026-07-06", "2026-07-13", "2026-07-20"]) {
    log = recordWeek(log, week(start, [TRAYBAKE, FISHPIE]));
    log = rateMeal(log, start, "dinner", "up"); // traybake
    const fish = log.entries.find((e) => e.weekStarting === start && e.key === "fish pie")!;
    log = rateMeal(log, fish.date, "dinner", "down");
  }
  const lines = patterns(log, (id) => (id === "salmon" ? "Salmon fillets" : id));
  assert.ok(lines.some((l) => /go down well — chicken: liked 3 of 3/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /not keen on — fish: liked 0 of 3/.test(l)), lines.join(" | "));
});

/* ---------------- what the planner is told ---------------- */

test("a new household's prompt gets no history section at all", () => {
  assert.equal(historyForPrompt(emptyLog(), "2026-09-07", []), "");
});

test("the planner is told what to bring back, what to avoid, and what was just had", () => {
  let log = liked();
  log = recordWeek(log, week("2026-09-07", [CURRY]));
  const repeats = chooseRepeats(log, "2026-09-14");
  const text = historyForPrompt(log, "2026-09-14", repeats);

  assert.match(text, new RegExp(`- ${repeatId("sticky chicken traybake")}: Sticky chicken traybake \\(liked 2 times`));
  assert.match(text, /do not define that recipe again/);
  assert.match(text, /Do not suggest[^]*- Fish pie/);
  assert.match(text, /last fortnight[^]*- Chickpea curry/);
  assert.match(text, /every dish should be one this family has not had before/);
});

/* ---------------- the planner keeps what it was told to keep ---------------- */

/** A provider that answers with a fixed plan and records what it was asked. */
function scripted(answer: { recipes: Recipe[]; meals: MealPlan["meals"] }) {
  const asked: string[] = [];
  const provider: PlanProvider = {
    id: "claude",
    model: "test",
    costUsd: () => 0,
    async generate(request) {
      asked.push(request.turns[0].text);
      return {
        text: JSON.stringify({ reasoning: "Swapped Tuesday.", ...answer }),
        usage: emptyUsage(),
      };
    },
  };
  return { provider, asked };
}

test("a favourite referred to by id arrives as the stored recipe", async () => {
  const plan = redatePlan(GOOD_PLAN, "2026-09-14");
  const favourite = { ...TRAYBAKE, id: repeatId("sticky chicken traybake") };
  const meals = plan.meals.map((m, i) => (i === 0 ? { ...m, recipeId: favourite.id } : m));
  const { provider } = scripted({ recipes: plan.recipes, meals });

  const run = await generatePlan(
    { ...CONSTRAINTS, weekStarting: "2026-09-14" },
    { provider, reuse: [favourite], maxRepairs: 0 },
  );
  const used = run.plan.recipes.find((r) => r.id === favourite.id);
  assert.ok(used, "the stored recipe was added to the plan");
  assert.deepEqual(used!.steps, TRAYBAKE.steps);
});

test("a revision shows the plan as it stands, and keeps what it was not told to change", async () => {
  const current = redatePlan(GOOD_PLAN, "2026-09-14");
  // The model changes Monday only, and refers to everything else by id.
  const monday = { ...CURRY, id: "new-monday" };
  const meals = current.meals.map((m, i) => (i === 0 ? { ...m, recipeId: monday.id } : m));
  const { provider, asked } = scripted({ recipes: [monday], meals });

  const run = await generatePlan(
    { ...CONSTRAINTS, weekStarting: "2026-09-14", thisWeek: "No chicken on Monday please" },
    { provider, current, maxRepairs: 0 },
  );
  assert.match(asked[0], /THE PLAN AS IT STANDS — revise it; do not start again/);
  assert.match(asked[0], /No chicken on Monday please/);
  for (const meal of run.plan.meals) {
    assert.ok(
      run.plan.recipes.some((r) => r.id === meal.recipeId),
      `${meal.date} lost its recipe`,
    );
  }
  assert.equal(run.reasoning, "Swapped Tuesday.");
});

/* ---------------- from the app ---------------- */

async function household(today: string) {
  const app = createApp({ today });
  await app.handle("/api/household/create", {
    householdName: "The Baileys",
    people: [
      { name: "Tom", ageBracket: "adult" },
      { name: "Jess", ageBracket: "adult" },
    ],
  });
  return app;
}

test("agreeing a plan logs it; a meal is rateable once its day has come", async () => {
  const app = await household("2026-10-03"); // plan runs 5–11 Oct
  let state: any = (await app.handle("/api/plan/agree")).body;
  assert.equal(state.plan.agreed, true);
  assert.ok(state.plan.meals.every((m: any) => !m.rateable), "nothing has been eaten yet");

  const early = await app.handle("/api/meal/rate", { date: "2026-10-05", rating: "up" });
  assert.equal(early.status, 400, "a meal cannot be rated before it is eaten");
});

test("thumbs given in the app are kept, counted, and can be taken back", async () => {
  const app = await household("2026-10-03");
  const snapshot: any = (await app.handle("/api/snapshot")).body;
  // A week later, on the Tuesday, Monday's dinner has been eaten.
  const later = createApp({ today: "2026-10-06", seed: snapshot });
  let state: any = (await later.handle("/api/meal/rate", { date: "2026-10-05", rating: "up" })).body;
  const monday = state.plan.meals.find((m: any) => m.date === "2026-10-05");
  assert.equal(monday.rating, "up");
  assert.equal(state.history.dishes[0].ups, 1);

  state = (await later.handle("/api/meal/rate", { date: "2026-10-05", rating: null })).body;
  assert.equal(state.plan.meals.find((m: any) => m.date === "2026-10-05").rating, null);
});

test("planning hands the model the history and the favourites to bring back", async () => {
  let asked: any = null;
  const app = createApp({
    today: "2026-11-01",
    ai: {
      available: true,
      async generatePlan(constraints, options) {
        asked = { constraints, options };
        throw new Error("captured");
      },
    },
    seed: {
      household: { name: "The Baileys", setUp: true },
      mealLog: rateMeal(recordWeek(emptyLog(), week("2026-09-07", [TRAYBAKE])), "2026-09-07", "dinner", "up"),
    },
  });
  await app.handle("/api/week/start", { date: "2026-11-02" });
  await app.handle("/api/plan/generate");

  assert.match(asked.constraints.history, /Bring back this week[^]*Sticky chicken traybake/);
  assert.deepEqual(asked.options.reuse.map((r: Recipe) => r.id), [repeatId("sticky chicken traybake")]);
  assert.equal(asked.options.current, undefined, "a fresh plan, not a revision");
});

test("a revision needs a note, and hands over the plan as it stands", async () => {
  let asked: any = null;
  const app = createApp({
    today: "2026-10-03",
    ai: {
      available: true,
      async generatePlan(constraints, options) {
        asked = { constraints, options };
        return { plan: options.current!, provider: "test", model: "test", attempts: 1, costUsd: 0, reasoning: "Made Friday quicker." };
      },
    },
  });
  await app.handle("/api/household/create", {
    householdName: "The Baileys",
    people: [{ name: "Tom", ageBracket: "adult" }],
  });
  await app.handle("/api/plan/agree");

  const empty = await app.handle("/api/plan/revise");
  assert.equal(empty.status, 400, "nothing to revise by");

  await app.handle("/api/week/note", { text: "Something quicker on Friday" });
  const state: any = (await app.handle("/api/plan/revise")).body;
  assert.equal(asked.constraints.thisWeek, "Something quicker on Friday");
  assert.ok(asked.options.current, "the current plan went with it");
  assert.equal(state.lastRun.reasoning, "Made Friday quicker.");
  assert.equal(state.lastRun.revised, true);
  assert.equal(state.plan.agreed, false, "a changed plan needs agreeing again");
});
