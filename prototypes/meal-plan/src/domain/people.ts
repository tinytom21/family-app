/**
 * Who lives here.
 *
 * Until now the household was a fixed list of names and portion multipliers
 * buried in the constraints — fine for a spike, useless for a real family,
 * because it cannot answer the two questions that actually vary: who is in for
 * dinner tonight, and who is going to cook it.
 *
 * A profile is set up once by whoever is holding the phone. Linking it to a
 * Google account is optional and only buys one thing — that person's calendar
 * feeding their own row in the week. Everything else about a person works
 * whether or not they ever log in, which matters when half the household is
 * seven years old.
 *
 * Portion size and whether someone can cook are both *derived* from the age
 * bracket and then overridable. Asking a parent to type a portion multiplier
 * for a toddler is the kind of question that makes people close an app.
 */

import type { DietTag } from "./types.ts";

export type AgeBracket =
  | "baby"
  | "toddler"
  | "child"
  | "teen"
  | "adult"
  | "senior";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly ageBracket: AgeBracket;
  /** Whether this person can be put down to cook dinner. */
  readonly canCook: boolean;
  /** Absolute: allergies and hard dietary rules. Never relaxed, ever. */
  readonly excludes: readonly DietTag[];
  /** Preferences. Steered in the prompt, not enforced in code. */
  readonly dislikes: readonly string[];
  readonly likes: readonly string[];
  /** Set when the profile is linked to a Google account. */
  readonly email?: string;
  /** Overrides the portion implied by the age bracket. */
  readonly portionOverride?: number;
  readonly notes?: string;
}

/**
 * Portions by age bracket.
 *
 * A baby is zero on purpose rather than missing: they are in for dinner, they
 * are just not eating out of the pot yet. Modelling that as "not present"
 * would be wrong the moment it starts mattering.
 */
const PORTION: Record<AgeBracket, number> = {
  baby: 0,
  toddler: 0.4,
  child: 0.6,
  teen: 1.3,
  adult: 1,
  senior: 0.8,
};

const COOKS_BY_DEFAULT: Record<AgeBracket, boolean> = {
  baby: false,
  toddler: false,
  child: false,
  teen: true,
  adult: true,
  senior: true,
};

export const AGE_BRACKETS = Object.keys(PORTION) as AgeBracket[];

export const AGE_BRACKET_LABELS: Record<AgeBracket, string> = {
  baby: "Baby (under 1)",
  toddler: "Toddler (1–3)",
  child: "Child (4–12)",
  teen: "Teenager (13–17)",
  adult: "Adult",
  senior: "Older adult",
};

export function portionFor(person: Person): number {
  return person.portionOverride ?? PORTION[person.ageBracket] ?? 1;
}

/** Portions when everybody is in — the fallback before a week is set up. */
export function householdPortions(people: readonly Person[]): number {
  return Math.round(people.reduce((sum, p) => sum + portionFor(p), 0) * 100) / 100;
}

export function defaultCanCook(bracket: AgeBracket): boolean {
  return COOKS_BY_DEFAULT[bracket] ?? true;
}

/** Fill in everything a profile can work out for itself. */
export function makePerson(
  input: Partial<Person> & { name: string },
): Person {
  const ageBracket = input.ageBracket ?? "adult";
  return {
    id: input.id ?? slugify(input.name),
    name: input.name,
    ageBracket,
    canCook: input.canCook ?? defaultCanCook(ageBracket),
    excludes: input.excludes ?? [],
    dislikes: input.dislikes ?? [],
    likes: input.likes ?? [],
    ...(input.email ? { email: input.email } : {}),
    ...(input.portionOverride !== undefined
      ? { portionOverride: input.portionOverride }
      : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "person"
  );
}

export function findByEmail(
  people: readonly Person[],
  email: string,
): Person | undefined {
  const wanted = email.trim().toLowerCase();
  return people.find((p) => p.email?.trim().toLowerCase() === wanted);
}

/**
 * Everything the household hard-excludes, whoever is at the table.
 *
 * Deliberately not filtered by who is in that night. Tuesday's stew is
 * Thursday's leftovers, and an allergen that was safe on Tuesday because that
 * child was at their grandmother's is still in the fridge on Thursday. The
 * cost of being wrong here is not a wasted meal.
 */
export function householdExclusions(people: readonly Person[]): Set<DietTag> {
  return new Set(people.flatMap((p) => p.excludes));
}

export function whoExcludes(
  people: readonly Person[],
  tags: readonly DietTag[],
): string[] {
  return people
    .filter((p) => p.excludes.some((t) => tags.includes(t)))
    .map((p) => p.name);
}

/** One line per person for the model prompt. */
export function peopleForPrompt(people: readonly Person[]): string[] {
  return people.map((p) => {
    const bits = [`${p.name} — ${p.ageBracket}, ${portionFor(p)} portion`];
    if (p.excludes.length) bits.push(`CANNOT EAT: ${p.excludes.join(", ")}`);
    if (p.dislikes.length) bits.push(`dislikes ${p.dislikes.join(", ")}`);
    if (p.likes.length) bits.push(`likes ${p.likes.join(", ")}`);
    if (p.notes) bits.push(p.notes);
    return bits.join("; ");
  });
}
