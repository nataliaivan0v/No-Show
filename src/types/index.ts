// pending: notified, waiting for seeker to act
// claimed: seeker accepted within the 30-min window
// expired: timed out or explicitly rejected — triggers notification to the next seeker
export type NotifStatus = "pending" | "claimed" | "expired";

export interface Profile {
  id: string; // matches auth.users.id in Supabase
  full_name: string;
  email: string | null;
  created_at: string;
}

export interface Spot {
  id: string;
  poster_id: string; // the user who posted the spot (references profiles.id)
  title: string;     // class name, e.g. "Morning Flow"
  class_type: string;
  studio: string;
  location: string | null;
  scheduled_at: string; // ISO timestamp of the class
  class_level: string | null;
  instructor: string | null;
  claim_info: string | null; // booking details revealed only after a seeker claims
  status: "available" | "claimed";
  created_at: string;
}

export interface WaitlistEntry {
  id: string;
  seeker_id: string;
  class_types: string[]; // multi-select — seeker is interested in any of these types
  class_level: string | null;
  time_preferences: string[] | null; // "morning" | "afternoon" | "evening", or null for any
  created_at: string; // used as the queue position; bumped to now after a successful claim
}

export interface Notification {
  id: string;
  seeker_id: string;
  spot_id: string;
  waitlist_entry_id: string; // used to resume the queue at the right position on reject/expire
  message: string;
  status: NotifStatus;
  created_at: string;
}
