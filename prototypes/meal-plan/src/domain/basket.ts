/**
 * Turning a shopping list into a supermarket basket.
 *
 * No supermarket will hand a third party an API for this, so whatever fills a
 * basket is unofficial and can break. That is worth accepting for a household
 * automating its own account, and it is emphatically not the hard part.
 *
 * The hard part is matching. The list says "240 g of baby spinach"; Tesco has
 * fourteen spinaches in four sizes, and picking the wrong one is not a crash —
 * it is a delivery containing the wrong thing, noticed on Thursday. So only a
 * 100% match — every word of the name, the exact size, and actually for sale —
 * is ever put in without a person looking. Everything else is scored, sorted
 * and handed to a person once per ingredient. Choices are remembered, so the
 * second week costs nothing and the tenth is instant.
 *
 * Deliberately knows nothing about how the basket is filled — see
 * `BasketProvider`. Whether that is a browser session or a reverse-engineered
 * HTTP call is a swappable detail; this is the part worth being careful in.
 */

import type { CanonicalIngredient, ShoppingLine } from "./types.ts";

/**
 * What the shelf label said when the product was searched for.
 *
 * Shown to help choose between two products, and never added up. Prices move
 * every week, so a stored one is only ever shown with the date it was seen.
 */
export interface ShelfPrice {
  /** Pounds for one pack. */
  readonly each: number;
  /** Pounds per `unit`, as the retailer states it. Never worked out here. */
  readonly perUnit?: number;
  /** What `perUnit` is per, in the retailer's words: "kg", "litre", "each". */
  readonly unit?: string;
}

/** One product as a retailer describes it. */
export interface RetailerProduct {
  readonly sku: string;
  readonly title: string;
  /** Size in the retailer's own words, when it is separate from the title. */
  readonly size?: string;
  readonly price?: ShelfPrice;
  /** A promotion in the retailer's words, such as "£3.50 Clubcard Price". */
  readonly offer?: string;
  /** The product's own page, for reading the label before trusting a match. */
  readonly url?: string;
  /** False when the retailer says it cannot be bought. Unknown is not false. */
  readonly available?: boolean;
}

/** A confirmed ingredient-and-pack to product mapping. */
export interface ProductLink {
  readonly ingredientId: string;
  /** A 400 g tin is a different product from a 2 kg one, so the size is part of the key. */
  readonly packSize: number;
  readonly sku: string;
  readonly title: string;
  readonly confirmedOn: string;
  readonly url?: string;
  /** The price on `confirmedOn` — not today's. */
  readonly price?: ShelfPrice;
  /** Put in by "Find all" as a 100% match, rather than chosen by a person. */
  readonly auto?: boolean;
}

export interface ParsedSize {
  /** Normalised to grams, millilitres, or a count. */
  readonly amount: number;
  readonly base: "mass" | "volume" | "count";
  /** Multipacks: "4 x 400g" is 1600 g in four units. */
  readonly units: number;
}

const MASS: Record<string, number> = { g: 1, kg: 1000, mg: 0.001 };
const VOLUME: Record<string, number> = { ml: 1, l: 1000, cl: 10 };

/**
 * Pull a size out of a product title.
 *
 * Retailers write these a dozen ways — "240G", "2.27L", "4 x 400g", "6 Pack" —
 * and the size is the single most useful signal for telling near-identical
 * products apart, so it is worth parsing properly rather than matching on words
 * alone.
 */
export function parseSize(title: string): ParsedSize | null {
  const text = title.toLowerCase().replace(/,/g, "");

  // Multipacks first: the "4 x 400g" form would otherwise read as 400 g.
  const multi = text.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|mg|g|ml|cl|l)\b/);
  if (multi) {
    const units = Number(multi[1]);
    const each = Number(multi[2]);
    const unit = multi[3];
    const factor = MASS[unit] ?? VOLUME[unit];
    return {
      amount: units * each * factor,
      base: unit in MASS ? "mass" : "volume",
      units,
    };
  }

  const single = text.match(/(\d+(?:\.\d+)?)\s*(kg|mg|g|ml|cl|l)\b/);
  if (single) {
    const unit = single[2];
    const factor = MASS[unit] ?? VOLUME[unit];
    return {
      amount: Number(single[1]) * factor,
      base: unit in MASS ? "mass" : "volume",
      units: 1,
    };
  }

  const pack = text.match(/(\d+)\s*(?:pack|pk)\b/);
  if (pack) {
    return { amount: Number(pack[1]), base: "count", units: Number(pack[1]) };
  }

  return null;
}

/* ------------------------------------------------------------------ */

