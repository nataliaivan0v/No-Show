import { useState } from "react";
import { supabase } from "../lib/supabase";
import { type Profile } from "../types";

export default function AccountPage({
  profile,
  onSignOut,
}: {
  profile: Profile;
  onSignOut: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(profile.full_name);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!fullName.trim()) {
      setStatus("Name cannot be empty.");
      return;
    }
    setLoading(true);
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName.trim() })
      .eq("id", profile.id);

    if (error) {
      setStatus(`Error: ${error.message}`);
    } else {
      setStatus("✅ Profile updated!");
      setEditing(false);
    }
    setLoading(false);
  };

  // Discard edits and revert the name field to what was last saved
  const handleCancel = () => {
    setFullName(profile.full_name);
    setEditing(false);
    setStatus("");
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
        My Account
      </h2>
      <p style={{ fontSize: 15, color: "#888", marginBottom: 32 }}>
        View and update your account details.
      </p>

      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: 32,
          border: "1px solid #f0e8e0",
          maxWidth: 480,
          margin: "0 auto",
        }}
      >
        {/* Full Name */}
        <div style={{ marginBottom: 24 }}>
          <p style={fieldLabelStyle}>Full Name</p>
          {editing ? (
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              style={inputStyle}
            />
          ) : (
            <p style={fieldValueStyle}>{fullName}</p>
          )}
        </div>

        {/* Email (read-only) */}
        <div style={{ marginBottom: 24 }}>
          <p style={fieldLabelStyle}>Email</p>
          <p style={{ ...fieldValueStyle, color: "#aaa" }}>
            {profile.email ?? "—"}
          </p>
          <p style={{ fontSize: 12, color: "#ccc", marginTop: 4 }}>
            Email cannot be changed.
          </p>
        </div>

        {/* Member Since */}
        <div
          style={{
            marginBottom: 16,
            paddingBottom: 32,
            borderBottom: "1px solid #f0e8e0",
          }}
        >
          <p style={fieldLabelStyle}>Member Since</p>
          <p style={fieldValueStyle}>
            {new Date(profile.created_at).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>

        {/* Action buttons */}
        {editing ? (
          <div
            style={{
              display: "flex",
              gap: 10,
              marginBottom: 16,
              justifyContent: "center",
            }}
          >
            <button
              onClick={handleSave}
              disabled={loading}
              style={primaryBtnStyle}
            >
              {loading ? "Saving..." : "Save Changes"}
            </button>
            <button onClick={handleCancel} style={outlineBtnStyle}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setEditing(true);
              setStatus("");
            }}
            style={{ ...outlineBtnStyle, marginBottom: 16 }}
          >
            Edit Profile
          </button>
        )}

        {/* Save feedback — green for success, red for errors */}
        {status && (
          <p
            style={{
              fontSize: 14,
              color: status.startsWith("✅") ? "#22c55e" : "#ef4444",
              marginBottom: 16,
            }}
          >
            {status}
          </p>
        )}

        {/* Sign out */}
        <div style={{ borderTop: "1px solid #f0e8e0", paddingTop: 16 }}>
          <button
            onClick={onSignOut}
            style={dangerBtnStyle}
            onMouseOver={(e) => (e.currentTarget.style.background = "#fef2f2")}
            onMouseOut={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}

// Shared field styles for the read-only profile display
const fieldLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#aaa",
  textTransform: "uppercase",
  letterSpacing: 1,
  marginBottom: 6,
  fontFamily: "'Afacad', sans-serif",
};

const fieldValueStyle: React.CSSProperties = {
  fontSize: 16,
  color: "#111",
  fontFamily: "'Afacad', sans-serif",
};

const inputStyle: React.CSSProperties = {
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

// Red-tinted button used for destructive actions (sign out)
const dangerBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#ef4444",
  border: "1.5px solid #ef4444",
  padding: "11px 28px",
  borderRadius: 100,
  fontSize: 15,
  fontFamily: "'Afacad', sans-serif",
  fontWeight: 600,
  cursor: "pointer",
  transition: "background 0.2s",
};
