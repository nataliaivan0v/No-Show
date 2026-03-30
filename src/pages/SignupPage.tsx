import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const nav = useNavigate();

  const handleSubmit = async () => {
    setError("");
    const { error } = await supabase.auth.signUp({
      email,
      password,
      // full_name is passed as user metadata so Supabase can write it to the profiles table on signup
      options: { data: { full_name: name } },
    });
    // On success, no explicit redirect needed — the auth state change in App.tsx handles it
    if (error) setError(error.message);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#fff8f4",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 400 }}>
        <Link
          to="/"
          style={{
            fontSize: 14,
            color: "#F35C20",
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 24,
          }}
        >
          ← Back to No Show
        </Link>

        <div
          style={{
            background: "#fff",
            borderRadius: 20,
            padding: "40px 36px",
            boxShadow: "0 8px 40px rgba(0,0,0,0.08)",
            border: "1px solid #f0e8e0",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div
              style={{
                fontFamily: "'Berkshire Swash', cursive",
                fontSize: 36,
                color: "#F35C20",
                marginBottom: 6,
              }}
            >
              No Show
            </div>
            <p style={{ fontSize: 14, color: "#888" }}>
              Create your free account
            </p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
            <input
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />
            <input
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />
            {error && (
              <p style={{ color: "#e53e3e", fontSize: 13, margin: 0 }}>
                {error}
              </p>
            )}
            <button onClick={handleSubmit} style={primaryBtnStyle}>
              Sign Up
            </button>
          </div>

          <p
            style={{
              fontSize: 14,
              textAlign: "center",
              marginTop: 20,
              color: "#666",
            }}
          >
            Already have an account?{" "}
            <span
              style={{ color: "#F35C20", cursor: "pointer", fontWeight: 600 }}
              onClick={() => nav("/login")}
            >
              Log in
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

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
};

const primaryBtnStyle: React.CSSProperties = {
  background: "#F35C20",
  color: "#fff",
  border: "none",
  padding: "13px",
  borderRadius: 100,
  fontSize: 16,
  fontFamily: "'Afacad', sans-serif",
  fontWeight: 600,
  cursor: "pointer",
  marginTop: 4,
  width: "100%",
};
