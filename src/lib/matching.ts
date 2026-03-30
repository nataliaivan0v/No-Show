import { supabase } from "./supabase";

// Finds the next eligible seeker on the waitlist for a given spot and sends them a notification.
// Returns true if a seeker was notified, false if no match was found or the waitlist is exhausted.
//
// afterEntryId: when provided, skips to the seeker *after* that entry — used when cascading
// through the waitlist after a rejection or timeout.
export async function notifyNextSeeker(
  spotId: string,
  afterEntryId?: string,
): Promise<boolean> {
  const { data: spot } = await supabase
    .from("spots")
    .select("*")
    .eq("id", spotId)
    .single();
  if (!spot) return false;

  // Find all waitlist entries whose class_types include this spot's type,
  // excluding the poster (they can't claim their own spot), ordered by join time (FIFO)
  const { data: matches } = await supabase
    .from("waitlist_entries")
    .select("*")
    .contains("class_types", [spot.class_type])
    .neq("seeker_id", spot.poster_id)
    .order("created_at", { ascending: true });

  if (!matches?.length) return false;

  // Default to the first person in line; if afterEntryId is set, advance one position
  let target = matches[0];
  if (afterEntryId) {
    const idx = matches.findIndex((e) => e.id === afterEntryId);
    if (idx === -1 || idx + 1 >= matches.length) return false;
    target = matches[idx + 1];
  }

  // Build an optional detail line (e.g. "Level 2 · with Sarah M. · 123 Newbury St")
  const details = [
    spot.class_level,
    spot.instructor ? `with ${spot.instructor}` : null,
    spot.location,
  ]
    .filter(Boolean)
    .join(" · ");

  const message = [
    `A ${spot.class_type} spot at ${spot.studio}${spot.title ? ` (${spot.title})` : ""} is available on ${new Date(spot.scheduled_at).toLocaleString()}.`,
    details || null,
    `Claim it before it's gone!`,
  ]
    .filter(Boolean)
    .join("\n");

  await supabase.from("notifications").insert({
    seeker_id: target.seeker_id,
    spot_id: spot.id,
    waitlist_entry_id: target.id,
    message,
    status: "pending",
  });

  return true;
}

// Marks the current notification as expired (rejected or timed out) and passes
// the spot to the next seeker in line
export async function rejectSpot(
  notifId: string,
  spotId: string,
  waitlistEntryId: string,
): Promise<void> {
  await supabase
    .from("notifications")
    .update({ status: "expired" })
    .eq("id", notifId);

  await notifyNextSeeker(spotId, waitlistEntryId);
}

// Dev/test utility to manually trigger a timeout on a spot's pending notification,
// simulating what happens when a seeker's 30-minute claim window runs out
export async function simulateTimeout(spotId: string): Promise<string> {
  const { data: notif } = await supabase
    .from("notifications")
    .select("*")
    .eq("spot_id", spotId)
    .eq("status", "pending")
    .maybeSingle();

  if (!notif) return "No pending notification for this spot";

  await supabase
    .from("notifications")
    .update({ status: "expired" })
    .eq("id", notif.id);

  const moved = await notifyNextSeeker(spotId, notif.waitlist_entry_id);
  return moved
    ? "⏱ Timed out — next seeker on waitlist notified"
    : "⏱ Timed out — waitlist exhausted, no more seekers";
}
