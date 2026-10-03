/**
 * Accounts, households and invites.
 *
 * The shape of this is "local first, account optional", which is the order the
 * family actually experiences it: set the household up, use it, and only then
 * decide whether it should follow you to a phone. Signing in is what turns a
 * browser's worth of data into something two people share.
 *
 * A user and a person are different things and stay different things. Signing
 * in creates a *user*; the people at the table already exist. Joining offers to
 * link you to one of them by name, and declining is fine — a grandparent who
 * does the shopping is a real account and not a portion.
 *
 * The anon key below is public by design: it names the project, not the person.
 * Everything that actually protects a family's week is a Row Level Security
 * policy in supabase/schema.sql, written on the assumption that whoever is
 * calling has this key and an account of their own.
 */

const STORE = "family-app.supabase";

/**
 * Project details, in order of preference.
 *
 * A committed config is what makes the published demo work for somebody who
 * has never opened the setup checker. The localStorage fallback is what makes
 * it work on the machine of whoever ran the checker before the config existed.
 */
export function supabaseConfig() {
  const built = window.__SUPABASE_CONFIG;
  if (built?.url && built?.anonKey) {
    return { url: built.url, key: built.anonKey };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    if (saved.url && saved.key) return saved;
  } catch {
    /* unreadable store; treated as absent */
  }
  return null;
}

let client = null;
export function getClient() {
  if (client) return client;
  const config = supabaseConfig();
  if (!config || !window.supabase) return null;
  client = window.supabase.createClient(config.url, config.key, {
    auth: { detectSessionInUrl: true, persistSession: true },
  });
  // Google's calendar token arrives once, in the session that comes back from
  // signing in, and Supabase neither keeps it across a reload nor renews it.
  // So it is caught here, on the way past, and kept for the hour it lasts.
  client.auth.onAuthStateChange((_event, session) => keepCalendarToken(session));
  return client;
}

export const isConfigured = () => Boolean(supabaseConfig() && window.supabase);

/* ------------------------------------------------------------------ */
/* Signing in                                                          */
/* ------------------------------------------------------------------ */

export async function currentUser() {
  const supabase = getClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

/**
 * Sign in to the account. Just that.
 *
 * This used to ask for calendar access and force Google's consent screen
 * every time, which is why signing in felt like a form rather than a click.
 * Now it asks only who you are, so Google can usually wave you straight
 * through, and the session then lasts for weeks. Reading a calendar is asked
 * for separately, when somebody presses the button that needs it.
 */
export async function signIn() {
  const supabase = getClient();
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Straight back to this page, which is the URL that has to be on
      // Supabase's Redirect URLs allow list.
      redirectTo: `${location.origin}${location.pathname}`,
    },
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/* Reading a Google Calendar                                           */
/* ------------------------------------------------------------------ */

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_TOKEN = "family-app.google-calendar";
/** Google's tokens last an hour. A little less, so one never dies mid-read. */
const CALENDAR_TOKEN_MS = 55 * 60 * 1000;
/** Marks the trip to Google as being for the calendar, so the return can finish it. */
export const CALENDAR_RETURN = "calendar";

function keepCalendarToken(session) {
  // Every sign-in brings a Google token, but only one that went out asking for
  // the calendar can read it. The marker on the way back says which this was.
  if (!session?.provider_token) return;
  if (new URLSearchParams(location.search).get("then") !== CALENDAR_RETURN) return;
  try {
    localStorage.setItem(
      CALENDAR_TOKEN,
      JSON.stringify({
        token: session.provider_token,
        email: session.user?.email ?? null,
        expiresAt: Date.now() + CALENDAR_TOKEN_MS,
      }),
    );
  } catch {
    /* without storage it simply asks again next time */
  }
}

/** A calendar token that still works, or null. */
export function calendarToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALENDAR_TOKEN) ?? "null");
    return saved?.token && saved.expiresAt > Date.now() ? saved : null;
  } catch {
    return null;
  }
}

export function forgetCalendarToken() {
  try {
    localStorage.removeItem(CALENDAR_TOKEN);
  } catch {
    /* already gone */
  }
}

/**
 * Go to Google for calendar access, and come back here to finish.
 *
 * No forced consent screen: Google shows it the first time and, after that,
 * usually just confirms the account. The page this returns to carries a marker
 * so the calendar read carries on by itself — rather than the old detour to a
 * setup page and a second press of the same button.
 */
