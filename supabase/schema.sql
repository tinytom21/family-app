-- Family app: households, membership, invites and stored state.
--
-- Run this once in the Supabase SQL editor. It is written to be re-runnable —
-- every object is created if absent and every policy is dropped first — so a
-- second run is a no-op rather than a pile of "already exists" errors.
--
-- The anon key that reaches the browser is public by design; it identifies the
-- project, not the person. Everything below is therefore written on the
-- assumption that an attacker has that key and a valid account of their own.
-- Row Level Security is the only thing standing between one family's week and
-- another's, so the policies here are the security model, not decoration.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.households (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 1 and 80),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- Which mouth at the table this account belongs to, when it is one of them.
  -- Nullable on purpose: a grandparent who helps with the shopping is a real
  -- user and not a portion.
  person_id    text,
  email        text,
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.household_invites (
  code         text primary key check (code ~ '^[A-Z0-9]{6}$'),
  household_id uuid not null references public.households (id) on delete cascade,
  created_by   uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_by      uuid references auth.users (id) on delete set null,
  used_at      timestamptz
);

create index if not exists household_invites_household_idx
  on public.household_invites (household_id);

-- The whole app payload for a household: people, plan, larder, tasks, the
-- week's overrides. One document rather than a dozen tables.
--
-- That is a deliberate prototype trade-off. It makes the entire app persist in
-- one step and keeps the RLS surface to four tables. What it does not do is
-- merge concurrent edits: two phones saving at once is last-write-wins, and
-- the loser's change vanishes without saying so. `revision` exists so that
-- becomes detectable rather than silent, and normalising this into real tables
-- is the first thing to do when two people actually use it at the same time.
create table if not exists public.household_state (
  household_id uuid primary key references public.households (id) on delete cascade,
  state        jsonb not null default '{}'::jsonb,
  revision     bigint not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Membership test
-- ---------------------------------------------------------------------------

-- Security definer, so it can read household_members without the caller's own
-- policies applying. Without this the obvious policy — "you may read members of
-- households you are a member of" — has to query household_members from inside
-- a household_members policy, and Postgres rejects it as infinite recursion.
-- This is the single most common way to get stuck writing Supabase RLS.
create or replace function public.is_household_member(target uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = target
      and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_household_member(uuid) from public;
grant execute on function public.is_household_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.household_state   enable row level security;

-- households -----------------------------------------------------------------
drop policy if exists households_select on public.households;
create policy households_select on public.households
  for select to authenticated
  using (public.is_household_member(id));

drop policy if exists households_insert on public.households;
create policy households_insert on public.households
  for insert to authenticated
  with check (owner_user_id = auth.uid());

-- Anyone in the household may rename it. There is deliberately no permission
-- ladder here: this is a family, not an organisation, and an adult having to
-- ask another adult for edit rights to the shopping list is a worse product.
drop policy if exists households_update on public.households;
create policy households_update on public.households
  for update to authenticated
  using (public.is_household_member(id))
  with check (public.is_household_member(id));

-- Deleting the household is the one thing kept to whoever created it.
drop policy if exists households_delete on public.households;
create policy households_delete on public.households
  for delete to authenticated
  using (owner_user_id = auth.uid());

-- household_members ----------------------------------------------------------
drop policy if exists members_select on public.household_members;
create policy members_select on public.household_members
  for select to authenticated
  using (public.is_household_member(household_id));

-- Joining is done through join_household() below, which redeems an invite.
-- The only insert allowed directly is the founder adding themselves to the
-- household they just created, which no invite can exist for yet.
drop policy if exists members_insert_self on public.household_members;
create policy members_insert_self on public.household_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.households h
      where h.id = household_id and h.owner_user_id = auth.uid()
    )
  );

-- You may edit your own row — which person you are, say — and nobody else's.
drop policy if exists members_update_self on public.household_members;
create policy members_update_self on public.household_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Leaving is always allowed; removing somebody else is the owner's call.
drop policy if exists members_delete on public.household_members;
create policy members_delete on public.household_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.households h
      where h.id = household_id and h.owner_user_id = auth.uid()
    )
  );

