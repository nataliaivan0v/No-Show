import { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase";
import { geocode } from "../../lib/geocode";

// Options for the class type and level dropdowns
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

// Shape returned by the parse-booking-screenshot edge function. Every field is
// nullable — the model returns null for anything it couldn't read.
interface ParsedBooking {
  studio: string | null;
  title: string | null;
  class_type: string | null;
  scheduled_date: string | null; // YYYY-MM-DD
  scheduled_time: string | null; // 24h HH:MM
  location: string | null;
  class_level: string | null;
  instructor: string | null;
}

// Reads a File as base64 WITHOUT the "data:<mime>;base64," prefix (the edge
// function / Anthropic want the raw base64 payload only).
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Coerce a HH:MM time into the zero-padded form a <input type="time"> expects.
function normalizeTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : t;
}

// Formats a full name as "First L." for display (e.g. "Sarah Mitchell" → "Sarah M.")
function getNameDisplay(fullName: string): string {
  const parts = fullName.trim().split(" ");
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export default function PostSpotForm({ posterId }: { posterId: string }) {
  const [studio, setStudio] = useState("");
  const [className, setClassName] = useState("");
  const [location, setLocation] = useState("");
  const [classDate, setClassDate] = useState("");
  const [classTime, setClassTime] = useState("");
  const [classType, setClassType] = useState("Yoga");
  const [classLevel, setClassLevel] = useState("");
  const [instructor, setInstructor] = useState("");
  const [claimInfo, setClaimInfo] = useState("");
  const [profileName, setProfileName] = useState("");
  const [status, setStatus] = useState("");
  // Autofill-from-screenshot UI state
  const [autofilling, setAutofilling] = useState(false);
  const [autofillMsg, setAutofillMsg] = useState("");

  // Fetch the poster's name once on mount so it can be prepended to claim_info
  useEffect(() => {
    supabase
      .from("profiles")
      .select("full_name")
      .eq("id", posterId)
      .single()
      .then(({ data }) => {
        if (data) setProfileName(getNameDisplay(data.full_name));
      });
  }, [posterId]);

  const handleSubmit = async () => {
    // Validate required fields
    if (
      !studio ||
      !className ||
      !location ||
      !classDate ||
      !classTime ||
      !classType
    ) {
      setStatus("Please fill in all required fields.");
      return;
    }

    // Reject classes that are in the past or less than 1 hour away
    const scheduledAt = new Date(`${classDate}T${classTime}`).toISOString();
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    if (new Date(scheduledAt).getTime() < Date.now()) {
      setStatus("❌ This class is in the past.");
      return;
    }
    if (new Date(scheduledAt).getTime() < oneHourFromNow) {
      setStatus("❌ Class must be at least 1 hour away.");
      return;
    }

    // Always prepend the poster's booking name; append any extra notes below it
    const bookingLine = `Booking name: ${profileName}`;
    const fullClaimInfo = claimInfo.trim()
      ? `${bookingLine}\n${claimInfo.trim()}`
      : bookingLine;

    // Geocode the address once, here at write time (never during search).
    // Best-effort: if it fails, the spot is still posted with null coordinates.
    const { lat, lng } = await geocode(location.trim());

    const { error } = await supabase.from("spots").insert({
      poster_id: posterId,
      title: className.trim(),
      class_type: classType,
      studio,
      location: location.trim() || null,
      lat,
      lng,
      scheduled_at: scheduledAt,
      class_level: classLevel || null,
      instructor: instructor.trim() || null,
      claim_info: fullClaimInfo,
    });

    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }

    // Matching + notifying the next seeker now happens server-side via an AFTER
    // INSERT trigger on the spots table (migrations/01_server_side_matching.sql).
    // The client can't read the matched seeker's notification (recipient-only), so
    // we no longer report whether a specific seeker was notified.
    setStatus(
      "✅ Spot posted! The next matching seeker on the waitlist will be notified.",
    );

    setStudio("");
    setClassName("");
    setLocation("");
    setClassDate("");
    setClassTime("");
    setClassType("Yoga");
    setClassLevel("");
    setInstructor("");
    setClaimInfo("");
  };

  // Pre-fill only the fields the model actually returned; anything null is left as
  // the user had it. class_type / class_level are only applied when they match a
  // known dropdown option, so a stray value can't leave a select in a broken state.
  const prefillFromParsed = (p: ParsedBooking) => {
    if (p.studio) setStudio(p.studio);
    if (p.title) setClassName(p.title);
    if (p.location) setLocation(p.location);
    if (p.scheduled_date) setClassDate(p.scheduled_date);
    if (p.scheduled_time) setClassTime(normalizeTime(p.scheduled_time));
    if (p.class_type && CLASS_TYPES.includes(p.class_type))
      setClassType(p.class_type);
    if (p.class_level && CLASS_LEVELS.includes(p.class_level))
      setClassLevel(p.class_level);
    if (p.instructor) setInstructor(p.instructor);
  };

  // Read a screenshot, send it to the parse-booking-screenshot edge function, and
  // pre-fill the form. Never auto-submits; failures leave the form untouched so the
  // manual path always works.
  const handleScreenshot = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the input so re-selecting the same file still fires onChange.
    e.target.value = "";
    if (!file) return;

    setAutofillMsg("");
    setAutofilling(true);
    try {
      const imageBase64 = await fileToBase64(file);
      const { data, error } = await supabase.functions.invoke(
        "parse-booking-screenshot",
        { body: { imageBase64, mediaType: file.type || "image/png" } },
      );

      // invoke() sets `error` on any non-2xx (bad image, unparseable output, etc.).
      if (error || !data || (data as { error?: string }).error) {
        setAutofillMsg("Couldn't read that one, please fill the form manually.");
        return;
      }

      prefillFromParsed(data as ParsedBooking);
      setAutofillMsg(
        "✅ Pre-filled from your screenshot — double-check the details before posting.",
      );
    } catch {
      setAutofillMsg("Couldn't read that one, please fill the form manually.");
    } finally {
      setAutofilling(false);
    }
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
        Post a Spot
      </h2>
      <p style={{ fontSize: 15, color: "#888", marginBottom: 32 }}>
        Can't make your class? Post your spot so someone else can take it — and
        avoid the no-show fee.
      </p>

      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: 32,
          border: "1px solid #f0e8e0",
          display: "flex",
          flexDirection: "column",
          gap: 20,
          maxWidth: 560,
          margin: "0 auto",
        }}
      >
        {/* Autofill from a booking screenshot — optional shortcut, manual entry
            below always works regardless of what this does. */}
        <div
          style={{
            borderBottom: "1px solid #f0e8e0",
            paddingBottom: 20,
          }}
        >
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              cursor: autofilling ? "default" : "pointer",
              background: "#fff3ee",
              color: "#F35C20",
              border: "1.5px solid #F35C20",
              padding: "10px 18px",
              borderRadius: 100,
              fontSize: 14,
              fontFamily: "'Afacad', sans-serif",
              fontWeight: 600,
              opacity: autofilling ? 0.6 : 1,
            }}
          >
            📷 Autofill from screenshot
            <input
              type="file"
              accept="image/*"
              disabled={autofilling}
              onChange={handleScreenshot}
              style={{ display: "none" }}
            />
          </label>
          <p style={{ fontSize: 12, color: "#aaa", margin: "8px 0 0" }}>
            Upload a booking confirmation and we'll try to fill in the details.
            Double-check the details before posting.
          </p>
          {autofilling && (
            <p style={{ fontSize: 13, color: "#F35C20", margin: "8px 0 0" }}>
              Reading your screenshot...
            </p>
          )}
          {!autofilling && autofillMsg && (
            <p
              style={{
                fontSize: 13,
                margin: "8px 0 0",
                color: autofillMsg.startsWith("✅") ? "#22c55e" : "#ef4444",
              }}
            >
              {autofillMsg}
            </p>
          )}
        </div>

        <Field label="Studio Name" required>
          <input
            placeholder="e.g. SoulCycle"
            value={studio}
            onChange={(e) => setStudio(e.target.value)}
            style={inputStyle}
          />
        </Field>

        <Field label="Class Name" required>
          <input
            placeholder="e.g. Morning Flow"
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            style={inputStyle}
          />
        </Field>

        <Field label="Studio Address" required>
          <input
            placeholder="e.g. 123 Newbury St, Boston, MA"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={inputStyle}
          />
        </Field>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
        >
          <Field label="Class Date" required>
            <input
              type="date"
              value={classDate}
              onChange={(e) => setClassDate(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Class Time" required>
            <input
              type="time"
              value={classTime}
              onChange={(e) => setClassTime(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>

        <Field label="Class Type" required>
          <select
            value={classType}
            onChange={(e) => setClassType(e.target.value)}
            style={inputStyle}
          >
            {CLASS_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>

        <Field label="Class Level" optional>
          <select
            value={classLevel}
            onChange={(e) => setClassLevel(e.target.value)}
            style={inputStyle}
          >
            <option value="">Select a level</option>
            {CLASS_LEVELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Field>

        <Field label="Instructor Name" optional>
          <input
            placeholder="e.g. Sarah M."
            value={instructor}
            onChange={(e) => setInstructor(e.target.value)}
            style={inputStyle}
          />
        </Field>

        <div style={{ borderTop: "1px solid #f0e8e0", paddingTop: 20 }}>
          <Field
            label="Additional Booking Info"
            optional
            hint="only shown after someone claims"
          >
            {profileName && (
              <p style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                📋 <strong>{profileName}</strong> will be included automatically
                as the booking name. Note below if the class is booked under a
                different name.
              </p>
            )}
            <textarea
              placeholder={`e.g.\n• Door code: 1234\n• Check in at the front desk\n• Booked under a different name: Jane D.`}
              value={claimInfo}
              onChange={(e) => setClaimInfo(e.target.value)}
              rows={4}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </Field>
        </div>

        <button onClick={handleSubmit} style={submitBtnStyle}>
          Post Spot
        </button>

        {/* Submission feedback — green for success, red for errors */}
        {status && (
          <p
            style={{
              fontSize: 14,
              color: status.startsWith("✅") ? "#22c55e" : "#ef4444",
              margin: 0,
            }}
          >
            {status}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  optional,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "#444",
          fontFamily: "'Afacad', sans-serif",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {label}
        {optional && (
          <span style={{ fontSize: 12, color: "#aaa", fontWeight: 400 }}>
            (optional)
          </span>
        )}
        {hint && (
          <span style={{ fontSize: 12, color: "#aaa", fontWeight: 400 }}>
            — {hint}
          </span>
        )}
        {required && <span style={{ color: "#F35C20", fontSize: 13 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

// Shared style for all text inputs, selects, and textareas
const inputStyle: React.CSSProperties = {
  padding: "12px 16px",
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

// Style for the primary submit button
const submitBtnStyle: React.CSSProperties = {
  background: "#F35C20",
  color: "#fff",
  border: "none",
  padding: "13px",
  borderRadius: 100,
  fontSize: 16,
  fontFamily: "'Afacad', sans-serif",
  fontWeight: 600,
  cursor: "pointer",
  width: "100%",
};
