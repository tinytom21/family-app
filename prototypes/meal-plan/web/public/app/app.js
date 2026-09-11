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
  $("basket").disabled = busy;
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

      // No supermarket will let us fill a basket, so the next best thing is to
      // put the shopper one click from the right aisle and let them pick.
      if (line.links?.length) {
        const shop = el("span", "line-shop");
        for (const link of line.links) {
          const anchor = document.createElement("a");
          anchor.href = link.url;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.textContent = link.name;
          anchor.title = `Search ${link.name} for ${line.name}`;
          shop.append(anchor);
        }
        row.append(shop);
      }
      group.append(row);
    }
    container.append(group);
  }

  const notes = $("list-footnotes");
  notes.replaceChildren();

  if (state.list.lines.length) {
    const copy = el("button", "mini", "Copy the list");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      const text = state.list.lines
        .map((l) => `- ${l.name} — ${formatBase(l.requiredBase, l.base)}`)
        .join("\n");
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy the list"), 1500);
      } catch {
        // Clipboard access can be refused; say so rather than looking broken.
        setStatus("This browser would not let me use the clipboard.", true);
      }
    });
    notes.append(copy);
  }
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
  setTimeout(() => (location.href = "../check-google.html"), 1600);
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

$("basket").addEventListener("click", async () => {
  const panel = $("basket-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    await refreshBasket();
    panel.scrollIntoView({ block: "nearest" });
  }
});
$("basket-close").addEventListener("click", () => {
  $("basket-panel").hidden = true;
});

$("account").addEventListener("click", async () => {
  const panel = $("account-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    await renderAccount();
    panel.scrollIntoView({ block: "nearest" });
  }
});
$("account-close").addEventListener("click", () => {
  $("account-panel").hidden = true;
});

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

/* ---------------- account ---------------- */

/**
 * Signing in is what turns a browser's worth of data into a shared family.
 *
 * Everything below degrades to a single explanatory sentence when the build
 * has no Supabase project, which is the state the app ships in until somebody
 * hands it one. A demo that shows a broken Sign in button teaches people the
 * app is broken.
 */
let account = null;

