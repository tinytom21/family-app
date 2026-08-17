import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureSchema,
  captureSystem,
  captureTasks,
  reconcile,
  type RawTask,
} from "../src/ai/capture.ts";
import { toAnthropicDialect, toGeminiDialect } from "../src/ai/dialect.ts";
import { statusOf, weekdayOf } from "../src/domain/tasks.ts";
import type { PlanProvider } from "../src/ai/providers.ts";

const CONTEXT = { people: ["Tom", "Priya"], today: "2026-08-16" };

const raw = (over: Partial<RawTask> = {}): RawTask => ({
  title: "A job",
  category: "household",
  assignee: "anyone",
  dueOn: null,
  effortMinutes: 20,
  repeatEvery: 0,
  repeatUnit: "none",
  repeatWeekdays: [],
  repeatAnchor: "none",
  eventMatch: "",
  eventLead: "none",
  notes: null,
  ...over,
});

/* ---------------- the schema itself ---------------- */

test("the capture schema survives both dialects", () => {
  const schema = captureSchema(CONTEXT.people);
  assert.doesNotThrow(() => JSON.stringify(toGeminiDialect(schema)));

  const anthropic = toAnthropicDialect(schema);
  assert.doesNotThrow(() => JSON.stringify(anthropic));

  // The bounds Anthropic cannot take must be gone, and nothing may be left as
  // a type union — those are the two things that make a request 400.
  const flat = JSON.stringify(anthropic);
  assert.equal(flat.includes('"minimum"'), false);
  assert.equal(flat.includes('"maxItems"'), false);
  assert.match(flat, /anyOf/, "nullable fields became anyOf");
});

test("the schema constrains who a job can be given to", () => {
  const schema = captureSchema(CONTEXT.people) as any;
  const props = schema.properties.tasks.items.properties;
  assert.deepEqual(props.assignee.enum, ["Tom", "Priya", "anyone"]);
  assert.deepEqual(props.repeatAnchor.enum, ["none", "schedule", "completion"]);
  // Every property is required, matching how the meal-plan schema is written.
  assert.deepEqual(
    [...schema.properties.tasks.items.required].sort(),
    Object.keys(props).sort(),
  );
});

test("the system prompt states today, the weekday and the household", () => {
  const system = captureSystem(CONTEXT);
  assert.match(system, /2026-08-16/);
  assert.match(system, /Sunday/);
  assert.match(system, /Tom, Priya/);
});

/* ---------------- reconciling what comes back ---------------- */

test("a plain one-off task passes through", () => {
  const task = reconcile(
    raw({ title: "Ring the dentist", category: "admin", dueOn: "2026-08-21" }),
    0,
    CONTEXT,
  );
  assert.equal(task.title, "Ring the dentist");
  assert.equal(task.dueOn, "2026-08-21");
  assert.equal(task.recurrence, undefined);
  assert.equal(task.assignee, undefined);
  assert.equal(task.id, "t-20260816-0");
});

test("a weekly job's due date is snapped to the weekday it named", () => {
  // The model said Tuesdays but dated it a Thursday. The words win.
  const task = reconcile(
    raw({
      repeatEvery: 1,
      repeatUnit: "week",
      repeatWeekdays: [2],
      repeatAnchor: "schedule",
      dueOn: "2026-08-20",
    }),
    0,
    CONTEXT,
  );
  assert.equal(weekdayOf(task.dueOn!), 2);
  assert.equal(task.dueOn, "2026-08-18");
});

test("a recurring job with no date at all starts today", () => {
  const task = reconcile(
    raw({ repeatEvery: 2, repeatUnit: "week", repeatAnchor: "completion" }),
    0,
    CONTEXT,
  );
  assert.equal(task.dueOn, "2026-08-16");
  assert.equal(statusOf(task, "2026-08-16"), "today");
});

test("no deadline stays no deadline", () => {
  const task = reconcile(raw({ title: "Sort the loft" }), 0, CONTEXT);
  assert.equal(task.dueOn, undefined);
  assert.equal(statusOf(task, "2026-08-16"), "someday");
});

test("an event trigger replaces the repeat rather than joining it", () => {
  const task = reconcile(
    raw({
      title: "Pack the swimming kit",
      eventMatch: "Swim",
      eventLead: "evening-before",
      repeatEvery: 1,
      repeatUnit: "week",
      repeatWeekdays: [4],
      repeatAnchor: "schedule",
    }),
    0,
    CONTEXT,
  );
  assert.deepEqual(task.beforeEvent, { match: "swim", lead: "evening-before" });
  assert.equal(task.recurrence, undefined, "a repeat would nag on quiet weeks");
  assert.equal(task.dueOn, undefined);
});

test("a name outside the household is dropped rather than invented", () => {
  const mine = reconcile(raw({ assignee: "Priya" }), 0, CONTEXT);
  assert.equal(mine.assignee, "Priya");

  const theirs = reconcile(raw({ assignee: "Granny" }), 0, CONTEXT);
  assert.equal(theirs.assignee, undefined);

  const shared = reconcile(raw({ assignee: "anyone" }), 0, CONTEXT);
  assert.equal(shared.assignee, undefined);
});

test("a repeat with no anchor is treated as a fixed schedule", () => {
  const task = reconcile(
    raw({ repeatEvery: 1, repeatUnit: "month", repeatAnchor: "none" }),
    0,
    CONTEXT,
  );
  assert.equal(task.recurrence!.anchor, "schedule");
});

/* ---------------- the run, without a network ---------------- */

test("capture runs end to end against a fake provider", async () => {
  const fake: PlanProvider = {
    id: "claude",
    model: "fake",
    costUsd: () => 0.0123,
    generate: async (request) => {
      assert.match(request.system, /brain-dump/);
      assert.equal(request.turns.length, 1);
      return {
        text: JSON.stringify({
          note: "Assumed the 12th means this month.",
          tasks: [
            raw({ title: "Bins out", repeatEvery: 1, repeatUnit: "week", repeatWeekdays: [2], repeatAnchor: "schedule", effortMinutes: 5 }),
            raw({ title: "Renew the car insurance", category: "admin", dueOn: "2026-08-12", effortMinutes: 30 }),
          ],
        }),
        usage: {
          inputTokens: 900,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 400,
          thoughtTokens: 0,
        },
      };
    },
  };

  const run = await captureTasks("bins tuesdays, car insurance on the 12th", CONTEXT, {
    provider: fake,
  });

  assert.equal(run.tasks.length, 2);
  assert.equal(run.tasks[0].dueOn, "2026-08-18");
  assert.equal(run.tasks[0].recurrence!.anchor, "schedule");
  assert.equal(statusOf(run.tasks[1], "2026-08-16"), "overdue");
  assert.equal(run.note, "Assumed the 12th means this month.");
  assert.equal(run.costUsd, 0.0123);
  assert.equal(run.usage.outputTokens, 400);
  // Ids are unique within a capture, or the second task overwrites the first.
  assert.notEqual(run.tasks[0].id, run.tasks[1].id);
});