export interface Scored {
  readonly product: RetailerProduct;
  /** 0 to 1, for ordering. Not a licence to pre-select — see `preselect`. */
  readonly score: number;
  /**
   * Safe to tick on the family's behalf: the whole catalogue name matched and
   * the size did not disagree. Deliberately stricter than any score threshold.
   */
  readonly preselect: boolean;
  /**
   * A 100% match that can be bought: every word, the exact size, and not marked
   * unavailable. The only kind of match put in without anybody looking.
   */
  readonly perfect: boolean;
  /** Why it scored that way, so a person can disagree with a reason. */
  readonly why: string;
}

/**
 * A score this high is a plausible match, worth showing near the top. It says
 * nothing about whether to tick it on anybody's behalf — that is `preselect`.
 */
export const CONFIDENT = 0.62;

const STOPWORDS = new Set([
  "tesco",
  "sainsburys",
  "finest",
  "the",
  "of",
  "and",
  "with",
  "fresh",
  "british",
  "organic",
  "value",
  "essential",
  "by",
  "in",
]);

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      // The percent sign survives tokenising on purpose. Stripping it turns
      // "5% fat" and "20% fat" into the same three words, and the whole
      // difference between those two products is that number.
      .replace(/[^a-z0-9%\s]/g, " ")
      .split(/\s+/)
      // Bare numbers are sizes and go; "5%" is a specification and stays.
      .filter((w) => w && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
}

/**
 * How well does this product match what the list asked for?
 *
 * Two signals, weighted towards the name. Size agreement is a strong secondary
 * — a 400 g tin and a 2.5 kg catering tin are not the same purchase — but a
 * product whose name does not match is wrong at any size.
 */
export function scoreMatch(
  ingredient: CanonicalIngredient,
  packSize: number,
  product: RetailerProduct,
): Scored {
  // Scored against the *full* catalogue name, not the search term.
  //
  // `searchTermFor` deliberately drops the qualifier after the comma, because
  // "Beef mince, 5% fat" as a query finds nothing. But that qualifier is
  // exactly what separates the 5% mince from the 20% mince, and scoring
  // without it rated them identically — which would have ordered whichever
  // Tesco listed first, every week, silently.
  const wanted = new Set(words(ingredient.name));
  const got = new Set(words(`${product.title} ${product.size ?? ""}`));

  let hits = 0;
  for (const word of wanted) if (got.has(word)) hits++;
  const nameScore = wanted.size ? hits / wanted.size : 0;
  const wholeName = wanted.size > 0 && hits === wanted.size;

  const size = parseSize(product.size ?? product.title);
  let sizeScore = 0.5; // unknown is neither good nor damning
  let sizeWhy = "size not stated";
  if (size) {
    const ratio = size.amount / packSize;
    if (ratio > 0.98 && ratio < 1.02) {
      sizeScore = 1;
      sizeWhy = "size matches";
    } else if (ratio > 0.8 && ratio < 1.25) {
      sizeScore = 0.75;
      sizeWhy = `close size (${size.amount} vs ${packSize})`;
    } else {
      sizeScore = 0.15;
      sizeWhy = `different size (${size.amount} vs ${packSize})`;
    }
  }

  // The score stays a measure of the match. Whether it can be bought is a
  // separate fact, and folding it in would rank the right product below a
  // wrong one on the day it happens to be out of stock.
  const buyable = product.available !== false;

  return {
    product,
    score: Number((nameScore * 0.7 + sizeScore * 0.3).toFixed(3)),
    // Ticking something on the family's behalf is a stricter test than a high
    // score: every word of the catalogue name must be there, and the size must
    // not disagree. The 20% mince scores 0.83 next to the 5% mince, and the
    // same mince in the wrong size scores 0.75 — both comfortably over any
    // sensible threshold, and both would arrive in a delivery as the wrong
    // thing for somebody who clicked through without reading the label.
    preselect: buyable && wholeName && sizeScore > 0.15,
    // Stricter again, because nobody reads it at all: a close size or an
    // unstated one is worth a tick for a person to confirm, not a purchase.
    perfect: buyable && wholeName && sizeScore === 1,
    why: `${hits}/${wanted.size} words matched, ${sizeWhy}${buyable ? "" : ", not available"}`,
  };
}

export function rankCandidates(
  ingredient: CanonicalIngredient,
  packSize: number,
  products: readonly RetailerProduct[],
): Scored[] {
  // Ties keep the retailer's order, which reflects what people actually buy.
  // Alphabetical order reflected nothing and quietly favoured whichever brand
  // started with A.
  return products
    .map((p) => scoreMatch(ingredient, packSize, p))
    .sort((a, b) => b.score - a.score);
}

