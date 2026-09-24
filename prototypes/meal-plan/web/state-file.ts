/**
 * Where the local server keeps the family between restarts.
 *
 * The published build has localStorage and, once you sign in, an account. The
 * local server had neither: every restart asked the family to type itself in
 * again, which is a good way to make sure nobody ever sets it up properly.
 *
 * What is written is the same snapshot the account sync uploads — one shape in
 * all three places, so a household can move between them without translation.
 *
 * Written whole and renamed into place. A half-written file read at the next
 * start is the one failure that loses everything rather than the last change.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The saved household, or undefined for a first run.
 *
 * Deliberately total: a missing, empty or unreadable file means "start fresh",
 * never a crash on boot. An app that will not start because its save file is
 * odd is worse than an app that starts empty and says so.
 */
export function readState(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // no file yet, which is what a first run looks like
  }

  try {
    const parsed = JSON.parse(raw);
    // A snapshot with no people is not a household. Half-restoring one and
    // calling it the family is worse than starting again.
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.people)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* falls through to the rescue below */
  }

  // Keep whatever could not be read rather than letting the next save write
  // over it: it is somebody's only copy, and it might be recoverable by hand.
  try {
    renameSync(path, `${path}.unreadable`);
  } catch {
    /* if it cannot even be moved, there is nothing more to try */
  }
  return undefined;
}

export function writeState(path: string, snapshot: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.writing`;
  writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}
