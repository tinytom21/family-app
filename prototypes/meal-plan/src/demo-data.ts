/**
 * Fixtures so the pipeline can be exercised end to end without an API key.
 *
 * GOOD_PLAN is deliberately awkward in the ways real data is awkward:
 *   - olive oil arrives as tbsp in one recipe and ml in another
 *   - onion arrives as "2 unit" in one recipe and "200 g" in another
 *   - garlic is counted in cloves but sold in bulbs
 *   - the korma needs 340 g of chicken breast, sold in 300 g and 650 g packs
 *   - Tuesday cooks a double batch that Wednesday eats, so it must not be
 *     bought twice
 *   - rice, pasta and peas are already in the cupboard
 *
 * BAD_PLAN trips six different validators, to show the guard rails working.
 */

import type { MealPlan, PlanConstraints, Recipe } from "./domain/types.ts";
import type { Larder } from "./domain/larder.ts";
import type { Task } from "./domain/tasks.ts";
import { makePerson } from "./domain/people.ts";
import type { Person } from "./domain/people.ts";
import type { CalendarEvent } from "./domain/agenda.ts";

/** "Today" for the fixtures — the plan starts tomorrow. */
export const TODAY = "2026-08-16";

/**
 * Profiles, not just names.
 *
 * Spread across the age brackets on purpose: the portions, and who can be put
 * down to cook, both fall out of the bracket rather than being typed in.
 */
export const PEOPLE: Person[] = [
  makePerson({
    name: "Tom",
    ageBracket: "adult",
    // Deliberately no email. This repo is public, and a real address in a
    // fixture is a real address in a search index. Put yours into the profile
    // editor and Connect calendar will match on it.
    likes: ["curry", "anything with chorizo"],
  }),
  makePerson({
    name: "Priya",
    ageBracket: "adult",
    dislikes: ["blue cheese"],
  }),
  makePerson({
    name: "Aria",
    ageBracket: "child",
    excludes: ["nuts", "peanut"],
    notes: "Nut allergy is absolute — carries an EpiPen.",
  }),
  makePerson({
    name: "Noor",
    ageBracket: "child",
    dislikes: ["mushrooms"],
    likes: ["pasta"],
  }),
];

export const CONSTRAINTS: PlanConstraints = {
  weekStarting: "2026-08-17",
  people: PEOPLE,
  maxWeeknightMinutes: 45,
  maxWeekendMinutes: 90,
  maxSameProteinPerWeek: 2,
  // A reduced view of DEMO_LARDER below, kept simple for the aggregation tests.
  // The web app uses the larder projection instead, which is the real model.
  pantry: [
    { ingredientId: "rice-basmati", amount: 500 },
    { ingredientId: "pasta-penne", amount: 200 },
    { ingredientId: "peas-frozen", amount: 400 },
  ],
  notes:
    "Trying to eat less red meat. Aria has a nut allergy — this is absolute. Thursday is swimming so dinner needs to be quick.",
};

