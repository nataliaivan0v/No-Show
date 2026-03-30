import { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase";
import { notifyNextSeeker } from "../../lib/matching";

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

// Formats a full name as "First L." for display (e.g. "Sarah Mitchell" → "Sarah M.")
function getNameDisplay(fullName: string): string {
  const parts = fullName.trim().split(" ");
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export default function PostSpotForm({
  posterId,
  onPost,
}: {
  posterId: string;
  onPost: () => void;
}) {
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

    const { data, error } = await supabase
      .from("spots")
      .insert({
        poster_id: posterId,
        title: className.trim(),
        class_type: classType,
        studio,
        location: location.trim() || null,
        scheduled_at: scheduledAt,
        class_level: classLevel || null,
        instructor: instructor.trim() || null,
        claim_info: fullClaimInfo,
      })
      .select()
      .single();

    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }

    // After inserting, attempt to notify the first matching seeker
    const notified = await notifyNextSeeker(data.id);
    setStatus(
      notified
        ? "✅ Spot posted! First matched seeker has been notified."
        : "✅ Spot posted! No matching seekers on the waitlist yet.",
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
    onPost();
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
