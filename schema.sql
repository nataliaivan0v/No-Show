-- =============================================================================
-- No Show — Database Schema
-- =============================================================================
-- Reconstructed from the application code (src/lib/*, src/types/index.ts, and all
-- Supabase queries across src/components and src/pages) and the schema described
-- in README.md.
--
-- Target: Supabase (Postgres + Auth + Realtime).
-- Paste this into the Supabase SQL Editor and run it.
--
-- Four tables: profiles, spots, waitlist_entries, notifications.
-- Row Level Security (RLS) is enabled on all of them.
--
-- Conventions used throughout:
--   * Primary keys are uuid, defaulted with gen_random_uuid() (except profiles.id,
--     which mirrors auth.users.id).
--   * created_at is timestamptz defaulting to now().
--   * "authenticated" is Supabase's built-in role for logged-in users.
-- =============================================================================

-- gen_random_uuid() lives in the pgcrypto extension. Supabase usually enables this
-- by default, but we create it defensively so this script is self-contained.
create extension if not exists pgcrypto;


-- =============================================================================
-- Table: profiles
-- -----------------------------------------------------------------------------
-- Basic user information. One row per auth user. The row is created automatically
-- by the handle_new_user() trigger (below) when someone signs up via Supabase Auth.
--
-- Code references:
--   * src/types/index.ts            -> Profile { id, full_name, email, created_at }
--   * PostSpotForm.tsx              -> select full_name where id = posterId
--   * AccountPage.tsx              -> update full_name where id = profile.id
--   * SignupPage.tsx              -> passes options.data.full_name as user metadata,
--                                    which the trigger copies into full_name.
-- =============================================================================
create table if not exists public.profiles (
  -- Mirrors auth.users.id (same value). Cascade-delete so removing an auth user
  -- cleans up their profile.
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null,
  -- email is present on the Profile TypeScript type (nullable) but is never written
  -- by the app code. Included as a nullable column; see "Guesses" note at the bottom.
  email      text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Readable by all authenticated users: the poster's booking name is auto-filled by
-- reading their profile, and matching needs to look up arbitrary users' profiles.
create policy "profiles: read (authenticated)"
  on public.profiles
  for select
  to authenticated
  using (true);

-- Editable by owner only: a user may update only their own profile row.
create policy "profiles: update own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- =============================================================================
-- Trigger: auto-create a profile row on signup
-- -----------------------------------------------------------------------------
-- README documents a Postgres trigger named handle_new_user that inserts a profile
-- when a new auth user is created. full_name comes from the signup metadata set in
-- SignupPage.tsx (options.data.full_name); email is copied from the new auth user.
-- =============================================================================
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();


-- =============================================================================
-- Table: spots
-- -----------------------------------------------------------------------------
-- Every class spot that has been posted. Each spot belongs to the user who posted it.
--
-- Code references:
--   * src/types/index.ts   -> Spot { ... status: "available" | "claimed" }
--   * PostSpotForm.tsx     -> insert { poster_id, title, class_type, studio, location,
--                              scheduled_at, class_level, instructor, claim_info }
--   * WaitlistForm.tsx     -> select where status = 'available' and class_type in (...)
--   * matching.ts          -> reads class_type, class_level, instructor, location,
--                              studio, title, scheduled_at, poster_id
--   * NotificationInbox.tsx / Dashboard.tsx -> update status = 'claimed'
-- =============================================================================
create table if not exists public.spots (
  id           uuid primary key default gen_random_uuid(),
  poster_id    uuid not null references public.profiles (id) on delete cascade,
  title        text not null,             -- class name, e.g. "Morning Flow"
  class_type   text not null,             -- e.g. Yoga, Spin
  studio       text not null,             -- studio name
  location     text,                      -- studio address (optional)
  scheduled_at timestamptz not null,      -- class date and time
  class_level  text,                      -- optional
  instructor   text,                      -- optional
  claim_info   text,                      -- booking details, revealed only after a claim
  -- 'available' when posted, 'claimed' once a seeker takes it.
  status       text not null default 'available'
                 check (status in ('available', 'claimed')),
  -- Seeker who claimed the spot. Added in migrations/02_atomic_claim.sql.
  claimed_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  -- Must be posted at least 1 hour before the class. Added in
  -- migrations/04_constraints.sql; anchored to created_at (not now()) so it stays
  -- immutable across later updates.
  constraint spots_posted_at_least_1h_before
    check (scheduled_at >= created_at + interval '1 hour')
);

-- Matching and the waitlist query filter spots by status and class_type.
create index if not exists spots_status_class_type_idx
  on public.spots (status, class_type);
create index if not exists spots_poster_id_idx
  on public.spots (poster_id);

alter table public.spots enable row level security;

-- Readable by all authenticated users: anyone logged in can browse available spots,
-- and matching reads spots when a seeker joins the waitlist.
create policy "spots: read (authenticated)"
  on public.spots
  for select
  to authenticated
  using (true);

-- Insertable by authenticated users: there are no fixed roles; any user may post.
-- The check ties the row to the inserting user.
create policy "spots: insert (authenticated)"
  on public.spots
  for insert
  to authenticated
  with check (auth.uid() = poster_id);

-- Updatable by authenticated users: both the poster (managing a listing) and a
-- seeker (marking a spot claimed) need update access, so this is intentionally open
-- to any authenticated user rather than owner-only.
create policy "spots: update (authenticated)"
  on public.spots
  for update
  to authenticated
  using (true)
  with check (true);

-- Deletable by owner only: only the poster may delete their own listing.
create policy "spots: delete own"
  on public.spots
  for delete
  to authenticated
  using (auth.uid() = poster_id);


-- =============================================================================
-- Table: waitlist_entries
-- -----------------------------------------------------------------------------
-- Each user's waitlist preferences. created_at doubles as the queue position (FIFO);
-- it is bumped to now() after a successful claim to move the seeker to the back.
--
-- Code references:
--   * src/types/index.ts   -> WaitlistEntry { id, seeker_id, class_types,
--                              class_level, time_preferences, created_at }
--   * WaitlistForm.tsx     -> insert/update { seeker_id, class_types, class_level,
--                              time_preferences }; select where seeker_id = ...
--   * matching.ts          -> select where class_types contains [spot.class_type],
--                              ordered by created_at ascending
--   * NotificationInbox.tsx -> update created_at = now() after a claim
-- =============================================================================
create table if not exists public.waitlist_entries (
  id               uuid primary key default gen_random_uuid(),
  seeker_id        uuid not null references public.profiles (id) on delete cascade,
  -- Array of preferred class types; matching uses `.contains("class_types", [...])`,
  -- which requires an array column.
  class_types      text[] not null,
  class_level      text,        -- optional preferred level
  -- morning / afternoon / evening, or null for "any". Nullable array.
  time_preferences text[],
  created_at       timestamptz not null default now()  -- queue position
);

-- One waitlist entry per user. Added in migrations/04_constraints.sql; this unique
-- index also covers seeker_id lookups (so a separate non-unique index isn't needed).
create unique index if not exists waitlist_entries_one_per_seeker
  on public.waitlist_entries (seeker_id);
-- Matching filters by the class_types array.
create index if not exists waitlist_entries_class_types_idx
  on public.waitlist_entries using gin (class_types);

alter table public.waitlist_entries enable row level security;

-- Readable by all authenticated users: matching runs in the browser as the posting
-- user and must query every waitlist entry to find matching seekers.
create policy "waitlist_entries: read (authenticated)"
  on public.waitlist_entries
  for select
  to authenticated
  using (true);

-- Insertable by owner only: a user may only add a waitlist entry for themselves.
create policy "waitlist_entries: insert own"
  on public.waitlist_entries
  for insert
  to authenticated
  with check (auth.uid() = seeker_id);

-- Updatable by owner only: only the seeker may edit preferences or have their queue
-- position (created_at) adjusted.
create policy "waitlist_entries: update own"
  on public.waitlist_entries
  for update
  to authenticated
  using (auth.uid() = seeker_id)
  with check (auth.uid() = seeker_id);

-- Deletable by owner only.
create policy "waitlist_entries: delete own"
  on public.waitlist_entries
  for delete
  to authenticated
  using (auth.uid() = seeker_id);


-- =============================================================================
-- Table: notifications
-- -----------------------------------------------------------------------------
-- Created by the matching engine when a seeker is found for a spot. Represents a
-- pending / claimed / expired offer to a specific seeker. created_at drives the
-- client-side 30-minute countdown.
--
-- Code references:
--   * src/types/index.ts   -> Notification { id, seeker_id, spot_id,
--                              waitlist_entry_id, message, status, created_at }
--                              NotifStatus = "pending" | "claimed" | "expired"
--   * matching.ts          -> insert { seeker_id, spot_id, waitlist_entry_id,
--                              message, status: 'pending' }; update status='expired'
--   * NotificationInbox.tsx -> select where seeker_id = ...; update status='claimed';
--                              delete; realtime subscription on this table
-- =============================================================================
create table if not exists public.notifications (
  id                uuid primary key default gen_random_uuid(),
  seeker_id         uuid not null references public.profiles (id) on delete cascade,
  -- README states spot deletion cascades to its notifications.
  spot_id           uuid not null references public.spots (id) on delete cascade,
  waitlist_entry_id uuid not null references public.waitlist_entries (id) on delete cascade,
  message           text not null,
  status            text not null default 'pending'
                      check (status in ('pending', 'claimed', 'expired')),
  created_at        timestamptz not null default now()  -- start of the 30-min window
);

-- The inbox fetches by seeker_id ordered by created_at.
create index if not exists notifications_seeker_id_idx
  on public.notifications (seeker_id);
create index if not exists notifications_spot_id_idx
  on public.notifications (spot_id);

alter table public.notifications enable row level security;

-- Readable by recipient only: a seeker sees only their own notifications (they carry
-- private spot/booking info).
create policy "notifications: read own"
  on public.notifications
  for select
  to authenticated
  using (auth.uid() = seeker_id);

-- Insertable by authenticated users: the matching engine runs as the posting user
-- but inserts a notification addressed to a *different* user (the matched seeker),
-- so this cannot be owner-only.
create policy "notifications: insert (authenticated)"
  on public.notifications
  for insert
  to authenticated
  with check (true);

-- Updatable by authenticated users: both the seeker (claim/reject) and the system
-- (expiry) update status, and the updater is not always the recipient.
create policy "notifications: update (authenticated)"
  on public.notifications
  for update
  to authenticated
  using (true)
  with check (true);

-- Deletable by recipient only: only the seeker can clear their own inbox.
create policy "notifications: delete own"
  on public.notifications
  for delete
  to authenticated
  using (auth.uid() = seeker_id);


-- =============================================================================
-- Realtime
-- -----------------------------------------------------------------------------
-- NotificationInbox.tsx subscribes to postgres_changes on public.notifications.
-- The table must be part of the supabase_realtime publication for that to fire.
-- (Wrapped so re-running the script doesn't error if it's already a member.)
-- =============================================================================
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;  -- already in the publication
  when undefined_object then null;  -- publication doesn't exist in this project
end
$$;
