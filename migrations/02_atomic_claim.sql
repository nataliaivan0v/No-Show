-- =============================================================================
-- Migration 02 — Atomic spot claiming
-- =============================================================================
-- Fixes a race condition: the old client claim flow (src/components/Waitlist/
-- NotificationInbox.tsx :: claim) did a read-free `update spots set status='claimed'`
-- with no guard, so two seekers acting at the same time could both "claim" the same
-- spot. This moves the claim into a single SECURITY DEFINER function whose success
-- hinges on one conditional UPDATE, guaranteeing exactly one winner.
--
-- What this adds:
--   1. spots.claimed_by  -> who claimed the spot (was previously not tracked)
--   2. claim_spot(...)    -> atomic claim; returns the claimed spot row (with booking
--                            info) on success, or NOTHING if the spot was already taken
--
-- Does NOT touch RLS (separate step).
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Track the claimer
-- -----------------------------------------------------------------------------
alter table public.spots
  add column if not exists claimed_by uuid references public.profiles (id);


-- -----------------------------------------------------------------------------
-- 2. claim_spot(p_spot_id, p_notif_id, p_waitlist_entry_id) -> setof spots
-- -----------------------------------------------------------------------------
-- Claims a spot for the calling user (auth.uid()) atomically:
--   * UPDATE the spot to 'claimed' ONLY WHERE it is still 'available' — this single
--     statement is the race guard. Postgres row-locks the spot, so of two concurrent
--     callers exactly one sees status='available' and updates it; the other matches
--     zero rows.
--   * If the spot was already taken (or doesn't exist), the function returns an EMPTY
--     result set so the client can show "this spot was just claimed."
--   * On success: mark the caller's own notification 'claimed', bump the caller's
--     waitlist entry to the back of the queue, and return the full spot row (which
--     includes claim_info / booking details).
--
-- SECURITY DEFINER so the claim works regardless of RLS and can be locked down later.
-- Because it runs with elevated rights, it authorizes the caller explicitly: it only
-- proceeds if the caller actually holds a pending notification for this spot, and it
-- only ever touches the caller's own notification / waitlist rows.
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

  -- The caller must actually hold a pending offer for this spot. If not (wrong user,
  -- already expired, etc.), behave like "already claimed" and return nothing.
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

  -- Mark the caller's own notification as claimed.
  update public.notifications
     set status = 'claimed'
   where id = p_notif_id
     and seeker_id = v_uid;

  -- Bump the caller's waitlist entry to the back of the FIFO queue.
  update public.waitlist_entries
     set created_at = now()
   where id = p_waitlist_entry_id
     and seeker_id = v_uid;

  -- Return the claimed spot (including claim_info) to the caller.
  return next v_spot;
  return;
end;
$$;
