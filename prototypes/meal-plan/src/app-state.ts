/**
 * The application, with no idea where it is running.
 *
 * This used to live inside `web/server.ts`, which was fine until the app
 * needed to run in two places: a Node process for local development, and a
 * plain static page for the hosted demo, where there is no server to speak to
 * at all. Copying the state machine into the browser would have been the fast
 * option and the wrong one — two implementations of "what happens when you
 * untick Priya on Tuesday" is precisely how a shopping list and a larder start
 * disagreeing.
 *
 * So the routes and the state live here, expressed as `handle(path, body)`,
 * and the two hosts are thin adapters over it. The HTTP server unwraps a
 * request into that call; the browser build calls it directly. Same code, same
 * answers, and the tests exercise the same thing either way.
 *
 * The one genuinely host-specific thing is talking to a model, which needs an
 * API key and must therefore never happen in a browser. That is injected
 * rather than imported, so the static bundle contains no SDK and no key-shaped
 * hole where one might go.
 */

import { buildShoppingList } from "./domain/aggregate.ts";
import {
  larderForPrompt,
  larderToPantry,
  projectLarder,
} from "./domain/larder.ts";
import type { Larder, LarderItem } from "./domain/larder.ts";
import { validatePlan } from "./validate.ts";
import { assessWeek, fromGoogleEvent } from "./domain/agenda.ts";
import type { CalendarEvent, DayAgenda } from "./domain/agenda.ts";
import {
  addDays,
  completeTask,
  remindersFor,
  rollForward,
  scheduleTasks,
  statusOf,
} from "./domain/tasks.ts";
import type { Task } from "./domain/tasks.ts";
import {
  AGE_BRACKETS,
  AGE_BRACKET_LABELS,
  findByEmail,
  householdPortions,
  makePerson,
  portionFor,
} from "./domain/people.ts";
import type { Person } from "./domain/people.ts";
import { proposeWeek, slotsFromWeek } from "./domain/sitting.ts";
import type { SittingOverrides } from "./domain/sitting.ts";
import {
  INVITE_PROBLEMS,
  generateInviteCode,
  inviteExpiry,
  isWellFormedInviteCode,
  normaliseInviteCode,
  peopleFromDraft,
  validateDraft,
} from "./domain/household.ts";
import {
  CONSTRAINTS,
  DEMO_EVENTS,
  DEMO_LARDER,
  DEMO_TASKS,
  GOOD_PLAN,
  PEOPLE,
  TODAY,
} from "./demo-data.ts";
import type { MealPlan, PlanConstraints } from "./domain/types.ts";

/* ------------------------------------------------------------------ */

export interface PlanRunSummary {
  readonly plan: MealPlan;
  readonly provider: string;
  readonly model: string;
  readonly attempts: number;
  readonly costUsd: number;
}

export interface CaptureRunSummary {
  readonly tasks: readonly Task[];
  readonly note: string;
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number;
}

/**
 * Everything that needs a network and a secret.
 *
 * Absent in the browser build, which is why `modelAvailable` is false there
 * and the two AI buttons are disabled rather than broken.
 */
