import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultCanCook,
  findByEmail,
  householdExclusions,
  makePerson,
  peopleForPrompt,
  portionFor,
  whoExcludes,
} from "../src/domain/people.ts";

test("a profile fills in everything it can work out for itself", () => {
  const person = makePerson({ name: "Priya Sharma" });
  assert.equal(person.id, "priya-sharma");
  assert.equal(person.ageBracket, "adult");
  assert.equal(person.canCook, true);
  assert.deepEqual(person.excludes, []);
  assert.deepEqual(person.likes, []);
  assert.equal(person.email, undefined);
});

test("portions come from the age bracket, and can be overridden", () => {
  assert.equal(portionFor(makePerson({ name: "A", ageBracket: "adult" })), 1);
  assert.equal(portionFor(makePerson({ name: "C", ageBracket: "child" })), 0.6);
  assert.equal(portionFor(makePerson({ name: "T", ageBracket: "teen" })), 1.3);
  // A teenager eating more than an adult is not a bug.
  assert.ok(
    portionFor(makePerson({ name: "T", ageBracket: "teen" })) >
      portionFor(makePerson({ name: "A", ageBracket: "adult" })),
  );
  assert.equal(
    portionFor(makePerson({ name: "C", ageBracket: "child", portionOverride: 1 })),
    1,
  );
});

test("a baby is present but eats nothing from the pot", () => {
  const baby = makePerson({ name: "Sam", ageBracket: "baby" });
  assert.equal(portionFor(baby), 0);
  assert.equal(baby.canCook, false);
});

test("who can cook defaults by age and is still explicit", () => {
  assert.equal(defaultCanCook("child"), false);
  assert.equal(defaultCanCook("teen"), true);
  // An adult who genuinely does not cook can say so.
  const person = makePerson({ name: "Alex", ageBracket: "adult", canCook: false });
  assert.equal(person.canCook, false);
});

test("exclusions are pooled across the household and attributed by name", () => {
  const people = [
    makePerson({ name: "Tom" }),
    makePerson({ name: "Aria", ageBracket: "child", excludes: ["nuts", "peanut"] }),
    makePerson({ name: "Noor", ageBracket: "child", excludes: ["shellfish"] }),
  ];
  assert.deepEqual([...householdExclusions(people)].sort(), [
    "nuts",
    "peanut",
    "shellfish",
  ]);
  assert.deepEqual(whoExcludes(people, ["peanut"]), ["Aria"]);
  assert.deepEqual(whoExcludes(people, ["shellfish"]), ["Noor"]);
  assert.deepEqual(whoExcludes(people, ["dairy"]), []);
});

test("a profile is found by email, however it was typed", () => {
  const people = [
    makePerson({ name: "Tom", email: "Tom.Example@Gmail.com " }),
    makePerson({ name: "Priya" }),
  ];
  assert.equal(findByEmail(people, "tom.example@gmail.com")?.name, "Tom");
  assert.equal(findByEmail(people, "someone@else.com"), undefined);
});

test("the prompt lines put the absolute rule in capitals", () => {
  const lines = peopleForPrompt([
    makePerson({
      name: "Aria",
      ageBracket: "child",
      excludes: ["nuts"],
      dislikes: ["olives"],
      likes: ["pasta"],
    }),
  ]);
  assert.match(lines[0], /Aria — child, 0\.6 portion/);
  assert.match(lines[0], /CANNOT EAT: nuts/);
  assert.match(lines[0], /dislikes olives/);
  assert.match(lines[0], /likes pasta/);
});