const RECIPES: Recipe[] = [
  {
    id: "sticky-chicken-traybake",
    title: "Sticky chicken thigh traybake",
    serves: 4,
    prepMinutes: 10,
    cookMinutes: 35,
    protein: "chicken",
    lines: [
      { ingredientId: "chicken-thigh", amount: 600, unit: "g" },
      { ingredientId: "potato", amount: 800, unit: "g", note: "cut into chunks" },
      { ingredientId: "pepper-red", amount: 2, unit: "unit" },
      { ingredientId: "courgette", amount: 1, unit: "unit" },
      { ingredientId: "olive-oil", amount: 2, unit: "tbsp" },
      { ingredientId: "paprika-smoked", amount: 2, unit: "tsp" },
      { ingredientId: "honey", amount: 1, unit: "tbsp" },
      { ingredientId: "lemon", amount: 1, unit: "unit" },
      { ingredientId: "salt", amount: 1, unit: "pinch" },
    ],
    steps: [
      "Heat the oven to 200C fan.",
      "Toss everything except the lemon in oil, paprika and honey.",
      "Roast 35 minutes, turning once.",
      "Squeeze the lemon over before serving.",
    ],
  },
  {
    id: "chorizo-chickpea-stew",
    title: "Chorizo and chickpea stew",
    serves: 6,
    prepMinutes: 10,
    cookMinutes: 30,
    protein: "pork",
    lines: [
      { ingredientId: "chorizo", amount: 200, unit: "g", note: "sliced" },
      { ingredientId: "chickpeas-tinned", amount: 2, unit: "tin" },
      { ingredientId: "tomato-tinned", amount: 2, unit: "tin" },
      { ingredientId: "onion", amount: 1, unit: "unit" },
      { ingredientId: "garlic", amount: 3, unit: "clove" },
      { ingredientId: "spinach", amount: 100, unit: "g" },
      { ingredientId: "olive-oil", amount: 1, unit: "tbsp" },
      { ingredientId: "cumin-ground", amount: 1, unit: "tsp" },
      { ingredientId: "bread-wholemeal", amount: 6, unit: "slice" },
    ],
    steps: [
      "Fry the chorizo until it releases its oil.",
      "Add onion and garlic, soften for 5 minutes.",
      "Tip in tomatoes and chickpeas, simmer 20 minutes.",
      "Stir the spinach through and serve with bread.",
    ],
  },
  {
    id: "salmon-new-potatoes",
    title: "Salmon with crushed potatoes and peas",
    serves: 4,
    prepMinutes: 10,
    cookMinutes: 25,
    protein: "fish",
    lines: [
      { ingredientId: "salmon-fillet", amount: 4, unit: "unit" },
      { ingredientId: "potato", amount: 700, unit: "g" },
      { ingredientId: "peas-frozen", amount: 300, unit: "g" },
      { ingredientId: "butter", amount: 30, unit: "g" },
      { ingredientId: "lemon", amount: 1, unit: "unit" },
      { ingredientId: "black-pepper", amount: 1, unit: "pinch" },
    ],
    steps: [
      "Boil the potatoes until tender, then crush with butter.",
      "Roast the salmon 12-14 minutes at 190C fan.",
      "Boil the peas for 3 minutes.",
      "Plate with a squeeze of lemon.",
    ],
  },
  {
    id: "beef-ragu-penne",
    title: "Beef ragù with penne",
    serves: 4,
    prepMinutes: 15,
    cookMinutes: 30,
    protein: "beef",
    lines: [
      { ingredientId: "beef-mince", amount: 500, unit: "g" },
      { ingredientId: "tomato-tinned", amount: 2, unit: "tin" },
      // Grams, where the traybake used whole onions. Same cupboard line.
      { ingredientId: "onion", amount: 200, unit: "g", note: "finely diced" },
      { ingredientId: "carrot", amount: 2, unit: "unit" },
      { ingredientId: "garlic", amount: 2, unit: "clove" },
      { ingredientId: "pasta-penne", amount: 400, unit: "g" },
      { ingredientId: "parmesan", amount: 40, unit: "g" },
      // Millilitres, where the traybake used tablespoons.
      { ingredientId: "olive-oil", amount: 15, unit: "ml" },
    ],
    steps: [
      "Soften onion, carrot and garlic in the oil.",
      "Brown the mince hard, then add the tomatoes.",
      "Simmer 25 minutes while the pasta cooks.",
      "Toss together and finish with parmesan.",
    ],
  },
  {
    id: "chicken-korma",
    title: "Chicken korma with rice",
    serves: 4,
    prepMinutes: 20,
    cookMinutes: 40,
    protein: "chicken",
    lines: [
      // 340 g against 300 g and 650 g packs — the pack solver earns its keep.
      { ingredientId: "chicken-breast", amount: 340, unit: "g" },
      { ingredientId: "curry-paste-korma", amount: 120, unit: "g" },
      { ingredientId: "coconut-milk", amount: 1, unit: "tin" },
      { ingredientId: "onion", amount: 2, unit: "unit" },
      { ingredientId: "garlic", amount: 3, unit: "clove" },
      { ingredientId: "ginger", amount: 20, unit: "g" },
      { ingredientId: "rice-basmati", amount: 300, unit: "g" },
      { ingredientId: "coriander", amount: 15, unit: "g" },
      { ingredientId: "yoghurt-greek", amount: 100, unit: "g" },
    ],
    steps: [
      "Brown the chicken, set aside.",
      "Soften onion, garlic and ginger, add the paste.",
      "Return the chicken with coconut milk, simmer 25 minutes.",
      "Stir the yoghurt through off the heat. Serve with rice and coriander.",
    ],
  },
  {
    id: "sweet-potato-chickpea-curry",
    title: "Sweet potato and chickpea curry",
    serves: 4,
    prepMinutes: 15,
    cookMinutes: 30,
    protein: "pulses",
    lines: [
      { ingredientId: "sweet-potato", amount: 700, unit: "g" },
      { ingredientId: "chickpeas-tinned", amount: 2, unit: "tin" },
      { ingredientId: "coconut-milk", amount: 1, unit: "tin" },
      { ingredientId: "onion", amount: 1, unit: "unit" },
      { ingredientId: "garlic", amount: 2, unit: "clove" },
      { ingredientId: "ginger", amount: 20, unit: "g" },
      { ingredientId: "curry-paste-korma", amount: 60, unit: "g" },
      { ingredientId: "spinach", amount: 100, unit: "g" },
      { ingredientId: "rice-basmati", amount: 250, unit: "g" },
      { ingredientId: "coriander", amount: 15, unit: "g" },
    ],
    steps: [
      "Soften onion, garlic and ginger, add the paste.",
      "Add sweet potato and coconut milk, simmer 20 minutes.",
      "Add chickpeas and warm through.",
      "Wilt the spinach in and serve with rice.",
    ],
  },
];

