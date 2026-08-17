/**
 * CLI for the spike.
 *
 *   node src/run.ts demo        offline: fixture plan -> shopping list
 *   node src/run.ts guardrails  offline: show validation catching a bad plan
 *   node src/run.ts live        calls Claude (needs ANTHROPIC_API_KEY)
 */

import { buildShoppingList, formatShoppingList } from "./domain/aggregate.ts";
import { validatePlan } from "./validate.ts";
import { BAD_PLAN, CONSTRAINTS, GOOD_PLAN } from "./demo-data.ts";
import type { MealPlan, PlanConstraints } from "./domain/types.ts";

const RULE = "─".repeat(72);

function heading(text: string): void {
  console.log(`\n${RULE}\n  ${text}\n${RULE}`);
}

function printPlan(plan: MealPlan): void {
  const byId = new Map(plan.recipes.map((r) => [r.id, r]));
  for (const meal of plan.meals) {
    const recipe = byId.get(meal.recipeId);
    const day = new Date(`${meal.date}T12:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    if (!recipe) {
      console.log(`  ${day.padEnd(12)} ?? unknown recipe "${meal.recipeId}"`);
      continue;
    }
    const time = meal.leftoverOf
      ? "leftovers"
      : `${recipe.prepMinutes + recipe.cookMinutes} min`;
    console.log(
      `  ${day.padEnd(12)} ${recipe.title.padEnd(38)} ${time.padStart(10)}  serves ${meal.servings}`,
    );
  }
}

function report(plan: MealPlan, constraints: PlanConstraints, slots: { date: string; slot: string }[]) {
  heading("THE WEEK");
  printPlan(plan);

  heading("SHOPPING LIST");
  const list = buildShoppingList(plan, constraints.pantry);
  console.log(formatShoppingList(list));

  heading("VALIDATION");
  const result = validatePlan(plan, constraints, slots);
  if (result.ok) {
    console.log(
      "  PASS — allergies, portions, timings, variety and coverage all check out.",
    );
  } else {
    console.log(`  FAIL — ${result.violations.length} violation(s):\n`);
    for (const v of result.violations) {
      console.log(`  [${v.code}]`);
      console.log(`      ${v.message}\n`);
    }
  }
  return { list, result };
}

function slotsOf(plan: MealPlan): { date: string; slot: string }[] {
  const dates = [...new Set(plan.meals.map((m) => m.date))].sort();
  return dates.map((date) => ({ date, slot: "dinner" }));
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "demo";

  if (mode === "demo") {
    const slots = slotsOf(GOOD_PLAN);
    report(GOOD_PLAN, CONSTRAINTS, slots);
    return;
  }

  if (mode === "guardrails") {
    heading("GUARD RAILS — a plan that should never reach the family");
    // Sunday is missing from BAD_PLAN, so ask for the full week explicitly.
    const slots = [
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ].map((date) => ({ date, slot: "dinner" }));
    report(BAD_PLAN, CONSTRAINTS, slots);
    return;
  }

  if (mode === "live") {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
      console.error(
        "No model key set. Either one works:\n" +
          "  $env:ANTHROPIC_API_KEY = 'sk-ant-...'   (console.anthropic.com)\n" +
          "  $env:GEMINI_API_KEY    = '...'          (aistudio.google.com/apikey)\n" +
          "Force one with MEAL_PLAN_PROVIDER=claude|gemini if both are present.\n" +
          "Then re-run:   node src/run.ts live",
      );
      process.exitCode = 1;
      return;
    }
    const { generatePlan, slotsForWeek, selectProvider } = await import(
      "./ai/planner.ts"
    );
    const { projectLarder, larderForPrompt } = await import(
      "./domain/larder.ts"
    );
    const { DEMO_LARDER, TODAY } = await import("./demo-data.ts");

    const provider = selectProvider();
    const slots = slotsForWeek(CONSTRAINTS.weekStarting);
    const { householdPortions } = await import("./domain/people.ts");
    const portions = householdPortions(CONSTRAINTS.people);
    const larderLines = larderForPrompt(
      projectLarder(DEMO_LARDER, GOOD_PLAN, TODAY, portions),
    );

    heading(`ASKING ${provider.model}`);
    const started = Date.now();
    const run = await generatePlan(CONSTRAINTS, {
      provider,
      slots,
      larderLines,
      onProgress: (m) => console.log(`  ${m}`),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    heading("REASONING");
    console.log(`  ${run.reasoning}`);

    report(run.plan, CONSTRAINTS, slots);

    heading("RUN COST");
    const u = run.usage;
    const billableInput = u.inputTokens + u.cachedReadTokens;
    const cacheHitRate = billableInput
      ? Math.round((u.cachedReadTokens / billableInput) * 100)
      : 0;
    console.log(`  provider        ${run.provider}`);
    console.log(`  model           ${run.model}`);
    console.log(`  attempts        ${run.attempts}`);
    console.log(`  wall clock      ${seconds}s`);
    console.log(`  input tokens    ${u.inputTokens.toLocaleString()} at full price`);
    console.log(`  cache read      ${u.cachedReadTokens.toLocaleString()} (${cacheHitRate}% of input)`);
    if (u.cacheWriteTokens) {
      console.log(`  cache write     ${u.cacheWriteTokens.toLocaleString()}`);
    }
    console.log(`  output tokens   ${u.outputTokens.toLocaleString()}`);
    if (u.thoughtTokens) {
      console.log(`  thought tokens  ${u.thoughtTokens.toLocaleString()}`);
    }
    console.log(`  approx cost     $${run.costUsd.toFixed(4)} per plan`);
    if (cacheHitRate === 0 && run.attempts > 1) {
      console.log(
        "\n  Note: no cached input across a multi-turn run — worth checking\n" +
          "  before relying on caching for cost.",
      );
    }
    return;
  }

  console.error(`Unknown mode "${mode}". Try: demo | guardrails | live`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nFailed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
