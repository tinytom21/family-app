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
import type { SittingOverrides, UsualWeek } from "./domain/sitting.ts";
import { nextStartOn, redatePlan, todayIn, weekdayIndex } from "./domain/week.ts";
import { dayMessage, ingredientLines, weekMessage, weekMessages } from "./domain/share.ts";
import type { ShareInput } from "./domain/share.ts";
import { linksFor, searchTermFor } from "./domain/retailers.ts";
import {
  CONFIDENT,
  autoMatch,
  cleanProductUrl,
  cleanShelfPrice,
  planBasket,
  rankCandidates,
} from "./domain/basket.ts";
import type { BasketProvider, ProductLink } from "./domain/basket.ts";
import { getIngredient } from "./domain/catalogue.ts";
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
import type { MealPlan, MealSlot, PlanConstraints, Recipe } from "./domain/types.ts";
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
} from "./domain/history.ts";
import type { MealLog, Rating } from "./domain/history.ts";

/* ------------------------------------------------------------------ */

export interface PlanRunSummary {
  readonly plan: MealPlan;
  readonly provider: string;
  readonly model: string;
  readonly attempts: number;
  readonly costUsd: number;
  /** The model's own two sentences — on a revision, what it changed and why. */
  readonly reasoning?: string;
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
      /** Favourites to bring back as they were. */
      reuse?: readonly Recipe[];
      /** Revise this plan rather than replace it. */
      current?: MealPlan;
    },
  ): Promise<PlanRunSummary>;
  captureTasks?(
    text: string,
    context: { people: readonly string[]; today: string },
  ): Promise<CaptureRunSummary>;
}

/**
 * Filling a real supermarket basket.
 *
 * Injected rather than imported, exactly like the model, and for a stronger
 * reason: the session behind it can act on somebody's grocery account. The
 * browser build passes nothing, so the published bundle has no path to a
 * basket at all — a property of the build rather than a flag.
 */
export interface BasketHooks {
  readonly available: boolean;
  readonly provider?: BasketProvider;
  signedIn?(): Promise<boolean>;
  signIn?(): Promise<void>;
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
  /** What the family wants every week, in their words: "pizza on Fridays". */
  instructions?: string;
  /** 0 = Sunday … 6 = Saturday. The day a planned week begins; Monday if unsaid. */
  weekStartsOn?: number;
  /** Who usually cooks each weekday, and how long they usually have. */
  usualWeek?: UsualWeek;
}

/** The part of the state worth keeping between visits. */
export interface Snapshot {
  household: HouseholdInfo;
  /** Confirmed ingredient-to-product mappings, learned once and reused. */
  productLinks: ProductLink[];
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
  /**
   * What is different about a particular week, keyed by the date it starts.
   * Per week on purpose: last week's "Jess away Thursday" must not quietly
   * apply forever. Optional because households saved before it existed lack it.
   */
  weekNotes?: Record<string, string>;
  /** Every agreed meal and the family's thumbs on it. */
  mealLog?: MealLog;
  /** The week whose plan the family has agreed, if it is the one on screen. */
  agreedWeek?: string | null;
}

function freshSnapshot(): Snapshot {
  return {
    household: { name: "", setUp: false },
    productLinks: [],
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
    weekNotes: {},
    mealLog: emptyLog(),
    agreedWeek: null,
  };
}

/* ------------------------------------------------------------------ */