export const GOOD_PLAN: MealPlan = {
  weekStarting: "2026-08-17",
  recipes: RECIPES,
  meals: [
    { date: "2026-08-17", slot: "dinner", recipeId: "sticky-chicken-traybake", servings: 4 },
    // Tuesday cooks a double batch of a six-portion recipe...
    { date: "2026-08-18", slot: "dinner", recipeId: "chorizo-chickpea-stew", servings: 8 },
    { date: "2026-08-19", slot: "dinner", recipeId: "beef-ragu-penne", servings: 4 },
    // ...and Thursday, which is swimming night, eats it. Buy it once.
    {
      date: "2026-08-20",
      slot: "dinner",
      recipeId: "chorizo-chickpea-stew",
      servings: 4,
      leftoverOf: "2026-08-18",
    },
    { date: "2026-08-21", slot: "dinner", recipeId: "salmon-new-potatoes", servings: 4 },
    { date: "2026-08-22", slot: "dinner", recipeId: "chicken-korma", servings: 4 },
    { date: "2026-08-23", slot: "dinner", recipeId: "sweet-potato-chickpea-curry", servings: 4 },
  ],
};

/* ------------------------------------------------------------------ */

/**
 * What is actually in the house on the morning of the shop.
 *
 * Chosen to exercise each of the four stock classes and, more importantly, the
 * three confidence states — including one entry the app should refuse to trust.
 */
export const DEMO_LARDER: Larder = {
  items: [
    // Ambient: counted, never rots, confirmed two days ago.
    { ingredientId: "rice-basmati", amount: 500, confirmedOn: "2026-08-14" },
    { ingredientId: "pasta-penne", amount: 200, confirmedOn: "2026-08-14" },
    { ingredientId: "chickpeas-tinned", amount: 2, confirmedOn: "2026-08-14" },

    // Frozen: the bag in the drawer.
    { ingredientId: "peas-frozen", amount: 400, confirmedOn: "2026-08-14" },

    // Fresh, and the plan only uses a quarter of it before it turns. This is
    // the case the whole feature exists for.
    {
      ingredientId: "yoghurt-greek",
      amount: 400,
      confirmedOn: "2026-08-12",
      bestBefore: "2026-08-20",
    },
    { ingredientId: "butter", amount: 80, confirmedOn: "2026-08-15" },

    // Confirmed nearly four weeks ago. Fresh produce does not survive that,
    // so the app treats this as unknown and buys carrots anyway.
    { ingredientId: "carrot", amount: 6, confirmedOn: "2026-07-20" },
  ],
  freezer: [
    {
      id: "fz-1",
      label: "Chorizo and chickpea stew",
      portions: 2,
      frozenOn: "2026-06-28",
      fromRecipeId: "chorizo-chickpea-stew",
    },
    {
      id: "fz-2",
      label: "Beef bolognese",
      portions: 3,
      frozenOn: "2026-07-19",
    },
  ],
};

