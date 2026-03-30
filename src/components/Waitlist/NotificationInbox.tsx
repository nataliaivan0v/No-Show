/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useState, useRef } from "react";
import { supabase } from "../../lib/supabase";
import { type Notification, type NotifStatus, type Spot } from "../../types";
import { rejectSpot } from "../../lib/matching";

// How long a seeker has to claim a spot before it expires and moves to the next person
const EXPIRY_MS = 30 * 60 * 1000;

// Text color and background color for each notification status badge
const statusColor: Record<NotifStatus, string> = {
  pending: "#F35C20",
  claimed: "#22c55e",
  expired: "#ef4444",
};

const statusBg: Record<NotifStatus, string> = {
  pending: "#fff3ee",
  claimed: "#f0fdf4",
  expired: "#fef2f2",
};

// Displays a live countdown for pending notifications; calls onExpire when time runs out
function Countdown({
  createdAt,
  onExpire,
}: {
  createdAt: string;
  onExpire: () => void;
}) {
  const expiresAt = new Date(createdAt).getTime() + EXPIRY_MS;
  const calcRemaining = () => Math.max(0, expiresAt - Date.now());
  const [remaining, setRemaining] = useState(calcRemaining);
  // Ref prevents onExpire from firing more than once if the interval ticks at 0 multiple times
  const firedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const r = calcRemaining();
      setRemaining(r);
      if (r === 0 && !firedRef.current) {
        firedRef.current = true;
        clearInterval(interval);
        onExpire();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [createdAt]);

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  // Turn red when under 5 minutes to signal urgency
  const isUrgent = remaining < 5 * 60 * 1000;

  return (
    <span
      style={{
        fontSize: 13,
        fontWeight: 700,
        color: isUrgent ? "#ef4444" : "#F35C20",
      }}
    >
      ⏱ {mins}:{secs.toString().padStart(2, "0")} remaining
    </span>
  );
}