export async function connectGoogleCalendar() {
  const supabase = getClient();
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${location.origin}${location.pathname}?then=${CALENDAR_RETURN}`,
      scopes: CALENDAR_SCOPE,
    },
  });
  if (error) throw new Error(error.message);
}

export async function signOut() {
  await getClient()?.auth.signOut();
}

const NOT_CONFIGURED =
  "This build has no Supabase project configured, so accounts are off. " +
  "Everything still works in this browser.";

/* ------------------------------------------------------------------ */
/* Households                                                          */
/* ------------------------------------------------------------------ */

/** Households this account belongs to. */
export async function myHouseholds() {
  const supabase = getClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("household_members")
    .select("household_id, person_id, households(id, name, owner_user_id)")
    .order("joined_at", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((row) => row.households)
    .map((row) => ({
      id: row.households.id,
      name: row.households.name,
      personId: row.person_id ?? null,
      isOwner: row.households.owner_user_id === row.households.owner_user_id,
    }));
}

/**
 * Create a household from what is already in this browser, and upload it.
 *
 * Two inserts and a save rather than one call, because the membership row has
 * to exist before the state row will pass its policy — you cannot write to a
 * household you are not yet in, which is the point of the policy.
 */
export async function createHousehold(name, snapshot) {
  const supabase = getClient();
  const user = await currentUser();
  if (!supabase || !user) throw new Error("Sign in first.");

  const { data: household, error: created } = await supabase
    .from("households")
    .insert({ name, owner_user_id: user.id })
    .select()
    .single();
  if (created) throw new Error(`Creating the household — ${created.message}`);

  /* All three steps can fail, and Row Level Security reports all three in
     almost the same words, so each one says which it was: "new row violates
     row-level security policy" is an afternoon when you do not know whether it
     came from the household, the membership or the week.
     If a later step fails, the empty household goes with it. Left behind, it
     would be invisible to the retry and the next attempt would make another. */
  try {
    const { error: joined } = await supabase
      .from("household_members")
      .insert({
        household_id: household.id,
        user_id: user.id,
        email: user.email,
      });
    if (joined) throw new Error(`Adding you to the household — ${joined.message}`);

    // The revision comes back with it, so the sync knows what it is building on
    // and the very first change does not look like somebody else's.
    const saved = await saveState(household.id, snapshot, null);
    return { ...household, revision: saved?.revision ?? null };
  } catch (error) {
    await supabase.from("households").delete().eq("id", household.id);
    throw error;
  }
}

export async function joinHousehold(code) {
  const supabase = getClient();
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { data, error } = await supabase.rpc("join_household", {
    invite_code: code,
  });
  if (error) throw new Error(error.message);
  return data; // { ok, household_id } or { ok: false, problem }
}

export async function createInvite(householdId, code, expiresAt) {
  const supabase = getClient();
  const user = await currentUser();
  if (!supabase || !user) throw new Error("Sign in first.");
  const { error } = await supabase.from("household_invites").insert({
    code,
    household_id: householdId,
    created_by: user.id,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return code;
}

/** Link this account to one of the people at the table — or to none of them. */
export async function linkToPerson(householdId, personId) {
  const supabase = getClient();
  const user = await currentUser();
  if (!supabase || !user) throw new Error("Sign in first.");
  const { error } = await supabase
    .from("household_members")
    .update({ person_id: personId })
    .eq("household_id", householdId)
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export async function loadState(householdId) {
  const supabase = getClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("household_state")
    .select("state, revision")
    .eq("household_id", householdId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * Save, and be told rather than guess when somebody else got there first.
 *
 * `expectedRevision` is what makes a clobber detectable. The prototype still
 * resolves it by taking the newest write, but it can now say so out loud
 * instead of a change quietly evaporating — which is the difference between a
 * known limitation and a bug nobody can reproduce.
 */
export async function saveState(householdId, snapshot, expectedRevision) {
  const supabase = getClient();
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { data, error } = await supabase.rpc("save_household_state", {
    target: householdId,
    next_state: snapshot,
    expected_revision: expectedRevision,
  });
  if (error) throw new Error(error.message);
  return data; // { ok, revision } or { ok: false, problem: "stale", revision }
}
