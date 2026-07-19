-- =============================================================================
-- Migration 03 — Server-side expiry via pg_cron
-- =============================================================================
-- The 30-minute claim window was enforced entirely in the browser (a countdown in
-- NotificationInbox.tsx that called rejectSpot on timeout). If the seeker closed the
-- tab, the spot was never expired and never passed to the next person in line.
--
-- This moves expiry into the database: a pg_cron job runs every minute, expires any
-- pending notification older than 30 minutes, and advances the queue to the next
-- eligible seeker — reusing the matching function from migration 01 (no duplication).
--
-- What this adds / changes:
--   1. notify_seeker_for_spot(uuid) -> REDEFINED to skip seekers already notified for
--      the spot. This is what makes it safe to call repeatedly to advance the queue:
--        * on initial post, no one has been notified yet -> picks the FIFO-first match
--        * on each expiry, the just-expired seeker is skipped -> picks the next one
--   2. expire_stale_notifications() -> the periodic sweep
--   3. a pg_cron job that runs (2) every minute
--
-- Requires the pg_cron extension (already enabled).
-- Does NOT touch RLS (separate step). Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Redefine notify_seeker_for_spot to support cascading
-- -----------------------------------------------------------------------------
-- Identical to migration 01 EXCEPT both match tiers now exclude any seeker who
-- already has a notification for this spot (`not exists (...)`). That single change
-- turns the function into "notify the next eligible seeker who hasn't been offered
-- this spot yet", so the expiry sweep can just call it again to advance the queue.
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
    and (w.time_preferences is null or v_tod = any(w.time_preferences))
    -- Skip anyone already offered this spot (powers the cascade on expiry).
    and not exists (
      select 1 from public.notifications n
      where n.spot_id = v_spot.id and n.seeker_id = w.seeker_id
    )
  order by w.created_at asc
  limit 1;

  -- TIER 2 — fallback to class-type-only matching.
  if not found then
    select w.* into v_entry
    from public.waitlist_entries w
    where w.class_types @> array[v_spot.class_type]
      and w.seeker_id <> v_spot.poster_id
      and not exists (
        select 1 from public.notifications n
        where n.spot_id = v_spot.id and n.seeker_id = w.seeker_id
      )
    order by w.created_at asc
    limit 1;
  end if;

  -- Waitlist exhausted for this spot (no one new to notify).
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


-- -----------------------------------------------------------------------------
-- 2. expire_stale_notifications() -> void
-- -----------------------------------------------------------------------------
-- Expires every pending notification whose 30-minute window has elapsed, then
-- advances each affected spot to the next eligible seeker by reusing
-- notify_seeker_for_spot(). Processing oldest-first keeps the queue fair.
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
    -- Pass the spot to the next eligible seeker (no-op if the spot was already
    -- claimed or the waitlist is exhausted).
    perform public.notify_seeker_for_spot(r.spot_id);
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Schedule the sweep every minute
-- -----------------------------------------------------------------------------
-- Unschedule first so re-running this migration doesn't error or duplicate the job.
select cron.unschedule('expire-stale-notifications')
where exists (select 1 from cron.job where jobname = 'expire-stale-notifications');

select cron.schedule(
  'expire-stale-notifications',
  '* * * * *',  -- every minute
  $$ select public.expire_stale_notifications(); $$
);
