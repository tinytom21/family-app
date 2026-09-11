/**
 * A pretend Tesco, for trying the basket flow without a real account.
 *
 * Two jobs. It lets a person see the whole screen — search, choose, fill,
 * checkout — before deciding whether to hand a browser session to basketeer at
 * all. And it lets the screen itself be built and changed without every click
 * landing in somebody's real Tesco trolley.
 *
 * The products are invented from the catalogue, but invented to be awkward in
 * the ways real search results are: every ingredient comes back alongside a
 * wrong-size version of itself, anything with a specification ("5% fat") also
 * comes back with a different one, some come back in a pricier range at the
 * same size, and some are out of stock. A practice mode where the first result
 * is always right would teach nothing about whether the matching holds up.
 *
 * The prices are invented too, and consistent from run to run: bigger packs are
 * cheaper by the kilo and Finest costs more, as on a real shelf.
 *
 * Nothing here touches the network.
 */

import { allIngredientIds, requireIngredient } from "../domain/catalogue.ts";
import type { BasketProvider, RetailerProduct, ShelfPrice } from "../domain/basket.ts";
import type { CanonicalIngredient } from "../domain/types.ts";

function sizeLabel(base: CanonicalIngredient["base"], size: number): string {
  if (base === "mass") return size >= 1000 ? `${size / 1000}kg` : `${size}g`;
  if (base === "volume") return size >= 1000 ? `${size / 1000}L` : `${size}ml`;
  return `${size} Pack`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A stable number from a string, so every run invents the same shop. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pence = (pounds: number) => Math.round(pounds * 100) / 100;

function inventPrice(
  ingredient: CanonicalIngredient,
  packSize: number,
  factor: number,
): ShelfPrice {
  const h = hash(ingredient.id);
  if (ingredient.base === "count") {
    const each = Math.max(0.3, Math.round(((15 + (h % 45)) / 100) * factor * packSize * 20) / 20);
    return { each, perUnit: pence(each / packSize), unit: "each" };
  }
  const perKilo =
    ingredient.base === "mass" ? 1.5 + (h % 1250) / 100 : 0.9 + (h % 510) / 100;
  const each = Math.max(0.3, Math.round(perKilo * factor * (packSize / 1000) * 20) / 20);
  return {
    each,
    perUnit: pence(each / (packSize / 1000)),
    unit: ingredient.base === "mass" ? "kg" : "litre",
  };
}

/** The awkward near-neighbours a real search returns alongside the right thing. */
function inventProducts(ingredient: CanonicalIngredient): RetailerProduct[] {
  const [rawHead, ...rest] = ingredient.name.split(",");
  const head = capitalise(rawHead.trim());
  const qualifier = rest.join(",").trim();
  const h = hash(ingredient.id);
  // Not a real product page — there isn't one — but a real Tesco search for the
  // same thing, so the link on the screen goes somewhere sensible.
  const url = `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(rawHead.trim().toLowerCase())}`;
  const out: RetailerProduct[] = [];

  for (const pack of ingredient.packs) {
    const size = sizeLabel(ingredient.base, pack.size);
    const spec = qualifier ? ` ${qualifier}` : "";

    out.push({
      sku: `practice-${ingredient.id}-${pack.size}`,
      title: `Tesco ${head}${spec} ${size}`,
      price: inventPrice(ingredient, pack.size, 1),
      url,
      // Roughly one in seven is out of stock, so "Find all" meets a line where
      // the best match cannot be bought and has to leave it for a person.
      ...(h % 7 === 3 ? { available: false } : {}),
    });

    // The same thing, bigger. Scores well on the name and should lose on size.
    out.push({
      sku: `practice-${ingredient.id}-${pack.size}-big`,
      title: `Tesco ${head}${spec} ${sizeLabel(ingredient.base, pack.size * 2)}`,
      price: inventPrice(ingredient, pack.size * 2, 0.85),
      url,
    });

    if (/\d+%/.test(qualifier)) {
      // The 20% mince next to the 5% mince: right size, wrong specification.
      const other = qualifier.replace(/(\d+)%/, (_, n) => `${Number(n) === 20 ? 5 : 20}%`);
      out.push({
        sku: `practice-${ingredient.id}-${pack.size}-spec`,
        title: `Tesco ${head} ${other} ${size}`,
        price: inventPrice(ingredient, pack.size, 0.8),
        url,
      });
    }

    if (h % 3 === 0) {
      // A second 100% match at a higher price. "Finest" is not a word that
      // counts against a match, so this is exactly as right as the own brand
      // and listed after it, as Tesco tends to.
      out.push({
        sku: `practice-${ingredient.id}-${pack.size}-finest`,
        title: `Tesco Finest ${head}${spec} ${size}`,
        price: inventPrice(ingredient, pack.size, 1.6),
        url,
        ...(h % 2
          ? { offer: `£${inventPrice(ingredient, pack.size, 1.3).each.toFixed(2)} Clubcard Price` }
          : {}),
      });
    }
  }

  const unique = new Map(out.map((p) => [p.title, p]));
  return [...unique.values()];
}

export class PracticeBasket implements BasketProvider {
  readonly id = "practice";
  readonly #products: RetailerProduct[];
  readonly #titles = new Map<string, string>();
  readonly #basket = new Map<string, number>();
  readonly #delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.#products = allIngredientIds().flatMap((id) =>
      inventProducts(requireIngredient(id)),
    );
    for (const p of this.#products) this.#titles.set(p.sku, p.title);
    // A little latency, so the screen's loading states are exercised rather
    // than skipped past.
    this.#delayMs = options.delayMs ?? 300;
  }

  async #pause(): Promise<void> {
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
  }

  async search(term: string, limit = 12): Promise<RetailerProduct[]> {
    await this.#pause();
    const wanted = term
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    // Ordered by how many words hit, and otherwise left in the order invented
    // — own brand first — the way a retailer's relevance ranking tends to be.
    return this.#products
      .map((product) => {
        const title = product.title.toLowerCase();
        const hits = wanted.filter((w) => title.includes(w)).length;
        return { product, hits };
      })
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)
      .map((r) => r.product);
  }

  async set(sku: string, quantity: number): Promise<void> {
    await this.#pause();
    if (!this.#titles.has(sku)) throw new Error(`No such product: ${sku}`);
    const product = this.#products.find((p) => p.sku === sku);
    if (product?.available === false) {
      throw new Error("Out of stock in the practice shop");
    }
    if (quantity <= 0) this.#basket.delete(sku);
    else this.#basket.set(sku, quantity);
  }

  async basket(): Promise<{ sku: string; title: string; quantity: number }[]> {
    return [...this.#basket].map(([sku, quantity]) => ({
      sku,
      title: this.#titles.get(sku) ?? sku,
      quantity,
    }));
  }

  async checkoutUrl(): Promise<string> {
    return "https://www.tesco.com/groceries/en-GB/trolley";
  }

  async isSignedIn(): Promise<boolean> {
    return true;
  }
}