export interface AiHooks {
  readonly available: boolean;
  generatePlan?(
    constraints: PlanConstraints,
    options: {
      slots: readonly { date: string; slot: string }[];
      larderLines: readonly string[];
    },
  ): Promise<PlanRunSummary>;
  captureTasks?(
    text: string,
    context: { people: readonly string[]; today: string },
  ): Promise<CaptureRunSummary>;
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

export interface HouseholdInfo {
  /** What the family call themselves. */
  name: string;
  /**
   * Whether anybody has been through the intro screen.
   *
   * False on a first visit, which is what puts the wizard in front of the app
   * rather than dropping a stranger into somebody else's fixture week.
   */
  setUp: boolean;
  /** Set once the household exists in Supabase rather than only in a browser. */
  remoteId?: string;
}

/** The part of the state worth keeping between visits. */
export interface Snapshot {
  household: HouseholdInfo;
  plan: MealPlan;
  larder: Larder;
  people: Person[];
  tasks: Task[];
  eventsByPerson: Record<string, CalendarEvent[]>;
  connected: string[];
  overrides: SittingOverrides;
  confirmedWeek: string | null;
  restockStaples: boolean;
  calendarConnectedAs: string | null;
}

function freshSnapshot(): Snapshot {
  return {
    household: { name: "", setUp: false },
    plan: GOOD_PLAN,
    larder: { ...DEMO_LARDER, items: [...DEMO_LARDER.items] },
    people: PEOPLE.map((p) => ({ ...p })),
    tasks: DEMO_TASKS.map((t) => ({ ...t })),
    eventsByPerson: Object.fromEntries(
      Object.entries(DEMO_EVENTS).map(([id, events]) => [id, [...events]]),
    ),
    connected: Object.keys(DEMO_EVENTS),
    overrides: {},
    confirmedWeek: null,
    restockStaples: false,
    calendarConnectedAs: null,
  };
}

/* ------------------------------------------------------------------ */

export function createApp(
  options: { ai?: AiHooks; seed?: Partial<Snapshot> } = {},
) {
  const ai = options.ai ?? { available: false };

  const state = {
    ...freshSnapshot(),
    ...options.seed,
    today: TODAY,
    source: "fixture" as "fixture" | "model",
    lastRun: null as null | {
      provider: string;
      model: string;
      attempts: number;
      costUsd: number;
      seconds: number;
    },
    lastCapture: null as null | {
      provider: string;
      model: string;
      count: number;
      note: string;
      costUsd: number;
    },
  };

  const planDates = (plan: MealPlan): string[] =>
    [...new Set(plan.meals.map((m) => m.date))].sort();

  /** Adults who can be rostered for jobs. Children are reminded, not rostered. */
  const doers = (): string[] =>
    state.people.filter((p) => p.canCook).map((p) => p.name);

  /** The reviewed grid: who is in, who cooks, how long they have. */
  const currentWeek = () =>
    proposeWeek({
      people: state.people,
      dates: planDates(state.plan),
      eventsByPerson: state.eventsByPerson,
      connected: state.connected,
      overrides: state.overrides,
      options: {
        maxWeeknightMinutes: CONSTRAINTS.maxWeeknightMinutes,
        maxWeekendMinutes: CONSTRAINTS.maxWeekendMinutes,
      },
    });

  const currentConstraints = (): PlanConstraints => ({
    ...CONSTRAINTS,
    people: state.people,
    week: currentWeek(),
  });

  /**
   * One household-wide agenda for the jobs scheduler.
   *
   * The tasks module wants to know when the house is busy, not who is busy, so
   * every calendar is poured into one view. That is deliberately a different
   * question from the sitting grid, which cares very much whose evening it is.
   */
  const currentAgenda = (): DayAgenda[] =>
    assessWeek(planDates(state.plan), Object.values(state.eventsByPerson).flat());

  /** How long each evening's cooking takes, so jobs are not stacked on top. */
  function mealMinutesByDate(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const meal of state.plan.meals) {
      if (meal.leftoverOf) continue; // reheating is not cooking
      const recipe = state.plan.recipes.find((r) => r.id === meal.recipeId);
      if (recipe) out[meal.date] = recipe.prepMinutes + recipe.cookMinutes;
    }
    return out;
  }

  function buildTasks() {
    // Roll fixed schedules forward before anything looks at them, so a missed
    // bin day reads as "last Tuesday" rather than a pile of dead occurrences.
    state.tasks = state.tasks.map((t) => rollForward(t, state.today));

    const agenda = currentAgenda();
    const live = state.tasks.filter((t) => !t.done);
    const schedule = scheduleTasks(live, agenda, {
      people: doers(),
      today: state.today,
      mealMinutes: mealMinutesByDate(),
    });

    const plannedFor = new Map<string, { date: string; assignee: string }>();
    for (const day of schedule.days) {
      for (const p of day.placed) {
        plannedFor.set(p.taskId, { date: p.date, assignee: p.assignee });
      }
    }

    return {
      items: state.tasks.map((task) => ({
        ...task,
        status: statusOf(task, state.today),
        planned: plannedFor.get(task.id) ?? null,
      })),
      reminders: remindersFor(live, agenda, state.today),
      schedule,
      people: doers(),
      lastCapture: state.lastCapture,
    };
  }

