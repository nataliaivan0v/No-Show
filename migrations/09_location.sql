-- =============================================================================
-- Migration 09 — Location columns for distance-based matching
-- =============================================================================
-- Design: geocode addresses ONCE at write time (in the edge functions) and store
-- the coordinates here. Search/matching then filters by distance in SQL using the
-- earthdistance extension — never geocoding during a query.
--
-- Assumes the `cube` and `earthdistance` extensions are already enabled.
-- Safe to re-run (ADD COLUMN IF NOT EXISTS).
-- =============================================================================

-- Spots already have a `location` text address; add its geocoded coordinates.
alter table public.spots
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- Waitlist entries get the seeker's preferred coordinates plus how far they'll travel.
alter table public.waitlist_entries
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists max_distance_miles integer not null default 10;

-- Reference — how distance filtering will look at search time (earthdistance returns
-- meters; 1 mile ≈ 1609.34 m). No geocoding happens here, only arithmetic on stored
-- coordinates:
--
--   select *
--   from public.spots s
--   where s.lat is not null and s.lng is not null
--     and earth_distance(
--           ll_to_earth(s.lat, s.lng),
--           ll_to_earth(:seeker_lat, :seeker_lng)
--         ) <= :max_distance_miles * 1609.34;
--
-- Optional (uncomment to speed up large tables): a GiST index on the earth point.
--   create index if not exists spots_earth_idx
--     on public.spots using gist (ll_to_earth(lat, lng))
--     where lat is not null and lng is not null;
