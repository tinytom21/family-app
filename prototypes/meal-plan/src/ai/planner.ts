/**
 * Constraints in, validated meal plan out.
 *
 * Shape of the loop:
 *   generate -> validate in code -> if violations, hand them back for a
 *   targeted repair -> re-validate. Two repair rounds, then give up and
 *   return the best attempt with its remaining violations attached, so the
 *   app can show "here's your week, but Thursday is over budget" rather than
 *   spinning forever or silently shipping a broken plan.
 *
 * Nothing in this file knows which model answered — see `providers.ts`.
 */

import { catalogueForPrompt } from "../domain/catalogue.ts";
import { peopleForPrompt, portionFor } from "../domain/people.ts";
import { planResponseSchema } from "./schema.ts";
import { validatePlan, isWeekend } from "../validate.ts";
import type { ValidationResult, Violation } from "../validate.ts";
import type { MealPlan, PlanConstraints } from "../domain/types.ts";
import {
  addUsage,
  emptyUsage,
  selectProvider,
  type PlanProvider,
  type Turn,
  type Usage,
} from "./providers.ts";

export interface PlanRun {
  readonly plan: MealPlan;
  readonly reasoning: string;
  readonly validation: ValidationResult;
  readonly attempts: number;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly provider: string;
  readonly model: string;
}

/* ------------------------------------------------------------------ */

/**
 * Stable across every household and every week, and deliberately first so that
 * a cached prefix has something long and identical to match on.
 */
export function systemInstruction(): string {
  return `You plan a household's week of meals.

Hard rules:
1. Every ingredient must be referenced by its catalogue id. The catalogue is the
   entire universe of available ingredients. If a dish needs something not listed,
   change the dish — do not invent an ingredient.
2. Quantities are for the number of portions given in the recipe's "serves"
   field. Scaling happens downstream; do not pre-scale.
3. "cookMinutes" includes hands-off time. A tray bake that sits in the oven for
   40 minutes costs 40 minutes, even if you are not standing over it.
4. Respect every dietary exclusion absolutely. There is no acceptable trade-off
   between an allergy and a nicer menu.
5. Prefer overlapping ingredients across the week so fresh produce gets used up
   rather than half a bunch of coriander rotting in the drawer. Deliberate
   leftovers are good: cook a larger batch and mark the second sitting with
   leftoverOf.
6. Weeknights are tight and weekends are not. Put anything slow on a weekend.
7. Anything already in the house should be cooked before it goes off. If the
   larder lists something with a use-by date this week, build a meal around it.
8. Each day states how many portions it needs and who is cooking. "servings"
   must meet that day's figure, not the household's full size — some evenings
   have people out. Cook deliberately over only when you are marking a later
   day as leftovers.
9. The cooking time given for a day belongs to the named cook. A different
   person being free changes nothing; that is who is at the hob.

Judgement:
- Meals should be things a tired adult will actually cook on a Tuesday, not
  restaurant projects. Assume a normal home kitchen and normal skills.
- Vary the protein, the cuisine, and the format across the week.
- Keep it economical without being asked for a number. Nobody is tracking a
  precise budget here, so aim for the kind of week that does not feel extravagant:
  pulses, eggs, seasonal veg and the cheaper cuts doing most of the work, with
  one or two meals that feel like a treat. Cheap does not mean grim.
- Buy whole things the week will finish. A recipe needing a third of a bunch of
  something, with nothing else using the rest, is a worse choice than one that
  uses it all.

INGREDIENT CATALOGUE (id — name, unit sold by):
${catalogueForPrompt()}`;
}

/** Volatile per household and per week. */
export function userPrompt(
  constraints: PlanConstraints,
  slots: readonly { date: string; slot: string }[],
  larderLines: readonly string[] = [],
): string {
  const people = peopleForPrompt(constraints.people)
    .map((line) => `- ${line}`)
    .join("\n");

  const totalPortions = constraints.people.reduce(
    (sum, p) => sum + portionFor(p),
    0,
  );

  const larder = larderLines.length
    ? larderLines.map((l) => `- ${l}`).join("\n")
    : "- (nothing worth counting)";

  const slotList = slots
    .map((s) => `- ${s.date} (${dayName(s.date)}) ${s.slot}`)
    .join("\n");

  return `Plan the week beginning ${constraints.weekStarting}.

HOUSEHOLD (${totalPortions} portions when everyone is in)
${people}

THE TABLE, DAY BY DAY
${tableSection(constraints)}

VARIETY
No single protein may star in more than ${constraints.maxSameProteinPerWeek} dinners.

ALREADY IN THE HOUSE (do not plan around buying these again; use up anything dated)
${larder}

SLOTS TO FILL
${slotList}
${constraints.notes ? `\nFROM THE FAMILY\n${constraints.notes}` : ""}`;
}

/**
 * Who is eating, who is cooking, and how long they have — per evening.
 *
 * The reason is given alongside every number. A model told "30 minutes on
 * Monday" plans around it; a model told "Priya cooks, 30 minutes, because Leo
 * has to be dropped at Wallingford at 17:30" plans around it *and* suggests the
 * thing that can sit in the oven while she drives.
 *
 * Portions vary by day for the same reason: cooking for four on the Thursday
 * two of them are out is how a fridge fills up with food nobody wanted.
 */
