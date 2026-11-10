import { useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router";
import { get } from "../lib/api";
import { HubProvider, useHub } from "../lib/hub";
import { pathForStep, useSession } from "../lib/session";
import { Brand, Icon, InstallButton, SampleBar } from "./ui";

export function Splash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark" aria-hidden="true" />
      <p>Loading</p>
    </div>
  );
}

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

/** Visitors: public pages only. No profiles are visible here (spec 2 "Visitor"). */
export function PublicLayout() {
  const { me, loading } = useSession();
  if (loading) return <Splash />;
  const name = me?.config.appName ?? "[NAME TBD]";
  return (
    <>
      <ScrollTop />
      {me?.config.sample && <SampleBar />}
      <header className="topbar">
        <Brand name={name} />
        <nav className="row" aria-label="Account">
          <InstallButton />
          {me?.user ? <Link className="btn small" to="/app">Open the app</Link> : <Link className="btn ghost small" to="/login">Sign in</Link>}
        </nav>
      </header>
      <main id="main"><Outlet /></main>
      <footer className="footer-links">
        <Link to="/guidelines">Community guidelines</Link>
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/safety">Safety</Link>
        <Link to="/contact">Contact us</Link>
        <Link to="/install">Download the app</Link>
      </footer>
    </>
  );
}

/** Signed-in members. Routes every member to the step the verification flow (spec 7) says they are on. */
export function AppLayout() {
  const { me, loading } = useSession();
  const { pathname } = useLocation();
  const [notices, setNotices] = useState(0);
  const signedIn = !!me?.user;
  useEffect(() => {
    if (signedIn) get<{ unread: number }>("/api/notifications").then((d) => setNotices(d.unread)).catch(() => {});
  }, [signedIn]);

  if (loading) return <Splash />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} replace />;

  const step = me.step;
  const target = pathForStep(step);
  // Pages anyone signed in may always reach, whatever step they are on.
  const always = ["/app/settings", "/app/standing", "/app/notifications", "/dev/provider"];
  const onboarding = ["/app/email", "/app/age", "/app/profile", "/app/pending"];
  if (!always.some((p) => pathname.startsWith(p))) {
    if (step !== "ready" && !pathname.startsWith(target) && !(step === "pending" && pathname.startsWith("/app/profile"))) return <Navigate to={target} replace />;
    if (step === "ready" && (pathname === "/app" || pathname === "/app/" || (onboarding.includes(pathname) && pathname !== "/app/profile"))) return <Navigate to="/app/discover" replace />;
  }
  const tabs = step === "ready";

  return (
    <HubProvider enabled={step === "ready" || step === "pending"} initialNotices={notices}>
      <ScrollTop />
      <div className={`shell ${tabs ? "has-tabs" : ""}`}>
        <div style={{ gridColumn: "1 / -1" }}>
          {me.config.sample && <SampleBar />}
          <header className="topbar">
            <Brand name={me.config.appName} />
            <nav className="row" aria-label="Quick links">
              <InstallButton />
              {tabs && <NoticeBell />}
            </nav>
          </header>
        </div>
        {tabs && <TabBar />}
        <main id="main" className="main">
          <Outlet />
        </main>
      </div>
    </HubProvider>
  );
}

function NoticeBell() {
  const { notices } = useHub();
  return (
    <Link to="/app/notifications" className="btn ghost small" aria-label={notices ? `Notifications, ${notices} new` : "Notifications"}>
      {Icon.bell}
      {notices > 0 && <span className="unread" aria-hidden="true">{notices > 9 ? "9+" : notices}</span>}
    </Link>
  );
}

function TabBar() {
  const { unread } = useHub();
  const total = Object.values(unread).reduce((a, b) => a + b, 0);
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink to="/app/discover">{Icon.discover}<span>Discover</span></NavLink>
      <NavLink to="/app/matches">{Icon.matches}<span>Matches</span>{total > 0 && <span className="badge" aria-label={`${total} unread`}>{total > 9 ? "9+" : total}</span>}</NavLink>
      <NavLink to="/app/verify">{Icon.verify}<span>Verify</span></NavLink>
      <NavLink to="/app/me">{Icon.me}<span>Me</span></NavLink>
    </nav>
  );
}

/** Staff console. The server checks every call against the staff role; this only hides what a role cannot use. */
export function AdminLayout() {
  const { me, loading } = useSession();
  const { pathname } = useLocation();
  if (loading) return <Splash />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} replace />;
  return (
    <>
      {me.config.sample && <SampleBar />}
      <header className="topbar">
        <Brand name={`${me.config.appName} staff`} />
        <Link to="/app" className="btn ghost small">Member app</Link>
      </header>
      <main id="main" className="main wide"><Outlet /></main>
    </>
  );
}