async function renderAccount() {
  const panel = $("account-body");
  panel.replaceChildren();
  account ??= await import("./account.js");

  if (!account.isConfigured()) {
    $("account-sub").textContent = "Not switched on in this build.";
    panel.append(
      el(
        "p",
        "account-note",
        "This copy has no Supabase project behind it, so there is nothing to sign in to. " +
          "Everything you do is saved in this browser and stays there — which is fine for a look round, " +
          "and no use for sharing with anyone.",
      ),
    );
    return;
  }

  const user = await account.currentUser();
  if (!user) {
    $("account-sub").textContent = "Sign in to share this family across devices.";
    const button = el("button", "btn btn-primary", "Sign in with Google");
    button.type = "button";
    button.addEventListener("click", () =>
      account.signIn().catch((e) => setStatus(e.message, true)),
    );
    panel.append(
      button,
      el(
        "p",
        "account-note",
        "Your week stays in this browser until you do. Signing in uploads it, " +
          "and lets you invite whoever else needs to change it.",
      ),
    );
    return;
  }

  $("account-sub").textContent = `Signed in as ${user.email}`;
  const households = await account.myHouseholds().catch((e) => {
    setStatus(e.message, true);
    return [];
  });

  const local = latestState.household;
  const remoteId = local.remoteId;

  if (!remoteId && households.length === 0) {
    panel.append(
      el("p", "account-note", `Nothing of yours is saved to the cloud yet.`),
      button("Save “" + (local.name || "this household") + "” to my account", true, async () => {
        const snapshot = await api.post("/api/snapshot", {});
        const created = await account.createHousehold(
          local.name || "Our household",
          snapshot,
        );
        await call("/api/household/rename", { name: created.name });
        latestState.household.remoteId = created.id;
        await renderAccount();
        setStatus(`Saved. Invite someone from here whenever you like.`);
      }),
    );
  }

  for (const household of households) {
    const row = el("div", "account-household");
    row.append(el("strong", null, household.name));
    row.append(
      button("Open", false, async () => {
        const stored = await account.loadState(household.id);
        if (!stored?.state) {
          setStatus("That household has no saved week yet.", true);
          return;
        }
        await api.post("/api/restore", stored.state);
        render(await api.get());
        setStatus(`Opened ${household.name}.`);
      }),
    );
    row.append(
      button("Invite someone", false, async () => {
        const { code, expiresAt } = await api.post("/api/invite/new", {});
        await account.createInvite(household.id, code, expiresAt);
        showCode(row, code);
      }),
    );
    panel.append(row);
  }

  /* joining somebody else's */
  const join = el("form", "account-join");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Invite code";
  input.setAttribute("aria-label", "Invite code");
  input.maxLength = 8;
  const go = el("button", "btn", "Join a family");
  go.type = "submit";
  join.append(input, go);
  join.addEventListener("submit", async (event) => {
    event.preventDefault();
    const checked = await api.post("/api/invite/check", { code: input.value });
    if (checked.problem) {
      setStatus(checked.message, true);
      return;
    }
    const result = await account.joinHousehold(checked.code);
    if (!result?.ok) {
      const message = await api.post("/api/invite/message", {
        problem: result?.problem ?? "unknown",
      });
      setStatus(message.message, true);
      return;
    }
    const stored = await account.loadState(result.household_id);
    if (stored?.state) {
      await api.post("/api/restore", stored.state);
      render(await api.get());
    }
    setStatus("Joined. Everything here is yours to change.");
    await renderAccount();
  });
  panel.append(join);

  const out = button("Sign out", false, async () => {
    await account.signOut();
    await renderAccount();
  });
  out.classList.add("btn-quiet");
  panel.append(out);
}

