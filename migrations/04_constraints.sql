-- =============================================================================
-- Migration 04 — Data-integrity constraints
-- =============================================================================
-- Pushes rules that were only enforced in the browser down into the database, so
-- they hold no matter how a row is written (client, SQL editor, future services).
--
-- What this adds / changes:
--   1. One waitlist entry per user            (unique index on waitlist_entries.seeker_id)
--   2. Spot posted >= 1 hour before its class (check constraint on spots)
--   3. A user cannot claim their own spot      (guard added to claim_spot)
--   4. Valid status values                     (check constraints on spots + notifications)
--
-- Does NOT touch RLS (separate step). Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. One waitlist entry per user
-- -----------------------------------------------------------------------------
-- The app assumes each user has a single waitlist entry (WaitlistForm looks it up by
-- seeker_id and updates in place). This enforces that at the DB level.
--
-- NOTE: the request called for a *partial* unique index ("one *active* entry"), but
-- waitlist_entries has no status/active column — every row is active — so there is no
-- predicate to make it partial. This is a plain unique index on seeker_id. If you
-- later add e.g. an `is_active` flag, switch to:
--   create unique index ... on public.waitlist_entries (seeker_id) where is_active;
--
-- If this fails, you have pre-existing duplicates. Find them with:
--   select seeker_id, count(*) from public.waitlist_entries
--   group by seeker_id having count(*) > 1;
-- and keep only the most recent per seeker before re-running.
create unique index if not exists waitlist_entries_one_per_seeker
  on public.waitlist_entries (seeker_id);


-- -----------------------------------------------------------------------------
-- 2. A spot must be posted at least 1 hour before it starts
-- -----------------------------------------------------------------------------
-- Mirrors the PostSpotForm check. Anchored to created_at (the post time), NOT now():
-- both columns are immutable after insert, so the constraint is stable and does not
-- re-fire misleadingly on later UPDATEs (e.g. when claim_spot flips status). A CHECK
-- using now() would re-evaluate on every update and could reject claims once the
-- class time nears.
--
-- Added NOT VALID so it applies to all new inserts/updates without failing on any
-- legacy rows that predate the rule. Once existing data is clean you may run:
--   alter table public.spots validate constraint spots_posted_at_least_1h_before;
alter table public.spots
  drop constraint if exists spots_posted_at_least_1h_before;
alter table public.spots
  add constraint spots_posted_at_least_1h_before
  check (scheduled_at >= created_at + interval '1 hour') not valid;


-- -----------------------------------------------------------------------------
-- 3. A user cannot claim their own spot
-- -----------------------------------------------------------------------------
-- Redefines claim_spot (from migration 02) with an explicit self-claim guard. In
-- practice the matching function already excludes the poster, so a poster never holds
-- a notification for their own spot — this is defense in depth. The raised exception
-- surfaces to the client (NotificationInbox shows error.message).
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

  -- A user can never claim their own spot.
  if exists (
    select 1 from public.spots
    where id = p_spot_id and poster_id = v_uid
  ) then
    raise exception 'you cannot claim your own spot';
  end if;

  -- The caller must actually hold a pending offer for this spot.
  perform 1
  from public.notifications
  where id = p_notif_id
    and spot_id = p_spot_id
    and seeker_id = v_uid
    and status = 'pending';
  if not found then
    return;
  end if;

  -- Atomic claim: succeeds for exactly one concurrent caller.
  update public.spots
     set status = 'claimed',
         claimed_by = v_uid
   where id = p_spot_id
     and status = 'available'
  returning * into v_spot;

  -- Someone else won the race (or the spot vanished): return an empty set.
  if not found then
    return;
  end if;

  update public.notifications
     set status = 'claimed'
   where id = p_notif_id
     and seeker_id = v_uid;

  update public.waitlist_entries
     set created_at = now()
   where id = p_waitlist_entry_id
     and seeker_id = v_uid;

  return next v_spot;
  return;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Constrain status columns to valid values
-- -----------------------------------------------------------------------------
-- Using CHECK constraints (rather than enum types) so the set of values stays easy to
-- change later. Drop-then-add keeps this idempotent regardless of whether an
-- equivalent constraint already exists.
alter table public.spots
  drop constraint if exists spots_status_check;
alter table public.spots
  add constraint spots_status_check
  check (status in ('available', 'claimed'));

alter table public.notifications
  drop constraint if exists notifications_status_check;
alter table public.notifications
  add constraint notifications_status_check
  check (status in ('pending', 'claimed', 'expired'));
