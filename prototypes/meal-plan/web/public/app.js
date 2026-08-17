/**
 * Rendering only. Every number on this page was computed by the shared domain
 * modules on the server — the client does no meal-planning arithmetic of its
 * own, because two implementations of the same sum is how the shopping list
 * and the larder start disagreeing.
 */

const $ = (id) => document.getElementById(id);

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  timeZone: "UTC",
});
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let busy = false;

/**
 * Where state comes from.
 *
 * Locally that is a Node server over HTTP. On the hosted demo there is no
 * server, so the bundled app answers in-page and exposes itself as
 * `window.__familyApi`. Both run identical domain code — this seam is the only
 * thing that differs between the two, and it is deliberately three lines long.
 */
const api = window.__familyApi ?? {
  get: () => fetch("/api/state").then((r) => r.json()),
  post: async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  },
};

async function call(path, body) {
  if (busy) return null;
  busy = true;
  setStatus(path === "/api/plan/generate" ? "Asking the model…" : "Saving…");
  try {
    const data = await api.post(path, body ?? {});
    render(data);
    setStatus("");
    return data;
  } catch (error) {
    setStatus(error.message, true);
    return null;
  } finally {
    busy = false;
    syncButtons();
  }
}

function setStatus(message, isError = false) {
  const node = $("status");
  node.textContent = message;
  node.classList.toggle("error", isError);
}

function syncButtons() {
  $("replan").disabled = busy || !window.__modelAvailable;
  $("reset").disabled = busy;
  $("calendar").disabled = busy;
  $("capture-go").disabled = busy || !window.__modelAvailable;
  $("capture-plain").disabled = busy;
  $("who").disabled = busy;
  $("grid-reset").disabled = busy;
}

/* ------------------------------------------------------------------ */

let latestState = null;

function render(state) {
  latestState = state;
  window.__modelAvailable = state.modelAvailable;

  const dates = state.plan.meals.map((m) => m.date).sort();
  $("week-range").textContent =
    `${dateFormat.format(asDate(dates[0]))} – ${dateFormat.format(asDate(dates.at(-1)))} · ` +
    `${state.household.portions} portions a sitting`;

  renderSummary(state);
  renderGrid(state);
  renderPeople(state);
  renderWeek(state);
  renderList(state);
  renderLarder(state);
  renderJobs(state);
  renderCalendarButton(state);

  $("restock").checked = state.restockStaples;
  $("week-source").textContent =
    state.source === "model"
      ? `${state.lastRun.model} · ${state.lastRun.attempts} attempt${state.lastRun.attempts > 1 ? "s" : ""} · $${state.lastRun.costUsd.toFixed(4)} · ${state.lastRun.seconds}s`
      : "fixture week";

  $("replan").title = state.modelAvailable
    ? "Generate a fresh week with the configured model"
    : "Set ANTHROPIC_API_KEY or GEMINI_API_KEY to enable this";
  syncButtons();
}