function button(label, primary, onClick) {
  const node = el("button", `btn${primary ? " btn-primary" : ""}`, label);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await onClick();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

function showCode(row, code) {
  const existing = row.querySelector(".invite-code");
  if (existing) existing.remove();
  const box = el("span", "invite-code", code);
  box.title = "Read this out to whoever is joining. It lasts a week.";
  row.append(box);
}

/* ---------------- the basket ---------------- */

/**
 * Filling a supermarket basket from the list.
 *
 * The panel does no matching of its own. It asks what is ready and what still
 * needs a person, fetches ranked candidates when asked, and records a choice
 * when one is made. "Find all" is only a loop with a progress count: whether a
 * match is sure enough to go straight in is decided by the server, and the
 * panel reports what it did. Prices are shown exactly as Tesco gave them, and
 * nothing here adds them up.
 */
let basketPlan = null;
let basketResult = null;
/** While "Find all" runs, and afterwards as its report: { running, done, total, linked, stopped }. */
let basketFinding = null;
const basketSearches = new Map();

const basketKey = (line) => `${line.ingredientId}|${line.packSize}`;

/** Options shown before "Show more": enough to compare, not a wall of mince. */
const FIRST_OPTIONS = 5;

async function refreshBasket() {
  try {
    basketPlan = await api.post("/api/basket/plan", {});
  } catch (error) {
    $("basket-body").replaceChildren(el("p", "account-note", error.message));
    return;
  }
  drawBasket();
}

function drawBasket() {
  const body = $("basket-body");
  body.replaceChildren();
  const plan = basketPlan;
  if (!plan) return;

  if (!plan.available) {
    $("basket-sub").textContent = "Not switched on here.";
    if (window.__familyApi) {
      body.append(
        el(
          "p",
          "account-note",
          "Filling a Tesco basket only runs on your own computer. It needs a signed-in " +
            "Tesco session, and a public web page is the wrong place to keep one.",
        ),
      );
    } else {
      body.append(
        el("p", "account-note", "Restart the server with it switched on. To try it without touching Tesco:"),
        el("pre", "basket-cmd", '$env:TESCO_BASKET = "practice"; node web/server.ts'),
        el("p", "account-note", "And for real — Chrome opens once so you can sign in to Tesco yourself:"),
        el("pre", "basket-cmd", '$env:TESCO_BASKET = "1"; node web/server.ts'),
      );
    }
    return;
  }

  if (!plan.signedIn) {
    $("basket-sub").textContent = "Not signed in to Tesco yet.";
    body.append(
      el(
        "p",
        "account-note",
        "A Chrome window will open on Tesco's own sign-in page. Your password goes to " +
          "Tesco, not to this app.",
      ),
      button("Sign in to Tesco", true, async () => {
        setStatus("Waiting for you to sign in to Tesco in the Chrome window…");
        await api.post("/api/basket/signin", {});
        setStatus("");
        await refreshBasket();
      }),
    );
    return;
  }

  const practice = plan.provider === "practice";
  $("basket-sub").textContent = practice
    ? "Practice mode — invented products, nothing is sent to Tesco."
    : "Signed in to Tesco.";

  /* where things stand, and what you can do about it */
  const finding = Boolean(basketFinding?.running);
  const toChoose = plan.needsChoosing.length;
  const summary = el("div", "basket-summary");
  summary.append(
    el("span", "basket-count", `${plan.items.length} ready`),
    el("span", `basket-count${toChoose ? " attention" : ""}`, `${toChoose} to choose`),
  );
  // The button to press first while anything is unchosen, and Fill after.
  const findAll = button(
    practice ? "Find all in the practice shop" : "Find all on Tesco",
    toChoose > 0,
    findAllProducts,
  );
  findAll.disabled = busy || finding || toChoose === 0;
  findAll.title = toChoose
    ? "Puts 100% matches straight in and lays out the options for the rest"
    : "Every line already has a product";
  const fill = button(
    practice ? "Fill practice basket" : "Fill Tesco basket",
    toChoose === 0,
    async () => {
      basketFinding = null;
      basketResult = await api.post("/api/basket/fill", {});
      drawBasket();
    },
  );
  fill.disabled = busy || finding || plan.items.length === 0;
  fill.title = plan.items.length
    ? "Sets each quantity, so pressing it twice does not double the order"
    : "Choose some products first";
  const checkout = button("Go to checkout", false, async () => {
    const { url } = await api.post("/api/basket/checkout", {});
    if (practice) {
      setStatus(`Practice mode: this is where Tesco's checkout would open — ${url}`);
      return;
    }
    // Opens Tesco's own checkout. Paying happens there, with a person looking.
    window.open(url, "_blank", "noopener");
  });
  summary.append(findAll, fill, checkout);
  if (finding) {
    const at = Math.min(basketFinding.done + 1, basketFinding.total);
    summary.append(el("span", "basket-progress", `Searching ${at} of ${basketFinding.total}…`));
  }
  body.append(summary);

  if (basketFinding && !finding) body.append(findingReport(basketFinding, toChoose));

  if (basketResult) {
    const result = el("div", `basket-result${basketResult.failed.length ? " partial" : ""}`);
    result.append(
      el(
        "strong",
        null,
        `Added ${basketResult.added.length} item${basketResult.added.length === 1 ? "" : "s"}.`,
      ),
    );
    if (basketResult.skipped) {
      result.append(
        el("span", null, ` ${basketResult.skipped} still need choosing and were left out.`),
      );
    }
    if (basketResult.failed.length) {
      result.append(el("span", null, " These could not be added:"));
      const failed = el("ul");
      for (const f of basketResult.failed) failed.append(el("li", null, `${f.title} — ${f.why}`));
      result.append(failed);
    }
    body.append(result);
  }

  // Both lists share one set of columns, so the lines still to choose line up
  // with the products already chosen below them.
  const lines = el("div", "basket-lines");
  if (toChoose) {
    lines.append(
      el(
        "h3",
        "subhead",
        basketFinding
          ? "Not a 100% match — choose once, remembered after"
          : "Choose once — remembered after",
      ),
    );
    const list = el("ul", "basket-list");
    for (const need of plan.needsChoosing) list.append(basketRow(need, null));
    lines.append(list);
  }
  if (plan.items.length) {
    lines.append(el("h3", "subhead", "Ready to add"));
    const list = el("ul", "basket-list");
    for (const item of plan.items) list.append(basketRow(item, item));
    lines.append(list);
  }
  body.append(lines);
}

/** What "Find all" did, in a sentence or two. */
function findingReport(finding, toChoose) {
  const box = el("div", `basket-result${finding.stopped ? " partial" : ""}`);
  box.append(
    el(
      "strong",
      null,
      finding.linked ? `Matched ${finding.linked} automatically.` : "Nothing was a 100% match.",
    ),
  );
  if (finding.stopped) {
    box.append(el("span", null, ` Stopped at ${finding.stopped.name}: ${finding.stopped.why}`));
  } else if (toChoose) {
    box.append(
      el(
        "span",
        null,
        ` ${toChoose} need${toChoose === 1 ? "s" : ""} you to choose. The options are below.`,
      ),
    );
  } else {
    box.append(el("span", null, " Every line has a product."));
  }
  return box;
}

/**
 * One line of the list: what it asked for and how many, and once a product is
 * chosen, which product, at what price, with a link to check it against the
 * label. The same row serves both lists, so changing a choice looks exactly
 * like making one.
 */
function basketRow(line, item) {
  const search = basketSearches.get(basketKey(line));
  const row = el("li", "basket-row");

  const name = el("span", "basket-name");
  if (item) {
    name.append(el("span", null, item.title), el("span", "basket-for", `for ${item.name}`));
    if (item.auto) name.append(el("span", "basket-auto", "Matched automatically"));
  } else {
    name.append(el("span", null, line.name));
  }

  const actions = el("div", "basket-actions");
  row.append(
    name,
    el("span", "basket-qty", `${line.quantity} × ${line.packLabel}`),
    // An empty cell still holds the column, so every row lines up.
    item ? priceTag(item.price, item.chosenOn) : el("span", "basket-price"),
    actions,
  );
  if (item) {
    const page = productLink(item.url, item.title);
    if (page) actions.append(page);
  }

  if (search?.loading) {
    actions.append(el("span", "basket-loading", "Searching…"));
    return row;
  }
  if (!search) {
    const open = button(item ? "Change" : "Find on Tesco", false, () =>
      findCandidates(line, undefined, item?.sku),
    );
    open.disabled = Boolean(basketFinding?.running);
    actions.append(open);
    return row;
  }

  row.append(optionsFor(line, item, search));
  return row;
}

/** The ranked options for one line, and the ways to act on them. */
function optionsFor(line, item, search) {
  const key = basketKey(line);
  const box = el("div", "basket-candidates");
  if (search.error) box.append(el("p", "basket-error", search.error));
  if (!search.error && search.candidates.length === 0) {
    box.append(el("p", "account-note", "Nothing came back for that. Try other words."));
  }

  // The first few, plus the ticked one if it sits further down.
  const shown = search.expanded
    ? search.candidates
    : search.candidates.filter((c, i) => i < FIRST_OPTIONS || c.product.sku === search.selected);
  for (const candidate of shown) box.append(optionRow(key, search, candidate));
  const hidden = search.candidates.length - shown.length;
  if (hidden > 0) {
    const more = el("button", "mini basket-more", `Show ${hidden} more`);
    more.type = "button";
    more.addEventListener("click", () => {
      search.expanded = true;
      drawBasket();
    });
    box.append(more);
  }

  const tools = el("div", "basket-cand-actions");
  tools.append(
    button("Use this one", true, async () => {
      const chosen = search.candidates.find((c) => c.product.sku === search.selected);
      if (!chosen) {
        setStatus(`Pick a product for ${line.name} first.`, true);
        return;
      }
      await call("/api/basket/link", {
        ingredientId: line.ingredientId,
        packSize: line.packSize,
        sku: chosen.product.sku,
        title: chosen.product.title,
        url: chosen.product.url,
        price: chosen.product.price,
      });
      basketSearches.delete(key);
      await refreshBasket();
    }),
  );

  const retry = el("form", "basket-retry");
  const input = document.createElement("input");
  input.type = "text";
  input.value = search.term ?? "";
  input.placeholder = "Search Tesco for…";
  input.setAttribute("aria-label", `Search Tesco for ${line.name}`);
  const again = el("button", "mini", "Search again");
  again.type = "submit";
  retry.append(input, again);
  retry.addEventListener("submit", (event) => {
    event.preventDefault();
    findCandidates(line, input.value, item?.sku);
  });
  tools.append(retry);

  const close = el("button", "mini", item ? "Keep the current one" : "Not now");
  close.type = "button";
  close.addEventListener("click", () => {
    basketSearches.delete(key);
    drawBasket();
  });
  tools.append(close);

  box.append(tools);
  return box;
}

function optionRow(key, search, candidate) {
  const { product } = candidate;
  const classes = ["basket-cand"];
  // Highlighted only when it is the app's suggestion. A border on every
  // plausible-looking product would say nothing at all.
  if (product.sku === search.suggested) classes.push("confident");
  if (product.available === false) classes.push("unavailable");
  const option = el("div", classes.join(" "));

  const pick = el("label", "basket-cand-pick");
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = `pick-${key}`;
  radio.value = product.sku;
  radio.checked = search.selected === product.sku;
  radio.addEventListener("change", () => {
    search.selected = product.sku;
  });
  const text = el("span", "basket-cand-text");
  text.append(
    el("span", "basket-cand-title", product.title),
    // The reason is shown so a person can disagree with it, not just the number.
    el("span", "basket-cand-why", `${Math.round(candidate.score * 100)}% · ${candidate.why}`),
  );
  if (product.offer) text.append(el("span", "basket-cand-offer", product.offer));
  pick.append(radio, text, priceTag(product.price));
  option.append(pick);

  // Outside the label, so opening the page never changes the choice.
  const page = productLink(product.url, product.title);
  if (page) option.append(page);
  return option;
}

const pounds = (amount) => `£${amount.toFixed(2)}`;

/**
 * Tesco's price, as Tesco gave it. A remembered price carries the date it was
 * seen, because last month's price passed off as today's is exactly the
 * confidently wrong number this app refuses to show.
 */
function priceTag(price, seenOn) {
  const tag = el("span", "basket-price");
  if (!price) return tag;
  tag.append(el("span", "basket-price-each", pounds(price.each)));
  if (price.perUnit != null && price.unit) {
    const per =
      price.unit === "each" ? `${pounds(price.perUnit)} each` : `${pounds(price.perUnit)}/${price.unit}`;
    tag.append(el("span", "basket-price-unit", per));
  }
  if (seenOn && seenOn !== latestState?.today) {
    tag.append(el("span", "basket-price-unit", `on ${dateFormat.format(asDate(seenOn))}`));
  }
  return tag;
}

/**
 * A link to the product's own page, so a match can be checked against the
 * label. Drawn only for https: links live in household state, which every
 * member of the household can write.
 */
function productLink(url, title) {
  let safe = false;
  try {
    safe = new URL(url).protocol === "https:";
  } catch {
    safe = false;
  }
  if (!safe) return null;
  const link = el("a", "basket-link", "View on Tesco ↗");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `View ${title} on Tesco, in a new tab`);
  return link;
}