/* ------------------------------------------------------------------ */

/**
 * A calendar each, so the week's grid has something to fill itself in from
 * without anyone signing in to Google.
 *
 * Between them these produce every case the grid has to get right: an evening
 * one adult loses entirely, an evening where being busy does *not* mean being
 * absent, somebody genuinely eating elsewhere, a child away overnight, and one
 * evening with nobody free to cook at all.
 */
export const DEMO_EVENTS: Record<string, CalendarEvent[]> = {
  tom: [
    // Monday is gone: a school run straight into a call that runs to 20:30.
    { id: "t1", summary: "Drop Leo at wallingford", startsAt: "2026-08-17T17:00:00+01:00", endsAt: "2026-08-17T18:00:00+01:00" },
    { id: "t2", summary: "Prepare documentation", startsAt: "2026-08-17T18:00:00+01:00", endsAt: "2026-08-17T20:30:00+01:00" },
    // Thursday he is genuinely elsewhere, and says so.
    { id: "t3", summary: "Dinner with the Hardys", startsAt: "2026-08-20T19:00:00+01:00", endsAt: "2026-08-20T22:00:00+01:00" },
  ],
  priya: [
    // Busy through dinner, but at home — she eats, she just cannot cook.
    { id: "p1", summary: "Client call", startsAt: "2026-08-17T17:30:00+01:00", endsAt: "2026-08-17T20:30:00+01:00" },
    { id: "p2", summary: "7.15 counselling", startsAt: "2026-08-18T19:15:00+01:00", endsAt: "2026-08-18T20:15:00+01:00" },
    { id: "p3", summary: "Noor swimming lesson", startsAt: "2026-08-20T17:30:00+01:00", endsAt: "2026-08-20T18:30:00+01:00" },
  ],
  aria: [
    { id: "a1", summary: "Staying at Grandma's", onDate: "2026-08-21" },
    { id: "a2", summary: "Charlton school holidays", onDate: "2026-08-17" },
  ],
  noor: [
    { id: "n1", summary: "Noor swimming lesson", startsAt: "2026-08-20T17:30:00+01:00", endsAt: "2026-08-20T18:30:00+01:00" },
    { id: "n2", summary: "Sophie's birthday party", startsAt: "2026-08-22T16:00:00+01:00", endsAt: "2026-08-22T19:00:00+01:00" },
  ],
};

/**
 * The jobs list, chosen so every branch of the tasks model shows up once.
 *
 * Between them these cover both recurrence anchors, an event-pinned reminder,
 * something already late, something with no date at all, and a weekend job big
 * enough that it can only fit where the calendar leaves room for it.
 */
