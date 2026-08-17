/**
 * Canonical UK ingredient catalogue.
 *
 * `packs` is what makes the list buyable: recipes need 340 g of chicken and
 * shops sell 300 g and 650 g. Pack *sizes* travel between shops well enough to
 * be worth modelling; pack *prices* do not, so there are none here. The list
 * tells you what to put in the trolley, not what it will cost.
 */

import type { CanonicalIngredient } from "./types.ts";

export const CATALOGUE: readonly CanonicalIngredient[] = [
  /* ---------- meat & fish ---------- */
  {
    id: "chicken-breast",
    name: "Chicken breast fillets",
    aisle: "meat-fish",
    base: "mass",
    gramsPerUnit: 170,
    tags: ["meat", "poultry"],
    packs: [
      { size: 300, label: "300 g pack" },
      { size: 650, label: "650 g pack" },
    ],
  },
  {
    id: "chicken-thigh",
    name: "Chicken thighs, boneless",
    aisle: "meat-fish",
    base: "mass",
    gramsPerUnit: 90,
    tags: ["meat", "poultry"],
    packs: [{ size: 500, label: "500 g pack" }],
  },
  {
    id: "beef-mince",
    name: "Beef mince, 5% fat",
    aisle: "meat-fish",
    base: "mass",
    tags: ["meat", "beef"],
    packs: [
      { size: 500, label: "500 g pack" },
      { size: 750, label: "750 g pack" },
    ],
  },
  {
    id: "salmon-fillet",
    name: "Salmon fillets",
    aisle: "meat-fish",
    base: "count",
    gramsPerUnit: 130,
    tags: ["fish"],
    packs: [{ size: 2, label: "2 fillets" }],
  },
  {
    id: "chorizo",
    name: "Chorizo ring",
    aisle: "meat-fish",
    base: "mass",
    tags: ["meat", "pork"],
    packs: [{ size: 200, label: "200 g" }],
  },

  /* ---------- produce ---------- */
  {
    id: "onion",
    name: "Brown onions",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 150,
    packs: [
      { size: 3, label: "3-pack" },
      { size: 7, label: "1 kg bag" },
    ],
  },
  {
    id: "garlic",
    name: "Garlic",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 5,
    aliases: ["garlic clove"],
    packs: [{ size: 11, label: "1 bulb" }],
  },
  {
    id: "carrot",
    name: "Carrots",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 80,
    packs: [{ size: 8, label: "600 g pack" }],
  },
  {
    id: "potato",
    name: "Maris Piper potatoes",
    aisle: "produce",
    base: "mass",
    packs: [{ size: 2500, label: "2.5 kg bag" }],
  },
  {
    id: "sweet-potato",
    name: "Sweet potatoes",
    aisle: "produce",
    base: "mass",
    packs: [{ size: 1000, label: "1 kg" }],
  },
  {
    id: "pepper-red",
    name: "Red peppers",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 160,
    packs: [{ size: 3, label: "3-pack" }],
  },
  {
    id: "courgette",
    name: "Courgettes",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 200,
    packs: [{ size: 2, label: "2-pack" }],
  },
  {
    id: "broccoli",
    name: "Broccoli",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 350,
    packs: [{ size: 1, label: "1 head" }],
  },
  {
    id: "spinach",
    name: "Baby spinach",
    aisle: "produce",
    base: "mass",
    packs: [{ size: 240, label: "240 g bag" }],
  },
  {
    id: "tomato-cherry",
    name: "Cherry tomatoes",
    aisle: "produce",
    base: "mass",
    packs: [{ size: 300, label: "300 g punnet" }],
  },
  {
    id: "lemon",
    name: "Lemons",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 100,
    packs: [{ size: 4, label: "4-pack" }],
  },
  {
    id: "ginger",
    name: "Fresh ginger",
    aisle: "produce",
    base: "mass",
    packs: [{ size: 100, label: "~100 g piece" }],
  },
  {
    id: "coriander",
    name: "Fresh coriander",
    aisle: "produce",
    base: "mass",
    packs: [{ size: 30, label: "30 g pack" }],
  },
  {
    id: "spring-onion",
    name: "Spring onions",
    aisle: "produce",
    base: "count",
    gramsPerUnit: 15,
    aliases: ["scallion", "salad onion"],
    packs: [{ size: 8, label: "1 bunch" }],
  },

  /* ---------- dairy & eggs ---------- */
  {
    id: "egg",
    name: "Free-range eggs",
    aisle: "dairy-eggs",
    base: "count",
    gramsPerUnit: 58,
    tags: ["egg"],
    packs: [
      { size: 6, label: "box of 6" },
      { size: 12, label: "box of 12" },
    ],
  },
  {
    id: "milk",
    name: "Semi-skimmed milk",
    aisle: "dairy-eggs",
    base: "volume",
    gramsPerMl: 1.03,
    tags: ["dairy"],
    packs: [
      { size: 1136, label: "2 pint" },
      { size: 2272, label: "4 pint" },
    ],
  },
  {
    id: "butter",
    name: "Salted butter",
    aisle: "dairy-eggs",
    base: "mass",
    gramsPerMl: 0.91,
    tags: ["dairy"],
    packs: [{ size: 250, label: "250 g block" }],
  },
  {
    id: "cheddar",
    name: "Mature cheddar",
    aisle: "dairy-eggs",
    base: "mass",
    tags: ["dairy"],
    packs: [{ size: 350, label: "350 g block" }],
  },
  {
    id: "yoghurt-greek",
    name: "Greek yoghurt",
    aisle: "dairy-eggs",
    base: "mass",
    tags: ["dairy"],
    packs: [{ size: 500, label: "500 g pot" }],
  },
  {
    id: "creme-fraiche",
    name: "Crème fraîche",
    aisle: "dairy-eggs",
    base: "mass",
    tags: ["dairy"],
    packs: [{ size: 300, label: "300 g pot" }],
  },
  {
    id: "parmesan",
    name: "Parmesan",
    aisle: "dairy-eggs",
    base: "mass",
    tags: ["dairy"],
    packs: [{ size: 150, label: "150 g" }],
  },

  /* ---------- bakery ---------- */
  {
    id: "bread-wholemeal",
    name: "Wholemeal loaf",
    aisle: "bakery",
    base: "count",
    gramsPerUnit: 44,
    tags: ["gluten"],
    packs: [{ size: 18, label: "800 g loaf (~18 slices)" }],
  },
  {
    id: "tortilla-wrap",
    name: "Tortilla wraps",
    aisle: "bakery",
    base: "count",
    gramsPerUnit: 62,
    tags: ["gluten"],
    packs: [{ size: 8, label: "8-pack" }],
  },

  /* ---------- ambient ---------- */
  {
    id: "pasta-penne",
    name: "Penne pasta",
    aisle: "ambient",
    base: "mass",
    tags: ["gluten"],
    packs: [
      { size: 500, label: "500 g" },
      { size: 1000, label: "1 kg" },
    ],
  },
  {
    id: "rice-basmati",
    name: "Basmati rice",
    aisle: "ambient",
    base: "mass",
    gramsPerMl: 0.85,
    packs: [{ size: 1000, label: "1 kg" }],
  },
  {
    id: "noodles-egg",
    name: "Egg noodles",
    aisle: "ambient",
    base: "mass",
    tags: ["gluten", "egg"],
    packs: [{ size: 250, label: "250 g" }],
  },
  {
    id: "tomato-tinned",
    name: "Chopped tomatoes",
    aisle: "ambient",
    base: "count",
    gramsPerUnit: 400,
    packs: [
      { size: 1, label: "400 g tin" },
      { size: 4, label: "4-tin multipack" },
    ],
  },
  {
    id: "chickpeas-tinned",
    name: "Chickpeas",
    aisle: "ambient",
    base: "count",
    gramsPerUnit: 400,
    packs: [{ size: 1, label: "400 g tin" }],
  },
  {
    id: "coconut-milk",
    name: "Coconut milk",
    aisle: "ambient",
    base: "count",
    gramsPerUnit: 400,
    packs: [{ size: 1, label: "400 ml tin" }],
  },
  {
    id: "stock-chicken",
    name: "Chicken stock cubes",
    aisle: "ambient",
    base: "count",
    gramsPerUnit: 10,
    packs: [{ size: 8, label: "8 cubes" }],
  },
  {
    id: "curry-paste-korma",
    name: "Korma curry paste",
    aisle: "ambient",
    base: "mass",
    packs: [{ size: 180, label: "180 g jar" }],
  },
  {
    id: "soy-sauce",
    name: "Soy sauce",
    aisle: "ambient",
    base: "volume",
    gramsPerMl: 1.15,
    tags: ["soy", "gluten"],
    staple: true,
    packs: [{ size: 150, label: "150 ml" }],
  },
  {
    id: "olive-oil",
    name: "Olive oil",
    aisle: "ambient",
    base: "volume",
    gramsPerMl: 0.92,
    staple: true,
    packs: [{ size: 500, label: "500 ml" }],
  },
  // Spices are bought by weight and cooked by the spoonful, so every one of
  // them needs a density or "2 tsp smoked paprika" cannot be costed at all.
  {
    id: "salt",
    name: "Salt",
    aisle: "ambient",
    base: "mass",
    gramsPerMl: 1.2,
    staple: true,
    packs: [{ size: 750, label: "750 g" }],
  },
  {
    id: "black-pepper",
    name: "Black pepper",
    aisle: "ambient",
    base: "mass",
    gramsPerMl: 0.45,
    staple: true,
    packs: [{ size: 50, label: "50 g" }],
  },
  {
    id: "cumin-ground",
    name: "Ground cumin",
    aisle: "ambient",
    base: "mass",
    gramsPerMl: 0.45,
    staple: true,
    packs: [{ size: 40, label: "40 g" }],
  },
  {
    id: "paprika-smoked",
    name: "Smoked paprika",
    aisle: "ambient",
    base: "mass",
    gramsPerMl: 0.46,
    staple: true,
    packs: [{ size: 45, label: "45 g" }],
  },
  {
    id: "flour-plain",
    name: "Plain flour",
    aisle: "ambient",
    base: "mass",
    gramsPerMl: 0.53,
    tags: ["gluten"],
    staple: true,
    packs: [{ size: 1500, label: "1.5 kg" }],
  },
  {
    id: "honey",
    name: "Honey",
    aisle: "ambient",
    base: "mass",
    gramsPerMl: 1.42,
    staple: true,
    packs: [{ size: 340, label: "340 g" }],
  },
  {
    id: "peanut-butter",
    name: "Peanut butter",
    aisle: "ambient",
    base: "mass",
    tags: ["nuts", "peanut"],
    packs: [{ size: 340, label: "340 g" }],
  },
  {
    id: "oats",
    name: "Porridge oats",
    aisle: "ambient",
    base: "mass",
    tags: ["gluten"],
    packs: [{ size: 1000, label: "1 kg" }],
  },

  /* ---------- frozen ---------- */
  {
    id: "peas-frozen",
    name: "Frozen peas",
    aisle: "frozen",
    base: "mass",
    packs: [{ size: 900, label: "900 g bag" }],
  },
];

const BY_ID = new Map(CATALOGUE.map((i) => [i.id, i]));

export function getIngredient(id: string): CanonicalIngredient | undefined {
  return BY_ID.get(id);
}

export function requireIngredient(id: string): CanonicalIngredient {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown ingredient id: "${id}"`);
  return found;
}

export function allIngredientIds(): readonly string[] {
  return CATALOGUE.map((i) => i.id);
}

/** Compact catalogue view for the model prompt — keeps the token cost down. */
export function catalogueForPrompt(): string {
  return CATALOGUE.map((i) => {
    const tags = i.tags?.length ? ` [${i.tags.join(",")}]` : "";
    const staple = i.staple ? " (staple)" : "";
    return `${i.id} — ${i.name}, sold by ${i.base}${tags}${staple}`;
  }).join("\n");
}
