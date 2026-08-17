/**
 * The intro screen: setting a family up for the first time.
 *
 * Three steps, in the order a person can actually answer them. How many of
 * you, then who they are, then the awkward details. Asking for allergies on
 * the same screen as "how many people live here" is how you get a form nobody
 * finishes.
 *
 * The wizard produces a plain draft object and asks the domain layer whether
 * it is any good. It knows nothing about portions, allergen tags or ids —
 * those are decisions the domain already has opinions about, and a second
 * opinion in the UI is how the two drift apart. That means one round trip per
 * step rather than per keystroke, which is the right trade: the answers only
 * matter when you press Next.
 */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const BRACKETS = [
  ["baby", "Baby (under 1)"],
  ["toddler", "Toddler (1–3)"],
  ["child", "Child (4–12)"],
  ["teen", "Teenager (13–17)"],
  ["adult", "Adult"],
  ["senior", "Older adult"],
];

/**
 * Runs the wizard and resolves with a draft, or with null if the visitor would
 * rather just look round the example family first.
 */
export function runSetup(root, options = {}) {
  const { validate, allowExample = true } = options;

  return new Promise((resolve) => {
    let step = 0;
    let draft = { householdName: "", people: rebuild([], 2, 2) };
    let issues = [];

    const render = () => {
      root.replaceChildren();
      root.append(
        header(),
        step === 0 ? stepSize() : step === 1 ? stepNames() : stepDetails(),
      );
      const firstInput = root.querySelector("input, select");
      if (firstInput && step > 0) firstInput.focus();
    };

    /* ---- chrome ---- */

    function header() {
      const head = el("header", "setup-head");
      head.append(el("span", "setup-mark"));
      const titles = [
        ["Who lives here?", "Two questions first, then the details."],
        ["Names and ages", "Ages set portion sizes and who can be asked to cook. Both are changeable later."],
        ["Anything the kitchen needs to know", "Allergies are treated as absolute. Likes and dislikes only steer suggestions."],
      ];
      const box = el("div");
      box.append(
        el("p", "setup-step", `Step ${step + 1} of 3`),
        el("h1", null, titles[step][0]),
        el("p", "setup-lede", titles[step][1]),
      );
      head.append(box);
      return head;
    }

    function footer(backLabel, nextLabel, onNext) {
      const bar = el("div", "setup-actions");
      if (step > 0) {
        const back = el("button", "btn", backLabel);
        back.type = "button";
        back.addEventListener("click", () => {
          step -= 1;
          issues = [];
          render();
        });
        bar.append(back);
      }
      const next = el("button", "btn btn-primary", nextLabel);
      next.type = "button";
      next.addEventListener("click", onNext);
      bar.append(next);

      if (step === 0 && allowExample) {
        const skip = el("button", "btn btn-quiet", "Show me an example family");
        skip.type = "button";
        skip.title = "Look round with made-up data; you can set yours up later";
        skip.addEventListener("click", () => resolve(null));
        bar.append(skip);
      }
      return bar;
    }

    function problems() {
      if (issues.length === 0) return el("div");
      const box = el("div", "setup-problems");
      box.append(el("strong", null, "Just a couple of things:"));
      const list = el("ul");
      for (const issue of issues) list.append(el("li", null, issue.message));
      box.append(list);
      return box;
    }

    /* ---- step 1: how many ---- */

    function stepSize() {
      const body = el("div", "setup-body");
      const counts = el("div", "setup-counts");

      const adults = counter("Adults", draft.people.filter(isGrownUp).length, 1, 8);
      const children = counter("Children", draft.people.filter((p) => !isGrownUp(p)).length, 0, 10);
      counts.append(adults.node, children.node);

      body.append(
        counts,
        el(
          "p",
          "setup-hint",
          "A rough answer is fine — you can add or remove people at any point.",
        ),
        footer(null, "Next", () => {
          draft = {
            householdName: draft.householdName,
            people: rebuild(draft.people, adults.value(), children.value()),
          };
          step = 1;
          render();
        }),
      );
      return body;
    }

    function counter(label, initial, min, max) {
      let value = initial;
      const node = el("div", "counter");
      const readout = el("span", "counter-value", String(value));
      const set = (next) => {
        value = Math.min(max, Math.max(min, next));
        readout.textContent = String(value);
        minus.disabled = value <= min;
        plus.disabled = value >= max;
      };
      const minus = el("button", "counter-btn", "−");
      minus.type = "button";
      minus.setAttribute("aria-label", `One fewer ${label.toLowerCase()}`);
      minus.addEventListener("click", () => set(value - 1));
      const plus = el("button", "counter-btn", "+");
      plus.type = "button";
      plus.setAttribute("aria-label", `One more ${label.toLowerCase()}`);
      plus.addEventListener("click", () => set(value + 1));

      node.append(el("span", "counter-label", label), minus, readout, plus);
      set(value);
      return { node, value: () => value };
    }

    /* ---- step 2: names ---- */

    function stepNames() {
      const body = el("div", "setup-body");
      body.append(problems());

      const nameField = field("What should we call this household?", "e.g. The Hardys", draft.householdName, (v) => {
        draft.householdName = v;
      });
      nameField.classList.add("setup-household-name");
      body.append(nameField);

      const list = el("ul", "setup-people");
      draft.people.forEach((person, index) => {
        const row = el("li", "setup-person");

        const name = document.createElement("input");
        name.type = "text";
        name.value = person.name;
        name.placeholder = "Name";
        name.setAttribute("aria-label", `Name of person ${index + 1}`);
        name.addEventListener("input", () => (person.name = name.value));

        const bracket = document.createElement("select");
        bracket.setAttribute("aria-label", `Age bracket for person ${index + 1}`);
        for (const [id, label] of BRACKETS) {
          const option = document.createElement("option");
          option.value = id;
          option.textContent = label;
          bracket.append(option);
        }
        bracket.value = person.ageBracket;
        bracket.addEventListener("change", () => {
          person.ageBracket = bracket.value;
          delete person.canCook; // let the new bracket decide again
          render();
        });

        const cooks = document.createElement("label");
        cooks.className = "toggle";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = person.canCook ?? isGrownUp(person);
        box.addEventListener("change", () => (person.canCook = box.checked));
        cooks.append(box, el("span", null, "can cook"));

        const drop = el("button", "mini", "Remove");
        drop.type = "button";
        drop.addEventListener("click", () => {
          draft.people.splice(index, 1);
          render();
        });

        row.append(name, bracket, cooks, drop);
        list.append(row);
      });
      body.append(list);

      const add = el("button", "btn btn-quiet", "Add another person");
      add.type = "button";
      add.addEventListener("click", () => {
        draft.people.push({ name: "", ageBracket: "adult" });
        render();
      });
      body.append(add);

      body.append(
        footer("Back", "Next", async () => {
          // "Nobody can cook" is true but premature here — it is a warning
          // about the finished household, not about the names screen.
          const all = await validate(draft);
          issues = all.filter((i) => !/able to cook/.test(i.message));
          if (issues.length) return render();
          step = 2;
          render();
        }),
      );
      return body;
    }

    /* ---- step 3: the details ---- */

    function stepDetails() {
      const body = el("div", "setup-body");
      body.append(problems());

      const list = el("ul", "setup-details");
      for (const person of draft.people) {
        const row = el("li", "setup-detail");
        row.append(el("h2", null, person.name || "Someone"));

        row.append(
          field("Cannot eat", "nuts, shellfish", person.excludes ?? "", (v) => {
            person.excludes = v;
          }, true),
          field("Dislikes", "mushrooms, olives", person.dislikes ?? "", (v) => {
            person.dislikes = v;
          }),
          field("Loves", "pasta, curry", person.likes ?? "", (v) => {
            person.likes = v;
          }),
        );

        if (isGrownUp(person)) {
          row.append(
            field(
              "Google account (optional)",
              "name@gmail.com",
              person.email ?? "",
              (v) => (person.email = v),
            ),
          );
        }
        list.append(row);
      }
      body.append(list);

      body.append(
        el(
          "p",
          "setup-hint",
          "Anything typed under “cannot eat” that the app cannot check for itself is kept as a strong dislike instead — it will say which.",
        ),
        footer("Back", "Create this household", async () => {
          issues = await validate(draft);
          // A household with no cook is odd but legal — say so and let them
          // through, rather than trapping somebody on the last screen.
          if (issues.some((i) => !/able to cook/.test(i.message))) return render();
          resolve(draft);
        }),
      );
      return body;
    }

    function field(label, placeholder, value, onInput, danger = false) {
      const wrap = el("label", `setup-field${danger ? " danger" : ""}`);
      wrap.append(el("span", "setup-field-label", label));
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = placeholder;
      input.value = value;
      input.addEventListener("input", () => onInput(input.value));
      wrap.append(input);
      return wrap;
    }

    render();
  });
}

const isGrownUp = (person) =>
  person.ageBracket === "adult" ||
  person.ageBracket === "teen" ||
  person.ageBracket === "senior";

/** Resize the people list without losing anything already typed. */
function rebuild(existing, adults, children) {
  const grown = existing.filter(isGrownUp);
  const young = existing.filter((p) => !isGrownUp(p));
  const out = [];
  for (let i = 0; i < adults; i++) {
    out.push(grown[i] ?? { name: "", ageBracket: "adult" });
  }
  for (let i = 0; i < children; i++) {
    out.push(young[i] ?? { name: "", ageBracket: "child" });
  }
  return out;
}
