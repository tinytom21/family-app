/**
 * Households, the people in them, and how somebody joins one.
 *
 * Two ideas that sound the same and are not:
 *
 *   A **person** is a mouth at the table. They have a name, an age bracket,
 *   things they cannot eat. Most of them will never log in — a seven-year-old
 *   does not need an account to be allergic to peanuts, and requiring one
 *   would be a good way to make sure the allergy never gets recorded.
 *
 *   A **user** is somebody holding a phone. They sign in, and they can change
 *   things.
 *
 * Keeping these apart is what lets one adult set the whole family up on their
 * own, and lets the other adult join later and be *linked to* the person
 * profile that already exists rather than creating a duplicate of themselves.
 * Every app that conflates the two ends up with two Priyas.
 *
 * Anyone who is in the household can change anything in it. There is no
 * permission ladder, deliberately: this is a family, not an organisation, and
 * a household where one adult has to ask the other for edit rights to the
 * shopping list is a worse product than one where they can both just fix it.
 */

import { makePerson } from "./people.ts";
import type { AgeBracket, Person } from "./people.ts";

export interface Household {
  readonly id: string;
  readonly name: string;
  /** The account that created it. Marked only so it can never be left empty. */
  readonly ownerUserId: string;
  readonly createdAt: string;
}

export interface Membership {
  readonly userId: string;
  readonly householdId: string;
  /** The person at the table this account belongs to, when it is one of them. */
  readonly personId?: string;
  readonly email?: string;
  readonly joinedAt: string;
}

export interface Invite {
  readonly code: string;
  readonly householdId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedBy?: string;
}

/* ------------------------------------------------------------------ */
/* Invite codes                                                        */
/* ------------------------------------------------------------------ */

/**
 * No 0/O, no 1/I/L, no U/V.
 *
 * These get read aloud across a kitchen and typed by somebody who is holding a
 * toddler. Every character that can be misheard or misread is one support
 * conversation, so they are simply not in the alphabet.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTWXYZ23456789";
const CODE_LENGTH = 6;

export function generateInviteCode(
  random: () => number = Math.random,
): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return code;
}

/**
 * Accept what a person actually types.
 *
 * Lower case, spaces, and the dash people add in the middle of a six-character
 * code all mean the same thing. Nothing is *substituted* — the alphabet above
 * already excludes every confusable character, so there is no ambiguity left
 * to guess at, and guessing would only turn a clear error into a wrong one.
 */
export function normaliseInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isWellFormedInviteCode(code: string): boolean {
  return (
    code.length === CODE_LENGTH &&
    [...code].every((c) => ALPHABET.includes(c))
  );
}

export type InviteProblem =
  | "malformed"
  | "unknown"
  | "expired"
  | "already-used";

/**
 * Why this code will not let you in, in the order the user can act on.
 *
 * Format first, because "that is not six characters" is answerable without a
 * round trip and without telling a stranger whether a code exists.
 */
export function checkInvite(
  code: string,
  invite: Invite | undefined,
  now: string,
): InviteProblem | null {
  if (!isWellFormedInviteCode(code)) return "malformed";
  if (!invite) return "unknown";
  if (invite.usedBy) return "already-used";
  if (invite.expiresAt <= now) return "expired";
  return null;
}

export const INVITE_PROBLEMS: Record<InviteProblem, string> = {
  malformed: "That code should be six letters and numbers.",
  unknown: "No family found for that code. Check it with whoever sent it.",
  expired: "That invite has expired. Ask for a fresh one — they last a week.",
  "already-used": "That invite has already been used. Ask for a fresh one.",
};

/** A week is long enough to get round to it and short enough to matter. */
export function inviteExpiry(from: string, days = 7): string {
  const at = new Date(from);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString();
}

/* ------------------------------------------------------------------ */
/* Setting a household up for the first time                           */
/* ------------------------------------------------------------------ */

/** What the intro screen collects, before any of it is real. */
export interface DraftPerson {
  name: string;
  ageBracket: AgeBracket;
  canCook?: boolean;
  /** Free text as typed — "nuts, shellfish" — parsed on the way out. */
  excludes?: string;
  dislikes?: string;
  likes?: string;
  email?: string;
}

export interface HouseholdDraft {
  householdName: string;
  people: DraftPerson[];
}

export type DraftIssue = { field: string; message: string };

/**
 * The allergen tags the app can actually reason about.
 *
 * Anything typed that is not in here is kept as a *dislike* rather than being
 * dropped or silently upgraded. A hard exclusion the validator cannot check is
 * worse than no exclusion at all, because it looks like protection and is not.
 */