  function buildState() {
    const week = currentWeek();
    const projection = projectLarder(
      state.larder,
      state.plan,
      state.today,
      householdPortions(state.people),
    );
    const list = buildShoppingList(state.plan, larderToPantry(projection), {
      restockStaples: state.restockStaples,
    });
    const validation = validatePlan(
      state.plan,
      { ...CONSTRAINTS, people: state.people, week },
      slotsFromWeek(week),
    );
    const weekByDate = new Map(week.map((d) => [d.date, d]));

    return {
      today: state.today,
      source: state.source,
      lastRun: state.lastRun,
      restockStaples: state.restockStaples,
      modelAvailable: ai.available,
      /** False on a first visit; the client shows the intro screen instead. */
      setUp: state.household.setUp,
      household: {
        name: state.household.name,
        remoteId: state.household.remoteId ?? null,
        people: state.people.map((p) => ({ ...p, portion: portionFor(p) })),
        portions: householdPortions(state.people),
        notes: CONSTRAINTS.notes,
        weekStarting: CONSTRAINTS.weekStarting,
        maxWeeknightMinutes: CONSTRAINTS.maxWeeknightMinutes,
        maxWeekendMinutes: CONSTRAINTS.maxWeekendMinutes,
        ageBrackets: AGE_BRACKETS.map((id) => ({
          id,
          label: AGE_BRACKET_LABELS[id],
        })),
      },
      week: {
        days: week,
        connected: state.connected,
        confirmed: state.confirmedWeek === (week[0]?.date ?? null),
        /** How much of the grid is still a guess rather than a fact. */
        assumed: week.reduce(
          (n, d) => n + d.attendance.filter((a) => a.source === "assumed").length,
          0,
        ),
      },
      calendar: {
        connected: state.connected.length > 0,
        connectedAs: state.calendarConnectedAs,
      },
      plan: {
        weekStarting: state.plan.weekStarting,
        meals: state.plan.meals.map((meal) => {
          const recipe = state.plan.recipes.find((r) => r.id === meal.recipeId);
          return {
            ...meal,
            title: recipe?.title ?? meal.recipeId,
            minutes: recipe ? recipe.prepMinutes + recipe.cookMinutes : null,
            protein: recipe?.protein ?? null,
            steps: recipe?.steps ?? [],
            sitting: weekByDate.get(meal.date) ?? null,
          };
        }),
      },
      list,
      larder: projection,
      validation,
      tasks: buildTasks(),
    };
  }

  const ok = (): ApiResult => ({ status: 200, body: buildState() });
  const bad = (status: number, error: string): ApiResult => ({
    status,
    body: { error },
  });

  /* ---------------------------------------------------------------- */