function asDate(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

/**
 * No money here on purpose — prices move too much between shops to show a
 * total anyone should believe. These are the three numbers that actually
 * change what you do next.
 */
function renderSummary(state) {
  $("stat-items").textContent = String(state.list.lines.length);
  $("stat-leftovers").textContent = String(state.list.linesWithSurplus);

  const useUp = state.larder.useUpFirst.length;
  $("stat-useup").textContent = String(useUp);
  $("stat-useup").parentElement.classList.toggle("attention", useUp > 0);

  const due = state.tasks.items.filter(
    (t) => t.status === "overdue" || t.status === "today",
  ).length;
  $("stat-jobs").textContent = String(due);
  $("stat-jobs").parentElement.classList.toggle("attention", due > 0);
}

function renderWeek(state) {
  const list = $("week");
  list.replaceChildren();

  const jobsByDate = new Map(
    state.tasks.schedule.days.map((d) => [d.date, d.placed]),
  );

  for (const meal of state.plan.meals) {
    const row = el("li", `day${meal.leftoverOf ? " leftover" : ""}`);
    const date = asDate(meal.date);
    row.append(
      el("span", "day-name", dayFormat.format(date)),
      el("span", "day-title", meal.title),
      el(
        "span",
        "day-meta",
        meal.leftoverOf ? "leftovers" : meal.minutes ? `${meal.minutes} min` : "",
      ),
    );
    const detail = meal.leftoverOf
      ? `from ${dayFormat.format(asDate(meal.leftoverOf))}`
      : [meal.protein, `serves ${meal.servings}`].filter(Boolean).join(" · ");
    row.append(el("span", "day-protein", detail));

    if (meal.sitting) {
      const { cookName, cookMinutes, portions, attendance, note } = meal.sitting;
      const away = attendance.filter((a) => !a.present).map((a) => a.name);
      const line = el(
        "span",
        `day-agenda ${cookName ? (cookMinutes < 45 ? "tight" : "clear") : "out"}`,
      );
      line.append(
        el(
          "span",
          "budget",
          cookName ? `${cookName} · ${cookMinutes} min` : "nobody cooking",
        ),
        el(
          "span",
          "what",
          `${portions} portions${away.length ? ` · ${away.join(" and ")} out` : ""}`,
        ),
      );
      line.title = note;

      // Flag the clash rather than leaving the reader to do the arithmetic.
      if (!meal.leftoverOf && meal.minutes && meal.minutes > cookMinutes) {
        row.classList.add("over-budget");
      }
      row.append(line);
    }

    // The jobs the scheduler put on this evening, next to the dinner they have
    // to fit around — which is the whole reason they are computed together.
    const jobs = jobsByDate.get(meal.date) ?? [];
    if (jobs.length) {
      const line = el("span", "day-jobs");
      for (const job of jobs) {
        const chip = el("span", `job-chip${job.late ? " late" : ""}`);
        chip.append(
          el("span", "job-who", job.assignee),
          el("span", null, job.title),
        );
        chip.title = job.late
          ? `${job.effortMinutes} min — the first evening with room after it was due`
          : `${job.effortMinutes} min`;
        line.append(chip);
      }
      row.append(line);
    }
    list.append(row);
  }

  const box = $("validation");
  box.replaceChildren();
  box.classList.toggle("fail", !state.validation.ok);
  if (state.validation.ok) {
    box.textContent = "Every check passes: allergies, timings, variety, budget.";
  } else {
    box.append(
      el("strong", null, `${state.validation.violations.length} problem(s) with this plan`),
    );
    const ul = el("ul");
    for (const v of state.validation.violations) {
      ul.append(el("li", null, `${v.code} — ${v.message}`));
    }
    box.append(ul);
  }
}

function renderList(state) {
  const container = $("list");
  container.replaceChildren();

  const byAisle = new Map();
  for (const line of state.list.lines) {
    if (!byAisle.has(line.aisle)) byAisle.set(line.aisle, []);
    byAisle.get(line.aisle).push(line);
  }

  $("list-count").textContent = `${state.list.lines.length} items`;

  for (const [aisle, lines] of byAisle) {
    const group = el("div");
    group.append(el("p", "aisle-name", aisle.replace("-", " / ")));
    for (const line of lines) {
      const row = el("div", "line");
      row.append(
        el("span", "line-name", line.name),
        el("span", "line-cost", formatBase(line.requiredBase, line.base)),
      );
      const packs = line.packs
        .map((p) => `${p.count} × ${p.pack.label}`)
        .join(" + ");
      const detail = el("span", "line-packs", packs);
      if (line.surplusBase > 0) {
        detail.append(
          el("span", "line-surplus", `  · ${formatBase(line.surplusBase, line.base)} spare`),
        );
      }
      row.append(detail);
      group.append(row);
    }
    container.append(group);
  }

  const notes = $("list-footnotes");
  notes.replaceChildren();
  if (state.list.coveredByPantry.length) {
    notes.append(
      el("p", null, `Already have: ${state.list.coveredByPantry.join(", ")}`),
    );
  }
  if (state.list.assumedInPantry.length) {
    notes.append(
      el("p", null, `Assumed in the cupboard: ${state.list.assumedInPantry.join(", ")}`),
    );
  }
  for (const warning of state.list.warnings) {
    notes.append(el("p", "line-surplus", `! ${warning}`));
  }
}

/** Mirrors formatBase in the domain layer for display of pre-computed numbers. */
function formatBase(value, base) {
  if (base === "mass") {
    return value >= 1000 ? `${trim(value / 1000)} kg` : `${trim(Math.round(value))} g`;
  }
  if (base === "volume") {
    return value >= 1000 ? `${trim(value / 1000)} L` : `${trim(Math.round(value))} ml`;
  }
  return trim(Math.round(value * 10) / 10);
}
const trim = (n) => String(Number(Number(n).toFixed(2)));

function renderLarder(state) {
  const { larder } = state;

  /* things about to turn */
  const useUp = $("use-up");
  const useUpList = $("use-up-list");
  useUpList.replaceChildren();
  useUp.hidden = larder.useUpFirst.length === 0;
  for (const item of larder.useUpFirst) {
    const li = el("li");
    li.append(
      el("span", null, `${item.name} — ${item.display} left`),
      el("span", null, `use by ${dateFormat.format(asDate(item.bestBefore))}`),
    );
    useUpList.append(li);
  }

  /* spare portions the plan will produce */
  const offers = $("freezer-offers");
  const offerList = $("freezer-offer-list");
  offerList.replaceChildren();
  offers.hidden = larder.freezerCandidates.length === 0;
  for (const candidate of larder.freezerCandidates) {
    const li = el("li");
    li.append(
      el(
        "span",
        null,
        `${candidate.sparePortions} × ${candidate.label} on ${dayFormat.format(asDate(candidate.date))}`,
      ),
    );
    const button = el("button", "mini", "Freeze it");
    button.type = "button";
    button.addEventListener("click", () =>
      call("/api/freezer", {
        label: candidate.label,
        portions: candidate.sparePortions,
        recipeId: candidate.recipeId,
      }),
    );
    li.append(button);
    offerList.append(li);
  }

  /* stock */
  const stock = $("stock");
  stock.replaceChildren();
  $("larder-count").textContent = `${larder.items.length} tracked`;

  for (const item of larder.items) {
    const row = el("li", "stock-item");
    row.append(
      el("span", "stock-name", item.name),
      el("span", "stock-amount", item.display),
    );

    const meta = el("span", "stock-meta");
    meta.append(el("span", `chip ${item.confidence}`, item.confidence));
    if (item.wasteRisk) meta.append(el("span", "chip risk", "use up"));
    meta.append(
      el(
        "span",
        null,
        item.daysSinceConfirmed === 0
          ? "checked today"
          : `checked ${item.daysSinceConfirmed}d ago`,
      ),
    );
    if (item.consumedByPlan > 0) {
      meta.append(
        el("span", null, `plan uses ${formatBase(item.consumedByPlan, item.base)}`),
      );
    }

    const edit = el("span", "stock-edit");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "any";
    input.value = String(Math.round(item.confirmedAmount * 100) / 100);
    input.setAttribute("aria-label", `Confirmed amount of ${item.name}`);
    const save = el("button", "mini", "Confirm");
    save.type = "button";
    save.addEventListener("click", () =>
      call("/api/larder/confirm", {
        ingredientId: item.ingredientId,
        amount: Number(input.value),
      }),
    );
    edit.append(input, save);
    meta.append(edit);

    row.append(meta);
    stock.append(row);
  }
  if (larder.items.length === 0) {
    stock.append(el("li", "empty", "Nothing logged yet."));
  }

  /* freezer */
  const freezer = $("freezer");
  freezer.replaceChildren();
  for (const meal of larder.freezer) {
    const row = el("li", "freezer-item");
    row.append(
      el("span", "stock-name", meal.label),
      el("span", "stock-amount", `${meal.portions} portion${meal.portions > 1 ? "s" : ""}`),
    );
    const meta = el("span", "stock-meta");
    meta.append(
      el("span", null, `frozen ${dateFormat.format(asDate(meal.frozenOn))}`),
    );
    const eat = el("button", "mini", "Eat one");
    eat.type = "button";
    eat.addEventListener("click", () => call("/api/freezer/eat", { id: meal.id }));
    meta.append(eat);
    row.append(meta);
    freezer.append(row);
  }
  if (larder.freezer.length === 0) {
    freezer.append(el("li", "empty", "Freezer is empty."));
  }
}

/* ---------------- the week's table ---------------- */

/**
 * A row per person, a column per day, and every cell says where it came from.
 *
 * The grid is a proposal the family corrects, so the important thing is not
 * that it is right — it will not always be — but that it is obvious which
 * cells are facts, which are guesses, and which somebody has already fixed.
 */
function renderGrid(state) {
  const { days, confirmed, assumed } = state.week;
  const people = state.household.people;

  $("grid-sub").textContent = confirmed
    ? "Confirmed. Change anything and the plan follows."
    : assumed > 0
      ? `Proposed from the calendars. ${assumed} cell${assumed === 1 ? "" : "s"} nobody's diary covers — check those first.`
      : "Proposed from the calendars. Check it over before planning the week.";

  $("grid-panel").classList.toggle("needs-review", !confirmed);
  $("grid-confirm").textContent = confirmed ? "Confirmed" : "Looks right";
  $("grid-confirm").disabled = busy || confirmed;

  const table = $("grid");
  table.replaceChildren();

  /* header: the days */
  const head = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "grid-corner", ""));
  for (const day of days) {
    const th = el("th");
    th.scope = "col";
    th.append(
      el("span", "grid-day", dayFormat.format(asDate(day.date))),
      el("span", "grid-date", dateFormat.format(asDate(day.date))),
      el("span", "grid-portions", `${day.portions} portions`),
    );
    if (day.portions === 0) th.classList.add("nobody");
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = el("tbody");

  /* one row per person: in for dinner? */
  for (const person of people) {
    const row = el("tr");
    const label = el("th", "grid-person");
    label.scope = "row";
    label.append(
      el("span", "grid-name", person.name),
      el("span", "grid-portion", `${person.portion} portion`),
    );
    row.append(label);

    for (const day of days) {
      const cell = day.attendance.find((a) => a.personId === person.id);
      const td = el("td", `grid-cell ${cell.source}`);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = cell.present;
      box.setAttribute(
        "aria-label",
        `${person.name} in for dinner on ${day.date}`,
      );
      box.addEventListener("change", () =>
        call("/api/week/present", {
          date: day.date,
          personId: person.id,
          present: box.checked,
        }),
      );
      td.append(box);
      td.title = cell.why || "In for dinner";
      if (!cell.present) td.classList.add("out");
      row.append(td);
    }
    body.append(row);
  }

  /* who is cooking */
  const cookRow = el("tr", "grid-cook-row");
  const cookLabel = el("th", "grid-person");
  cookLabel.scope = "row";
  cookLabel.append(el("span", "grid-name", "Cooking"));
  cookRow.append(cookLabel);

  for (const day of days) {
    const td = el("td", `grid-cell ${day.cookSource}`);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Who cooks on ${day.date}`);

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "nobody";
    select.append(none);

    for (const person of people) {
      if (!person.canCook) continue;
      const present = day.attendance.find(
        (a) => a.personId === person.id,
      )?.present;
      const option = document.createElement("option");
      option.value = person.id;
      // Somebody who is out can still be chosen, but say what you are choosing.
      option.textContent = present ? person.name : `${person.name} (out)`;
      select.append(option);
    }
    select.value = day.cookId ?? "";
    select.addEventListener("change", () =>
      call("/api/week/cook", { date: day.date, personId: select.value || null }),
    );
    td.append(select);
    if (!day.cookId) td.classList.add("out");
    cookRow.append(td);
  }
  body.append(cookRow);

  /* how long they have */
  const timeRow = el("tr", "grid-time-row");
  const timeLabel = el("th", "grid-person");
  timeLabel.scope = "row";
  timeLabel.append(
    el("span", "grid-name", "Time to cook"),
    el("span", "grid-portion", "prep + cook"),
  );
  timeRow.append(timeLabel);

  for (const day of days) {
    const td = el("td", `grid-cell ${day.minutesSource}`);
    if (!day.cookId) {
      td.append(el("span", "grid-nocook", "—"));
      td.title = day.note;
      timeRow.append(td);
      continue;
    }
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "10";
    slider.max = "120";
    slider.step = "5";
    slider.value = String(day.cookMinutes);
    slider.setAttribute("aria-label", `Minutes to cook on ${day.date}`);
    const readout = el("span", "grid-minutes", `${day.cookMinutes} min`);
    slider.addEventListener("input", () => {
      readout.textContent = `${slider.value} min`;
    });
    slider.addEventListener("change", () =>
      call("/api/week/minutes", {
        date: day.date,
        minutes: Number(slider.value),
      }),
    );
    td.append(slider, readout);
    td.title = day.note;
    timeRow.append(td);
  }
  body.append(timeRow);

  table.append(body);
  $("grid-reset").disabled = busy;
}

/* ---------------- profiles ---------------- */

function renderPeople(state) {
  const list = $("people");
  list.replaceChildren();

  const brackets = state.household.ageBrackets;
  const select = $("new-bracket");
  if (select.options.length === 0) {
    for (const bracket of brackets) {
      const option = document.createElement("option");
      option.value = bracket.id;
      option.textContent = bracket.label;
      select.append(option);
    }
    select.value = "adult";
  }

  for (const person of state.household.people) {
    const row = el("li", "person");
    row.append(el("span", "person-name", person.name));

    const bracket = document.createElement("select");
    bracket.setAttribute("aria-label", `Age bracket for ${person.name}`);
    for (const b of brackets) {
      const option = document.createElement("option");
      option.value = b.id;
      option.textContent = b.label;
      bracket.append(option);
    }
    bracket.value = person.ageBracket;
    bracket.addEventListener("change", () =>
      call("/api/people/update", { id: person.id, ageBracket: bracket.value }),
    );

    const meta = el("span", "person-meta");
    meta.append(bracket, el("span", "chip portion", `${person.portion} portion`));

    const cooks = document.createElement("label");
    cooks.className = "toggle";
    const cooksBox = document.createElement("input");
    cooksBox.type = "checkbox";
    cooksBox.checked = person.canCook;
    cooksBox.addEventListener("change", () =>
      call("/api/people/update", { id: person.id, canCook: cooksBox.checked }),
    );
    cooks.append(cooksBox, el("span", null, "can cook"));
    meta.append(cooks);
    row.append(meta);

    const fields = el("span", "person-fields");
    fields.append(
      textField(person, "excludes", "Cannot eat", "nuts, shellfish", true),
      textField(person, "dislikes", "Dislikes", "mushrooms"),
      textField(person, "likes", "Likes", "pasta, curry"),
      textField(person, "email", "Google account", "name@gmail.com"),
    );
    row.append(fields);

    const drop = el("button", "mini", "Remove");
    drop.type = "button";
    drop.addEventListener("click", () =>
      call("/api/people/delete", { id: person.id }),
    );
    row.append(drop);

    list.append(row);
  }
}

/** One editable profile field, saved on blur rather than per keystroke. */
function textField(person, key, label, placeholder, danger = false) {
  const wrap = el("label", `person-field${danger ? " danger" : ""}`);
  wrap.append(el("span", "person-field-label", label));
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  const value = person[key];
  input.value = Array.isArray(value) ? value.join(", ") : (value ?? "");
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    const parsed = Array.isArray(value)
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : raw;
    call("/api/people/update", { id: person.id, [key]: parsed });
  });
  wrap.append(input);
  return wrap;
}

/* ---------------- jobs ---------------- */

const STATUS_ORDER = ["overdue", "today", "soon", "later", "someday", "done"];

function renderJobs(state) {
  const { items, reminders, schedule } = state.tasks;

  /* what is actually happening tonight and tomorrow */
  const box = $("reminders");
  const list = $("reminder-list");
  list.replaceChildren();
  box.hidden = reminders.length === 0;
  for (const reminder of reminders) {
    const li = el("li");
    li.append(
      el("span", null, reminder.title),
      el("span", "reminder-why", reminder.message),
    );
    list.append(li);
  }

  /* work with nowhere to go — said out loud rather than rolled over silently */
  const wont = $("jobs-unplaced");
  const wontList = $("jobs-unplaced-list");
  wontList.replaceChildren();
  wont.hidden = schedule.unplaced.length === 0;
  for (const item of schedule.unplaced) {
    const li = el("li");
    li.append(el("span", null, item.title), el("span", "reminder-why", item.reason));
    wontList.append(li);
  }

  /* the list itself */
  const jobs = $("jobs");
  jobs.replaceChildren();

  const open = items.filter((t) => !t.done);
  open.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"),
  );

  const doneCount = items.length - open.length;
  $("jobs-count").textContent =
    `${open.length} open` + (doneCount ? ` · ${doneCount} done` : "");

  for (const task of open) {
    const row = el("li", "job");
    row.append(el("span", "job-title", task.title));

    const when = el("span", "job-when");
    when.append(
      task.beforeEvent
        ? el("span", "chip cued", "on cue")
        : el("span", `chip ${task.status}`, statusLabel(task)),
    );
    row.append(when);

    const meta = el("span", "job-meta");
    if (task.assignee) meta.append(el("span", "job-who", task.assignee));
    meta.append(el("span", null, `${task.effortMinutes} min`));
    if (task.recurrence) meta.append(el("span", null, recurrenceLabel(task.recurrence)));
    if (task.beforeEvent) {
      meta.append(
        el(
          "span",
          null,
          task.beforeEvent.lead === "evening-before"
            ? `the night before "${task.beforeEvent.match}"`
            : `the day of "${task.beforeEvent.match}"`,
        ),
      );
    }
    if (task.planned) {
      meta.append(
        el(
          "span",
          "job-planned",
          `${dayFormat.format(asDate(task.planned.date))} · ${task.planned.assignee}`,
        ),
      );
    } else if (!task.beforeEvent) {
      meta.append(el("span", "job-planned unplanned", "no slot this week"));
    }

    const done = el("button", "mini", "Done");
    done.type = "button";
    done.addEventListener("click", () => call("/api/tasks/complete", { id: task.id }));

    const drop = el("button", "mini", "×");
    drop.type = "button";
    drop.title = `Remove "${task.title}"`;
    drop.setAttribute("aria-label", `Remove ${task.title}`);
    drop.addEventListener("click", () => call("/api/tasks/delete", { id: task.id }));

    meta.append(done);
    // Deferring a dated job by a day is normal; a job that fires off the diary
    // has no date to push, so the button would do nothing visible.
    if (task.dueOn) {
      const defer = el("button", "mini", "+1 day");
      defer.type = "button";
      defer.title = "Push this occurrence back a day";
      defer.addEventListener("click", () =>
        call("/api/tasks/defer", { id: task.id, days: 1 }),
      );
      meta.append(defer);
    }
    meta.append(drop);
    row.append(meta);
    if (task.notes) row.append(el("span", "job-note", task.notes));
    jobs.append(row);
  }

  if (open.length === 0) {
    jobs.append(el("li", "empty", "Nothing outstanding."));
  }

  const note = $("capture-note");
  const capture = state.tasks.lastCapture;
  note.hidden = !capture;
  if (capture) {
    note.textContent =
      `${capture.model} read ${capture.count} job${capture.count === 1 ? "" : "s"} ` +
      `out of that · $${capture.costUsd.toFixed(4)}` +
      (capture.note ? ` — ${capture.note}` : "");
  }
  $("capture-go").disabled = busy || !state.modelAvailable;
  $("capture-go").title = state.modelAvailable
    ? "Write it how you would say it; the model splits and dates it"
    : "Set ANTHROPIC_API_KEY or GEMINI_API_KEY to enable this";
}

function statusLabel(task) {
  if (task.status === "someday") return "someday";
  if (task.status === "overdue") return "overdue";
  if (task.status === "today") return "today";
  return dateFormat.format(asDate(task.dueOn));
}

function recurrenceLabel(rec) {
  const every = rec.every === 1 ? "" : `${rec.every} `;
  const unit = rec.unit + (rec.every === 1 ? "" : "s");
  const anchor = rec.anchor === "completion" ? " after doing" : "";
  if (rec.weekdays?.length) {
    const names = rec.weekdays
      .map((d) => dayFormat.format(asDate(sundayPlus(d))))
      .join(", ");
    return rec.every === 1 ? `every ${names}` : `every ${every}weeks, ${names}`;
  }
  return `every ${every}${unit}${anchor}`;
}

/** A known Sunday, so weekday numbers can be turned into names for display. */
const sundayPlus = (weekday) => {
  const base = new Date(Date.UTC(2026, 7, 16)); // 2026-08-16 is a Sunday
  base.setUTCDate(base.getUTCDate() + weekday);
  return base.toISOString().slice(0, 10);
};

/* ---------------- calendar ---------------- */

/**
 * The Supabase project details are whatever the setup checker saved, so the
 * two pages share one configuration and there is nothing extra to fill in here.
 *
 * The Google token used below lives in this browser, which is fine for a
 * prototype and wrong for the real thing: the agenda has to refresh overnight
 * with nobody signed in, which is what the stored refresh token is for.
 */
function supabaseCreds() {
  try {
    return JSON.parse(localStorage.getItem("family-app.supabase") ?? "{}");
  } catch {
    return {};
  }
}

function sendToChecker(message) {
  setStatus(`${message} Opening the setup page…`, true);
  setTimeout(() => (location.href = "/check-google.html"), 1600);
}

async function connectCalendar(state) {
  const { url, key } = supabaseCreds();
  if (!url || !key) {
    sendToChecker("This browser has no Supabase project saved.");
    return;
  }

  busy = true;
  syncButtons();
  setStatus("Reading your calendar…");
  try {
    const sb = window.supabase.createClient(url, key);
    const { data } = await sb.auth.getSession();
    const session = data.session;

    if (!session?.provider_token) {
      sendToChecker("No Google token in this browser.");
      return;
    }

    const dates = state.plan.meals.map((m) => m.date).sort();
    const params = new URLSearchParams({
      timeMin: new Date(`${dates[0]}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${dates.at(-1)}T23:59:59Z`).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${session.provider_token}` } },
    );
    const body = await res.json();
    if (!res.ok) {
      const reason = body?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 401) {
        sendToChecker(`Google token has expired (${reason}).`);
        return;
      }
      throw new Error(reason);
    }

    busy = false;
    await call("/api/agenda", {
      googleEvents: body.items ?? [],
      connectedAs: session.user.email,
    });
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    busy = false;
    syncButtons();
  }
}