function tableSection(constraints: PlanConstraints): string {
  if (!constraints.week?.length) {
    return [
      "Nobody has set the week up, so assume everyone is in every night.",
      `- Weeknight dinners: ${constraints.maxWeeknightMinutes} minutes maximum, prep plus cook.`,
      `- Weekend dinners: ${constraints.maxWeekendMinutes} minutes maximum.`,
    ].join("\n");
  }

  const lines = constraints.week.map((day) => {
    const inFor = day.attendance.filter((a) => a.present);
    const away = day.attendance.filter((a) => !a.present);
    const bits = [
      `${day.portions} portions for ${inFor.map((a) => a.name).join(", ") || "nobody"}`,
    ];
    if (away.length) {
      bits.push(`${away.map((a) => `${a.name} out (${a.why})`).join(", ")}`);
    }
    bits.push(
      day.cookName
        ? `${day.cookName} cooks and has ${day.cookMinutes} min for prep plus cook`
        : "NOBODY IS FREE TO COOK",
    );
    return `- ${day.date} (${dayName(day.date)}): ${bits.join("; ")}.`;
  });

  return [
    "The family has reviewed and confirmed this. Servings and cooking times are",
    "hard limits, not suggestions.",
    ...lines,
    "",
    "Where an evening is nearly gone, do not simply pick a fast recipe — cook a",
    "larger batch on a free night and mark that evening as leftovers instead.",
    "An evening where nobody can cook MUST be leftovers, something from the",
    "freezer, or a cold assembly; never a recipe that needs the hob.",
    "Where somebody is out, scale that day down rather than cooking for everyone",
    "and hoping. Where a cook has a short window, favour things that look after",
    "themselves once they are in the oven.",
  ].join("\n");
}

function dayName(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    timeZone: "UTC",
  });
}

function repairPrompt(violations: readonly Violation[]): string {
  return `That plan fails validation. Fix every problem below and return the complete plan again in the same format — all recipes and all meals, not just the changed ones.

${violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`).join("\n")}

Change as little as possible: keep the meals that are fine exactly as they are.`;
}

/* ------------------------------------------------------------------ */

export function slotsForWeek(
  weekStarting: string,
  slots: readonly ("breakfast" | "lunch" | "dinner")[] = ["dinner"],
  days = 7,
): { date: string; slot: string }[] {
  const out: { date: string; slot: string }[] = [];
  const start = new Date(`${weekStarting}T12:00:00Z`);
  for (let d = 0; d < days; d++) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + d);
    const iso = day.toISOString().slice(0, 10);
    for (const slot of slots) out.push({ date: iso, slot });
  }
  return out;
}

export async function generatePlan(
  constraints: PlanConstraints,
  options: {
    provider?: PlanProvider;
    slots?: readonly { date: string; slot: string }[];
    larderLines?: readonly string[];
    maxRepairs?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<PlanRun> {
  const provider = options.provider ?? selectProvider();
  const slots = options.slots ?? slotsForWeek(constraints.weekStarting);
  const maxRepairs = options.maxRepairs ?? 2;
  const log = options.onProgress ?? (() => {});

  const usage = emptyUsage();
  const system = systemInstruction();
  const schema = planResponseSchema();

  const turns: Turn[] = [
    {
      role: "user",
      text: userPrompt(constraints, slots, options.larderLines),
    },
  ];

  let best:
    | { plan: MealPlan; reasoning: string; validation: ValidationResult }
    | null = null;

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    log(attempt === 1 ? "Generating plan…" : `Repair round ${attempt - 1}…`);

    const result = await provider.generate({ system, turns, schema });
    addUsage(usage, result.usage);

    const parsed = JSON.parse(result.text) as {
      reasoning: string;
      recipes: MealPlan["recipes"];
      meals: MealPlan["meals"];
    };

    const plan: MealPlan = {
      weekStarting: constraints.weekStarting,
      meals: parsed.meals.map((m) => ({
        ...m,
        leftoverOf: m.leftoverOf ?? undefined,
      })),
      recipes: parsed.recipes,
    };

    const validation = validatePlan(plan, constraints, slots);
    if (
      best === null ||
      validation.violations.length < best.validation.violations.length
    ) {
      best = { plan, reasoning: parsed.reasoning, validation };
    }

    if (validation.ok) {
      log(`Valid on attempt ${attempt}.`);
      return finish(best, attempt, usage, provider);
    }

    log(
      `${validation.violations.length} violation(s): ${validation.violations
        .map((v) => v.code)
        .join(", ")}`,
    );
    if (attempt === maxRepairs + 1) break;

    turns.push({ role: "assistant", text: result.text });
    turns.push({ role: "user", text: repairPrompt(validation.violations) });
  }

  log("Returning best attempt with outstanding violations.");
  return finish(best!, maxRepairs + 1, usage, provider);
}

function finish(
  best: { plan: MealPlan; reasoning: string; validation: ValidationResult },
  attempts: number,
  usage: Usage,
  provider: PlanProvider,
): PlanRun {
  return {
    plan: best.plan,
    reasoning: best.reasoning,
    validation: best.validation,
    attempts,
    usage,
    costUsd: provider.costUsd(usage),
    provider: provider.id,
    model: provider.model,
  };
}

export { isWeekend, selectProvider };
export type { Usage, PlanProvider };
