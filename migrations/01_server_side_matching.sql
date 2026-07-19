-- =============================================================================
-- Migration 01 — Server-side matching for newly posted spots
-- =============================================================================
-- Moves the "a spot was just posted → notify the best-matching seeker" logic out
-- of the browser (src/lib/matching.ts :: notifyNextSeeker) and into the database,
-- so the client can no longer fabricate or tamper with notifications for this flow.
--
-- What this adds:
--   1. spot_time_of_day(timestamptz)  -> maps a class time to morning/afternoon/evening
--   2. notify_seeker_for_spot(uuid)   -> SECURITY DEFINER; finds the best match for a
--                                        spot and inserts one 'pending' notification
--   3. spots_notify_on_insert()       -> trigger function wrapping (2)
--   4. trigger spots_after_insert     -> AFTER INSERT ON public.spots
--
-- Matching rules (per README + src/lib/matching.ts):
--   * Only the seeker's class_types must contain the spot's class_type.
--   * The poster can never be matched to their own spot.
--   * Queue order is FIFO by waitlist_entries.created_at (ascending).
--   * TIER 1 (exact): class_type match AND class_level equal AND the spot's
--                     time-of-day is in the seeker's time_preferences (null = "any").
--   * TIER 2 (fallback): class_type match only. Used when no exact match exists.
--   * Exactly one notification is inserted, for the single best match.
--
-- NOTE: This migration intentionally does NOT touch RLS (that is a separate step),
-- and does NOT cover two flows that still run client-side (see the bottom of this
-- file and src/lib/matching.ts):
--   * seeker joining the waitlist and matching already-available spots
--   * reject / 30-min-timeout cascade to the next seeker in line
--
-- Safe to re-run: uses CREATE OR REPLACE and DROP ... IF EXISTS throughout.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. spot_time_of_day(timestamptz) -> text
-- -----------------------------------------------------------------------------
-- Buckets a class start time into 'morning' | 'afternoon' | 'evening' so it can be
-- compared against waitlist_entries.time_preferences.
--
-- IMPORTANT (verify): the hour is read in the database session time zone, which on
-- Supabase is UTC. spots.scheduled_at is stored as UTC (the client does
-- `new Date(...).toISOString()`), so a class the poster entered as 9:00am local will
-- be bucketed by its UTC hour, not the local hour. If time-of-day matching must
-- reflect the *studio's* local time, store a timezone alongside each spot and convert
-- here (e.g. `p_scheduled_at AT TIME ZONE spot_tz`). The hour boundaries below are
-- also an assumption — adjust to taste.
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


-- -----------------------------------------------------------------------------
-- 2. notify_seeker_for_spot(uuid) -> uuid
-- -----------------------------------------------------------------------------
-- Given a spot id, find the best-matching waitlist entry and insert one pending
-- notification for that seeker. Returns the new notification id, or NULL if there
-- was no match (or the spot is not available / does not exist).
--
-- SECURITY DEFINER: runs with the privileges of the function owner so it can insert
-- a notification addressed to a *different* user than the caller. This is what lets
-- us tighten notifications RLS later without breaking matching.
create or replace function public.notify_seeker_for_spot(p_spot_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_spot    public.spots%rowtype;
  v_entry   public.waitlist_entries%rowtype;
  v_tod     text;
  v_details text;
  v_message text;
  v_notif_id uuid;
begin
  -- Load the spot; only match spots that are actually up for grabs.
  select * into v_spot from public.spots where id = p_spot_id;
  if not found or v_spot.status <> 'available' then
    return null;
  end if;

  v_tod := public.spot_time_of_day(v_spot.scheduled_at);

  -- TIER 1 — exact match on class_type + level + time-of-day, FIFO by created_at.
  -- `is not distinct from` treats NULL = NULL as a match (e.g. a no-level spot
  -- exactly matches a seeker with no level preference).
  select w.* into v_entry
  from public.waitlist_entries w
  where w.class_types @> array[v_spot.class_type]
    and w.seeker_id <> v_spot.poster_id
    and w.class_level is not distinct from v_spot.class_level
    and (w.time_preferences is null or v_tod = any(w.time_preferences))
  order by w.created_at asc
  limit 1;

  -- TIER 2 — fallback to class-type-only matching (mirrors the original client logic).
  if not found then
    select w.* into v_entry
    from public.waitlist_entries w
    where w.class_types @> array[v_spot.class_type]
      and w.seeker_id <> v_spot.poster_id
    order by w.created_at asc
    limit 1;
  end if;

  -- No one on the waitlist wants this type of class.
  if not found then
    return null;
  end if;

  -- Build the message. array_to_string skips NULL elements, so optional fields
  -- (level, instructor, location) drop out cleanly. Mirrors the string that
  -- src/lib/matching.ts used to build client-side.
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


-- -----------------------------------------------------------------------------
-- 3. spots_notify_on_insert() -> trigger
-- -----------------------------------------------------------------------------
-- Thin AFTER INSERT wrapper. Any error in matching is swallowed (logged as a
-- WARNING) so that a matching failure can never roll back the spot insert itself —
-- posting a spot must always succeed even if no notification could be created.
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


-- -----------------------------------------------------------------------------
-- 4. Trigger: fire matching after every new spot
-- -----------------------------------------------------------------------------
drop trigger if exists spots_after_insert on public.spots;
create trigger spots_after_insert
  after insert on public.spots
  for each row
  execute function public.spots_notify_on_insert();


-- =============================================================================
-- Follow-ups NOT included here (still handled client-side in src/lib/matching.ts)
-- -----------------------------------------------------------------------------
-- Before you can lock down notifications RLS to "insert only your own", these two
-- flows must also move server-side, because they still insert notifications from
-- the browser:
--
--   A. Seeker joins the waitlist -> match already-available spots.
--      Suggested: an AFTER INSERT (and maybe AFTER UPDATE) trigger on
--      waitlist_entries that scans available spots and calls a helper similar to
--      notify_seeker_for_spot, but iterating spots for one seeker.
--
--   B. Reject / 30-minute timeout -> cascade to the next seeker in line.
--      Suggested: a SECURITY DEFINER RPC, e.g.
--      reject_and_advance(p_notif_id uuid) that marks the notification 'expired'
--      and notifies the next matching entry after the current one (the
--      `afterEntryId` argument in the old client code).
--
-- Until A and B exist, keep the notifications INSERT policy permissive.
-- =============================================================================
