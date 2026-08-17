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

export async function signIn() {
  const supabase = getClient();
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Straight back to this page, which is the URL that has to be on
      // Supabase's Redirect URLs allow list.
      redirectTo: `${location.origin}${location.pathname}`,
      scopes: "https://www.googleapis.com/auth/calendar.readonly",
      queryParams: { access_type: "offline", prompt: "consent" },
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

  const { data: household, error: e1 } = await supabase
    .from("households")
    .insert({ name, owner_user_id: user.id })
    .select()
    .single();
  if (e1) throw new Error(e1.message);

  const { error: e2 } = await supabase
    .from("household_members")
    .insert({
      household_id: household.id,
      user_id: user.id,
      email: user.email,
    });
  if (e2) throw new Error(e2.message);

  await saveState(household.id, snapshot, null);
  return household;
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
