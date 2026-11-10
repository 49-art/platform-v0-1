import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorText, Face, Sheet } from "../../components/ui";
import { ApiFailure, ago, del, get, messageOf, post, put, when } from "../../lib/api";
import { useHub } from "../../lib/hub";
import { useSession } from "../../lib/session";

/* ── Verify (spec 7: ID + liveness when a member wants to meet) ── */

export function Verify() {
  const { me, refresh } = useSession();
  const [status, setStatus] = useState<{ idv: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { refresh(); get<{ idv: string }>("/api/verification/status").then(setStatus).catch((e) => setError(messageOf(e))); }, [refresh]);
  async function start() {
    setBusy(true); setError("");
    try { const r = await post<{ url?: string }>("/api/verification/start"); if (r.url) window.location.assign(r.url); else setStatus(await get("/api/verification/status")); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  const idv = status?.idv ?? me?.flags?.idStatus ?? "none";
  return (
    <div>
      <h1>Verify your identity</h1>
      <div className={`panel ${idv === "passed" ? "tone-cyan" : ""}`}>
        <div className="row">
          <Face alt="Your verification status" verified={idv === "passed"} size={72} />
          <div className="grow">
            <h2 style={{ marginBottom: "0.2rem" }}>{idv === "passed" ? "You are verified" : idv === "review" ? "Being checked by our team" : idv === "pending" ? "Check in progress" : "Not verified yet"}</h2>
            <p className="muted" style={{ margin: 0 }}>{idv === "passed" ? "Your cyan ring is live. Date tools unlock with anyone who is verified too." : "A photo of your ID and a short selfie video. Your face is matched to your profile photos."}</p>
          </div>
        </div>
      </div>
      {idv !== "passed" && idv !== "review" && (
        <section className="panel">
          <h3>Why we ask</h3>
          <p>Everyone who plans a date here has proved who they are. It is the main thing that stops scams and fake profiles.</p>
          <p className="small muted">The provider checks your document and keeps it. We only get the result: passed, failed or needs a manual check. We never store your ID.</p>
          {me?.config.sample && <div className="notice amber"><p><strong>SAMPLE:</strong> a practice page stands in for the provider.</p></div>}
          <ErrorText>{error}</ErrorText>
          <button className="btn cyan block" type="button" disabled={busy} onClick={start}>{idv === "failed" ? "Try again" : "Start ID check"}</button>
        </section>
      )}
      {idv === "review" && <p className="notice">A member of our team is reviewing your check. You will get a notification.</p>}
    </div>
  );
}

/* ── Me ── */

export function MeScreen() {
  const { me } = useSession();
  const [staff, setStaff] = useState<{ staff: { role: string } | null; canClaim: boolean } | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    get("/api/admin/me").then(setStaff).catch(() => {});
    get<{ profile: { displayName: string } | null; photos: { url: string; status: string }[] }>("/api/profile").then((p) => { setName(p.profile?.displayName ?? ""); setPhoto(p.photos.find((x) => x.status === "approved")?.url ?? p.photos[0]?.url ?? null); }).catch(() => {});
  }, []);
  return (
    <div>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <Face src={photo} alt="Your photo" verified={me?.flags?.idVerified} size={84} />
        <div>
          <h1 style={{ margin: 0 }}>{name || "You"}</h1>
          <p className="muted" style={{ margin: 0 }}>{me?.flags?.idVerified ? "ID verified" : "Not ID verified yet"}</p>
        </div>
      </div>
      <ul className="list panel" style={{ padding: "0 1rem" }}>
        <li><Link className="item" to="/app/profile"><span className="who"><strong>Edit profile</strong><span>Photos, about you, identity</span></span></Link></li>
        <li><Link className="item" to="/app/verify"><span className="who"><strong>Identity verification</strong><span>Unlocks dates and contact swaps</span></span></Link></li>
        <li><Link className="item" to="/app/notifications"><span className="who"><strong>Notifications</strong><span>Matches, dates, report outcomes</span></span></Link></li>
        <li><Link className="item" to="/app/settings"><span className="who"><strong>Settings and privacy</strong><span>Safety contacts, phone, sessions, your data</span></span></Link></li>
        <li><Link className="item" to="/app/standing"><span className="who"><strong>Account standing</strong><span>Warnings, appeals</span></span></Link></li>
        <li><Link className="item" to="/safety"><span className="who"><strong>Safety advice</strong><span>Meeting someone for the first time</span></span></Link></li>
        {(staff?.staff || staff?.canClaim) && <li><Link className="item" to="/admin"><span className="who"><strong>Staff console</strong><span>{staff.staff ? `Signed in as ${staff.staff.role.replace(/_/g, " ")}` : "Claim the first admin seat (sample only)"}</span></span></Link></li>}
      </ul>
    </div>
  );
}

