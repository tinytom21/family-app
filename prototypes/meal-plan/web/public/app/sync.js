/**
 * Keeping a household in step with the account it belongs to.
 *
 * Signing in used to be a single upload: the copy in the account was written
 * once and never again, so a phone showed whatever the laptop had on the day
 * somebody pressed the button. This makes it continuous and, deliberately,
 * almost invisible — one word in the top bar saying whether the last change is
 * safe, and nothing else to think about.
 *
 * Three rules, chosen because two adults editing the same week is the normal
 * case rather than an edge case:
 *
 *   1. **On opening, the account wins.** Whatever was saved last, from any
 *      device, is what this one shows. A device that has been shut in a drawer
 *      for a week does not get to undo the week.
 *
 *   2. **Every change is pushed, with the revision it was based on.** The
 *      database refuses a save built on a stale revision, so two people
 *      editing at once is detected rather than quietly resolved in favour of
 *      whoever happened to be last.
 *
 *   3. **A refused save is never thrown away.** It is kept in this browser and
 *      offered back from the Account panel, because the alternative is
 *      somebody's Sunday evening vanishing without a word.
 */

import * as account from "./account.js";

/** What this browser last saw or wrote: { householdId, revision }. */
const SEEN = "family-app.sync.v1";
/** A change that lost a race, kept until it is put back or deliberately dropped. */
const RESCUE = "family-app.rescue.v1";

/** Long enough to collect a flurry of ticks, short enough to feel immediate. */
const PUSH_DELAY_MS = 1200;
/** How often an open tab asks whether somebody else has saved. */
const POLL_MS = 120000;

let api = null;
let onState = null;
let onStatus = null;

let user = null;
let householdId = null;
let revision = null;

let pushTimer = null;
let pushing = false;
let pushAgain = false;
/** True while remote state is being applied, so arriving changes never bounce back. */
let applying = false;

/* ---------------- the two small stores ---------------- */

function readSeen() {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? "null");
  } catch {
    return null;
  }
}

function writeSeen() {
  try {
    localStorage.setItem(SEEN, JSON.stringify({ householdId, revision }));
  } catch {
    /* private browsing: sync still works, it just re-checks more often */
  }
}

export function rescued() {
  try {
    return JSON.parse(localStorage.getItem(RESCUE) ?? "null");
  } catch {
    return null;
  }
}

function keepRescue(snapshot) {
  try {
    localStorage.setItem(
      RESCUE,
      JSON.stringify({ savedAt: new Date().toISOString(), householdId, snapshot }),
    );
  } catch {
    /* nothing to be done, and not worth failing the save over */
  }
}

export function dropRescue() {
  try {
    localStorage.removeItem(RESCUE);
  } catch {
    /* already gone */
  }
}

function say(state, detail) {
  onStatus?.(state, detail ?? null);
}

export function attach(options) {
  api = options.api;
  onState = options.onState;
  onStatus = options.onStatus;

  // Another device saving is only interesting while this one is being looked
  // at, so the tab checks when it comes back to the front.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pull().catch(() => {});
  });
  setInterval(() => {
    if (document.visibilityState === "visible") pull().catch(() => {});
  }, POLL_MS);
}

/* ---------------- opening ---------------- */

/**
 * Work out what this browser should be showing, and show it.
 *
 * Returns the state to render when the account had something this device did
 * not, and null when what is already on screen is the truth. Called before the
 * intro screen, because on a new device the family already exists — it has
 * just never been here before, and asking for it again is the whole problem.
 */
