/**
 * Filling a real Tesco basket, via basketeer.
 *
 * The one genuinely unofficial thing in this project, and deliberately the
 * smallest file that could do the job. Tesco publishes no API for this;
 * basketeer is reverse-engineered, pre-release, and will break when Tesco
 * changes something. Keeping the surface to five methods means that break is an
 * afternoon rather than a rewrite, and means the matching logic — which is the
 * part that decides what actually turns up in the delivery — never depends on
 * any of it.
 *
 * Three deliberate limits:
 *
 *   1. **This never spends money.** `checkoutUrl` asks basketeer for the
 *      checkout link and returns it. A person goes there, sees the total, and
 *      pays. There is no code path here that completes an order, and there
 *      should not be one — an automated system that can spend is a different
 *      risk category from one that can only fill a basket.
 *
 *   2. **Quantities are set, not added.** basketeer's `basket.set` replaces the
 *      line rather than incrementing it, so filling the basket twice leaves one
 *      week's shopping rather than two. Given this runs from a button somebody
 *      might press again when nothing appears to happen, that matters.
 *
 *   3. **Server only.** The session it holds can act on a real grocery account,
 *      so it is injected into the app the way the model keys are, and the
 *      browser build simply has no basket provider. That is enforced by the
 *      build — the published bundle never imports this file — rather than by a
 *      flag somebody can flip.
 *
 * The session lives at ~/.basketeer/session.json, in plain text, because that
 * is where basketeer puts it. It is a live Tesco session: worth knowing before
 * running this on a shared machine.
 */

import type { BasketProvider, RetailerProduct } from "../domain/basket.ts";

export interface TescoOptions {
  /** Where to keep the session between runs. */
  readonly storePath?: string;
  /** Chrome profile that keeps you signed in, and lets the session be renewed. */
  readonly profileDir?: string;
  /** Slow requests down; Tesco is somebody else's service. */
  readonly throttleMs?: number;
}

export class TescoBasket implements BasketProvider {
  readonly id = "tesco";
  #client: any = null;
  #options: TescoOptions;

  constructor(options: TescoOptions = {}) {
    this.#options = options;
  }

  /**
   * Loaded lazily so that a household not using this pays nothing for it, and
   * so a missing optional dependency is a clear message rather than a crash on
   * startup.
   */
  async #ensureClient(authBackend?: unknown): Promise<any> {
    if (this.#client && !authBackend) return this.#client;

    let mod: any;
    try {
      mod = await import("basketeer");
    } catch {
      throw new Error(
        "basketeer is not installed. Run: npm install basketeer",
      );
    }

    const { Basketeer, FileTokenStore } = mod;
    this.#client = new Basketeer({
      store: new FileTokenStore(this.#options.storePath),
      ...(authBackend ? { authBackend } : {}),
      // Deliberately unhurried. This is a weekly shop, not a benchmark, and
      // hammering a retailer is both rude and the fastest way to get blocked.
      throttleMs: this.#options.throttleMs ?? 400,
    });
    return this.#client;
  }

  /** Is there a usable session already, or does somebody need to sign in? */
  async isSignedIn(): Promise<boolean> {
    try {
      const client = await this.#ensureClient();
      return Boolean(client.isAuthenticated);
    } catch {
      return false;
    }
  }

  /**
   * Sign in, once, through a real browser.
   *
   * Tesco's login sits behind bot defences, so basketeer drives a visible
   * Chromium for this and nothing else; every request after it is plain HTTP.
   * No password passes through this app — the person types it into Tesco's own
   * page, which is the only arrangement worth having.
   */
  async signIn(): Promise<void> {
    let backend: any;
    try {
      const { BrowserAuthBackend } = await import(
        "basketeer/auth/browser/playwright"
      );
      backend = new BrowserAuthBackend({
        // A persistent profile is what keeps you signed in between weeks, and
        // it is also what lets the session be renewed later: Tesco's bot
        // defences reject a headless refresh, so the profile's accumulated
        // state is the thing doing the convincing.
        profileDir: this.#options.profileDir,
        channel: "chrome",
      });
    } catch {
      throw new Error(
        "Signing in needs Playwright and Chrome. Run: npx playwright install chromium",
      );
    }
    const client = await this.#ensureClient(backend);
    await client.login();
  }

  async search(term: string, limit = 12): Promise<RetailerProduct[]> {
    const client = await this.#ensureClient();
    const page = await client.search(term, { limit });
    return (page.results ?? []).map((r: any) => ({
      sku: r.sku,
      title: r.title,
      // Tesco states the size in the title; where a structured pack size is
      // available it is better, so pass both and let the scorer prefer it.
      ...(r.packSize ? { size: `${r.packSize.value}${r.packSize.units}` } : {}),
    }));
  }

  /** Set the line to this quantity. Idempotent — see the note at the top. */
  async set(sku: string, quantity: number): Promise<void> {
    const client = await this.#ensureClient();
    await client.basket.set(sku, quantity);
  }

  async basket(): Promise<{ sku: string; title: string; quantity: number }[]> {
    const client = await this.#ensureClient();
    const basket = await client.basket.get();
    return (basket?.lines ?? []).map((line: any) => ({
      sku: line.sku ?? line.id,
      title: line.title ?? "",
      quantity: line.quantity ?? 0,
    }));
  }

  /**
   * Where to go and pay.
   *
   * Returns a URL and nothing else happens. Whoever is shopping sees the real
   * total, the real substitutions and the real slot before any money moves.
   */
  async checkoutUrl(): Promise<string> {
    const client = await this.#ensureClient();
    const { url } = await client.checkout();
    return url;
  }
}
