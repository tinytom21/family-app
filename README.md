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
| `supabase/schema.sql` | Households, membership, invites and state — and the RLS that is the security model. |

## Run it for real

The hosted demo has no model behind it, so **Replan with AI** is disabled there.
To use this for an actual week's shop, run it locally with a key:

```bash
cd "prototypes/meal-plan"
npm install
```

Set a key, then start it — in the *same* window, because a key is set per
terminal:

```bash
$env:GEMINI_API_KEY = "your-key"
node web/server.ts
```

Command Prompt uses `set GEMINI_API_KEY=your-key` instead. `ANTHROPIC_API_KEY`
works just as well; if both are set Claude wins, and `MEAL_PLAN_PROVIDER=gemini`
forces the other.

These say `node` rather than `npm run` on purpose. Windows blocks `npm.ps1`
under the default execution policy, so `npm` fails in PowerShell with a security
error that has nothing to do with this project. `node` sidesteps it entirely;
`npm.cmd run web` also works if you prefer npm.

Paste a real key, not the placeholder. `$env:ANTHROPIC_API_KEY = "sk-ant-..."`
sets the variable to the literal string `sk-ant-...`, and the assignment
succeeds even when the command after it fails — the app now refuses that rather
than sending it to Anthropic, but it is still a wasted minute.

### Which model, and what it costs

Roughly 2,300 tokens in and 7,000 out for one week's plan, so at one plan a
week:

| Model | Per plan | Per year |
|---|---|---|
| `claude-opus-5` (default) | ~$0.19 | ~$10 |
| `claude-sonnet-5` | ~$0.11 | ~$6 |
| `claude-haiku-4-5` | ~$0.04 | ~$2 |

Set one with `$env:CLAUDE_MODEL = "claude-sonnet-5"`. A repair round costs
another call, so budget for two or three plans' worth on a bad week.

Gemini's free tier allows **twenty requests a day**, which is under three
clicks of Replan once repair rounds are counted. It is enough to see the thing
work and not enough to use, which is worth knowing before concluding the app is
broken.

The order that gets you a usable week:

1. **Set the family up** in the intro screen — real names, real allergies.
2. **Connect calendar** for each adult who has one. Run `/check-google.html`
   once first if you have not already.
3. **Check the week's table** and fix whatever the calendars got wrong: who is
   in, who is cooking, how long they have. Press *Looks right*.
4. **Replan with AI.** It plans around the grid, so do this after step 3, not
   before.
5. **Confirm what is already in the cupboard** in the larder column. Anything
   you confirm drops off the shopping list.
6. **Shop.** Each line links straight into a Tesco or Sainsbury's search, and
   *Copy the list* gives you the lot as text.

The week is taken from the real calendar — a household set up today is planned
for tomorrow onward. The example family stays pinned to its fixture week in
August, because its calendars and jobs are written against it.

## What's in it

You get the week, the jobs, the shopping list and the larder, all live — confirm
what is in the cupboard and watch the shopping list change underneath you.

On a first visit you get an **intro screen** rather than somebody else's data:
how many of you, then names and ages, then allergies, likes and dislikes.
Allergies are matched against the tags the validator can actually enforce —
anything it can't check (`kiwi`, say) is kept as a strong dislike and it says
so, because an exclusion that looks like protection and isn't is worse than
none. There's a second door marked *Show me an example family* for looking
round.

**Accounts are optional and come second.** Set the household up, use it, and
sign in later if you want it on another device or shared with someone else.
Signing in uploads what's already in the browser; an invite code lets the other
adult join and change everything. A person at the table and a user with a login
are deliberately different things — a seven-year-old doesn't need an account to
be allergic to peanuts, and requiring one is a good way to make sure the
allergy never gets recorded.

To switch accounts on you need a Supabase project: run
[`supabase/schema.sql`](supabase/schema.sql) in its SQL editor, then set
`SUPABASE_URL` and `SUPABASE_ANON_KEY` (repository secrets for the published
build, or a `supabase.config.json` locally). Without them the app says accounts
are off and keeps working in the browser. The anon key is public by design —
it names the project, not the person — so Row Level Security is what actually
protects a family's week, and the build refuses any key whose role isn't
`anon`.

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

Everything except the two AI buttons runs without an API key.

## The rest of the commands

```bash
node --test "test/*.test.ts"   # 207 tests, no API key needed
node scripts/doctor.mjs       # why will the model not answer?
node src/run.ts demo          # the same week, in the terminal
node src/run.ts guardrails    # a deliberately broken plan, and what catches it
node src/run.ts live          # one plan via the model, with token counts and cost
node scripts/build-static.mjs # the hosted demo, into docs/app
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