export async function open(state) {
  if (!account.isConfigured()) {
    say("off");
    return null;
  }

  user = await account.currentUser();
  if (!user) {
    say("local");
    return null;
  }

  const seen = readSeen();
  householdId = state?.household?.remoteId ?? seen?.householdId ?? null;
  revision = seen?.householdId === householdId ? (seen?.revision ?? null) : null;

  if (!householdId) {
    // Signed in on a device that has never opened one of these: take the
    // household the account already has.
    const households = await account.myHouseholds().catch(() => []);
    householdId = households[0]?.id ?? null;
    revision = null;
  }
  if (!householdId) {
    say("unsaved");
    return null;
  }

  say("syncing");
  const stored = await account.loadState(householdId);
  if (!stored?.state) {
    // The household exists but has never been saved into. Whatever is here is
    // the best copy there is, so send it up.
    writeSeen();
    touch();
    return null;
  }

  if (state?.setUp && revision !== null && stored.revision <= revision) {
    revision = stored.revision;
    writeSeen();
    say("saved");
    return null; // already the newest: nothing to do
  }

  // About to replace what is in this browser. If it was set up here and never
  // reached the account, it is somebody's typing, and it is kept where they
  // can put it back.
  if (state?.setUp && revision === null) {
    keepRescue(await api.post("/api/snapshot", {}));
  }

  return await adopt(stored);
}

/** Take the account's copy, and remember which revision it was. */
async function adopt(stored) {
  applying = true;
  try {
    await api.post("/api/restore", stored.state);
    const next = await api.post("/api/household/link", { remoteId: householdId });
    revision = stored.revision;
    writeSeen();
    say("saved");
    return next;
  } finally {
    applying = false;
  }
}

/** Has anybody else saved since this device last looked? */
async function pull() {
  if (!householdId || !user || pushing || pushTimer) return;
  const stored = await account.loadState(householdId);
  if (!stored?.state || stored.revision === revision) return;
  onState?.(await adopt(stored));
}

/* ---------------- saving ---------------- */

/** Something changed. Push it, once the change has stopped changing. */
export function touch() {
  if (applying || !householdId || !user) return;
  clearTimeout(pushTimer);
  say("saving");
  pushTimer = setTimeout(() => {
    pushTimer = null;
    push();
  }, PUSH_DELAY_MS);
}

async function push() {
  if (pushing) {
    pushAgain = true;
    return;
  }
  pushing = true;
  try {
    const snapshot = await api.post("/api/snapshot", {});
    const result = await account.saveState(householdId, snapshot, revision);

    if (result?.ok) {
      revision = result.revision;
      writeSeen();
      dropRescue();
      say("saved");
      return;
    }

    if (result?.problem === "stale") {
      // Somebody else saved first. Their copy is the one both devices will
      // agree on; this one is kept where it can be put back deliberately.
      keepRescue(snapshot);
      const stored = await account.loadState(householdId);
      if (stored?.state) onState?.(await adopt(stored));
      say("clash");
      return;
    }

    say("error", result?.problem ?? "it would not save");
  } catch (error) {
    say("error", error.message);
  } finally {
    pushing = false;
    if (pushAgain) {
      pushAgain = false;
      touch();
    }
  }
}

/* ---------------- the account panel's handles ---------------- */

/** This browser now belongs to that household — start keeping it in step. */
export async function linkTo(id, startingRevision = null) {
  householdId = id;
  revision = startingRevision;
  writeSeen();
  applying = true;
  try {
    await api.post("/api/household/link", { remoteId: id });
  } finally {
    applying = false;
  }
  if (startingRevision === null) touch();
  else say("saved");
}

/**
 * Show a particular household from the account, and follow it from now on.
 *
 * Returns the state to render, or null when that household has never been
 * saved into — in which case what is on screen is sent up as its first copy.
 */
export async function openHousehold(id) {
  householdId = id;
  revision = null;
  const stored = await account.loadState(id);
  if (!stored?.state) {
    writeSeen();
    touch();
    return null;
  }
  return await adopt(stored);
}

/** Signed out: stop pushing, and forget which household this was. */
export function forget() {
  clearTimeout(pushTimer);
  pushTimer = null;
  user = null;
  householdId = null;
  revision = null;
  try {
    localStorage.removeItem(SEEN);
  } catch {
    /* nothing kept */
  }
  say("local");
}

/** Put back a change that lost a race, and send it up as the newest word. */
export async function restoreRescue() {
  const rescue = rescued();
  if (!rescue?.snapshot) return null;
  applying = true;
  try {
    await api.post("/api/restore", rescue.snapshot);
  } finally {
    applying = false;
  }
  dropRescue();
  const next = await api.get();
  touch();
  return next;
}

export const linkedHousehold = () => householdId;
