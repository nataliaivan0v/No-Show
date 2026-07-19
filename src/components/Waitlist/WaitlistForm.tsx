import { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase";
import { geocode } from "../../lib/geocode";
import { type WaitlistEntry } from "../../types";

// Options for the preference dropdowns/pills
const CLASS_TYPES = [
  "Yoga",
  "Spin",
  "Pilates",
  "HIIT",
  "Barre",
  "Cycling",
  "Boxing",
  "Dance",
  "Strength",
  "Other",
];
const CLASS_LEVELS = [
  "All Levels",
  "Beginner",
  "Level 1",
  "Level 1.5",
  "Level 2",
  "Intermediate",
  "Advanced",
];
const TIME_PREFS = [
  { value: "morning", label: "Morning", hint: "Before 12pm" },
  { value: "afternoon", label: "Afternoon", hint: "12pm – 5pm" },
  { value: "evening", label: "Evening", hint: "After 5pm" },
];
// Distance options (miles) for the "how far will you travel" selector
const DISTANCE_OPTIONS = [2, 5, 10, 25];

export default function WaitlistForm({ seekerId }: { seekerId: string }) {
  // existing: the seeker's current waitlist entry, or null if they haven't joined yet
  const [existing, setExisting] = useState<WaitlistEntry | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [classLevel, setClassLevel] = useState("");
  const [timePref, setTimePref] = useState<string[]>([]);
  // Preferred location (address text, geocoded on save) + how far the seeker travels.
  // The address text isn't stored (only lat/lng + distance are), so it's left blank
  // on edit; the saved distance is reloaded below.
  const [locationInput, setLocationInput] = useState("");
  const [maxDistance, setMaxDistance] = useState(10);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  // Fetch the seeker's existing waitlist entry on mount and pre-populate the form fields
  useEffect(() => {
    supabase
      .from("waitlist_entries")
      .select("*")
      .eq("seeker_id", seekerId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setExisting(data);
          setSelectedTypes(data.class_types);
          setClassLevel(data.class_level ?? "");
          setTimePref(data.time_preferences ?? []);
          setLocationInput(data.location ?? "");
          setMaxDistance(data.max_distance_miles ?? 10);
        }
        setLoading(false);
      });
  }, [seekerId]);

  // Toggle helpers for the multi-select pill groups
  const toggleType = (t: string) =>
    setSelectedTypes((s) =>
      s.includes(t) ? s.filter((x) => x !== t) : [...s, t],
    );

  const toggleTime = (t: string) =>
    setTimePref((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  const handleJoin = async () => {
    if (!selectedTypes.length) {
      setStatus("Please select at least one class type.");
      return;
    }

    // Geocode the preferred address once, at write time — same approach as the spots
    // path, reusing the shared geocode() helper (best-effort → null coords on failure).
    const trimmedLocation = locationInput.trim();
    const { lat, lng } = await geocode(trimmedLocation);

    const { data, error } = await supabase
      .from("waitlist_entries")
      .insert({
        seeker_id: seekerId,
        class_types: selectedTypes,
        class_level: classLevel || null,
        time_preferences: timePref.length ? timePref : null,
        location: trimmedLocation || null,
        lat,
        lng,
        max_distance_miles: maxDistance,
      })
      .select()
      .single();

    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }

    // Matching against already-available spots now runs server-side in a SECURITY
    // DEFINER function (migrations/05_tighten_rls.sql), so the client no longer reads
    // other users' waitlist entries or inserts notifications directly.
    await supabase.rpc("notify_available_spots_for_me");

    setExisting(data);
    setEditing(false);
    setStatus("✅ You're on the waitlist!");
  };

  // allows users to update waitlist preferences
  const handleUpdate = async () => {
    if (!selectedTypes.length) {
      setStatus("Please select at least one class type.");
      return;
    }
    if (!existing) return;

    const trimmedLocation = locationInput.trim();
    const updatePayload: {
      class_types: string[];
      class_level: string | null;
      time_preferences: string[] | null;
      max_distance_miles: number;
      location: string | null;
      lat?: number | null;
      lng?: number | null;
    } = {
      class_types: selectedTypes,
      class_level: classLevel || null,
      time_preferences: timePref.length ? timePref : null,
      max_distance_miles: maxDistance,
      location: trimmedLocation || null,
    };

    // Re-geocode only when the address actually changed (avoids a needless Nominatim
    // call on preference-only edits). Cleared address → clear the coordinates too.
    if (trimmedLocation !== (existing.location ?? "")) {
      const { lat, lng } = trimmedLocation
        ? await geocode(trimmedLocation)
        : { lat: null, lng: null };
      updatePayload.lat = lat;
      updatePayload.lng = lng;
    }

    const { data, error } = await supabase
      .from("waitlist_entries")
      .update(updatePayload)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }

    // Updated preferences may now match spots that are already available.
    await supabase.rpc("notify_available_spots_for_me");

    setExisting(data);
    setEditing(false);
    setStatus("✅ Preferences updated!");
  };

  // Discard edits and revert form fields back to the last saved preferences
  const handleCancel = () => {
    if (existing) {
      setSelectedTypes(existing.class_types);
      setClassLevel(existing.class_level ?? "");
      setTimePref(existing.time_preferences ?? []);
      setMaxDistance(existing.max_distance_miles ?? 10);
      setLocationInput(existing.location ?? "");
    }
    setEditing(false);
    setStatus("");
  };

  if (loading)
    return (
      <p style={{ color: "#aaa", fontFamily: "'Afacad', sans-serif" }}>
        Loading...
      </p>
    );

  // Show the editable form if the user clicked "Edit" or hasn't joined yet
  const isEditMode = editing || !existing;

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
        Waitlist Preferences
      </h2>
      <p style={{ fontSize: 15, color: "#888", marginBottom: 32 }}>
        {existing
          ? "You're on the waitlist. Update your preferences below."
          : "Tell us what you're looking for. We'll notify you when a matching spot is posted."}
      </p>

      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: 32,
          border: "1px solid #f0e8e0",
          maxWidth: 560,
          margin: "0 auto",
        }}
      >
        {/* Read-only view */}
        {existing && !editing && (
          <>
            <PreferenceSection label="Class Types">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "center",
                }}
              >
                {existing.class_types.map((t) => (
                  <Pill key={t} label={t} active />
                ))}
              </div>
            </PreferenceSection>

            {existing.class_level && (
              <PreferenceSection label="Class Level">
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <Pill label={existing.class_level} active />
                </div>
              </PreferenceSection>
            )}

            {existing.time_preferences?.length ? (
              <PreferenceSection label="Preferred Time">
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    justifyContent: "center",
                  }}
                >
                  {existing.time_preferences.map((t) => (
                    <Pill
                      key={t}
                      label={TIME_PREFS.find((p) => p.value === t)?.label ?? t}
                      active
                    />
                  ))}
                </div>
              </PreferenceSection>
            ) : null}

            {existing.location ? (
              <PreferenceSection label="Preferred Location">
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <Pill label={`📍 ${existing.location}`} active />
                </div>
              </PreferenceSection>
            ) : null}

            {existing.max_distance_miles ? (
              <PreferenceSection label="Search Radius">
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <Pill
                    label={`Within ${existing.max_distance_miles} miles`}
                    active
                  />
                </div>
              </PreferenceSection>
            ) : null}

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginTop: 24,
              }}
            >
              <button
                onClick={() => {
                  setEditing(true);
                  setStatus("");
                }}
                style={outlineBtnStyle}
              >
                Edit Preferences
              </button>
            </div>
          </>
        )}

        {/* Edit / Join form */}
        {isEditMode && (
          <>
            <PreferenceSection label="Class Types" required>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "center",
                }}
              >
                {CLASS_TYPES.map((t) => (
                  <Pill
                    key={t}
                    label={t}
                    active={selectedTypes.includes(t)}
                    onClick={() => toggleType(t)}
                  />
                ))}
              </div>
            </PreferenceSection>

            <PreferenceSection
              label="Class Level"
              hint="optional — leave blank to match any level"
            >
              <select
                value={classLevel}
                onChange={(e) => setClassLevel(e.target.value)}
                style={selectStyle}
              >
                <option value="">Any level</option>
                {CLASS_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </PreferenceSection>

            <PreferenceSection
              label="Preferred Time"
              hint="optional — select all that apply"
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                {TIME_PREFS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => toggleTime(t.value)}
                    style={{
                      padding: "10px 16px",
                      borderRadius: 12,
                      border: "1.5px solid",
                      borderColor: timePref.includes(t.value)
                        ? "#F35C20"
                        : "#e8e0d8",
                      background: timePref.includes(t.value)
                        ? "#fff3ee"
                        : "#fafafa",
                      color: timePref.includes(t.value) ? "#F35C20" : "#555",
                      fontFamily: "'Afacad', sans-serif",
                      fontWeight: timePref.includes(t.value) ? 700 : 500,
                      cursor: "pointer",
                      transition: "all 0.15s",
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 14 }}>
                      {timePref.includes(t.value) ? "✓ " : ""}
                      {t.label}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: timePref.includes(t.value) ? "#F35C20" : "#aaa",
                        marginTop: 2,
                      }}
                    >
                      {t.hint}
                    </div>
                  </button>
                ))}
              </div>
            </PreferenceSection>

            <PreferenceSection
              label="Preferred Location"
              hint="Enter a neighborhood or address so we can match you to nearby classes."
            >
              <input
                placeholder="e.g. Back Bay, Boston or 123 Newbury St"
                value={locationInput}
                onChange={(e) => setLocationInput(e.target.value)}
                style={selectStyle}
              />
            </PreferenceSection>

            <PreferenceSection
              label="Max Distance"
              hint="how far you're willing to travel"
            >
              <select
                value={maxDistance}
                onChange={(e) => setMaxDistance(Number(e.target.value))}
                style={selectStyle}
              >
                {DISTANCE_OPTIONS.map((mi) => (
                  <option key={mi} value={mi}>
                    {mi} miles
                  </option>
                ))}
              </select>
            </PreferenceSection>

            <div
              style={{
                display: "flex",
                gap: 10,
                justifyContent: "center",
                marginTop: 24,
              }}
            >
              <button
                onClick={existing ? handleUpdate : handleJoin}
                style={primaryBtnStyle}
              >
                {existing ? "Save Preferences" : "Join Waitlist"}
              </button>
              {existing && (
                <button onClick={handleCancel} style={outlineBtnStyle}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}

        {status && (
          <p
            style={{
              marginTop: 16,
              fontSize: 14,
              textAlign: "center",
              color: status.startsWith("✅") ? "#22c55e" : "#ef4444",
            }}
          >
            {status}
          </p>
        )}
      </div>
    </div>
  );
}

