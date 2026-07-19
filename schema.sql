-- =============================================================================
-- No Show — Full database schema (self-contained, reproducible on a fresh project)
-- =============================================================================
-- Single source of truth for the database. Recreates the live Supabase schema:
-- tables, columns, indexes, RLS policies, functions, triggers, the pg_cron job,
-- and the extensions everything depends on.
--
-- To run: paste this whole file into the Supabase SQL Editor and run it.
-- Order matters (extensions → tables → functions → triggers → grants → realtime →
-- cron), so run it top to bottom.
--
-- REGENERATING FROM THE LIVE DB (optional): `npx supabase db dump --schema public
-- -f schema.sql` captures tables/columns/RLS/functions/triggers but OMITS the two
-- bannered blocks below (EXTENSIONS at the top, PG_CRON SCHEDULE at the bottom).
-- If you re-dump, re-add those two blocks manually.
-- =============================================================================


-- =============================================================================
-- EXTENSIONS  (a plain `supabase db dump` does NOT include these — keep them here)
-- =============================================================================
-- gen_random_uuid() (uuid PK defaults).
create extension if not exists pgcrypto;
-- Distance math for location-based matching (earthdistance depends on cube).
-- On Supabase these live in the `extensions` schema.
create extension if not exists cube with schema extensions;
create extension if not exists earthdistance with schema extensions;
-- Outbound HTTP from Postgres (used by Database Webhooks, e.g. send-notification-email).
create extension if not exists pg_net with schema extensions;
-- Scheduled jobs (the notification-expiry sweep). NOTE: pg_cron is privileged; if this
-- statement errors on a fresh project, enable it first via Dashboard → Database →
-- Extensions, then re-run. It creates the `cron` schema used at the bottom of this file.
create extension if not exists pg_cron;


-- =============================================================================
-- Table: profiles
-- -----------------------------------------------------------------------------
-- One row per auth user, created automatically by handle_new_user() on signup.
-- =============================================================================
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null,
  email      text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read (authenticated)"
  on public.profiles for select to authenticated
  using (true);

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- =============================================================================
-- Table: spots
-- -----------------------------------------------------------------------------
-- Every posted class spot. lat/lng are geocoded from `location` at write time.
-- =============================================================================
create table if not exists public.spots (
  id           uuid primary key default gen_random_uuid(),
  poster_id    uuid not null references public.profiles (id) on delete cascade,
  title        text not null,             -- class name, e.g. "Morning Flow"
  class_type   text not null,             -- e.g. Yoga, Spin
  studio       text not null,             -- studio name
  location     text,                      -- studio address (optional)
  lat          double precision,          -- geocoded from location at write time
  lng          double precision,
  scheduled_at timestamptz not null,      -- class date and time
  class_level  text,                      -- optional
  instructor   text,                      -- optional
  claim_info   text,                      -- booking details, revealed only after a claim
  status       text not null default 'available'
                 check (status in ('available', 'claimed')),
  claimed_by   uuid references public.profiles (id),  -- seeker who claimed it
  created_at   timestamptz not null default now(),
  -- Spot must be posted at least 1 hour before the class (anchored to created_at,
  -- not now(), so it stays immutable across later updates like claiming).
  constraint spots_posted_at_least_1h_before
    check (scheduled_at >= created_at + interval '1 hour')
);

create index if not exists spots_status_class_type_idx
  on public.spots (status, class_type);
create index if not exists spots_poster_id_idx
  on public.spots (poster_id);

alter table public.spots enable row level security;

create policy "spots: read (authenticated)"
  on public.spots for select to authenticated
  using (true);

create policy "spots: insert (authenticated)"
  on public.spots for insert to authenticated
  with check (auth.uid() = poster_id);

-- NO update policy: claiming is the only spot update and happens exclusively through
-- claim_spot() (SECURITY DEFINER). Add a poster-scoped UPDATE policy if you add an
-- "edit listing" feature.

create policy "spots: delete own"
  on public.spots for delete to authenticated
  using (auth.uid() = poster_id);