async function findCandidates(line, term, keep) {
  const key = basketKey(line);
  basketSearches.set(key, { loading: true, term });
  drawBasket();
  try {
    const found = await api.post("/api/basket/candidates", {
      ingredientId: line.ingredientId,
      packSize: line.packSize,
      term,
    });
    basketSearches.set(key, searchState(found, keep));
  } catch (error) {
    basketSearches.set(key, {
      candidates: [],
      term: term ?? "",
      error: error.message,
      selected: null,
    });
  }
  drawBasket();
}

/**
 * What to show for one search.
 *
 * The suggestion is the first candidate the domain is willing to tick, not
 * simply the top score: when the right size is missing from the results, the
 * top result is the wrong one, and a pre-ticked wrong answer gets accepted
 * without anybody reading it. When changing a choice, the current product stays
 * ticked if it came back, so "Change" never quietly becomes "replace".
 */
function searchState(found, keep) {
  const suggestion = found.candidates.find((c) => c.preselect);
  const kept = keep ? found.candidates.find((c) => c.product.sku === keep) : undefined;
  return {
    candidates: found.candidates,
    term: found.term,
    suggested: suggestion?.product.sku ?? null,
    selected: (kept ?? suggestion)?.product.sku ?? null,
    expanded: false,
  };
}

