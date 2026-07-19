// ---------------------------------------------------------------------------
// PURE REFERENCE IMPLEMENTATION of the spot -> seeker matching decision.
//
// This is NOT called by the app at runtime. Matching runs server-side in the
// SECURITY DEFINER function public.notify_seeker_for_spot() (see
// migrations/01_server_side_matching.sql and 03/05). This file re-expresses that
// function's *decision logic* as pure, dependency-free TypeScript so it can be unit
// tested quickly and serve as an executable spec.
//
// KEEP IN SYNC with notify_seeker_for_spot(). The rules mirrored here:
//   * candidate must have the spot's class_type in its class_types array
//   * the poster is never matched to their own spot
//   * seekers already notified for this spot are skipped (this is what advances the
//     queue on expiry/reject)
//   * TIER 1 (exact): class_level equal (NULL = NULL) AND the spot's time-of-day is in
//     the seeker's time_preferences (NULL preferences = "any")
//   * TIER 2 (fallback): class_type match only
//   * within a tier, the earliest created_at (FIFO queue position) wins
// ---------------------------------------------------------------------------

import type { Spot, WaitlistEntry } from "../types";

export type TimeOfDay = "morning" | "afternoon" | "evening";

// Only the fields matching actually depends on — tied to the real DB-backed types.
export type MatchSpot = Pick<
  Spot,
  "class_type" | "class_level" | "scheduled_at" | "poster_id"
>;

export type MatchCandidate = Pick<
  WaitlistEntry,
  "id" | "seeker_id" | "class_types" | "class_level" | "time_preferences" | "created_at"
>;

// Mirrors public.spot_time_of_day(). The SQL reads the hour in the DB session time
// zone (UTC on Supabase), so we use UTC hours here to match. Boundaries: morning < 12,
// afternoon < 17, evening otherwise.
export function spotTimeOfDay(scheduledAt: string): TimeOfDay {
  const hour = new Date(scheduledAt).getUTCHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

// Mirrors SQL `class_level is not distinct from class_level` (NULL equals NULL).
function levelMatches(entryLevel: string | null, spotLevel: string | null): boolean {
  return entryLevel === spotLevel;
}

// Mirrors SQL `time_preferences is null or tod = any(time_preferences)`.
// NULL/empty preferences means "any time".
function timeMatches(
  timePreferences: string[] | null,
  tod: TimeOfDay,
): boolean {
  if (timePreferences === null || timePreferences.length === 0) return true;
  return timePreferences.includes(tod);
}

// Returns the entry with the earliest created_at (FIFO), preserving input order on
// exact ties (deterministic; SQL's `order by created_at limit 1` is unspecified on
// exact-timestamp ties). Returns null for an empty list.
function earliest(entries: MatchCandidate[]): MatchCandidate | null {
  return entries.reduce<MatchCandidate | null>((best, e) => {
    if (best === null) return e;
    return new Date(e.created_at).getTime() < new Date(best.created_at).getTime()
      ? e
      : best;
  }, null);
}

// The core decision: pick the best-matching waitlist entry for a spot, or null.
// `alreadyNotifiedSeekerIds` are seekers who have already been offered this spot
// (any notification status) and are therefore skipped — this is how the cascade
// advances through the queue on expiry/reject.
export function findMatch(
  spot: MatchSpot,
  entries: MatchCandidate[],
  alreadyNotifiedSeekerIds: readonly string[] = [],
): MatchCandidate | null {
  const notified = new Set(alreadyNotifiedSeekerIds);

  const eligible = entries.filter(
    (e) =>
      e.class_types.includes(spot.class_type) &&
      e.seeker_id !== spot.poster_id &&
      !notified.has(e.seeker_id),
  );

  const tod = spotTimeOfDay(spot.scheduled_at);

  // TIER 1 — exact match on level + time-of-day.
  const exact = eligible.filter(
    (e) =>
      levelMatches(e.class_level, spot.class_level) &&
      timeMatches(e.time_preferences, tod),
  );
  const tier1 = earliest(exact);
  if (tier1) return tier1;

  // TIER 2 — fallback to class-type-only.
  return earliest(eligible);
}