/**
 * The product to put in the basket without asking, or null.
 *
 * Only ever the top-ranked candidate, and only when it is `perfect`. When
 * several products match exactly — own brand and Finest, both 500 g — the
 * retailer's own order decides, and the link is marked `auto` so the screen
 * can say it was nobody's choice. When the best match is out of stock, nothing
 * is chosen: the next exact match is a substitution, and remembering a
 * substitution as the family's usual is a decision for a person.
 */
export function autoMatch(ranked: readonly Scored[]): Scored | null {
  return ranked[0]?.perfect ? ranked[0] : null;
}

/* ------------------------------------------------------------------ */

/**
 * Links and prices arrive in household state, which every member of the
 * household can write — so they are checked on the way in, whoever sent them.
 */
export function cleanProductUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    // A `javascript:` link drawn as "View on Tesco" is a script run by whoever
    // clicks it. Retailers serve their pages over https; nothing else is needed.
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function cleanShelfPrice(value: unknown): ShelfPrice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { each, perUnit, unit } = value as Record<string, unknown>;
  const money = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!money(each)) return undefined;
  return {
    each,
    ...(money(perUnit) ? { perUnit } : {}),
    ...(typeof unit === "string" && unit.trim() ? { unit: unit.trim().slice(0, 16) } : {}),
  };
}

/* ------------------------------------------------------------------ */

export interface BasketItem {
  readonly sku: string;
  readonly title: string;
  readonly quantity: number;
  readonly ingredientId: string;
  /** What the list asked for, so a person can check the product against it. */
  readonly name: string;
  /** Which pack this is, so a choice can be changed without guessing which one. */
  readonly packSize: number;
  readonly packLabel: string;
  /** When it was chosen, which is also when its price was seen. */
  readonly chosenOn: string;
  readonly url?: string;
  readonly price?: ShelfPrice;
  readonly auto?: boolean;
}

export interface NeedsChoosing {
  readonly ingredientId: string;
  readonly name: string;
  readonly packSize: number;
  readonly packLabel: string;
  readonly quantity: number;
}

export interface BasketPlan {
  readonly items: readonly BasketItem[];
  /** Lines with no confirmed product yet — these need a person, once. */
  readonly needsChoosing: readonly NeedsChoosing[];
}

const linkKey = (ingredientId: string, packSize: number) =>
  `${ingredientId}|${packSize}`;

/**
 * What to put in the basket, and what still needs a human.
 *
 * The pack solver has already decided how many of which size to buy, so this is
 * only a lookup — which is the point of doing that arithmetic in one place. An
 * ingredient with no confirmed product is reported rather than guessed at,
 * because a wrong guess arrives in a delivery and a missing one does not.
 */
export function planBasket(
  lines: readonly ShoppingLine[],
  links: readonly ProductLink[],
): BasketPlan {
  const byKey = new Map(links.map((l) => [linkKey(l.ingredientId, l.packSize), l]));
  const items: BasketItem[] = [];
  const needsChoosing: NeedsChoosing[] = [];

  for (const line of lines) {
    for (const { pack, count } of line.packs) {
      const link = byKey.get(linkKey(line.ingredientId, pack.size));
      if (link) {
        items.push({
          sku: link.sku,
          title: link.title,
          quantity: count,
          ingredientId: line.ingredientId,
          name: line.name,
          packSize: pack.size,
          packLabel: pack.label,
          chosenOn: link.confirmedOn,
          ...(link.url ? { url: link.url } : {}),
          ...(link.price ? { price: link.price } : {}),
          ...(link.auto ? { auto: true } : {}),
        });
      } else {
        needsChoosing.push({
          ingredientId: line.ingredientId,
          name: line.name,
          packSize: pack.size,
          packLabel: pack.label,
          quantity: count,
        });
      }
    }
  }

  return { items, needsChoosing };
}

/* ------------------------------------------------------------------ */

/**
 * Whatever actually talks to the supermarket.
 *
 * Kept to four methods so the unofficial, breakable part of this is as small as
 * it can be, and so replacing it when a retailer changes something is an
 * afternoon rather than a rewrite. Note the absence of anything that spends
 * money: `checkoutUrl` hands back a link for a person to finish.
 */
export interface BasketProvider {
  readonly id: string;
  search(term: string, limit?: number): Promise<RetailerProduct[]>;
  /**
   * Set a line to this quantity, rather than adding to it.
   *
   * Idempotent on purpose: filling the basket twice should leave one week's
   * shopping, not two, and "nothing seemed to happen so I clicked again" is a
   * thing people do.
   */
  set(sku: string, quantity: number): Promise<void>;
  basket(): Promise<{ sku: string; title: string; quantity: number }[]>;
  /** Returns where to go and pay. Never pays. */
  checkoutUrl(): Promise<string>;
}