export default function NotificationInbox({ seekerId }: { seekerId: string }) {
  const [notifs, setNotifs] = useState<Notification[]>([]);
  // Stores full spot data for claimed notifications so booking info can be shown
  const [claimedSpots, setClaimedSpots] = useState<Record<string, Spot>>({});

  const fetchNotifs = () =>
    supabase
      .from("notifications")
      .select("*")
      .eq("seeker_id", seekerId)
      .order("created_at", { ascending: false })
      .then(({ data }) => setNotifs(data ?? []));

  // Initial fetch + realtime subscription so the inbox updates without a page refresh
  useEffect(() => {
    fetchNotifs();
    const channel = supabase
      .channel("notif-inbox")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `seeker_id=eq.${seekerId}`,
        },
        fetchNotifs,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [seekerId]);

  // Marks the notification and spot as claimed, bumps the waitlist entry timestamp
  // (resetting its queue position), then fetches the full spot to reveal booking info
  const claim = async (
    notifId: string,
    spotId: string,
    waitlistEntryId: string,
  ) => {
    await supabase
      .from("notifications")
      .update({ status: "claimed" })
      .eq("id", notifId);
    await supabase.from("spots").update({ status: "claimed" }).eq("id", spotId);
    // Bumping created_at resets the entry's position so it goes to the back of the queue next time
    await supabase
      .from("waitlist_entries")
      .update({ created_at: new Date().toISOString() })
      .eq("id", waitlistEntryId);
    const { data: spot } = await supabase
      .from("spots")
      .select("*")
      .eq("id", spotId)
      .single();
    if (spot) setClaimedSpots((prev) => ({ ...prev, [spotId]: spot }));
    fetchNotifs();
  };

  // Removes a single notification from the DB and local state
  const deleteNotif = async (notifId: string) => {
    await supabase.from("notifications").delete().eq("id", notifId);
    setNotifs((prev) => prev.filter((n) => n.id !== notifId));
  };

  // Wipes all notifications for this seeker at once
  const clearAll = async () => {
    await supabase.from("notifications").delete().eq("seeker_id", seekerId);
    setNotifs([]);
    setClaimedSpots({});
  };

  // Called by Countdown when time runs out — rejects the spot so the next seeker can be notified
  const handleExpire = async (n: Notification) => {
    await rejectSpot(n.id, n.spot_id, n.waitlist_entry_id);
    fetchNotifs();
  };

  return (
    <div>
      <h2
        style={{
          fontFamily: "'Berkshire Swash', cursive",
          fontSize: 26,
          color: "#111",
          marginBottom: 6,
        }}
      >
        Notifications
      </h2>

      {/* Clear All — constrained to same width as cards */}
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto 28px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
        }}
      >
        {notifs.length > 0 && (
          <button
            onClick={clearAll}
            style={{
              background: "transparent",
              color: "#aaa",
              border: "1.5px solid #e8e0d8",
              padding: "7px 16px",
              borderRadius: 100,
              fontSize: 13,
              fontFamily: "'Afacad', sans-serif",
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "#ef4444";
              e.currentTarget.style.borderColor = "#ef4444";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "#aaa";
              e.currentTarget.style.borderColor = "#e8e0d8";
            }}
          >
            Clear All
          </button>
        )}
      </div>

      {notifs.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "60px 24px",
            background: "#fff",
            borderRadius: 16,
            border: "1px solid #f0e8e0",
            maxWidth: 560,
            margin: "0 auto",
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
          <p style={{ color: "#aaa", fontSize: 15 }}>
            No notifications yet. Join the waitlist to get notified when a spot
            opens up.
          </p>
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          maxWidth: 720,
          margin: "0 auto",
        }}
      >
        {notifs.map((n) => (
          <div
            key={n.id}
            style={{
              background: "#fff",
              border: `1.5px solid ${statusColor[n.status]}`,
              borderRadius: 16,
              padding: "20px 24px",
              borderLeft: `5px solid ${statusColor[n.status]}`,
              textAlign: "center",
              position: "relative",
            }}
          >
            <button
              onClick={() => deleteNotif(n.id)}
              style={{
                position: "absolute",
                top: 10,
                right: 12,
                background: "none",
                border: "none",
                fontSize: 16,
                color: "#ccc",
                cursor: "pointer",
                lineHeight: 1,
                padding: 4,
              }}
              onMouseOver={(e) => (e.currentTarget.style.color = "#ef4444")}
              onMouseOut={(e) => (e.currentTarget.style.color = "#ccc")}
            >
              ✕
            </button>

            <p
              style={{
                fontSize: 15,
                color: "#333",
                marginBottom: 12,
                lineHeight: 1.7,
                whiteSpace: "pre-line",
              }}
            >
              {n.message}
            </p>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: n.status === "pending" ? 14 : 0,
              }}
            >
              <span
                style={{
                  background: statusBg[n.status],
                  color: statusColor[n.status],
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "3px 10px",
                  borderRadius: 100,
                  textTransform: "capitalize",
                }}
              >
                ● {n.status}
              </span>
              {n.status === "pending" && (
                <Countdown
                  createdAt={n.created_at}
                  onExpire={() => handleExpire(n)}
                />
              )}
            </div>

            {/* Booking info is only revealed after the seeker claims — fetched in claim() */}
            {n.status === "claimed" && claimedSpots[n.spot_id]?.claim_info && (
              <div
                style={{
                  textAlign: "left",
                  marginTop: 14,
                  padding: "14px 16px",
                  background: "#f0fdf4",
                  borderRadius: 10,
                  border: "1px solid #86efac",
                }}
              >
                <p
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    marginBottom: 6,
                    color: "#166534",
                  }}
                >
                  Booking Info
                </p>
                <p
                  style={{
                    fontSize: 13,
                    whiteSpace: "pre-wrap",
                    color: "#333",
                    margin: 0,
                  }}
                >
                  {claimedSpots[n.spot_id].claim_info}
                </p>
              </div>
            )}

            {n.status === "pending" && (
              <div
                style={{ display: "flex", gap: 10, justifyContent: "center" }}
              >
                <button
                  onClick={() => claim(n.id, n.spot_id, n.waitlist_entry_id)}
                  style={claimBtnStyle}
                >
                  ✅ Claim Spot
                </button>
                <button
                  onClick={() =>
                    rejectSpot(n.id, n.spot_id, n.waitlist_entry_id).then(
                      fetchNotifs,
                    )
                  }
                  style={rejectBtnStyle}
                >
                  ✕ Not Interested
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Shared button styles for the claim/reject actions on pending notifications
const claimBtnStyle: React.CSSProperties = {
  background: "#F35C20",
  color: "#fff",
  border: "none",
  padding: "10px 20px",
  borderRadius: 100,
  fontSize: 14,
  fontFamily: "'Afacad', sans-serif",
  fontWeight: 600,
  cursor: "pointer",
};

const rejectBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#ef4444",
  border: "1.5px solid #ef4444",
  padding: "10px 20px",
  borderRadius: 100,
  fontSize: 14,
  fontFamily: "'Afacad', sans-serif",
  fontWeight: 600,
  cursor: "pointer",
};
