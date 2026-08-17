import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blankDraft,
  checkInvite,
  generateInviteCode,
  inviteExpiry,
  isWellFormedInviteCode,
  normaliseInviteCode,
  parseExclusions,
  peopleFromDraft,
  splitList,
  validateDraft,
} from "../src/domain/household.ts";
import type { HouseholdDraft, Invite } from "../src/domain/household.ts";
import { portionFor } from "../src/domain/people.ts";

/* ---------------- invite codes ---------------- */

test("invite codes avoid every character that gets misread", () => {
  // Read aloud across a kitchen, typed one-handed. 0/O, 1/I/L and U/V are the
  // pairs that cause support conversations, so they are not in the alphabet.
  const codes = Array.from({ length: 200 }, () => generateInviteCode());
  for (const code of codes) {
    assert.equal(code.length, 6);
    assert.equal(/[01ILOUV]/.test(code), false, `bad character in ${code}`);
    assert.ok(isWellFormedInviteCode(code));
  }
});

test("codes are drawn from the whole alphabet", () => {
  // A generator with an off-by-one would quietly never emit the last letter.
  const seen = new Set<string>();
  let seed = 1;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 2000; i++) {
    for (const c of generateInviteCode(random)) seen.add(c);
  }
  assert.equal(seen.size, 29, `only saw ${[...seen].sort().join("")}`);
});

test("a typed code is read the way people write it", () => {
  assert.equal(normaliseInviteCode(" abc-123 "), "ABC123");
  assert.equal(normaliseInviteCode("ABC 123"), "ABC123");
  assert.equal(normaliseInviteCode("abc123"), "ABC123");
});

test("well-formed means the right length and the right alphabet", () => {
  assert.equal(isWellFormedInviteCode("ABCDEF"), true);
  assert.equal(isWellFormedInviteCode("ABCDE"), false, "too short");
  assert.equal(isWellFormedInviteCode("ABCDEFG"), false, "too long");
  assert.equal(isWellFormedInviteCode("ABCDE0"), false, "zero is not in it");
  assert.equal(isWellFormedInviteCode("ABCDEI"), false, "nor is I");
});

const invite = (over: Partial<Invite> = {}): Invite => ({
  code: "ABC234",
  householdId: "h1",
  createdBy: "u1",
  createdAt: "2026-08-10T00:00:00.000Z",
  expiresAt: "2026-08-17T00:00:00.000Z",
  ...over,
});

test("an invite is refused for one reason at a time, in a useful order", () => {
  const now = "2026-08-15T00:00:00.000Z";
  assert.equal(checkInvite("ABC234", invite(), now), null);
  // Format is checked before lookup, so a nonsense code never has to ask the
  // server whether some other code exists.
  assert.equal(checkInvite("nope", undefined, now), "malformed");
  assert.equal(checkInvite("ABC234", undefined, now), "unknown");
  assert.equal(
    checkInvite("ABC234", invite({ usedBy: "u2" }), now),
    "already-used",
  );
  assert.equal(
    checkInvite("ABC234", invite(), "2026-08-20T00:00:00.000Z"),
    "expired",
  );
});

test("an invite that expires exactly now is expired", () => {
  const at = "2026-08-17T00:00:00.000Z";
  assert.equal(checkInvite("ABC234", invite({ expiresAt: at }), at), "expired");
});

test("invites last a week", () => {
  assert.equal(
    inviteExpiry("2026-08-10T09:30:00.000Z"),
    "2026-08-17T09:30:00.000Z",
  );
});

/* ---------------- what the wizard collects ---------------- */

test("a blank draft is sized to the answer given", () => {
  const draft = blankDraft(2, 3);
  assert.equal(draft.people.length, 5);
  assert.equal(draft.people.filter((p) => p.ageBracket === "adult").length, 2);
  assert.equal(draft.people.filter((p) => p.ageBracket === "child").length, 3);
});

test("splitList copes with however people type a list", () => {
  assert.deepEqual(splitList("nuts, shellfish"), ["nuts", "shellfish"]);
  assert.deepEqual(splitList("nuts;shellfish\negg"), ["nuts", "shellfish", "egg"]);
  assert.deepEqual(splitList("  nuts ,, "), ["nuts"]);
  assert.deepEqual(splitList(undefined), []);
});

test("common words for an allergy map onto the tag the validator checks", () => {
  assert.deepEqual(parseExclusions("peanuts").tags, ["peanut"]);
  assert.deepEqual(parseExclusions("Milk, Eggs").tags, ["dairy", "egg"]);
  assert.deepEqual(parseExclusions("wheat").tags, ["gluten"]);
  assert.deepEqual(parseExclusions("prawns").tags, ["shellfish"]);
  assert.deepEqual(parseExclusions("nuts, nut, tree nuts").tags, ["nuts"]);
});