/**
 * Search every line that still needs a product, one at a time.
 *
 * One at a time on purpose: it is somebody else's shop, and the server spaces
 * requests out anyway. A line moves to "Ready" the moment it is matched, so
 * the counts are the progress bar. It stops at the first failure rather than
 * repeating it — an expired session would otherwise show the same error for
 * every line on the list.
 */
async function findAllProducts() {
  const lines = [...(basketPlan?.needsChoosing ?? [])];
  if (!lines.length) return;
  basketResult = null;
  basketFinding = { running: true, done: 0, total: lines.length, linked: 0, stopped: null };

  for (const line of lines) {
    const key = basketKey(line);
    // Keep any words a person already changed the search to.
    const term = basketSearches.get(key)?.term;
    basketSearches.set(key, { loading: true, term });
    drawBasket();
    try {
      const found = await api.post("/api/basket/match", {
        ingredientId: line.ingredientId,
        packSize: line.packSize,
        term,
      });
      basketFinding.done++;
      if (found.linked) {
        basketFinding.linked++;
        basketSearches.delete(key);
        await refreshBasket();
      } else {
        basketSearches.set(key, searchState(found));
      }
    } catch (error) {
      basketSearches.delete(key);
      basketFinding.stopped = { name: line.name, why: error.message };
      break;
    }
  }

  basketFinding.running = false;
  await refreshBasket();
}