/* ── Notifications ── */

export function Notifications() {
  const { clearNotices } = useHub();
  const [rows, setRows] = useState<{ id: string; title: string; body: string; href: string; at: number; read: boolean }[] | null>(null);
  useEffect(() => {
    get<{ notifications: any[] }>("/api/notifications").then((r) => { setRows(r.notifications); post("/api/notifications/read").then(clearNotices).catch(() => {}); }).catch(() => setRows([]));
  }, [clearNotices]);
  return (
    <div>
      <h1>Notifications</h1>
      {rows === null && <p className="muted">Loading</p>}
      {rows?.length === 0 && <p className="muted">Nothing yet. Matches, date replies and report outcomes appear here.</p>}
      <ul className="list">
        {rows?.map((n) => (
          <li key={n.id}>
            <Link className="item" to={n.href && n.href.startsWith("/") ? n.href : "/app"}>
              {!n.read && <span className="dot" aria-label="New" />}
              <span className="who"><strong>{n.title}</strong><span>{n.body ? `${n.body} ` : ""}{ago(n.at)}</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Standing and appeals (spec 1: every action has a reason code, is logged, and can be appealed) ── */

export function Standing() {
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  const [data, setData] = useState<any>(null);
  const [appealing, setAppealing] = useState<string | null>(params.get("ref"));
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const load = () => get("/api/standing").then(setData).catch((e) => setError(messageOf(e)));
  useEffect(() => { void load(); }, []);
  async function appeal(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { const r = await post<{ message: string }>("/api/appeals", { actionId: appealing, body: text }); setMsg(r.message); setAppealing(null); setText(""); await load(); await refresh(); } catch (err) { setError(messageOf(err)); }
  }
  const label: Record<string, string> = { warn: "Warning", restrict: "Messaging paused", suspend: "Suspension", ban: "Permanent ban" };
  return (
    <div>
      <h1>Account standing</h1>
      {data && (
        <div className={`panel ${data.status === "active" ? "" : "tone-red"}`}>
          <h2>{data.status === "active" ? "Your account is in good standing" : data.status === "suspended" ? `Suspended until ${when(data.suspendedUntil)}` : data.status === "banned" ? "Your account is closed" : data.status}</h2>
          {data.restrictedUntil && <p>Messaging is paused until {when(data.restrictedUntil)}.</p>}
        </div>
      )}
      {msg && <p className="ok" role="status">{msg}</p>}
      <ErrorText>{error}</ErrorText>
      {data?.actions?.length > 0 && <h2 style={{ marginTop: "1.5rem" }}>Decisions on your account</h2>}
      {data?.actions?.map((a: any) => (
        <section className="panel" key={a.id}>
          <div className="spread"><strong>{label[a.kind] ?? a.kind}</strong><span className="small muted">{when(a.at)}</span></div>
          <p>{a.reason}</p>
          <p className="small muted">Reference {a.id}{a.expiresAt ? `. Ends ${when(a.expiresAt)}` : ""}{a.liftedAt ? `. Lifted ${when(a.liftedAt)}` : ""}</p>
          {a.appeal ? <p className="small"><strong>Appeal {a.appeal.status === "open" ? "in review" : a.appeal.status}.</strong> {a.appeal.decisionNote}</p>
            : !a.liftedAt && <button className="btn ghost small" type="button" onClick={() => setAppealing(a.id)}>Appeal this decision</button>}
        </section>
      ))}
      {data?.actions?.length === 0 && <p className="muted">No moderation decisions have been made on your account.</p>}
      <Sheet open={!!appealing} onClose={() => setAppealing(null)} title="Appeal a decision">
        <form onSubmit={appeal}>
          <p className="small">A senior moderator who was not involved in the decision will review it.</p>
          <div className="field"><label htmlFor="ap">Tell us why you think it was wrong</label><textarea id="ap" minLength={20} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} /></div>
          <ErrorText>{error}</ErrorText>
          <button className="btn block">Send appeal</button>
        </form>
      </Sheet>
      {me?.user && me.step !== "ready" && <p style={{ marginTop: "1rem" }}><LogoutButton /></p>}
    </div>
  );
}

export function LogoutButton() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  return <button className="btn ghost" type="button" onClick={async () => { await post("/api/auth/logout").catch(() => {}); await refresh(); navigate("/", { replace: true }); }}>Sign out</button>;
}

/* ── Settings ── */

function Reauth({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { await post("/api/auth/reauth", { password }); setPassword(""); onDone(); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Confirm it is you">
      <form onSubmit={submit}>
        <p className="small">For your safety we ask for your password before this change.</p>
        <div className="field"><label htmlFor="ra">Password</label><input id="ra" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <ErrorText>{error}</ErrorText>
        <button className="btn block">Confirm</button>
      </form>
    </Sheet>
  );
}

export function Settings() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const [phone, setPhone] = useState("");
  const [tc, setTc] = useState({ name: "", channel: "email", address: "" });
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [reauthFor, setReauthFor] = useState<null | (() => Promise<void>)>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function load() {
    const [s, t, b, c] = await Promise.all([get("/api/me/sessions"), get("/api/trusted-contacts"), get("/api/blocks"), get("/api/consents")]);
    setSessions(s.sessions); setContacts(t.contacts); setBlocks(b.blocks);
    const active: Record<string, boolean> = {};
    for (const x of c.consents) if (!x.withdrawnAt) active[x.kind] = true;
    setConsents(active);
  }
  useEffect(() => { load().catch((e) => setError(messageOf(e))); }, []);

  /** Runs a sensitive action, asking for the password first if the server wants a fresh sign-in. */
  async function sensitive(action: () => Promise<void>) {
    setError(""); setMsg("");
    try { await action(); } catch (err) {
      if (err instanceof ApiFailure && err.error.code === "reauth_required") setReauthFor(() => action);
      else setError(messageOf(err));
    }
  }

  return (
    <div>
      <h1>Settings and privacy</h1>
      {msg && <p className="ok" role="status">{msg}</p>}
      <ErrorText>{error}</ErrorText>

      <section className="panel tone-amber">
        <h2>Trusted contacts</h2>
        <p className="small">People we contact if you press SOS or miss a check-in on a date. Up to three.</p>
        <ul className="list">
          {contacts.map((c) => (
            <li key={c.id} className="item"><span className="who"><strong>{c.name}</strong><span>{c.address}</span></span><button className="btn ghost small" type="button" onClick={async () => { await del(`/api/trusted-contacts/${c.id}`); await load(); }}>Remove</button></li>
          ))}
        </ul>
        {contacts.length < 3 && (
          <form onSubmit={async (e) => { e.preventDefault(); setError(""); try { await post("/api/trusted-contacts", tc); setTc({ name: "", channel: "email", address: "" }); await load(); setMsg("Trusted contact added."); } catch (err) { setError(messageOf(err)); } }}>
            <div className="field"><label htmlFor="tcn">Their name</label><input id="tcn" type="text" value={tc.name} onChange={(e) => setTc({ ...tc, name: e.target.value })} /></div>
            <div className="field">
              <label htmlFor="tcc">Reach them by</label>
              <select id="tcc" value={tc.channel} onChange={(e) => setTc({ ...tc, channel: e.target.value })}><option value="email">Email</option><option value="sms">Text message</option></select>
            </div>
            <div className="field"><label htmlFor="tca">{tc.channel === "sms" ? "Mobile number, with country code (+44...)" : "Email address"}</label><input id="tca" type={tc.channel === "sms" ? "tel" : "email"} value={tc.address} onChange={(e) => setTc({ ...tc, address: e.target.value })} /></div>
            <button className="btn amber small">Add trusted contact</button>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Phone number</h2>
        <p className="small">Only shared with a match when you are both verified and both agree to swap.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void sensitive(async () => { await put("/api/me/phone", { phone }); setMsg("Phone number saved."); setPhone(""); }); }}>
          <label htmlFor="ph" className="sr-only">Phone number</label>
          <input id="ph" type="tel" autoComplete="tel" placeholder="+44 7700 900123" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ flex: "1 1 220px" }} />
          <button className="btn small">Save number</button>
        </form>
      </section>

      <section className="panel">
        <h2>Choices</h2>
        <label className="check">
          <input type="checkbox" checked={!!consents.explicit_media} onChange={async (e) => { await post("/api/consents", { kind: "explicit_media", granted: e.target.checked }).catch((err) => setError(messageOf(err))); await load(); }} />
          <span>Allow matches to send me explicit images. Off by default. They are still hidden until I tap to show them.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={!!consents.marketing} onChange={async (e) => { await post("/api/consents", { kind: "marketing", granted: e.target.checked }).catch((err) => setError(messageOf(err))); await load(); }} />
          <span>Send me occasional news about the app.</span>
        </label>
      </section>

      <section className="panel">
        <h2>Blocked people</h2>
        {blocks.length === 0 ? <p className="small muted">You have not blocked anyone.</p> : (
          <ul className="list">{blocks.map((b) => <li key={b.userId} className="item"><span className="who"><strong>{b.name || "A member"}</strong><span>Blocked {ago(b.at)}</span></span><button className="btn ghost small" type="button" onClick={async () => { await del(`/api/blocks/${b.userId}`); await load(); }}>Unblock</button></li>)}</ul>
        )}
      </section>

      <section className="panel">
        <h2>Where you are signed in</h2>
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id} className="item"><span className="who"><strong>{s.label || "A device"}{s.current ? " (this device)" : ""}</strong><span>Last active {ago(s.lastSeenAt)}</span></span>
              {!s.current && <button className="btn ghost small" type="button" onClick={async () => { await del(`/api/me/sessions/${s.id}`); await load(); }}>Sign out</button>}</li>
          ))}
        </ul>
        <button className="btn ghost small" type="button" onClick={async () => { await del("/api/me/sessions"); await refresh(); navigate("/login"); }}>Sign out everywhere</button>
      </section>

      {me?.user?.hasPassword && (
        <section className="panel">
          <h2>Password</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void sensitive(async () => { await post("/api/me/password", { password: pw }); setPw(""); setMsg("Password changed."); }); }}>
            <label htmlFor="npw" className="sr-only">New password</label>
            <input id="npw" type="password" autoComplete="new-password" placeholder="New password, 10+ characters" value={pw} onChange={(e) => setPw(e.target.value)} style={{ flex: "1 1 220px" }} />
            <button className="btn small">Change password</button>
          </form>
        </section>
      )}

      <section className="panel">
        <h2>Your data</h2>
        <p className="small">Download everything we hold about you, as a file you can keep.</p>
        <a className="btn ghost small" href="/api/me/export" download>Download my data</a>
        <hr />
        <h3>Delete account</h3>
        <p className="small">Your profile disappears at once. Personal data is erased within 30 days, except records the law or safety requires us to keep.</p>
        <button className="btn red small" type="button" onClick={() => setConfirmDelete(true)}>Delete my account</button>
      </section>

      <p style={{ marginTop: "1.25rem" }}><LogoutButton /></p>

      <Reauth open={!!reauthFor} onClose={() => setReauthFor(null)} onDone={async () => { const a = reauthFor; setReauthFor(null); if (a) await sensitive(a); }} />
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete your account?">
        <p>This cannot be undone. Your matches and chats close straight away.</p>
        <button className="btn red block" type="button" onClick={() => { setConfirmDelete(false); void sensitive(async () => { await del("/api/me"); await refresh(); navigate("/", { replace: true }); }); }}>Yes, delete my account</button>
      </Sheet>
    </div>
  );
}