-- =============================================================================
-- Table: waitlist_entries
-- -----------------------------------------------------------------------------
-- Each seeker's preferences. created_at doubles as FIFO queue position (bumped to
-- now() after a successful claim). location is geocoded to lat/lng at write time;
-- max_distance_miles is how far the seeker will travel.
-- =============================================================================
create table if not exists public.waitlist_entries (
  id                 uuid primary key default gen_random_uuid(),
  seeker_id          uuid not null references public.profiles (id) on delete cascade,
  class_types        text[] not null,      -- preferred class types (multi-select)
  class_level        text,                 -- optional preferred level
  time_preferences   text[],               -- morning/afternoon/evening, or null = any
  location           text,                 -- preferred address/neighborhood
  lat                double precision,      -- geocoded from location at write time
  lng                double precision,
  max_distance_miles integer not null default 10,
  created_at         timestamptz not null default now()  -- queue position
);

-- One waitlist entry per user (also covers seeker_id lookups).
create unique index if not exists waitlist_entries_one_per_seeker
  on public.waitlist_entries (seeker_id);
create index if not exists waitlist_entries_class_types_idx
  on public.waitlist_entries using gin (class_types);

alter table public.waitlist_entries enable row level security;

-- Owner-only for everything (matching reads the whole waitlist server-side via
-- SECURITY DEFINER functions that bypass RLS, so the client never needs others' rows).
create policy "waitlist_entries: select own"
  on public.waitlist_entries for select to authenticated
  using (auth.uid() = seeker_id);

create policy "waitlist_entries: insert own"
  on public.waitlist_entries for insert to authenticated
  with check (auth.uid() = seeker_id);

create policy "waitlist_entries: update own"
  on public.waitlist_entries for update to authenticated
  using (auth.uid() = seeker_id)
  with check (auth.uid() = seeker_id);

create policy "waitlist_entries: delete own"
  on public.waitlist_entries for delete to authenticated
  using (auth.uid() = seeker_id);


-- =============================================================================
-- Table: notifications
-- -----------------------------------------------------------------------------
-- One pending/claimed/expired offer to a specific seeker. created_at drives the
-- claim countdown. Written only by SECURITY DEFINER functions.
-- =============================================================================
create table if not exists public.notifications (
  id                uuid primary key default gen_random_uuid(),
  seeker_id         uuid not null references public.profiles (id) on delete cascade,
  spot_id           uuid not null references public.spots (id) on delete cascade,
  waitlist_entry_id uuid not null references public.waitlist_entries (id) on delete cascade,
  message           text not null,
  status            text not null default 'pending'
                      check (status in ('pending', 'claimed', 'expired')),
  created_at        timestamptz not null default now()
);

create index if not exists notifications_seeker_id_idx
  on public.notifications (seeker_id);
create index if not exists notifications_spot_id_idx
  on public.notifications (spot_id);

alter table public.notifications enable row level security;

create policy "notifications: read own"
  on public.notifications for select to authenticated
  using (auth.uid() = seeker_id);

-- NO insert/update policies: notifications are inserted only by the matching/cascade
-- functions and updated only by claim_spot / reject_and_advance / the expiry cron —
-- all SECURITY DEFINER. The client never writes notifications directly.

create policy "notifications: delete own"
  on public.notifications for delete to authenticated
  using (auth.uid() = seeker_id);


-- =============================================================================
-- Functions
-- =============================================================================

-- Creates a profile row when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.email
  );
  return new;
end;
$$;

-- Buckets a class time into morning / afternoon / evening.
create or replace function public.spot_time_of_day(p_scheduled_at timestamptz)
returns text
language sql
stable
as $$
  select case
           when extract(hour from p_scheduled_at) < 12 then 'morning'
           when extract(hour from p_scheduled_at) < 17 then 'afternoon'
           else 'evening'
         end;
$$;

