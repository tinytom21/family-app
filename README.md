# Family app

One app to replace the pile of apps: meal planning, the larder, the family
agenda, shopping lists, tasks and reminders, and spending analysis. Web first,
so it works on a laptop the day it exists.

**[Try it](https://tinytom21.github.io/family-app/app/)** ·
**[The build plan](https://tinytom21.github.io/family-app/plan.html)**

The hosted demo runs the real domain code in your browser — the same modules
the server calls — with state in `localStorage` and no back end at all. The two
AI buttons are disabled there, because an API key shipped to a web page is an
API key given away. Clone and set a key to see that half.

## Where things are

| Path | What it is |
|---|---|
| `docs/` | The published site: landing page, build plan, Google runbook. |
| `docs/plan.html` | The build plan — stack decisions, architecture, the larder design, phases, risks. Start here. |
| `docs/google-setup.html` | Runbook for wiring Google Calendar access through Supabase auth. |
| `prototypes/meal-plan/` | The working spike. |
| `prototypes/meal-plan/src/app-state.ts` | The whole app, with no idea where it is running. |

## Run it

```bash
cd "prototypes/meal-plan"
npm install
npm run web
```

Then open <http://localhost:4321>. You get the week, the jobs, the shopping list
and the larder, all live — confirm what is in the cupboard and watch the
shopping list change underneath you.

**Who lives here** holds a profile per person: age bracket, allergies, likes and
dislikes, whether they can cook, and optionally a Google account. Portion size
and cooking ability both follow from the age bracket until you say otherwise,
because asking a parent to type a portion multiplier for a toddler is how an app
gets closed.

**This week's table** is the grid the family reviews on a Sunday: a tick per
person per day for who is in for dinner, a dropdown for who is cooking, and a
slider for how long they have. The calendars fill it in and every cell says
where its value came from — read from a diary, assumed, or corrected by a human.
Corrections are stored separately from the proposal, so re-reading a calendar
can never quietly undo one.

That grid then drives everything downstream. Portions are the sum of who is
actually in, so the Thursday one child is at a friend's house buys less food.
The cooking limit belongs to the *person cooking*, not the evening. And a day
where nobody is free to cook is a real answer — the planner is told to use
leftovers or the freezer rather than just something faster.

**Connect calendar** attaches a Google Calendar to one profile, matched by the
signed-in email address. Run `/check-google.html` once first — it sets up the
Supabase details this page then reuses.

**Jobs** are laid into the evenings the calendar actually leaves, around the
cooking, one column each for the two adults. Three things make this more than a
to-do list. Recurrence knows the difference between a bin day, which is fixed
whatever you did last week, and clean sheets, whose fortnight restarts when you
last managed it. Reminders can hang off the diary rather than a date, so "pack
the swimming kit" fires the night before swimming and stays silent the week the
lesson is off. And work that will not fit anywhere is said out loud instead of
rolling quietly to tomorrow forever.

Type a brain-dump into the box — *"bins tuesdays, ring the dentist before term
starts, sheets every couple of weeks"* — and **Add with AI** splits it into
dated, assigned, correctly-anchored jobs. That button needs a model key; **Add
as one job** does not.

There are no prices anywhere. Pack *sizes* are worth modelling because a 400 g
tin is a 400 g tin wherever you shop; pack *prices* are not, and a total that is
confidently wrong is worse than no total. So the list tells you what to put in
the trolley, and the pack solver minimises what ends up in the bin rather than
what it costs.

Everything runs from a fixture week with no API key. To make the **Replan**
button work, set one of these first:

```bash
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

```bash
$env:GEMINI_API_KEY = "..."
```

If both are present, Claude wins; force the other with
`MEAL_PLAN_PROVIDER=gemini`.

## The rest of the commands

```bash
npm test           # 160 tests, no API key needed
npm run demo       # the same week, in the terminal
npm run guardrails # a deliberately broken plan, and what catches it
npm run live       # one plan via the model, with token counts and cost
npm run build:static  # the hosted demo, into docs/app
```

Requires Node 22.6+ — it runs the TypeScript directly, so there is no build
step and no bundler.

## How it fits together

The riskiest part of this product was never the AI writing a nice-looking menu.
It is turning that menu into a shopping list that is *correct* — units
reconciled across recipes, the larder subtracted, real pack sizes — and doing it
without asking anyone to log what they ate.

```
src/domain/      units, catalogue, aggregation, larder,  ← the part that must be right
                 people, the week's table, the agenda,
                 tasks and recurrence
src/validate.ts  allergies, timings, portions, variety   ← guard rails, not prompts
src/app-state.ts the routes and the state, host-agnostic ← one implementation
src/ai/          two providers behind one interface      ← the swappable part
web/server.ts    HTTP wrapper for local development      ← ~20 lines of host
web/static/      browser wrapper for the hosted demo     ← ~20 lines of host
web/public/      the rendering client                    ← computes nothing itself
```

The client asks `window.__familyApi` for state when the bundled app is present
and falls back to `fetch("/api/...")` when it is not. That seam is the only
difference between running locally and running on GitHub Pages, and it is
deliberately three lines long — two implementations of "what happens when you
untick Priya on Tuesday" is how a shopping list and a larder start disagreeing.

The web client does no arithmetic of its own; every figure on screen comes from
the same modules a server would call. That is deliberate — two implementations
of the same sum is how a shopping list and a larder start disagreeing.
