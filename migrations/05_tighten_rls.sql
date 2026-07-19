-- =============================================================================
-- Migration 05 — Tighten RLS now that writes go through SECURITY DEFINER functions
-- =============================================================================
-- Matching, notification creation, claiming, and expiry all now run inside SECURITY
-- DEFINER functions (migrations 01–04), which bypass RLS. That lets us remove the
-- permissive policies the browser previously required.
--
-- Policy changes:
--   * waitlist_entries — readable by OWNER ONLY (was: all authenticated). The browser
--     no longer scans the whole waitlist; the definer matching functions do.
--   * notifications    — DROP the broad "insert by any authenticated" policy (only the
--     definer functions insert now). Keep SELECT + DELETE for the recipient only.
--     The broad UPDATE policy is also dropped: claim/reject now go through definer
--     RPCs, so no client updates notifications directly.
--   * spots            — DROP the broad UPDATE policy so claiming can ONLY happen via
--     claim_spot(). SELECT (browse), INSERT (own), DELETE (own) are kept.
--
-- To make this work end to end, two flows that still ran in the browser are moved
-- into definer RPCs here (they were the only remaining client-side notification
-- inserts / cross-user waitlist reads):
--   * notify_available_spots_for_me() — replaces WaitlistForm's join-time matching
--   * reject_and_advance(uuid)        — replaces NotificationInbox's rejectSpot
--
-- Because the exact policy names in your database are unknown, this migration drops
-- ALL existing policies on the three tables and recreates the desired set, so the end
-- state is deterministic regardless of prior names. profiles is left untouched.
--
-- Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. RPC: notify_available_spots_for_me()
-- -----------------------------------------------------------------------------
-- Called by a seeker after joining/updating their waitlist entry. Scans currently
-- available spots that match their class types (excluding their own) and that have no
-- pending offer outstanding, and notifies the next eligible seeker for each — reusing
-- notify_seeker_for_spot(). Returns how many notifications were created.
--
-- (Improvement over the old client code, which only handled the first matching spot
-- and could create a second pending offer for a spot that already had one.)
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

  -- One entry per user (enforced by the unique index in migration 04).
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


-- -----------------------------------------------------------------------------
-- 2. RPC: reject_and_advance(p_notif_id)
-- -----------------------------------------------------------------------------
-- Called when a seeker clicks "Not Interested". Marks their own pending notification
-- expired and advances the spot to the next eligible seeker. Mirrors the old
-- rejectSpot(), but server-side and scoped to the caller's own notification.
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

  -- Only the recipient can reject, and only a still-pending offer.
  select * into v_notif
  from public.notifications
  where id = p_notif_id and seeker_id = v_uid and status = 'pending';
  if not found then
    return;
  end if;

  update public.notifications set status = 'expired' where id = p_notif_id;

  -- notify_seeker_for_spot skips seekers already notified for this spot (including
  -- the one we just expired), so it advances to the next person in line.
  perform public.notify_seeker_for_spot(v_notif.spot_id);
end;
$$;

grant execute on function public.notify_available_spots_for_me() to authenticated;
grant execute on function public.reject_and_advance(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 3. Drop all existing policies on the three tables (names may vary in your DB)
-- -----------------------------------------------------------------------------
do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('waitlist_entries', 'notifications', 'spots')
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- RLS stays enabled (these are no-ops if it already is).
alter table public.waitlist_entries enable row level security;
alter table public.notifications    enable row level security;
alter table public.spots            enable row level security;


-- -----------------------------------------------------------------------------
-- 4. waitlist_entries — owner only for everything
-- -----------------------------------------------------------------------------
-- TIGHTENED: select is now owner-only (was readable by all authenticated).
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


-- -----------------------------------------------------------------------------
-- 5. notifications — recipient may read/delete; no client insert or update
-- -----------------------------------------------------------------------------
-- Inserts come only from definer functions (matching/cascade). Updates (claim/expire)
-- come only from definer functions (claim_spot / reject_and_advance / cron). So there
-- are deliberately NO insert or update policies here.
create policy "notifications: select own"
  on public.notifications for select to authenticated
  using (auth.uid() = seeker_id);

create policy "notifications: delete own"
  on public.notifications for delete to authenticated
  using (auth.uid() = seeker_id);


-- -----------------------------------------------------------------------------
-- 6. spots — browse/insert/delete from client; claiming only via claim_spot()
-- -----------------------------------------------------------------------------
-- TIGHTENED: no UPDATE policy, so the client cannot flip status directly; claim_spot()
-- (SECURITY DEFINER) is the only way a spot becomes claimed. If you later add a
-- poster "edit listing" feature, add a poster-scoped UPDATE policy for it.
create policy "spots: select (authenticated)"
  on public.spots for select to authenticated
  using (true);

create policy "spots: insert own"
  on public.spots for insert to authenticated
  with check (auth.uid() = poster_id);

create policy "spots: delete own"
  on public.spots for delete to authenticated
  using (auth.uid() = poster_id);