const KNOWN_ALLERGENS = [
  "meat",
  "poultry",
  "pork",
  "beef",
  "fish",
  "shellfish",
  "dairy",
  "egg",
  "gluten",
  "nuts",
  "peanut",
  "soy",
  "sesame",
  "alcohol",
] as const;

const ALIASES: Record<string, string> = {
  "nut": "nuts",
  "tree nuts": "nuts",
  "treenuts": "nuts",
  "peanuts": "peanut",
  "milk": "dairy",
  "lactose": "dairy",
  "cheese": "dairy",
  "eggs": "egg",
  "wheat": "gluten",
  "coeliac": "gluten",
  "celiac": "gluten",
  "shell fish": "shellfish",
  "prawns": "shellfish",
  "shrimp": "shellfish",
  "seafood": "shellfish",
  "soya": "soy",
  "chicken": "poultry",
  "red meat": "beef",
};

export interface ParsedExclusions {
  readonly tags: string[];
  /** Typed, meant seriously, and not something the validator can enforce. */
  readonly unrecognised: string[];
}

export function parseExclusions(input: string | undefined): ParsedExclusions {
  const tags: string[] = [];
  const unrecognised: string[] = [];

  for (const raw of splitList(input)) {
    const key = raw.toLowerCase();
    const mapped = ALIASES[key] ?? key;
    if ((KNOWN_ALLERGENS as readonly string[]).includes(mapped)) {
      if (!tags.includes(mapped)) tags.push(mapped);
    } else {
      unrecognised.push(raw);
    }
  }
  return { tags, unrecognised };
}

export function splitList(input: string | undefined): string[] {
  return (input ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Everything wrong with the draft, all at once.
 *
 * Returned as a list rather than thrown one at a time, because a wizard that
 * reveals one problem per attempt is how people give up on step two.
 */
export function validateDraft(draft: HouseholdDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];

  if (!draft.householdName.trim()) {
    issues.push({ field: "householdName", message: "Give the household a name." });
  }
  if (draft.people.length === 0) {
    issues.push({ field: "people", message: "Add at least one person." });
  }

  const seen = new Set<string>();
  draft.people.forEach((person, index) => {
    const name = person.name.trim();
    if (!name) {
      issues.push({ field: `people.${index}.name`, message: "Everyone needs a name." });
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      issues.push({
        field: `people.${index}.name`,
        // Two people called the same thing would collide on id, and the grid
        // would quietly show one of them twice.
        message: `There are two people called ${name}. Use something that tells them apart.`,
      });
    }
    seen.add(key);

    if (person.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(person.email.trim())) {
      issues.push({
        field: `people.${index}.email`,
        message: `${name}'s email address does not look right.`,
      });
    }
  });

  if (draft.people.length > 0 && !draft.people.some((p) => canCookOf(p))) {
    issues.push({
      field: "people",
      // Not fatal, but the meal planner has nothing to work with otherwise.
      message: "Nobody is marked as able to cook, so no meals can be planned.",
    });
  }

  return issues;
}

function canCookOf(person: DraftPerson): boolean {
  if (person.canCook !== undefined) return person.canCook;
  return person.ageBracket === "adult" ||
    person.ageBracket === "teen" ||
    person.ageBracket === "senior";
}

/** Turn the wizard's answers into real profiles. */
export function peopleFromDraft(draft: HouseholdDraft): {
  people: Person[];
  unrecognised: { name: string; entries: string[] }[];
} {
  const unrecognised: { name: string; entries: string[] }[] = [];

  const people = draft.people.map((person) => {
    const parsed = parseExclusions(person.excludes);
    if (parsed.unrecognised.length) {
      unrecognised.push({ name: person.name.trim(), entries: parsed.unrecognised });
    }
    return makePerson({
      name: person.name.trim(),
      ageBracket: person.ageBracket,
      ...(person.canCook !== undefined ? { canCook: person.canCook } : {}),
      excludes: parsed.tags as Person["excludes"],
      // Anything the validator cannot enforce becomes a strongly-worded
      // preference, which the model is told about but code cannot guarantee.
      dislikes: [...splitList(person.dislikes), ...parsed.unrecognised],
      likes: splitList(person.likes),
      ...(person.email?.trim() ? { email: person.email.trim() } : {}),
    });
  });

  return { people, unrecognised };
}

/** A starting draft, sized to the answer of "how many of you are there?". */
export function blankDraft(adults = 2, children = 0): HouseholdDraft {
  const people: DraftPerson[] = [];
  for (let i = 0; i < adults; i++) {
    people.push({ name: "", ageBracket: "adult" });
  }
  for (let i = 0; i < children; i++) {
    people.push({ name: "", ageBracket: "child" });
  }
  return { householdName: "", people };
}