/* ---------------- first run ---------------- */

/**
 * Nobody should land in somebody else's fixture week.
 *
 * On a first visit the intro screen takes the whole page and the app proper is
 * not rendered at all until there is a household to render it for. The example
 * family is a deliberate second door rather than the default, so real data and
 * made-up data never get mixed up in the same household.
 */
async function boot() {
  let state = await api.get();

  if (!state.setUp) {
    const { runSetup } = await import("./setup.js");
    const shell = $("setup");
    shell.hidden = false;
    $("app-shell").hidden = true;

    const draft = await runSetup(shell, {
      validate: async (d) => (await api.post("/api/household/validate", d)).issues,
    });

    state = draft
      ? await api.post("/api/household/create", draft)
      : await api.post("/api/household/example", {});

    shell.hidden = true;
    shell.replaceChildren();
    $("app-shell").hidden = false;

    if (draft?.people?.length && state.unrecognised?.length) {
      // Said out loud rather than swallowed: an exclusion the validator cannot
      // enforce has been demoted, and the person who typed it should know.
      const lines = state.unrecognised
        .map((u) => `${u.name}: ${u.entries.join(", ")}`)
        .join(" · ");
      setStatus(
        `Kept as strong dislikes, because they cannot be checked automatically — ${lines}`,
        true,
      );
    }
  }

  render(state);
}

await boot();