function PreferenceSection({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          justifyContent: "center",
          marginBottom: 12,
        }}
      >
        <p
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#444",
            textTransform: "uppercase",
            letterSpacing: 0.8,
            margin: 0,
          }}
        >
          {label}
        </p>
        {required && <span style={{ color: "#F35C20", fontSize: 13 }}>*</span>}
        {hint && (
          <span style={{ fontSize: 12, color: "#aaa", fontWeight: 400 }}>
            — {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// Reusable toggle pill — renders as non-interactive (cursor: default) in read-only mode when no onClick is passed
function Pill({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 16px",
        borderRadius: 100,
        border: "1.5px solid",
        borderColor: active ? "#F35C20" : "#e8e0d8",
        background: active ? "#fff3ee" : "#fafafa",
        color: active ? "#F35C20" : "#555",
        fontSize: 13,
        fontFamily: "'Afacad', sans-serif",
        fontWeight: active ? 700 : 500,
        cursor: onClick ? "pointer" : "default",
        transition: "all 0.15s",
      }}
    >
      {active && onClick ? "✓ " : ""}
      {label}
    </button>
  );
}

// Shared button styles
const primaryBtnStyle: React.CSSProperties = {
  background: "#F35C20",
  color: "#fff",
  border: "none",
  padding: "11px 28px",
  borderRadius: 100,
  fontSize: 15,
  fontFamily: "'Afacad', sans-serif",
  fontWeight: 600,
  cursor: "pointer",
};

const outlineBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#F35C20",
  border: "1.5px solid #F35C20",
  padding: "11px 28px",
  borderRadius: 100,
  fontSize: 15,
  fontFamily: "'Afacad', sans-serif",
  fontWeight: 600,
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  padding: "11px 14px",
  borderRadius: 10,
  border: "1.5px solid #e8e0d8",
  fontSize: 15,
  fontFamily: "'Afacad', sans-serif",
  outline: "none",
  width: "100%",
  background: "#fafafa",
  boxSizing: "border-box",
  color: "#111",
};