  async function handle(path: string, body: any = {}): Promise<ApiResult> {
    switch (path) {
      case "/api/state":
        return ok();

      /* ---- setting the household up ---- */

      /* The intro screen asks rather than deciding for itself, so there is one
         implementation of what makes a household valid. */
      case "/api/household/validate": {
        return { status: 200, body: { issues: validateDraft(body) } };
      }

      case "/api/household/create": {
        const issues = validateDraft(body).filter(
          (i) => !/able to cook/.test(i.message),
        );
        if (issues.length) return { status: 400, body: { issues } };

        const { people, unrecognised } = peopleFromDraft(body);
        state.people = people;
        state.household = {
          name: body.householdName.trim(),
          setUp: true,
          ...(state.household.remoteId ? { remoteId: state.household.remoteId } : {}),
        };

        // A real family starts with an empty cupboard and no jobs — those are
        // theirs to fill. The example week stays as something to look at and
        // replan, because an app that opens on seven blank days looks broken.
        state.larder = { items: [], freezer: [] };
        state.tasks = [];
        state.eventsByPerson = {};
        state.connected = [];
        state.overrides = {};
        state.confirmedWeek = null;
        state.calendarConnectedAs = null;
        state.lastCapture = null;

        return { status: 200, body: { ...buildState(), unrecognised } };
      }

      /* Look round with made-up data. Explicitly a different door from the one
         above, so nobody's real household is ever quietly seeded with fiction. */
      case "/api/household/example": {
        Object.assign(state, freshSnapshot());
        state.household = { name: "The Hardys", setUp: true };
        state.source = "fixture";
        state.lastRun = null;
        state.lastCapture = null;
        return ok();
      }

      /* ---- invites ---- */

      /* Code generation, format checking and the wording of every refusal all
         live in the domain, so the browser cannot invent a seventh character
         or a friendlier-but-wrong error. */
      case "/api/invite/new": {
        const now = new Date().toISOString();
        return {
          status: 200,
          body: { code: generateInviteCode(), expiresAt: inviteExpiry(now) },
        };
      }

      case "/api/invite/check": {
        const code = normaliseInviteCode(body.code ?? "");
        if (!isWellFormedInviteCode(code)) {
          return {
            status: 200,
            body: { problem: "malformed", message: INVITE_PROBLEMS.malformed },
          };
        }
        return { status: 200, body: { code } };
      }

      case "/api/invite/message": {
        const problem = body.problem as keyof typeof INVITE_PROBLEMS;
        return {
          status: 200,
          body: { message: INVITE_PROBLEMS[problem] ?? INVITE_PROBLEMS.unknown },
        };
      }

      /* The whole household as one document, for syncing to an account. Both
         hosts expose it the same way so the account code has one path. */
      case "/api/snapshot":
        return { status: 200, body: snapshot() };

      case "/api/restore": {
        if (!body || typeof body !== "object" || !body.people) {
          return bad(400, "a snapshot with people is required");
        }
        Object.assign(state, body);
        return ok();
      }

      case "/api/household/rename": {
        if (!body.name?.trim()) return bad(400, "name required");
        state.household = { ...state.household, name: body.name.trim() };
        return ok();
      }

      case "/api/options": {
        if (typeof body.restockStaples === "boolean") {
          state.restockStaples = body.restockStaples;
        }
        return ok();
      }

      /* Confirming stock is the only manual entry the design asks for, and it
         exists to correct drift rather than to build the record. */
      case "/api/larder/confirm": {
        const { ingredientId, amount } = body;
        if (typeof ingredientId !== "string" || !Number.isFinite(amount)) {
          return bad(400, "ingredientId and amount required");
        }
        const items = state.larder.items.filter(
          (i) => i.ingredientId !== ingredientId,
        );
        if (amount > 0) {
          const existing = state.larder.items.find(
            (i) => i.ingredientId === ingredientId,
          );
          const entry: LarderItem = {
            ingredientId,
            amount,
            confirmedOn: state.today,
            // A fresh confirmation supersedes an old best-before guess.
            ...(existing?.bestBefore && amount === existing.amount
              ? { bestBefore: existing.bestBefore }
              : {}),
          };
          items.push(entry);
        }
        state.larder = { ...state.larder, items };
        return ok();
      }

      case "/api/freezer": {
        const { label, portions, recipeId } = body;
        if (!label || !Number.isFinite(portions)) {
          return bad(400, "label and portions required");
        }
        state.larder = {
          ...state.larder,
          freezer: [
            ...state.larder.freezer,
            {
              id: `fz-${Date.now()}`,
              label,
              portions,
              frozenOn: state.today,
              fromRecipeId: recipeId,
            },
          ],
        };
        return ok();
      }

      case "/api/freezer/eat": {
        state.larder = {
          ...state.larder,
          freezer: state.larder.freezer
            .map((m) => (m.id === body.id ? { ...m, portions: m.portions - 1 } : m))
            .filter((m) => m.portions > 0),
        };
        return ok();
      }

      /* The browser holds the Google token and reads the calendar itself, so no
         access token ever reaches a server. In production this moves to an Edge
         Function using the stored refresh token, because the agenda has to
         refresh overnight with nobody signed in. */
      case "/api/agenda": {
        if (!Array.isArray(body.googleEvents)) {
          return bad(400, "googleEvents array required");
        }

        // A calendar belongs to a person, not to the house. Prefer an explicit
        // choice, fall back to matching the signed-in address to a profile, and
        // refuse rather than guess — attaching one person's evenings to another
        // is worse than not reading the calendar at all.
        const person = body.personId
          ? state.people.find((p) => p.id === body.personId)
          : body.connectedAs
            ? findByEmail(state.people, body.connectedAs)
            : undefined;

        if (!person) {
          return bad(
            400,
            body.connectedAs
              ? `No profile has the email ${body.connectedAs}. Add it to somebody's profile, or pick who this calendar belongs to.`
              : "Pick which profile this calendar belongs to.",
          );
        }

        // Mapped here rather than in the client so there is one tested
        // implementation of Google's event shape, not two that drift.
        state.eventsByPerson[person.id] = body.googleEvents
          .map(fromGoogleEvent)
          .filter((e: CalendarEvent | null): e is CalendarEvent => e !== null);
        if (!state.connected.includes(person.id)) {
          state.connected = [...state.connected, person.id];
        }
        state.calendarConnectedAs = body.connectedAs ?? person.name;
        return ok();
      }

      case "/api/agenda/disconnect": {
        if (body.personId) {
          delete state.eventsByPerson[body.personId];
          state.connected = state.connected.filter((c) => c !== body.personId);
        } else {
          state.eventsByPerson = {};
          state.connected = [];
        }
        state.calendarConnectedAs = null;
        return ok();
      }

      /* ---- profiles ---- */

      case "/api/people": {
        if (!body.name?.trim()) return bad(400, "name required");
        const person = makePerson({ ...body, name: body.name.trim() });
        if (state.people.some((p) => p.id === person.id)) {
          return bad(400, `There is already a profile called ${person.name}.`);
        }
        state.people = [...state.people, person];
        return ok();
      }

      case "/api/people/update": {
        const existing = state.people.find((p) => p.id === body.id);
        if (!existing) return bad(404, `No profile "${body.id}"`);

        // The age bracket drives the default for cooking, so a change to it
        // re-derives that unless this same edit says otherwise.
        const bracketChanged =
          body.ageBracket !== undefined && body.ageBracket !== existing.ageBracket;
        const merged = makePerson({
          ...existing,
          ...body,
          id: existing.id,
          canCook:
            body.canCook !== undefined
              ? body.canCook
              : bracketChanged
                ? undefined
                : existing.canCook,
        });

        state.people = state.people.map((p) => (p.id === body.id ? merged : p));
        return ok();
      }

      case "/api/people/delete": {
        if (state.people.length <= 1) {
          return bad(400, "Somebody has to be eating. Add another profile first.");
        }
        const id = body.id;
        state.people = state.people.filter((p) => p.id !== id);
        // Their calendar and their cells in the grid go with them.
        delete state.eventsByPerson[id];
        state.connected = state.connected.filter((c) => c !== id);
        state.overrides = {
          ...state.overrides,
          present: Object.fromEntries(
            Object.entries(state.overrides.present ?? {}).filter(
              ([key]) => !key.endsWith(`|${id}`),
            ),
          ),
          cook: Object.fromEntries(
            Object.entries(state.overrides.cook ?? {}).filter(
              ([, who]) => who !== id,
            ),
          ),
        };
        return ok();
      }

      /* ---- the week's grid ---- */

      /* Each of these records a human answer. They are stored apart from the
         proposal so that re-reading a calendar can never undo one. */
      case "/api/week/present": {
        state.overrides = {
          ...state.overrides,
          present: {
            ...state.overrides.present,
            [`${body.date}|${body.personId}`]: body.present,
          },
        };
        return ok();
      }

      case "/api/week/cook": {
        state.overrides = {
          ...state.overrides,
          cook: { ...state.overrides.cook, [body.date]: body.personId ?? null },
        };
        // Choosing a different cook invalidates a time that belonged to the old
        // one; let it be re-proposed rather than silently inherited.
        const minutes = { ...state.overrides.minutes };
        delete minutes[body.date];
        state.overrides = { ...state.overrides, minutes };
        return ok();
      }

      case "/api/week/minutes": {
        if (!Number.isFinite(body.minutes) || body.minutes < 0) {
          return bad(400, "minutes must be a positive number");
        }
        state.overrides = {
          ...state.overrides,
          minutes: {
            ...state.overrides.minutes,
            [body.date]: Math.round(body.minutes),
          },
        };
        return ok();
      }

      case "/api/week/confirm": {
        state.confirmedWeek = planDates(state.plan)[0] ?? null;
        return ok();
      }

      /* Hand a cell back to the calendar. The inverse of an override, and the
         reason overrides are a separate layer rather than edits in place. */
      case "/api/week/reset": {
        if (!body.date) {
          state.overrides = {};
        } else {
          const strip = (
            record: Readonly<Record<string, unknown>> | undefined,
            match: (key: string) => boolean,
          ) =>
            Object.fromEntries(
              Object.entries(record ?? {}).filter(([key]) => !match(key)),
            );
          state.overrides = {
            present: strip(state.overrides.present, (k) =>
              k.startsWith(`${body.date}|`),
            ),
            cook: strip(state.overrides.cook, (k) => k === body.date),
            minutes: strip(state.overrides.minutes, (k) => k === body.date),
          } as SittingOverrides;
        }
        return ok();
      }

      /* ---- tasks ---- */

      case "/api/tasks/complete": {
        if (!state.tasks.some((t) => t.id === body.id)) {
          return bad(404, `No task "${body.id}"`);
        }
        state.tasks = state.tasks.map((t) =>
          t.id === body.id ? completeTask(t, state.today) : t,
        );
        return ok();
      }

      /* Deferring is a first-class answer, not a failure. A job pushed to
         tomorrow keeps its recurrence; only this occurrence moves. */
      case "/api/tasks/defer": {
        const step = Number.isFinite(body.days) ? Number(body.days) : 1;
        state.tasks = state.tasks.map((t) =>
          t.id === body.id
            ? { ...t, dueOn: addDays(t.dueOn ?? state.today, step) }
            : t,
        );
        return ok();
      }

      case "/api/tasks/delete": {
        state.tasks = state.tasks.filter((t) => t.id !== body.id);
        return ok();
      }

      case "/api/tasks/add": {
        if (!body.title) return bad(400, "title required");
        state.tasks = [
          ...state.tasks,
          {
            id: `t-${Date.now()}`,
            title: body.title,
            category: body.category ?? "household",
            effortMinutes: Number(body.effortMinutes) || 15,
            ...(body.assignee ? { assignee: body.assignee } : {}),
            ...(body.dueOn ? { dueOn: body.dueOn } : {}),
          },
        ];
        return ok();
      }

      /* Free text in, structured jobs out. One of the two routes that needs a
         model; everything else works without one. */
      case "/api/tasks/capture": {
        if (!body.text?.trim()) return bad(400, "text required");
        if (!ai.captureTasks) return bad(400, NO_MODEL);
        try {
          const run = await ai.captureTasks(body.text, {
            people: doers(),
            today: state.today,
          });
          state.tasks = [...state.tasks, ...run.tasks];
          state.lastCapture = {
            provider: run.provider,
            model: run.model,
            count: run.tasks.length,
            note: run.note,
            costUsd: run.costUsd,
          };
          return ok();
        } catch (error) {
          return bad(400, message(error));
        }
      }

      case "/api/tasks/reset": {
        state.tasks = DEMO_TASKS.map((t) => ({ ...t }));
        state.lastCapture = null;
        return ok();
      }

      /* ---- the plan ---- */

      case "/api/plan/generate": {
        if (!ai.generatePlan) return bad(400, NO_MODEL);
        const week = currentWeek();
        const projection = projectLarder(
          state.larder,
          state.plan,
          state.today,
          householdPortions(state.people),
        );
        const started = Date.now();
        try {
          const run = await ai.generatePlan(currentConstraints(), {
            // Days with nobody in are not slots worth filling.
            slots: slotsFromWeek(week),
            larderLines: larderForPrompt(projection),
          });
          state.plan = run.plan;
          state.source = "model";
          state.lastRun = {
            provider: run.provider,
            model: run.model,
            attempts: run.attempts,
            costUsd: run.costUsd,
            seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
          };
          return ok();
        } catch (error) {
          return bad(400, message(error));
        }
      }

      case "/api/plan/reset": {
        state.plan = GOOD_PLAN;
        state.source = "fixture";
        state.lastRun = null;
        return ok();
      }

      default:
        return bad(404, `No route ${path}`);
    }
  }

  /** The bits worth persisting; everything else is derived on every read. */
  function snapshot(): Snapshot {
    return {
      household: state.household,
      plan: state.plan,
      larder: state.larder,
      people: state.people,
      tasks: state.tasks,
      eventsByPerson: state.eventsByPerson,
      connected: state.connected,
      overrides: state.overrides,
      confirmedWeek: state.confirmedWeek,
      restockStaples: state.restockStaples,
      calendarConnectedAs: state.calendarConnectedAs,
    };
  }

  function reset(): void {
    Object.assign(state, freshSnapshot(), {
      source: "fixture",
      lastRun: null,
      lastCapture: null,
    });
  }

  return { buildState, handle, snapshot, reset };
}

const NO_MODEL =
  "No model provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY " +
  "(or MEAL_PLAN_PROVIDER to force one).";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
