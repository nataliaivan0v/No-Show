/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useState, useRef } from "react";
import { supabase } from "../../lib/supabase";
import { type Notification, type NotifStatus, type Spot } from "../../types";

// How long a seeker has to claim a spot before it expires and moves to the next person
const EXPIRY_MS = 2 * 60 * 1000;

// True once a notification's 30-min window has elapsed, computed purely client-side
// from created_at. Used to hide the claim/reject buttons the instant time runs out,
// without waiting for the server-side cron to flip the status.
const isTimeUp = (createdAt: string) =>
  Date.now() >= new Date(createdAt).getTime() + EXPIRY_MS;

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

  // Sets up a countdown timer that fires a callback when time runs out
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
  // Per-notification message shown when a claim loses the race (spot already taken)
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({});
  // IDs whose countdown has hit zero this session — lets us flip a still-'pending'
  // row to an expired display immediately, before the server/cron catches up.
  const [expiredIds, setExpiredIds] = useState<Set<string>>(new Set());

  const markExpired = (id: string) =>
    setExpiredIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  const fetchNotifs = () =>
    supabase
      .from("notifications")
      .select("*")
      .eq("seeker_id", seekerId)
      .order("created_at", { ascending: false })
      .then(({ data }) => setNotifs(data ?? []));

  // Initial fetch + realtime subscription so the inbox updates without a page refresh.
  // We listen for INSERT, UPDATE and DELETE on this seeker's own rows and patch local
  // state directly from the payload, so status changes (expired via cron, claimed,
  // queue advancement) reflect immediately without a refetch. RLS (notifications are
  // recipient-only SELECT) plus the seeker_id filter means we only ever receive our
  // own rows.
  useEffect(() => {
    fetchNotifs();
    const filter = `seeker_id=eq.${seekerId}`;
    const channel = supabase
      .channel(`notif-inbox-${seekerId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter },
        (payload) => {
          const row = payload.new as Notification;
          setNotifs((prev) =>
            prev.some((n) => n.id === row.id) ? prev : [row, ...prev],
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "notifications", filter },
        (payload) => {
          const row = payload.new as Notification;
          setNotifs((prev) =>
            prev.map((n) => (n.id === row.id ? { ...n, ...row } : n)),
          );
        },
      )
      .on(
        "postgres_changes",
        // DELETE payloads only carry the primary key unless the table uses REPLICA
        // IDENTITY FULL; in-app deletes are already removed optimistically, so this
        // just keeps other sessions in sync when it does fire.
        { event: "DELETE", schema: "public", table: "notifications", filter },
        (payload) => {
          const oldRow = payload.old as { id?: string };
          if (oldRow?.id)
            setNotifs((prev) => prev.filter((n) => n.id !== oldRow.id));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [seekerId]);

  // Claims the spot atomically via the claim_spot() DB function (migrations/
  // 02_atomic_claim.sql). The function marks the spot + notification claimed and
  // bumps the waitlist entry in one transaction, but only if the spot is still
  // available — so if two seekers claim at once, exactly one wins. The winner gets
  // the spot row back (with booking info); the loser gets an empty result.
  const claim = async (
    notifId: string,
    spotId: string,
    waitlistEntryId: string,
  ) => {
    const { data, error } = await supabase.rpc("claim_spot", {
      p_spot_id: spotId,
      p_notif_id: notifId,
      p_waitlist_entry_id: waitlistEntryId,
    });

    if (error) {
      setClaimErrors((prev) => ({ ...prev, [notifId]: error.message }));
      return;
    }

    // Empty result → the spot was already taken by someone else.
    const spot = (data as Spot[] | null)?.[0];
    if (!spot) {
      setClaimErrors((prev) => ({
        ...prev,
        [notifId]: "This spot was just claimed by someone else.",
      }));
      fetchNotifs();
      return;
    }

    setClaimedSpots((prev) => ({ ...prev, [spotId]: spot }));
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

  // Expiry is enforced server-side by a pg_cron job (migrations/03_expiry_cron.sql),
  // which marks the notification expired and advances the queue. When the local
  // countdown hits zero we don't wait for that: we mark the row expired in local
  // state so the buttons hide and the badge flips immediately. Realtime reconciles
  // with the authoritative status once cron runs.
  const handleExpire = (id: string) => {
    markExpired(id);
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
        {notifs.map((n) => {
          // Flip a still-'pending' row to an expired display the moment its timer is
          // up (recorded in expiredIds when the countdown fires, or computed from
          // created_at on mount) so the buttons vanish without waiting on the server.
          const effStatus: NotifStatus =
            n.status === "pending" &&
            (expiredIds.has(n.id) || isTimeUp(n.created_at))
              ? "expired"
              : n.status;
          return (
          <div
            key={n.id}
            style={{
              background: "#fff",
              border: `1.5px solid ${statusColor[effStatus]}`,
              borderRadius: 16,
              padding: "20px 24px",
              borderLeft: `5px solid ${statusColor[effStatus]}`,
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
                marginBottom: effStatus === "pending" ? 14 : 0,
              }}
            >
              <span
                style={{
                  background: statusBg[effStatus],
                  color: statusColor[effStatus],
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "3px 10px",
                  borderRadius: 100,
                  textTransform: "capitalize",
                }}
              >
                ● {effStatus}
              </span>
              {effStatus === "pending" && (
                <Countdown
                  createdAt={n.created_at}
                  onExpire={() => handleExpire(n.id)}
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

            {effStatus === "pending" && (
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
                    supabase
                      .rpc("reject_and_advance", { p_notif_id: n.id })
                      .then(fetchNotifs)
                  }
                  style={rejectBtnStyle}
                >
                  ✕ Not Interested
                </button>
              </div>
            )}

            {/* Shown when this seeker lost the claim race */}
            {claimErrors[n.id] && (
              <p style={{ color: "#ef4444", fontSize: 13, marginTop: 12 }}>
                {claimErrors[n.id]}
              </p>
            )}
          </div>
          );
        })}
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
