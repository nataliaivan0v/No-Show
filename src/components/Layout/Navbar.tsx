import { useNavigate, useLocation } from "react-router-dom";

// All top-level nav destinations, rendered as tabs in order
const navTabs = [
  { path: "/dashboard", label: "My Dashboard" },
  { path: "/inbox", label: "Inbox" },
  { path: "/waitlist", label: "Waitlist Preferences" },
  { path: "/post", label: "Post a Spot" },
  { path: "/account", label: "My Account" },
];

// pendingCount is the number of unread notifications
export default function Navbar({
  pendingCount,
}: {
  pendingCount: number;
}) {
  const nav = useNavigate();
  const { pathname } = useLocation(); // used to highlight the currently active tab

  return (
    <nav
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0 48px",
        height: 68,
        background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(10px)",
        borderBottom: "1px solid rgba(0,0,0,0.07)",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      {/* Logo */}
      <div
        onClick={() => nav("/dashboard")}
        style={{
          fontFamily: "'Berkshire Swash', cursive",
          fontSize: 26,
          color: "#F35C20",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        No Show
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {navTabs.map((t) => {
          const active = pathname === t.path;
          return (
            <button
              key={t.path}
              onClick={() => nav(t.path)}
              style={{
                background: "none",
                border: "none",
                padding: "8px 14px",
                fontFamily: "'Afacad', sans-serif",
                fontSize: 15,
                // bold + orange underline on the active tab
                fontWeight: active ? 700 : 500,
                color: active ? "#F35C20" : "#111",
                cursor: "pointer",
                borderBottom: active
                  ? "2px solid #F35C20"
                  : "2px solid transparent",
                borderRadius: 0,
                transition: "color 0.15s",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
              // hover color handled via JS since we're using inline styles (no CSS classes)
              onMouseOver={(e) => {
                if (!active) e.currentTarget.style.color = "#F35C20";
              }}
              onMouseOut={(e) => {
                if (!active) e.currentTarget.style.color = "#111";
              }}
            >
              {t.label}
              {/* Badge showing number of pending inbox items — only shown when > 0 */}
              {t.path === "/inbox" && pendingCount > 0 && (
                <span
                  style={{
                    background: "#F35C20",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    borderRadius: 100,
                    padding: "1px 7px",
                    lineHeight: "18px",
                    minWidth: 18,
                    textAlign: "center",
                    display: "inline-block",
                  }}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
