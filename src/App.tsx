/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { supabase } from "./lib/supabase";
import { type Profile } from "./types";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import Dashboard from "./pages/Dashboard";
import AccountPage from "./pages/AccountPage";
import Navbar from "./components/Layout/Navbar";
import NotificationInbox from "./components/Waitlist/NotificationInbox";
import WaitlistForm from "./components/Waitlist/WaitlistForm";
import PostSpotForm from "./components/Spots/PostSpotForm";

// Wraps all authenticated routes — owns the Navbar and the inbox badge count
function AuthedLayout({ profile }: { profile: Profile }) {
  // refreshKey is incremented after posting a spot; not consumed here but can be
  // passed down to trigger re-fetches in child components if needed in future
  const [, setRefreshKey] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();

  // Uses head:true so Supabase returns only the count, not the full rows
  const fetchPending = async () => {
    const { count } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("seeker_id", profile.id)
      .eq("status", "pending");
    setPendingCount(count ?? 0);
  };

  // Keep the badge count live via realtime so it updates without a page refresh
  useEffect(() => {
    fetchPending();
    const channel = supabase
      .channel("pending-count")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `seeker_id=eq.${profile.id}`,
        },
        fetchPending,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile.id]);

  // Clear the badge immediately when the user navigates to the inbox
  useEffect(() => {
    if (location.pathname === "/inbox") setPendingCount(0);
  }, [location.pathname]);

  return (
    <>
      <Navbar pendingCount={pendingCount} />
      <div
        style={{
          minHeight: "100vh",
          background: "#fff8f4",
          fontFamily: "'Afacad', sans-serif",
        }}
      >
        <Routes>
          <Route path="/dashboard" element={<Dashboard profile={profile} />} />
          <Route
            path="/inbox"
            element={
              <PageWrapper>
                <NotificationInbox seekerId={profile.id} />
              </PageWrapper>
            }
          />
          <Route
            path="/waitlist"
            element={
              <PageWrapper>
                <WaitlistForm seekerId={profile.id} />
              </PageWrapper>
            }
          />
          <Route
            path="/post"
            element={
              <PageWrapper>
                <PostSpotForm
                  posterId={profile.id}
                  onPost={() => setRefreshKey((k) => k + 1)}
                />
              </PageWrapper>
            }
          />
          <Route
            path="/account"
            element={
              <PageWrapper>
                <AccountPage
                  profile={profile}
                  onSignOut={() => supabase.auth.signOut()}
                />
              </PageWrapper>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" />} />
        </Routes>
      </div>
    </>
  );
}

function PageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "40px 48px", maxWidth: 860, margin: "0 auto" }}>
      {children}
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for an existing session on mount (e.g. page refresh while already logged in)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) fetchProfile(session.user.id);
      else setLoading(false);
    });

    // Also listen for auth changes — handles login/logout from LoginPage and SignupPage
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) fetchProfile(session.user.id);
      else {
        setProfile(null);
        setLoading(false);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const fetchProfile = async (uid: string) => {
    const { data: profileData } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", uid)
      .single();
    // Email lives in auth.users, not the profiles table, so we fetch it separately
    const {
      data: { user },
    } = await supabase.auth.getUser();
    setProfile({ ...profileData, email: user?.email ?? null });
    setLoading(false);
  };

  if (loading) return <p style={{ padding: 24 }}>Loading...</p>;

  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes — redirect to dashboard if already logged in */}
        <Route
          path="/"
          element={!profile ? <LandingPage /> : <Navigate to="/dashboard" />}
        />
        <Route
          path="/login"
          element={!profile ? <LoginPage /> : <Navigate to="/dashboard" />}
        />
        <Route
          path="/signup"
          element={!profile ? <SignupPage /> : <Navigate to="/dashboard" />}
        />
        {/* All other routes require auth — redirect to landing if not logged in */}
        <Route
          path="/*"
          element={
            profile ? <AuthedLayout profile={profile} /> : <Navigate to="/" />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