function renderCalendarButton(state) {
  const button = $("calendar");
  if (state.calendar.connected) {
    button.textContent = "Refresh calendar";
    button.title = state.calendar.connectedAs
      ? `Connected as ${state.calendar.connectedAs}`
      : "Connected";
  } else {
    button.textContent = "Connect calendar";
    button.title = "Read this week's events and plan around them";
  }
}

/* ------------------------------------------------------------------ */

$("calendar").addEventListener("click", () => connectCalendar(latestState));

$("who").addEventListener("click", () => {
  const panel = $("people-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) panel.scrollIntoView({ block: "nearest" });
});
$("people-close").addEventListener("click", () => {
  $("people-panel").hidden = true;
});

$("add-person").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("new-name").value.trim();
  if (!name) return;
  const result = await call("/api/people", {
    name,
    ageBracket: $("new-bracket").value,
  });
  if (result) $("new-name").value = "";
});

$("grid-confirm").addEventListener("click", () => call("/api/week/confirm"));
$("grid-reset").addEventListener("click", () => call("/api/week/reset", {}));

$("capture").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("capture-text").value.trim();
  if (!text) return;
  const result = await call("/api/tasks/capture", { text });
  if (result) $("capture-text").value = "";
});

/* The escape hatch: no key, no network, or the model read it wrong. One line
   of text becomes one job with no interpretation at all. */
$("capture-plain").addEventListener("click", async () => {
  const title = $("capture-text").value.trim();
  if (!title) return;
  const result = await call("/api/tasks/add", { title, effortMinutes: 15 });
  if (result) $("capture-text").value = "";
});

$("restock").addEventListener("change", (event) =>
  call("/api/options", { restockStaples: event.target.checked }),
);
$("replan").addEventListener("click", () => call("/api/plan/generate"));

/* On the hosted demo there is no `npm run web` to restart, and state persists
   in this browser, so Reset has to mean "clear everything" rather than just
   "put the fixture plan back". */
if (window.__familyApi?.reset) {
  $("reset").textContent = "Start over";
  $("reset").title =
    "Clear this browser's saved demo and go back to the fixture week";
  $("reset").addEventListener("click", async () => {
    render(await window.__familyApi.reset());
  });
} else {
  $("reset").addEventListener("click", () => call("/api/plan/reset"));
}

render(await api.get());