test("an allergy the app cannot check is never silently accepted", () => {
  // This is the whole point. Pretending to enforce "kiwi" would look like
  // protection and provide none, so it comes back flagged.
  const parsed = parseExclusions("nuts, kiwi fruit");
  assert.deepEqual(parsed.tags, ["nuts"]);
  assert.deepEqual(parsed.unrecognised, ["kiwi fruit"]);
});

const draft = (over: Partial<HouseholdDraft> = {}): HouseholdDraft => ({
  householdName: "The Hardys",
  people: [
    { name: "Tom", ageBracket: "adult" },
    { name: "Aria", ageBracket: "child" },
  ],
  ...over,
});

test("a good draft has nothing to say about it", () => {
  assert.deepEqual(validateDraft(draft()), []);
});

test("every problem is reported at once, not one per attempt", () => {
  const issues = validateDraft({
    householdName: "  ",
    people: [
      { name: "", ageBracket: "adult" },
      { name: "Tom", ageBracket: "adult" },
      { name: "tom", ageBracket: "child" },
    ],
  });
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes("householdName"));
  assert.ok(fields.includes("people.0.name"));
  assert.ok(fields.includes("people.2.name"), "the duplicate name");
  assert.ok(issues.length >= 3, `got ${JSON.stringify(issues)}`);
});

test("two people with the same name is caught, whatever the casing", () => {
  const issues = validateDraft(
    draft({
      people: [
        { name: "Sam", ageBracket: "adult" },
        { name: " sam ", ageBracket: "child" },
      ],
    }),
  );
  // The message points at the row it is complaining about and quotes what is
  // actually typed there, so "sam" rather than a tidied-up "Sam".
  assert.match(issues[0].message, /two people called sam/i);
  assert.equal(issues[0].field, "people.1.name");
});

test("a household with nobody who can cook is flagged", () => {
  const issues = validateDraft(
    draft({ people: [{ name: "Noor", ageBracket: "child" }] }),
  );
  assert.ok(issues.some((i) => /nobody is marked as able to cook/i.test(i.message)));
});

test("a bad email address is caught before it reaches Google", () => {
  const issues = validateDraft(
    draft({
      people: [{ name: "Tom", ageBracket: "adult", email: "tom@nope" }],
    }),
  );
  assert.match(issues[0].message, /email address does not look right/);
});

test("an empty household is not a household", () => {
  const issues = validateDraft(draft({ people: [] }));
  assert.ok(issues.some((i) => i.field === "people"));
});

/* ---------------- turning it into profiles ---------------- */

test("the draft becomes real profiles, with portions derived", () => {
  const { people } = peopleFromDraft({
    householdName: "The Hardys",
    people: [
      { name: "Tom", ageBracket: "adult", likes: "curry, chorizo" },
      {
        name: "Aria",
        ageBracket: "child",
        excludes: "peanuts, nuts",
        dislikes: "olives",
      },
    ],
  });

  assert.equal(people.length, 2);
  assert.equal(people[0].id, "tom");
  assert.equal(people[0].canCook, true);
  assert.deepEqual(people[0].likes, ["curry", "chorizo"]);

  assert.equal(people[1].canCook, false, "children are not put down to cook");
  assert.equal(portionFor(people[1]), 0.6);
  assert.deepEqual(people[1].excludes, ["peanut", "nuts"]);
  assert.deepEqual(people[1].dislikes, ["olives"]);
});

test("an unenforceable exclusion becomes a strongly worded dislike", () => {
  const { people, unrecognised } = peopleFromDraft({
    householdName: "x",
    people: [{ name: "Noor", ageBracket: "child", excludes: "nuts, kiwi" }],
  });

  assert.deepEqual(people[0].excludes, ["nuts"]);
  assert.deepEqual(people[0].dislikes, ["kiwi"], "kept, but not as a guarantee");
  assert.deepEqual(unrecognised, [{ name: "Noor", entries: ["kiwi"] }]);
});

test("names are trimmed before they become ids", () => {
  const { people } = peopleFromDraft({
    householdName: "x",
    people: [{ name: "  Priya Sharma  ", ageBracket: "adult" }],
  });
  assert.equal(people[0].name, "Priya Sharma");
  assert.equal(people[0].id, "priya-sharma");
});

test("an email on a profile is what links it to an account later", () => {
  const { people } = peopleFromDraft({
    householdName: "x",
    people: [{ name: "Tom", ageBracket: "adult", email: " Tom@Example.com " }],
  });
  assert.equal(people[0].email, "Tom@Example.com");
});