-- household_invites ----------------------------------------------------------
-- Note there is no select policy for looking a code up. Redemption happens
-- inside join_household() instead, so an invite code can never be used to read
-- anything — including whether a given code exists.
drop policy if exists invites_select on public.household_invites;
create policy invites_select on public.household_invites
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists invites_insert on public.household_invites;
create policy invites_insert on public.household_invites
  for insert to authenticated
  with check (
    created_by = auth.uid() and public.is_household_member(household_id)
  );

drop policy if exists invites_delete on public.household_invites;
create policy invites_delete on public.household_invites
  for delete to authenticated
  using (public.is_household_member(household_id));

-- household_state ------------------------------------------------------------
drop policy if exists state_select on public.household_state;
create policy state_select on public.household_state
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists state_insert on public.household_state;
create policy state_insert on public.household_state
  for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists state_update on public.household_state;
create policy state_update on public.household_state
  for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Joining a household
-- ---------------------------------------------------------------------------

-- Redeeming an invite has to do two things the caller is not allowed to do
-- directly: read a row in household_invites they cannot yet see, and insert a
-- membership for a household they are not yet in. So it happens here, once,
-- under a definer, with the checks written out explicitly.
--
-- The returned text is a status code the client maps to a message. It never
-- distinguishes "no such code" from "wrong code", so the function cannot be
-- used to enumerate valid invites.
create or replace function public.join_household(invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invite   public.household_invites%rowtype;
  caller   uuid := auth.uid();
begin
  if caller is null then
    return jsonb_build_object('ok', false, 'problem', 'not-signed-in');
  end if;

  select * into invite
  from public.household_invites
  where code = upper(btrim(invite_code))
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'problem', 'unknown');
  end if;
  if invite.used_by is not null then
    return jsonb_build_object('ok', false, 'problem', 'already-used');
  end if;
  if invite.expires_at <= now() then
    return jsonb_build_object('ok', false, 'problem', 'expired');
  end if;

  -- Already in it: succeed quietly rather than erroring. Somebody clicking the
  -- same link twice has not done anything wrong.
  if exists (
    select 1 from public.household_members m
    where m.household_id = invite.household_id and m.user_id = caller
  ) then
    return jsonb_build_object('ok', true, 'household_id', invite.household_id);
  end if;

  insert into public.household_members (household_id, user_id, email)
  values (
    invite.household_id,
    caller,
    (select email from auth.users where id = caller)
  );

  update public.household_invites
     set used_by = caller, used_at = now()
   where code = invite.code;

  return jsonb_build_object('ok', true, 'household_id', invite.household_id);
end;
$$;

revoke all on function public.join_household(text) from public;
grant execute on function public.join_household(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Saving state
-- ---------------------------------------------------------------------------

-- Bumps the revision and records who wrote it, so a stale client can be told
-- it was overtaken instead of silently overwriting somebody.
create or replace function public.save_household_state(
  target uuid,
  next_state jsonb,
  expected_revision bigint default null
)
returns jsonb
language plpgsql
security invoker            -- deliberately: the RLS policies above still apply
set search_path = public, pg_temp
as $$
declare
  current_revision bigint;
begin
  select revision into current_revision
  from public.household_state
  where household_id = target
  for update;

  if not found then
    insert into public.household_state (household_id, state, revision, updated_by)
    values (target, next_state, 1, auth.uid());
    return jsonb_build_object('ok', true, 'revision', 1);
  end if;

  if expected_revision is not null and expected_revision <> current_revision then
    return jsonb_build_object(
      'ok', false, 'problem', 'stale', 'revision', current_revision
    );
  end if;

  update public.household_state
     set state = next_state,
         revision = current_revision + 1,
         updated_at = now(),
         updated_by = auth.uid()
   where household_id = target;

  return jsonb_build_object('ok', true, 'revision', current_revision + 1);
end;
$$;

grant execute on function public.save_household_state(uuid, jsonb, bigint) to authenticated;
