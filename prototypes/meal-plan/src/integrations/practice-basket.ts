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
 * wrong-size version of itself, and anything with a specification ("5% fat")
 * also comes back with a different one. A practice mode where the first result
 * is always right would teach nothing about whether the matching holds up.
 *
 * Nothing here touches the network.
 */

import { allIngredientIds, requireIngredient } from "../domain/catalogue.ts";
import type { BasketProvider, RetailerProduct } from "../domain/basket.ts";
import type { CanonicalIngredient } from "../domain/types.ts";

function sizeLabel(base: CanonicalIngredient["base"], size: number): string {
  if (base === "mass") return size >= 1000 ? `${size / 1000}kg` : `${size}g`;
  if (base === "volume") return size >= 1000 ? `${size / 1000}L` : `${size}ml`;
  return `${size} Pack`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The awkward near-neighbours a real search returns alongside the right thing. */
function inventProducts(ingredient: CanonicalIngredient): RetailerProduct[] {
  const [rawHead, ...rest] = ingredient.name.split(",");
  const head = capitalise(rawHead.trim());
  const qualifier = rest.join(",").trim();
  const out: RetailerProduct[] = [];

  for (const pack of ingredient.packs) {
    const size = sizeLabel(ingredient.base, pack.size);
    const spec = qualifier ? ` ${qualifier}` : "";

    out.push({
      sku: `practice-${ingredient.id}-${pack.size}`,
      title: `Tesco ${head}${spec} ${size}`,
    });

    // The same thing, bigger. Scores well on the name and should lose on size.
    out.push({
      sku: `practice-${ingredient.id}-${pack.size}-big`,
      title: `Tesco ${head}${spec} ${sizeLabel(ingredient.base, pack.size * 2)}`,
    });

    if (/\d+%/.test(qualifier)) {
      // The 20% mince next to the 5% mince: right size, wrong specification.
      const other = qualifier.replace(/(\d+)%/, (_, n) => `${Number(n) === 20 ? 5 : 20}%`);
      out.push({
        sku: `practice-${ingredient.id}-${pack.size}-spec`,
        title: `Tesco ${head} ${other} ${size}`,
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

    return this.#products
      .map((product) => {
        const title = product.title.toLowerCase();
        const hits = wanted.filter((w) => title.includes(w)).length;
        return { product, hits };
      })
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.product.title.localeCompare(b.product.title))
      .slice(0, limit)
      .map((r) => r.product);
  }

  async set(sku: string, quantity: number): Promise<void> {
    await this.#pause();
    if (!this.#titles.has(sku)) throw new Error(`No such product: ${sku}`);
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