-- Core matcher: finds the best-matching, in-range, not-yet-notified seeker for a spot
-- (Tier 1 exact class_type+level+time, Tier 2 class-type-only) and inserts one pending
-- notification. Distance filter is fail-open when either side lacks coordinates.
-- Note: earthdistance funcs live in the `extensions` schema, hence the search_path and
-- the extensions.-qualified calls.
create or replace function public.notify_seeker_for_spot(p_spot_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_spot     public.spots%rowtype;
  v_entry    public.waitlist_entries%rowtype;
  v_tod      text;
  v_details  text;
  v_message  text;
  v_notif_id uuid;
begin
  select * into v_spot from public.spots where id = p_spot_id;
  if not found or v_spot.status <> 'available' then
    return null;
  end if;

  v_tod := public.spot_time_of_day(v_spot.scheduled_at);

  -- TIER 1 — exact match on class_type + level + time-of-day, FIFO by created_at.
  select w.* into v_entry
  from public.waitlist_entries w
  where w.class_types @> array[v_spot.class_type]
    and w.seeker_id <> v_spot.poster_id
    and w.class_level is not distinct from v_spot.class_level
    and (w.time_preferences is null or v_tod = any (w.time_preferences))
    and not exists (
      select 1 from public.notifications n
      where n.spot_id = v_spot.id and n.seeker_id = w.seeker_id
    )
    -- Distance filter, FAIL-OPEN: enforce only when both sides have coordinates.
    and (
      v_spot.lat is null or v_spot.lng is null
      or w.lat is null or w.lng is null
      or extensions.earth_distance(
           extensions.ll_to_earth(v_spot.lat, v_spot.lng),
           extensions.ll_to_earth(w.lat, w.lng)
         ) <= coalesce(w.max_distance_miles, 10) * 1609.34
    )
  order by w.created_at asc
  limit 1;

  -- TIER 2 — fallback to class-type-only matching (same distance rule).
  if not found then
    select w.* into v_entry
    from public.waitlist_entries w
    where w.class_types @> array[v_spot.class_type]
      and w.seeker_id <> v_spot.poster_id
      and not exists (
        select 1 from public.notifications n
        where n.spot_id = v_spot.id and n.seeker_id = w.seeker_id
      )
      and (
        v_spot.lat is null or v_spot.lng is null
        or w.lat is null or w.lng is null
        or extensions.earth_distance(
             extensions.ll_to_earth(v_spot.lat, v_spot.lng),
             extensions.ll_to_earth(w.lat, w.lng)
           ) <= coalesce(w.max_distance_miles, 10) * 1609.34
      )
    order by w.created_at asc
    limit 1;
  end if;

  if not found then
    return null;
  end if;

  v_details := array_to_string(
    array[
      v_spot.class_level,
      case when v_spot.instructor is not null then 'with ' || v_spot.instructor end,
      v_spot.location
    ],
    ' · '
  );

  v_message := 'A ' || v_spot.class_type || ' spot at ' || v_spot.studio
             || coalesce(' (' || v_spot.title || ')', '')
             || ' is available on '
             || to_char(v_spot.scheduled_at, 'FMDay, FMMon FMDD, YYYY "at" FMHH12:MI AM')
             || '.';

  if v_details <> '' then
    v_message := v_message || E'\n' || v_details;
  end if;

  v_message := v_message || E'\n' || 'Claim it before it''s gone!';

  insert into public.notifications (seeker_id, spot_id, waitlist_entry_id, message, status)
  values (v_entry.seeker_id, v_spot.id, v_entry.id, v_message, 'pending')
  returning id into v_notif_id;

  return v_notif_id;
end;
$$;

-- AFTER INSERT trigger fn: run the matcher on a newly posted spot. Errors are
-- swallowed so a matching failure can never roll back the spot insert.
create or replace function public.spots_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform public.notify_seeker_for_spot(new.id);
  exception when others then
    raise warning 'notify_seeker_for_spot failed for spot %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- When a seeker joins/updates the waitlist: notify the next eligible seeker for every
-- currently-available matching spot that has no pending offer out.
create or replace function public.notify_available_spots_for_me()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_entry public.waitlist_entries%rowtype;
  r       record;
  v_count integer := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select * into v_entry from public.waitlist_entries where seeker_id = v_uid;
  if not found then
    return 0;
  end if;

  for r in
    select s.id
    from public.spots s
    where s.status = 'available'
      and s.poster_id <> v_uid
      and s.class_type = any (v_entry.class_types)
      and not exists (
        select 1 from public.notifications n
        where n.spot_id = s.id and n.status = 'pending'
      )
    order by s.created_at asc
  loop
    if public.notify_seeker_for_spot(r.id) is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- Atomically claim a spot (only if still available), mark the notification claimed,
-- bump the seeker to the back of the queue, and return the spot (with booking info).
-- Empty result set = the spot was already taken (or caller isn't the recipient).
create or replace function public.claim_spot(
  p_spot_id           uuid,
  p_notif_id          uuid,
  p_waitlist_entry_id uuid
)
returns setof public.spots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_spot public.spots%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if exists (
    select 1 from public.spots where id = p_spot_id and poster_id = v_uid
  ) then
    raise exception 'you cannot claim your own spot';
  end if;

  perform 1
  from public.notifications
  where id = p_notif_id
    and spot_id = p_spot_id
    and seeker_id = v_uid
    and status = 'pending';
  if not found then
    return;
  end if;

  update public.spots
     set status = 'claimed',
         claimed_by = v_uid
   where id = p_spot_id
     and status = 'available'
  returning * into v_spot;

  if not found then
    return;
  end if;

  update public.notifications
     set status = 'claimed'
   where id = p_notif_id and seeker_id = v_uid;

  update public.waitlist_entries
     set created_at = now()
   where id = p_waitlist_entry_id and seeker_id = v_uid;

  return next v_spot;
  return;
end;
$$;

-- "Not Interested": expire the caller's own pending offer and advance the queue.
create or replace function public.reject_and_advance(p_notif_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_notif public.notifications%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select * into v_notif
  from public.notifications
  where id = p_notif_id and seeker_id = v_uid and status = 'pending';
  if not found then
    return;
  end if;

  update public.notifications set status = 'expired' where id = p_notif_id;
  perform public.notify_seeker_for_spot(v_notif.spot_id);
end;
$$;

-- Expiry sweep (run by pg_cron every minute): expire pending offers older than 30
-- minutes and advance each affected spot to the next eligible seeker.
create or replace function public.expire_stale_notifications()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in
    select id, spot_id
    from public.notifications
    where status = 'pending'
      and created_at < now() - interval '30 minutes'
    order by created_at asc
  loop
    update public.notifications set status = 'expired' where id = r.id;
    perform public.notify_seeker_for_spot(r.spot_id);
  end loop;
end;
$$;


-- =============================================================================
-- Triggers
-- =============================================================================
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

drop trigger if exists spots_after_insert on public.spots;
create trigger spots_after_insert
  after insert on public.spots
  for each row
  execute function public.spots_notify_on_insert();


-- =============================================================================
-- Grants (client-callable RPCs via supabase.rpc)
-- =============================================================================
grant execute on function public.claim_spot(uuid, uuid, uuid) to authenticated;
grant execute on function public.notify_available_spots_for_me() to authenticated;
grant execute on function public.reject_and_advance(uuid) to authenticated;


-- =============================================================================
-- Realtime — notifications inbox subscribes to postgres_changes on this table.
-- =============================================================================
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;  -- already in the publication
  when undefined_object then null;  -- publication doesn't exist in this project
end
$$;


-- =============================================================================
-- PG_CRON SCHEDULE  (a plain `supabase db dump` does NOT include this — keep it here)
-- -----------------------------------------------------------------------------
-- Runs the expiry sweep every minute. Requires pg_cron (enabled at the top / via the
-- Dashboard). Unschedule-then-schedule keeps this idempotent.
-- =============================================================================
select cron.unschedule('expire-stale-notifications')
where exists (select 1 from cron.job where jobname = 'expire-stale-notifications');

select cron.schedule(
  'expire-stale-notifications',
  '* * * * *',  -- every minute
  $$ select public.expire_stale_notifications(); $$
);
