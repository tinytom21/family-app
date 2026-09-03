import { test } from "node:test";
import assert from "node:assert/strict";

import { RETAILERS, linksFor, listAsText, searchTermFor } from "../src/domain/retailers.ts";
import { requireIngredient } from "../src/domain/catalogue.ts";

test("the search term drops the qualifier a shop cannot match on", () => {
  // "Beef mince, 5% fat" as a query finds nothing; "beef mince" finds the aisle.
  assert.equal(searchTermFor(requireIngredient("beef-mince")), "beef mince");
  assert.equal(searchTermFor(requireIngredient("chicken-thigh")), "chicken thighs");
  assert.equal(searchTermFor(requireIngredient("onion")), "brown onions");
});

test("a term with no qualifier is left alone", () => {
  assert.equal(searchTermFor(requireIngredient("garlic")), "garlic");
});

test("links are built for every retailer, and are safely encoded", () => {
  const links = linksFor(requireIngredient("beef-mince"));
  assert.equal(links.length, RETAILERS.length);

  const tesco = links.find((l) => l.retailer === "tesco")!;
  assert.equal(
    tesco.url,
    "https://www.tesco.com/groceries/en-GB/search?query=beef%20mince",
  );
  // A space reaching a URL unescaped is the classic way these break.
  assert.equal(links.every((l) => !l.url.includes(" ")), true);
  assert.equal(links.every((l) => l.url.startsWith("https://")), true);
});

test("the text list is grouped the way the shop is walked", () => {
  const text = listAsText([
    { name: "Carrots", aisle: "produce", display: "500 g" },
    { name: "Beef mince", aisle: "meat-fish", display: "500 g" },
    { name: "Brown onions", aisle: "produce", display: "3" },
  ]);

  assert.match(text, /PRODUCE\n- Carrots — 500 g\n- Brown onions — 3/);
  assert.match(text, /MEAT \/ FISH\n- Beef mince — 500 g/);
  // Produce came first in the input and stays first; the order is the caller's.
  assert.ok(text.indexOf("PRODUCE") < text.indexOf("MEAT / FISH"));
});