export const DEMO_TASKS: Task[] = [
  {
    id: "bins",
    title: "Bins out",
    category: "household",
    dueOn: "2026-08-18",
    effortMinutes: 5,
    // The council does not care when you last managed it.
    recurrence: { every: 1, unit: "week", weekdays: [2], anchor: "schedule" },
    lastCompletedOn: "2026-08-11",
  },
  {
    id: "bedsheets",
    title: "Change the bedsheets",
    category: "household",
    dueOn: "2026-08-19",
    effortMinutes: 20,
    // The sheets, by contrast, only know when you last changed them.
    recurrence: { every: 2, unit: "week", anchor: "completion" },
    lastCompletedOn: "2026-08-05",
  },
  {
    id: "swim-kit",
    title: "Pack the swimming kit",
    category: "kids",
    assignee: "Priya",
    effortMinutes: 10,
    // Fires off the calendar, so a cancelled lesson is a silent week.
    beforeEvent: { match: "swim", lead: "evening-before" },
  },
  {
    id: "car-insurance",
    title: "Renew the car insurance",
    category: "admin",
    dueOn: "2026-08-12",
    effortMinutes: 30,
    notes: "Quote from the comparison site expires Friday.",
  },
  {
    id: "dentist",
    title: "Book the girls' dental check-ups",
    category: "admin",
    assignee: "Tom",
    dueOn: "2026-08-21",
    effortMinutes: 15,
  },
  {
    id: "hoover",
    title: "Hoover downstairs",
    category: "household",
    dueOn: "2026-08-22",
    effortMinutes: 25,
    recurrence: { every: 1, unit: "week", weekdays: [6], anchor: "schedule" },
    lastCompletedOn: "2026-08-15",
  },
  {
    id: "reading-record",
    title: "Sign Noor's reading record",
    category: "kids",
    assignee: "Priya",
    dueOn: "2026-08-21",
    effortMinutes: 5,
    recurrence: { every: 1, unit: "week", weekdays: [5], anchor: "schedule" },
  },
  {
    id: "plants",
    title: "Water the plants",
    category: "household",
    dueOn: "2026-08-17",
    effortMinutes: 10,
    recurrence: { every: 3, unit: "day", anchor: "completion" },
    lastCompletedOn: "2026-08-14",
  },
  {
    id: "loft",
    title: "Sort the boxes in the loft",
    category: "household",
    effortMinutes: 90,
    notes: "No rush, but it has been eighteen months.",
  },
];

/* ------------------------------------------------------------------ */

const SATAY: Recipe = {
  id: "peanut-satay-noodles",
  title: "Peanut satay noodles",
  serves: 4,
  prepMinutes: 15,
  cookMinutes: 15,
  protein: "chicken",
  lines: [
    { ingredientId: "noodles-egg", amount: 250, unit: "g" },
    // Aria is allergic. This must never reach the table.
    { ingredientId: "peanut-butter", amount: 90, unit: "g" },
    { ingredientId: "chicken-breast", amount: 400, unit: "g" },
    { ingredientId: "soy-sauce", amount: 2, unit: "tbsp" },
  ],
  steps: ["Cook noodles.", "Whisk peanut butter with soy.", "Toss together."],
};

const SLOW_STEW: Recipe = {
  id: "eight-hour-beef",
  title: "Slow-braised beef shin",
  serves: 4,
  prepMinutes: 25,
  cookMinutes: 240,
  protein: "beef",
  lines: [
    { ingredientId: "beef-mince", amount: 800, unit: "g" },
    { ingredientId: "carrot", amount: 4, unit: "unit" },
    { ingredientId: "onion", amount: 2, unit: "unit" },
    // Not in the catalogue — the model should never be able to emit this,
    // but a hand-written or imported recipe can.
    { ingredientId: "red-wine", amount: 250, unit: "ml" },
  ],
  steps: ["Brown.", "Braise for four hours."],
};

export const BAD_PLAN: MealPlan = {
  weekStarting: "2026-08-17",
  recipes: [...RECIPES, SATAY, SLOW_STEW],
  meals: [
    { date: "2026-08-17", slot: "dinner", recipeId: "sticky-chicken-traybake", servings: 4 },
    { date: "2026-08-18", slot: "dinner", recipeId: "peanut-satay-noodles", servings: 4 },
    { date: "2026-08-19", slot: "dinner", recipeId: "eight-hour-beef", servings: 4 },
    { date: "2026-08-20", slot: "dinner", recipeId: "chicken-korma", servings: 4 },
    // Repeat without a leftover marker, and a fourth chicken dinner.
    { date: "2026-08-21", slot: "dinner", recipeId: "chicken-korma", servings: 4 },
    { date: "2026-08-22", slot: "dinner", recipeId: "roast-partridge", servings: 4 },
    // Sunday is simply missing.
  ],
};
