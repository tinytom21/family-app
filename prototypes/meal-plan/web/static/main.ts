/**
 * The hosted-demo host.
 *
 * GitHub Pages serves files and nothing else — there is no process to run a
 * Node server in. So this bundles the same `createApp` the local server uses
 * and calls `handle(path, body)` directly, in the page. The rendering client
 * never learns the difference: it asks `window.__familyApi` for state and gets
 * the same object either way.
 *
 * Two honest consequences of having no server:
 *
 *   1. No model. Calling Claude or Gemini needs an API key, and a key shipped
 *      to a browser is a key given away — anyone can read it out of the
 *      bundle and spend it. So the AI hooks are absent, the two AI buttons
 *      disable themselves, and this file imports no SDK at all. That is a
 *      property of the build, not a promise in a comment.
 *
 *   2. No database. State lives in localStorage, which means the demo is
 *      per-browser and survives a refresh but not a different device. Good
 *      enough to try; nowhere near the shared, offline-tolerant sync the real
 *      thing needs, which is still Phase 1's problem.
 */

import { createApp } from "../../src/app-state.ts";
import type { Snapshot } from "../../src/app-state.ts";

const STORAGE_KEY = "family-app.demo-state.v1";

function loadSnapshot(): Partial<Snapshot> | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Snapshot>) : undefined;
  } catch {
    // A corrupt or unreadable store should cost the demo its history, not its
    // ability to start.
    return undefined;
  }
}

const app = createApp({ seed: loadSnapshot() });

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(app.snapshot()));
  } catch {
    // Private browsing, or a full quota. The app keeps working in memory.
  }
}

declare global {
  interface Window {
    __familyApi?: {
      get(): Promise<unknown>;
      post(path: string, body?: unknown): Promise<unknown>;
      reset(): Promise<unknown>;
    };
  }
}

window.__familyApi = {
  async get() {
    const result = await app.handle("/api/state");
    return result.body;
  },

  async post(path, body) {
    const result = await app.handle(path, body ?? {});
    if (result.status >= 400) {
      throw new Error((result.body as { error?: string }).error ?? `HTTP ${result.status}`);
    }
    save();
    return result.body;
  },

  /** Start again from the fixtures — the demo's way out of a mess. */
  async reset() {
    app.reset();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
    const result = await app.handle("/api/state");
    return result.body;
  },
};