export function createApp(
  options: {
    ai?: AiHooks;
    basket?: BasketHooks;
    seed?: Partial<Snapshot>;
    today?: string;
  } = {},
) {
  const ai = options.ai ?? { available: false };
  const basketHooks = options.basket ?? { available: false };
  // The clock, unless a caller pins it. Tests and the example household pin it;
  // a real household follows the calendar, because a plan whose days are all in
  // the past fails in ways that look like unrelated bugs.
  const realToday = options.today ?? todayIn();

  const state = {
    ...freshSnapshot(),
    ...options.seed,
    today: realToday,
    source: "fixture" as "fixture" | "model",
    lastRun: null as null | {
      provider: string;
      model: string;
      attempts: number;
      costUsd: number;
      seconds: number;
      reasoning?: string;
      revised?: boolean;
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
      usual: state.household.usualWeek,
      options: {
        maxWeeknightMinutes: CONSTRAINTS.maxWeeknightMinutes,
        maxWeekendMinutes: CONSTRAINTS.maxWeekendMinutes,
      },
    });

  /** The usual week in the family's own day order, with names, for the screen. */
  const usualSummary = () => {
    const usual = state.household.usualWeek;
    if (!usual || Object.keys(usual).length === 0) return null;
    const start = state.household.weekStartsOn ?? 1;
    return Array.from({ length: 7 }, (_, i) => (start + i) % 7)
      .filter((weekday) => usual[weekday] !== undefined)
      .map((weekday) => {
        const day = usual[weekday]!;
        return {
          weekday,
          day: WEEKDAY_NAMES[weekday],
          cookName:
            day.cookId === null
              ? null
              : (state.people.find((p) => p.id === day.cookId)?.name ?? "someone no longer here"),
          minutes: day.minutes,
        };
      });
  };

  const mealLog = (): MealLog => state.mealLog ?? emptyLog();
  const ingredientName = (id: string) => getIngredient(id)?.name ?? id;

  /**
   * What the screen shows of the log: dishes and their thumbs, the patterns,
   * what is still waiting for a verdict, and which favourites the next plan
   * will bring back — so nothing about the suggestions is a mystery.
   */
  const historySummary = () => {
    const log = mealLog();
    const thisWeek = state.plan.weekStarting;
    const fourWeeksAgo = addDays(state.today, -28);
    return {
      meals: log.entries.filter((e) => !e.leftover).length,
      dishes: dishStats(log).slice(0, 40),
      patterns: patterns(log, ingredientName),
      toRate: log.entries
        .filter(
          (e) =>
            !e.leftover &&
            !e.rating &&
            e.date < state.today &&
            e.date >= fourWeeksAgo &&
            e.weekStarting !== thisWeek,
        )
        .map((e) => ({ date: e.date, slot: e.slot, title: e.title }))
        .reverse(),
      comingBack: chooseRepeats(log, thisWeek).map((r) => ({
        title: r.title,
        weeksSince: r.weeksSince,
      })),
    };
  };

  /** This week's meal's rating, if it has one. */
  const ratingOf = (date: string, slot: MealSlot, title: string): Rating | null =>
    mealLog().entries.find(
      (e) => e.date === date && e.slot === slot && e.key === dishKey(title),
    )?.rating ?? null;

  /** What the WhatsApp message is written from: the plan and the week's table. */
  const shareInput = (): ShareInput => ({
    householdName: state.household.name,
    plan: state.plan,
    days: currentWeek().map((day) => ({
      date: day.date,
      cookName: day.cookName,
      away: day.attendance.filter((a) => !a.present).map((a) => a.name),
    })),
    weekNote: weekNote(),
  });

  /** This week's notes, for whichever week the plan is currently on. */
  const weekNote = (): string =>
    (state.weekNotes ?? {})[state.plan.weekStarting]?.trim() ?? "";

  const currentConstraints = (): PlanConstraints => ({
    ...CONSTRAINTS,
    // CONSTRAINTS.notes is the example family's text — a made-up child's nut
    // allergy and their swimming night. It used to ride along from here into
    // every real household's prompt. A family's instructions now come from
    // that family and nowhere else.
    notes: undefined,
    standing: state.household.instructions?.trim() || undefined,
    thisWeek: weekNote() || undefined,
    people: state.people,
    // The plan's own week, not the fixture's — otherwise a household set up in
    // September is asked to plan a week in August.
    weekStarting: state.plan.weekStarting,
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
      history: historySummary(),
      restockStaples: state.restockStaples,
      modelAvailable: ai.available,
      /** False on a first visit; the client shows the intro screen instead. */
      setUp: state.household.setUp,
      household: {
        name: state.household.name,
        remoteId: state.household.remoteId ?? null,
        people: state.people.map((p) => ({ ...p, portion: portionFor(p) })),
        portions: householdPortions(state.people),
        instructions: state.household.instructions ?? "",
        weekStartsOn: state.household.weekStartsOn ?? 1,
        usualWeek: usualSummary(),
        weekStarting: state.plan.weekStarting,
        maxWeeknightMinutes: CONSTRAINTS.maxWeeknightMinutes,
        maxWeekendMinutes: CONSTRAINTS.maxWeekendMinutes,
        ageBrackets: AGE_BRACKETS.map((id) => ({
          id,
          label: AGE_BRACKET_LABELS[id],
        })),
      },
      week: {
        days: week,
        note: weekNote(),
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
        /** Agreed by the family: in the meal log, and what they are eating. */
        agreed: state.agreedWeek === state.plan.weekStarting,
        meals: state.plan.meals.map((meal) => {
          const recipe = state.plan.recipes.find((r) => r.id === meal.recipeId);
          const title = recipe?.title ?? meal.recipeId;
          return {
            ...meal,
            title: recipe?.title ?? meal.recipeId,
            minutes: recipe ? recipe.prepMinutes + recipe.cookMinutes : null,
            protein: recipe?.protein ?? null,
            steps: recipe?.steps ?? [],
            // Scaled to tonight's portions by the same code that writes the
            // WhatsApp message, so the screen and the chat never disagree.
            ingredients:
              recipe && !meal.leftoverOf ? ingredientLines(recipe, meal.servings) : [],
            sitting: weekByDate.get(meal.date) ?? null,
            // Rated once it has been eaten, never before — and never the
            // leftover night, which would only score the same dish twice.
            rateable: !meal.leftoverOf && meal.date <= state.today,
            rating: meal.leftoverOf ? null : ratingOf(meal.date, meal.slot, title),
          };
        }),
      },
      list: {
        ...list,
        // A search link per line. There is no supermarket API that can fill a
        // basket, so the shopper resolves the product ambiguity themselves —
        // which is the part an API was never going to get right anyway.
        lines: list.lines.map((line) => {
          const ingredient = getIngredient(line.ingredientId);
          return {
            ...line,
            links: ingredient ? linksFor(ingredient) : [],
          };
        }),
      },
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

  /**
   * Remember which product answers a line. One link per ingredient and pack
   * size, so choosing again replaces rather than adds. The link and price are
   * checked here whoever sent them: household state is shared, and a stored
   * `javascript:` link would run in the next member's browser.
   */
  function linkProduct(
    ingredientId: string,
    packSize: number,
    product: { sku: string; title?: string; url?: unknown; price?: unknown },
    auto: boolean,
  ): void {
    const url = cleanProductUrl(product.url);
    const price = cleanShelfPrice(product.price);
    state.productLinks = [
      ...state.productLinks.filter(
        (l) => !(l.ingredientId === ingredientId && l.packSize === packSize),
      ),
      {
        ingredientId,
        packSize,
        sku: String(product.sku),
        title: product.title ? String(product.title) : String(product.sku),
        confirmedOn: state.today,
        ...(url ? { url } : {}),
        ...(price ? { price } : {}),
        ...(auto ? { auto: true } : {}),
      },
    ];
  }

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
        const weekStartsOn =
          Number.isInteger(body.weekStartsOn) && body.weekStartsOn >= 0 && body.weekStartsOn <= 6
            ? body.weekStartsOn
            : 1;
        state.people = people;
        state.household = {
          name: body.householdName.trim(),
          setUp: true,
          instructions: cleanText(body.instructions),
          weekStartsOn,
          ...(state.household.remoteId ? { remoteId: state.household.remoteId } : {}),
        };

        // The starter week is moved onto the week actually coming up, starting
        // on the family's own day. Left on the fixture's dates it would all be
        // in the past, and the calendar read, the jobs scheduler and every due
        // date would quietly misbehave.
        state.today = realToday;
        state.plan = redatePlan(GOOD_PLAN, nextStartOn(realToday, weekStartsOn));
        state.weekNotes = {};

        // A real family starts with an empty cupboard and no jobs — those are
        // theirs to fill. The starter week stays as something to look at and
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
        // Pinned to the fixture week on purpose: the example calendars, larder
        // dates and jobs are all written against it, and re-dating half of them
        // would make the example demonstrate nothing.
        state.today = TODAY;
        // Their notes are theirs: given to the example household explicitly,
        // rather than spread into everyone's prompt from the constraints.
        state.household = {
          name: "The Hardys",
          setUp: true,
          instructions: CONSTRAINTS.notes ?? "",
        };
        state.source = "fixture";
        state.lastRun = null;
        state.lastCapture = null;
        return ok();
      }

      /* ---- filling a supermarket basket ---- */

      /* Everything here is local-only: the browser build passes no basket
         provider, so these all answer "not switched on" there. */
      case "/api/basket/plan": {
        const week = currentWeek();
        const projection = projectLarder(
          state.larder, state.plan, state.today, householdPortions(state.people),
        );
        const list = buildShoppingList(state.plan, larderToPantry(projection), {
          restockStaples: state.restockStaples,
        });
        const plan = planBasket(list.lines, state.productLinks);
        return {
          status: 200,
          body: {
            ...plan,
            available: basketHooks.available,
            // Which provider, so the screen can say plainly when it is practice.
            provider: basketHooks.provider?.id ?? null,
            signedIn: basketHooks.signedIn ? await basketHooks.signedIn() : false,
          },
        };
      }

      /* Search the retailer for one line and rank what comes back. The ranking
         is the domain's job; this only fetches. */
      case "/api/basket/candidates":
      /* "Find all" asks the same question, and puts the answer straight in
         when it is a 100% match. The browser loops over the lines so it can
         show progress, but what counts as sure enough is decided here, once,
         rather than in whichever client happens to be asking. */
      case "/api/basket/match": {
        if (!basketHooks.provider) return bad(400, NO_BASKET);
        const ingredient = getIngredient(body.ingredientId);
        if (!ingredient) return bad(404, `No ingredient "${body.ingredientId}"`);
        if (!Number.isFinite(body.packSize)) return bad(400, "packSize required");
        try {
          // Returned alongside the results so the screen can show — and let a
          // person edit — the words that were actually searched for.
          const term = body.term?.trim() || searchTermFor(ingredient);
          const found = await basketHooks.provider.search(term, 12);
          const candidates = rankCandidates(ingredient, body.packSize, found);
          const sure = path === "/api/basket/match" ? autoMatch(candidates) : null;
          if (sure) linkProduct(ingredient.id, body.packSize, sure.product, true);
          return {
            status: 200,
            body: { candidates, confident: CONFIDENT, term, linked: sure?.product ?? null },
          };
        } catch (error) {
          return bad(400, message(error));
        }
      }

      /* A person has decided. Remembered per ingredient and pack size, so the
         same choice is never asked for twice. */
      case "/api/basket/link": {
        const { ingredientId, packSize, sku } = body;
        if (!ingredientId || !sku || !Number.isFinite(packSize)) {
          return bad(400, "ingredientId, packSize and sku required");
        }
        linkProduct(ingredientId, packSize, body, false);
        return ok();
      }

      case "/api/basket/unlink": {
        state.productLinks = state.productLinks.filter(
          (l) => !(l.ingredientId === body.ingredientId && l.packSize === body.packSize),
        );
        return ok();
      }

      /* Put the confirmed items in the basket. Quantities are *set*, so
         pressing this twice leaves one week's shopping rather than two. */
      case "/api/basket/fill": {
        if (!basketHooks.provider) return bad(400, NO_BASKET);
        const projection = projectLarder(
          state.larder, state.plan, state.today, householdPortions(state.people),
        );
        const list = buildShoppingList(state.plan, larderToPantry(projection), {
          restockStaples: state.restockStaples,
        });
        const plan = planBasket(list.lines, state.productLinks);
        const done: string[] = [];
        const failed: { title: string; why: string }[] = [];
        for (const item of plan.items) {
          try {
            await basketHooks.provider.set(item.sku, item.quantity);
            done.push(item.title);
          } catch (error) {
            // One unavailable product must not abandon the rest of the shop.
            failed.push({ title: item.title, why: message(error) });
          }
        }
        return {
          status: 200,
          body: { added: done, failed, skipped: plan.needsChoosing.length },
        };
      }

      /* Hand back where to pay. Nothing here spends money, by design. */
      case "/api/basket/checkout": {
        if (!basketHooks.provider) return bad(400, NO_BASKET);
        try {
          return { status: 200, body: { url: await basketHooks.provider.checkoutUrl() } };
        } catch (error) {
          return bad(400, message(error));
        }
      }

      case "/api/basket/signin": {
        if (!basketHooks.signIn) return bad(400, NO_BASKET);
        try {
          await basketHooks.signIn();
          return { status: 200, body: { signedIn: true } };
        } catch (error) {
          return bad(400, message(error));
        }
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
      /* The week, and one day of it, as WhatsApp messages. Read-only: these
         describe the plan and change nothing. */
      case "/api/share/week": {
        const input = shareInput();
        // `parts` is what to send: one message when the week fits, several
        // when it does not. `text` stays as the whole, unsplit week.
        return {
          status: 200,
          body: { text: weekMessage(input), parts: weekMessages(input) },
        };
      }

      case "/api/share/day": {
        const text = dayMessage(shareInput(), String(body.date ?? ""));
        if (!text) return bad(404, "That day is not in this week's plan.");
        return { status: 200, body: { text } };
      }

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

      /* Which household in the account this browser is looking at.
         Kept in the state, not in a variable, because a page reload used to
         forget it — and a browser that has forgotten where it uploaded to
         makes a second household the next time it saves. */
      case "/api/household/link": {
        const remoteId = typeof body.remoteId === "string" ? body.remoteId.trim() : "";
        if (!remoteId) return bad(400, "remoteId required");
        state.household = { ...state.household, remoteId };
        return ok();
      }

      /* What the family wants every week. Free text on purpose — "pizza on
         Fridays" does not fit a form — so it reaches the planner as words, and
         nothing here pretends it can check them. */
      case "/api/household/instructions": {
        state.household = { ...state.household, instructions: cleanText(body.text) };
        return ok();
      }

      /* Which day this week begins. The plan moves onto the new dates rather
         than being thrown away, and the weekday is remembered, so a family
         that shops Monday to Sunday only has to say so once. */
      case "/api/week/start": {
        const date = typeof body.date === "string" ? body.date : "";
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          Number.isNaN(Date.parse(`${date}T00:00:00Z`))
        ) {
          return bad(400, "A date like 2026-10-05 is needed.");
        }
        const from = state.plan.weekStarting;
        const notes = { ...(state.weekNotes ?? {}) };
        // A note written before the date was changed is about the week being
        // planned, not about the old date. It moves with it.
        if (notes[from] && !notes[date]) {
          notes[date] = notes[from];
          delete notes[from];
        }
        state.weekNotes = notes;
        state.plan = redatePlan(state.plan, date);
        state.household = { ...state.household, weekStartsOn: weekdayIndex(date) };
        return ok();
      }

      /* Keep this week's cooks and times as the family's usual week.

         Taken from the table exactly as it stands — calendar, guesses and
         corrections alike — because that is what the person pressing the
         button is looking at, and "save what I can see" is the only rule
         nobody has to have explained. */
      case "/api/week/save-usual": {
        const usual: UsualWeek = {};
        for (const day of currentWeek()) {
          usual[weekdayIndex(day.date)] = { cookId: day.cookId, minutes: day.cookMinutes };
        }
        state.household = { ...state.household, usualWeek: usual };

        // This week's corrections to cook and time are now simply the usual,
        // so they stop being corrections. Who is in for dinner is a different
        // question and stays exactly as it was.
        const dates = new Set(planDates(state.plan));
        state.overrides = {
          ...state.overrides,
          cook: withoutDates(state.overrides.cook, dates),
          minutes: withoutDates(state.overrides.minutes, dates),
        };
        return ok();
      }

      case "/api/week/forget-usual": {
        const { usualWeek: _gone, ...household } = state.household;
        state.household = household;
        return ok();
      }

      /* Anything different about this particular week. */
      case "/api/week/note": {
        const text = cleanText(body.text);
        const notes = { ...(state.weekNotes ?? {}) };
        if (text) notes[state.plan.weekStarting] = text;
        else delete notes[state.plan.weekStarting];
        state.weekNotes = notes;
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

      case "/api/plan/generate":
      /* A revision: the same planner, shown the plan as it stands and told to
         change only what this week's notes ask for. */
      case "/api/plan/revise": {
        if (!ai.generatePlan) return bad(400, NO_MODEL);
        const revising = path === "/api/plan/revise";
        if (revising && !weekNote()) {
          return bad(400, "Write what you would like changed in the box above the button first.");
        }

        const week = currentWeek();
        const projection = projectLarder(
          state.larder,
          state.plan,
          state.today,
          householdPortions(state.people),
        );
        // The favourites due back this week, decided here once, so the prompt
        // that names them and the recipes handed over always agree.
        const log = mealLog();
        const repeats = chooseRepeats(log, state.plan.weekStarting);
        const history = historyForPrompt(log, state.plan.weekStarting, repeats, ingredientName);
        const started = Date.now();
        try {
          const run = await ai.generatePlan(
            { ...currentConstraints(), history: history || undefined },
            {
              // Days with nobody in are not slots worth filling.
              slots: slotsFromWeek(week),
              larderLines: larderForPrompt(projection),
              reuse: repeats.map((r) => ({ ...r.recipe, id: repeatId(r.key) })),
              ...(revising ? { current: state.plan } : {}),
            },
          );
          state.plan = run.plan;
          state.source = "model";
          // A changed plan is a new proposal: it needs agreeing again. The log
          // keeps what was agreed until then, and agreeing replaces it.
          if (state.agreedWeek === state.plan.weekStarting) state.agreedWeek = null;
          state.lastRun = {
            provider: run.provider,
            model: run.model,
            attempts: run.attempts,
            costUsd: run.costUsd,
            seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
            ...(run.reasoning ? { reasoning: run.reasoning } : {}),
            revised: revising,
          };
          return ok();
        } catch (error) {
          return bad(400, message(error));
        }
      }

      /* "This is what we are eating." Puts the week in the meal log, which is
         what ratings attach to and what future plans learn from. */
      case "/api/plan/agree": {
        const cooks = Object.fromEntries(currentWeek().map((d) => [d.date, d.cookName]));
        state.mealLog = recordWeek(mealLog(), state.plan, cooks);
        state.agreedWeek = state.plan.weekStarting;
        return ok();
      }

      /* Thumbs up, thumbs down, or null to take it back. A meal from this
         week that was never formally agreed is logged on being rated:
         somebody ate it, which is agreement enough. */
      case "/api/meal/rate": {
        const date = String(body.date ?? "");
        const slot = (body.slot ?? "dinner") as MealSlot;
        const rating: Rating | null =
          body.rating === "up" || body.rating === "down" ? body.rating : null;
        if (body.rating != null && rating === null) return bad(400, "rating is up, down or null");
        if (date > state.today) return bad(400, "That meal has not been eaten yet.");

        let log = mealLog();
        const logged = (l: MealLog) =>
          l.entries.some((e) => e.date === date && e.slot === slot && !e.leftover);
        if (!logged(log) && state.plan.meals.some((m) => m.date === date && m.slot === slot)) {
          const cooks = Object.fromEntries(currentWeek().map((d) => [d.date, d.cookName]));
          log = recordWeek(log, state.plan, cooks);
        }
        if (!logged(log)) return bad(404, "That meal is not in the log.");
        state.mealLog = rateMeal(log, date, slot, rating);
        return ok();
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
      productLinks: state.productLinks,
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
      weekNotes: state.weekNotes ?? {},
      mealLog: state.mealLog ?? emptyLog(),
      agreedWeek: state.agreedWeek ?? null,
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

const NO_BASKET =
  "Basket filling is not switched on. It runs from the local server only — " +
  "the published demo has no supermarket session and never will.";

const NO_MODEL =
  "No model provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY " +
  "(or MEAL_PLAN_PROVIDER to force one).";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A family's own words, trimmed and kept to a sane length. Long enough for a
 * paragraph of house rules; short enough that a pasted cookbook does not end
 * up in every prompt, paid for every week.
 */
const cleanText = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, 2000) : "";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A by-date record without the given dates. */
function withoutDates<T>(
  record: Record<string, T> | undefined,
  dates: ReadonlySet<string>,
): Record<string, T> | undefined {
  if (!record) return record;
  return Object.fromEntries(Object.entries(record).filter(([date]) => !dates.has(date)));
}
