import { useNavigate } from "react-router-dom";
import "./LandingPage.css";

export default function LandingPage() {
  const nav = useNavigate();

  return (
    <div className="lp">
      {/* NAV */}
      <nav className="lp-nav">
        <div className="lp-logo" onClick={() => nav("/")}>
          No Show
        </div>
        <div className="lp-nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#for-who">Who it's for</a>
          <a
            href="/login"
            style={{ color: "#444", cursor: "pointer" }}
            onClick={(e) => {
              e.preventDefault();
              nav("/login");
            }}
          >
            Log in
          </a>
          <button className="lp-btn-primary" onClick={() => nav("/signup")}>
            Get started free
          </button>
        </div>
      </nav>

      {/* HERO */}
      <section className="lp-hero">
        <div className="lp-photo-grid">
          {[
            "p1",
            "p2",
            "p3",
            "p4",
            "p5",
            "p6",
            "p7",
            "p8",
            "p9",
            "p10",
            "p11",
            "p12",
            "p13",
            "p14",
            "p15",
            "p16",
            "p17",
            "p18",
          ].map((p) => (
            <div key={p} className={`lp-photo-grid-item lp-${p}`} />
          ))}
        </div>
        <div className="lp-hero-overlay" />
        <div className="lp-hero-card">
          <div className="lp-hero-card-logo">No Show</div>
          <p className="lp-hero-tagline">
            Skip the No-Show, Let It Go.
            <br />
            Share Your Spot, Save Your Fee.
          </p>
          <p className="lp-hero-divider">
            Whether you want to list a spot or claim one, first:
          </p>
          <div className="lp-hero-cta">
            <button className="lp-btn-outline" onClick={() => nav("/login")}>
              Log In
            </button>
            <button className="lp-btn-dark" onClick={() => nav("/signup")}>
              Sign Up
            </button>
          </div>
          <button
            className="lp-scroll-hint"
            onClick={() =>
              document
                .getElementById("how-it-works")
                ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            See how it works ↓
          </button>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <div id="how-it-works">
        <div className="lp-section">
          <div className="lp-section-inner">
            <div className="lp-section-label">How it works</div>
            <h2 className="lp-section-title">Four steps. Zero wasted spots.</h2>
            <p className="lp-section-sub">
              The whole process takes under a minute — from posting to someone
              claiming your spot.
            </p>
            <div className="lp-steps">
              {[
                {
                  n: "1",
                  title: "Post your spot",
                  body: "Can't make your Spin class? Post it in seconds with the studio, time, and your booking details.",
                },
                {
                  n: "2",
                  title: "We find a match",
                  body: "Our waitlist engine instantly finds the next person looking for that class type and notifies them.",
                },
                {
                  n: "3",
                  title: "They claim it",
                  body: "The matched seeker has 30 minutes to claim the spot. If they pass, it moves to the next person automatically.",
                },
                {
                  n: "4",
                  title: "You're off the hook",
                  body: "Once claimed, the claimer gets your booking info. You avoid the no-show fee. Everyone wins.",
                },
              ].map((s) => (
                <div key={s.n} className="lp-step">
                  <div className="lp-step-number">{s.n}</div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* DIVIDER */}
      <div className="lp-divider-band">
        <p>
          Whether you have a spot to give or a class to find,
          <br />
          No Show connects you in seconds.
        </p>
      </div>

      {/* FOR WHO */}
      <div id="for-who">
        <div className="lp-section">
          <div className="lp-section-inner">
            <div className="lp-section-label">Who it's for</div>
            <h2 className="lp-section-title">
              Built for both sides of the waitlist.
            </h2>
            <p className="lp-section-sub">
              Every user can post a spot they can't make or join the waitlist
              for one they want.
            </p>
            <div className="lp-split">
              <div className="lp-split-card">
                <span className="lp-split-icon">📤</span>
                <h3>Posting a spot</h3>
                <p>
                  You signed up for a class but life got in the way. Hand it off
                  instead of losing money.
                </p>
                <ul className="lp-feature-list">
                  {[
                    "Post in under a minute",
                    "Booking name auto-filled from your profile",
                    "Add door codes or check-in notes",
                    "Delete your listing anytime",
                    "See when your spot gets claimed in real time",
                  ].map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
              <div className="lp-split-card">
                <span className="lp-split-icon">📬</span>
                <h3>Joining the waitlist</h3>
                <p>
                  Always down for a Barre class but can never get a spot? You'll
                  be first to know when one opens up.
                </p>
                <ul className="lp-feature-list">
                  {[
                    "Select the class types you want",
                    "Get notified the moment a match is posted",
                    "30-minute window to claim before it moves on",
                    "Get full booking info instantly after claiming",
                    "Fair queue — claiming bumps you to the back",
                  ].map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <footer className="lp-footer">
        <div className="lp-logo">No Show</div>
        <p>© 2026 No Show</p>
      </footer>
    </div>
  );
}
