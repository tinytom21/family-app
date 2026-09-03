/**
 * Getting the list into a supermarket.
 *
 * There is no way to do this properly. Tesco's developer API is gone — the old
 * Tesco Labs portal no longer resolves, and even while it lived it did product
 * search only; basket writes were "planned" and never arrived. Whisk built the
 * thing everybody wants (parse a list, match it to real products, fill a
 * basket) and had all five big UK grocers, then Samsung bought them and closed
 * the API to new clients. What is left is browser automation against your own
 * account, which is a personal-use grey area at best and not something to ask a
 * beta tester to hand over their login for.
 *
 * So this does the honest version: a search link per line. It cannot fill a
 * basket, but it puts a person exactly where the ambiguity is — deciding which
 * of Tesco's fourteen tins of chopped tomatoes they actually want — which is
 * the part no API was going to solve for us anyway. Matching a canonical
 * ingredient to a specific product id is the hard problem here, not the HTTP.
 */

import type { CanonicalIngredient } from "./types.ts";

export interface Retailer {
  readonly id: string;
  readonly name: string;
  /** Builds a search URL for a term that is already URL-safe to encode. */
  search(term: string): string;
}

export const RETAILERS: readonly Retailer[] = [
  {
    id: "tesco",
    name: "Tesco",
    search: (term) =>
      `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(term)}`,
  },
  {
    id: "sainsburys",
    name: "Sainsbury's",
    search: (term) =>
      `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(term)}`,
  },
];

/**
 * What to actually type into the search box.
 *
 * Catalogue names are written for a human reading a list — "Beef mince, 5% fat",
 * "Chicken thighs, boneless" — and the qualifier after the comma is exactly the
 * kind of thing that turns a supermarket search into no results. The clause
 * before the comma is the product; the rest is a preference the shopper can
 * apply with their eyes.
 *
 * Quantities are left out on purpose. The list already says how much to buy,
 * and "2 x 400g tin chopped tomatoes" as a search term finds nothing.
 */
export function searchTermFor(ingredient: CanonicalIngredient): string {
  const base = ingredient.name.split(",")[0].trim();
  return base.toLowerCase();
}

export function linksFor(
  ingredient: CanonicalIngredient,
  retailers: readonly Retailer[] = RETAILERS,
): { retailer: string; name: string; url: string }[] {
  const term = searchTermFor(ingredient);
  return retailers.map((r) => ({
    retailer: r.id,
    name: r.name,
    url: r.search(term),
  }));
}

/**
 * The whole list as text, for pasting wherever a person actually wants it.
 *
 * Grouped by aisle, because that is the order the shop is walked in, and
 * because a flat alphabetical list is how you end up crossing the store four
 * times.
 */
export function listAsText(
  lines: readonly {
    name: string;
    aisle: string;
    display: string;
  }[],
): string {
  const byAisle = new Map<string, string[]>();
  for (const line of lines) {
    const aisle = line.aisle.replace("-", " / ");
    if (!byAisle.has(aisle)) byAisle.set(aisle, []);
    byAisle.get(aisle)!.push(`- ${line.name} — ${line.display}`);
  }
  return [...byAisle]
    .map(([aisle, items]) => `${aisle.toUpperCase()}\n${items.join("\n")}`)
    .join("\n\n");
}
