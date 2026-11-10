import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, useParams } from "react-router";
import { ErrorText } from "../../components/ui";
import { get, messageOf, post, when } from "../../lib/api";

interface AdminMe { staff: { role: string; capabilities: string[] } | null; canClaim: boolean; sample: boolean; warnings: string[] }
interface Reason { code: string; label: string; zeroTolerance?: boolean }

const SECTIONS: { path: string; label: string; cap: string }[] = [
  { path: "dashboard", label: "Dashboard", cap: "dashboards.view" },
  { path: "premod", label: "Pre-moderation", cap: "queue.premod" },
  { path: "reports", label: "Reports", cap: "queue.reports" },
  { path: "members", label: "Members", cap: "user.view" },
  { path: "appeals", label: "Appeals", cap: "appeals.decide" },
  { path: "audit", label: "Audit log", cap: "audit.read" },
  { path: "le", label: "Law enforcement", cap: "le.desk" },
  { path: "staff", label: "Staff", cap: "staff.manage" },
  { path: "categories", label: "Categories", cap: "taxonomy.manage" },
  { path: "policy", label: "Policies", cap: "audit.read" },
  { path: "contact", label: "Contact inbox", cap: "queue.reports" },
  { path: "mail", label: "Sample mail", cap: "audit.read" },
];

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await get<T>(path)); setError(""); } catch (err) { setError(messageOf(err)); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload, setError };
}

export default function Admin() {
  const { section = "dashboard", id } = useParams();
  const { data: me, error, reload } = useLoad<AdminMe>("/api/admin/me");
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!me) return <p className="muted">Loading</p>;
  if (!me.staff) {
    return (
      <div className="auth">
        <h1>Staff console</h1>
        {me.canClaim ? (
          <>
            <p>No admin exists yet. As the first verified account on this sample, you can take the admin seat. After that, only an admin can add staff.</p>
            <button className="btn" type="button" onClick={async () => { await post("/api/admin/claim"); await reload(); }}>Make me the admin</button>
          </>
        ) : <p>This area is for staff only. Ask an admin to add your email address.</p>}
      </div>
    );
  }
  const caps = new Set(me.staff.capabilities);
  const allowed = SECTIONS.filter((s) => caps.has(s.cap) && (s.path !== "mail" || me.sample));
  return (
    <div>
      <div className="spread"><h1 style={{ margin: 0 }}>Staff console</h1><span className="chip cyan">{me.staff.role.replace(/_/g, " ")}</span></div>
      {me.warnings.length > 0 && (
        <div className="notice amber" style={{ marginTop: "1rem" }}>
          <p><strong>Before real launch</strong></p>
          <ul style={{ margin: 0 }}>{me.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <nav className="admin-nav" aria-label="Staff sections">
        {allowed.map((s) => <NavLink key={s.path} to={`/admin/${s.path}`}>{s.label}</NavLink>)}
      </nav>
      {section === "dashboard" && <Dashboard sample={me.sample} canSample={caps.has("staff.manage")} />}
      {section === "premod" && <Premod />}
      {section === "reports" && <Reports caps={caps} />}
      {section === "members" && (id ? <User360 id={id} caps={caps} /> : <Members />)}
      {section === "appeals" && <Appeals />}
      {section === "audit" && <Audit canExport={caps.has("audit.export")} />}
      {section === "le" && <LawEnforcement />}
      {section === "staff" && <Staff />}
      {section === "categories" && <Categories />}
      {section === "policy" && <Policies canPublish={caps.has("policy.publish")} />}
      {section === "contact" && <ContactInbox />}
      {section === "mail" && <Outbox />}
    </div>
  );
}

const Kpi = ({ n, label, alert }: { n: ReactNode; label: string; alert?: boolean }) => <div className={`kpi ${alert ? "alert" : ""}`}><b>{n ?? "—"}</b><span>{label}</span></div>;

function Dashboard({ sample, canSample }: { sample: boolean; canSample: boolean }) {
  const { data: d, error, reload } = useLoad<any>("/api/admin/dashboard");
  const [msg, setMsg] = useState("");
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!d) return <p className="muted">Loading</p>;
  const list = (rows: { k: string; n: number }[]) => rows.length ? rows.map((r) => `${r.k.replace(/_/g, " ")}: ${r.n}`).join(", ") : "none";
  return (
    <div>
      <div className="kpis">
        <Kpi n={d.signups.total} label={`Members (${d.signups.last7d} in the last 7 days)`} />
        <Kpi n={d.ageCheck.passRate === null ? "—" : `${d.ageCheck.passRate}%`} label={`Age-check pass rate (${d.ageCheck.decided} checks, 30 days)`} />
        <Kpi n={d.verification.passRate === null ? "—" : `${d.verification.passRate}%`} label={`ID verification pass rate (${d.verification.decided} checks)`} />
        <Kpi n={d.queue.pending} label="Waiting for pre-moderation" />
        <Kpi n={d.queue.overdue} label="Past the SLA" alert={d.queue.overdue > 0} />
        <Kpi n={d.activeChats} label="Active chats (7 days)" />
        <Kpi n={d.datesArranged} label="Dates arranged" />
        <Kpi n={d.safetyAlerts.sos + d.safetyAlerts.missedCheckins} label={`Safety alerts (${d.safetyAlerts.sos} SOS, ${d.safetyAlerts.missedCheckins} missed check-ins)`} alert={d.safetyAlerts.sos > 0} />
      </div>
      <section className="panel"><h3>Open reports by reason</h3><p>{list(d.reportsByReason)}</p></section>
      <section className="panel"><h3>Actions taken (30 days)</h3><p>{list(d.actionsByKind)}</p></section>
      <section className="panel"><h3>Bot blocks and ban-evasion hits (30 days)</h3><p>{list(d.botBlocks)}</p></section>
      {sample && canSample && (
        <section className="panel tone-amber">
          <h3>Sample members</h3>
          <p className="small">{d.sampleMembers} clearly labelled SAMPLE profiles near London, so Discover is not empty. They like back and never message.</p>
          <div className="row">
            <button className="btn amber small" type="button" onClick={async () => { const r = await post<{ n: number }>("/api/admin/sample/seed"); setMsg(`Added ${r.n}.`); await reload(); }}>Add sample members</button>
            <button className="btn ghost small" type="button" onClick={async () => { const r = await post<{ n: number }>("/api/admin/sample/remove"); setMsg(`Removed ${r.n}.`); await reload(); }}>Remove sample members</button>
          </div>
          {msg && <p className="ok small" role="status">{msg}</p>}
        </section>
      )}
    </div>
  );
}

function ScoreChips({ scores }: { scores: Record<string, unknown> | null }) {
  if (!scores) return null;
  const s = scores as any;
  const tone = (v: number, hi: number) => (v >= hi ? "red" : v >= hi / 2 ? "amber" : "");
  return (
    <div className="scores">
      {typeof s.nudity === "number" && <span className={`chip ${tone(s.nudity, 0.85)}`}>nudity {Math.round(s.nudity * 100)}%</span>}
      {typeof s.minor === "number" && <span className={`chip ${tone(s.minor, 0.2)}`}>possible minor {Math.round(s.minor * 100)}%</span>}
      {typeof s.weapon === "number" && s.weapon > 0 && <span className="chip amber">weapon {Math.round(s.weapon * 100)}%</span>}
      {typeof s.drugs === "number" && s.drugs > 0 && <span className="chip amber">drugs {Math.round(s.drugs * 100)}%</span>}
      {typeof s.faces === "number" && <span className={`chip ${s.faces === 0 ? "amber" : ""}`}>{s.faces} face{s.faces === 1 ? "" : "s"}</span>}
      {s.provider && <span className="chip">scanner: {s.provider}</span>}
      {s.resubmission && <span className="chip">edited live profile</span>}
      {s.signal && <span className="chip red">ban-evasion signal: {s.signal}</span>}
      {s.duplicateIdentity && <span className="chip red">same identity on another account</span>}
    </div>
  );
}

function Premod() {
  const { data, error, reload, setError } = useLoad<{ items: any[]; reasons: Reason[] }>("/api/admin/premod");
  const [reasonFor, setReasonFor] = useState<Record<string, string>>({});
  async function decide(id: string, decision: string) {
    try { await post(`/api/admin/premod/${id}`, { decision, reasonCode: reasonFor[id] || undefined }); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  useEffect(() => {
    // Keyboard shortcuts on the first item (spec 8): A approve, R reject (with the chosen reason), E escalate.
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !data?.items[0]) return;
      const first = data.items[0];
      if (e.key === "a") void decide(first.id, "approve");
      if (e.key === "r" && reasonFor[first.id]) void decide(first.id, "reject");
      if (e.key === "e") void decide(first.id, "escalate");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!data) return error ? <ErrorText>{error}</ErrorText> : <p className="muted">Loading</p>;
  return (
    <div>
      <p className="small muted">Oldest SLA first. Shortcuts on the top item: A approve, R reject (choose a reason first), E escalate. Approve photos before the profile.</p>
      <ErrorText>{error}</ErrorText>
      {data.items.length === 0 && <p className="ok">The queue is empty.</p>}
      {data.items.map((it) => (
        <section className="panel queue-item" key={it.id}>
          <div className="spread">
            <strong>{{ photo: "Photo", profile: "Profile", ban_evasion: "Ban-evasion review", idv_review: "ID check: manual review" }[it.kind as string] ?? it.kind}</strong>
            <span className={it.slaDueAt < Date.now() ? "sla-late small" : "small muted"}>{it.slaDueAt < Date.now() ? "Overdue" : "Due"} {when(it.slaDueAt)}</span>
          </div>
          <ScoreChips scores={it.scores} />
          {it.profile && (
            <div>
              <p style={{ margin: "0.4rem 0 0.2rem" }}><strong>{it.profile.displayName || "(no name)"}</strong>{it.profile.birthYear ? `, born ${it.profile.birthYear}` : ""}{it.profile.area ? `, ${it.profile.area}` : ""}</p>
              {it.profile.bio && <p className="small">{it.profile.bio}</p>}
            </div>
          )}
          {it.photos.length > 0 && (
            <div className="photos">
              {it.photos.map((p: any) => <div className="ph" key={p.id}><img src={p.url} alt={`Photo under review for ${it.profile?.displayName ?? "member"}`} /><span className={`chip ${p.status === "approved" ? "volt" : "amber"}`}>{p.status}</span></div>)}
            </div>
          )}
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button className="btn small" type="button" onClick={() => decide(it.id, "approve")}>Approve</button>
            <label className="sr-only" htmlFor={`r-${it.id}`}>Reason for rejecting</label>
            <select id={`r-${it.id}`} value={reasonFor[it.id] ?? ""} onChange={(e) => setReasonFor({ ...reasonFor, [it.id]: e.target.value })} style={{ width: "auto", flex: "1 1 200px" }}>
              <option value="">Reason, to reject</option>
              {data.reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <button className="btn red small" type="button" disabled={!reasonFor[it.id]} onClick={() => decide(it.id, "reject")}>Reject</button>
            <button className="btn ghost small" type="button" onClick={() => decide(it.id, "escalate")}>Escalate</button>
            <Link className="small" to={`/admin/members/${it.userId}`}>User 360</Link>
          </div>
        </section>
      ))}
    </div>
  );
}

function Reports({ caps }: { caps: Set<string> }) {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const { data, error, reload, setError } = useLoad<{ reports: any[]; reasons: Reason[] }>(`/api/admin/reports?status=${tab}`);
  const [chat, setChat] = useState<{ id: string; messages: any[] } | null>(null);
  const [form, setForm] = useState<Record<string, { kind: string; reasonCode: string; days: string; note: string }>>({});
  const f = (id: string) => form[id] ?? { kind: "warn", reasonCode: "", days: "7", note: "" };
  async function resolve(id: string, outcome: string) {
    const v = f(id);
    try {
      await post(`/api/admin/reports/${id}/resolve`, { outcome, note: v.note, action: outcome === "action_taken" ? { kind: v.kind, reasonCode: v.reasonCode, durationDays: v.kind === "restrict" || v.kind === "suspend" ? Number(v.days) : undefined } : undefined });
      await reload();
    } catch (err) { setError(messageOf(err)); }
  }
  async function openChat(id: string) {
    try { const r = await get<{ messages: any[] }>(`/api/admin/reports/${id}/chat`); setChat({ id, messages: r.messages }); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <div>
      <div className="row"><button className={`btn small ${tab === "open" ? "cyan" : "ghost"}`} type="button" onClick={() => setTab("open")}>Open</button><button className={`btn small ${tab === "resolved" ? "cyan" : "ghost"}`} type="button" onClick={() => setTab("resolved")}>Resolved</button></div>
      <p className="small muted">Highest priority first: under 18, threats and child abuse at the top, then scams. Opening a chat is logged.</p>
      <ErrorText>{error}</ErrorText>
      {data?.reports.length === 0 && <p className="ok">Nothing here.</p>}
      {data?.reports.map((r) => r.restricted ? (
        <section className="panel tone-red" key={r.id}><strong>Escalated: {r.reason}</strong><p className="small">Handled by the Trust and safety lead. Reference {r.id}.</p></section>
      ) : (
        <section className={`panel ${r.priority === 0 ? "tone-red" : r.priority === 1 ? "tone-amber" : ""}`} key={r.id}>
          <div className="spread"><strong>{r.reasonLabel}</strong><span className="small muted">P{r.priority}, {when(r.createdAt)}, {r.status}</span></div>
          <p className="small">About <Link to={`/admin/members/${r.subjectUserId}`}>{r.subject.name}</Link> (risk {r.subject.riskScore}, {r.subject.status}){r.duplicates ? `. ${r.duplicates} duplicate report${r.duplicates === 1 ? "" : "s"} merged in` : ""}.</p>
          {r.detail && <p className="small">“{r.detail}”</p>}
          {r.outcome && <p className="small"><strong>Outcome:</strong> {r.outcome.replace(/_/g, " ")}. {r.outcomeNote}</p>}
          {tab === "open" && (
            <>
              <div className="row">
                {r.status === "open" && <button className="btn ghost small" type="button" onClick={async () => { await post(`/api/admin/reports/${r.id}/assign`); await reload(); }}>Assign to me</button>}
                {r.conversationId && caps.has("chat.open_on_report") && <button className="btn ghost small" type="button" onClick={() => openChat(r.id)}>Open chat (logged)</button>}
              </div>
              <div className="row" style={{ marginTop: "0.6rem" }}>
                <select aria-label="Action" value={f(r.id).kind} onChange={(e) => setForm({ ...form, [r.id]: { ...f(r.id), kind: e.target.value } })} style={{ width: "auto" }}>
                  <option value="warn">Warn</option><option value="restrict">Restrict messaging</option><option value="suspend">Suspend</option>{caps.has("enforce.ban") && <option value="ban">Ban</option>}
                </select>
                {(f(r.id).kind === "restrict" || f(r.id).kind === "suspend") && <input aria-label="Days" type="number" min={1} max={caps.has("enforce.suspend_long") ? 3650 : 7} value={f(r.id).days} onChange={(e) => setForm({ ...form, [r.id]: { ...f(r.id), days: e.target.value } })} style={{ width: 90 }} />}
                <select aria-label="Reason code" value={f(r.id).reasonCode} onChange={(e) => setForm({ ...form, [r.id]: { ...f(r.id), reasonCode: e.target.value } })} style={{ width: "auto", flex: "1 1 200px" }}>
                  <option value="">Reason code</option>
                  {data.reasons.map((x) => <option key={x.code} value={x.code}>{x.label}{x.zeroTolerance ? " (zero tolerance)" : ""}</option>)}
                </select>
              </div>
              <div className="field" style={{ marginTop: "0.6rem" }}><label htmlFor={`n-${r.id}`} className="sr-only">Note</label><input id={`n-${r.id}`} type="text" placeholder="Internal note" value={f(r.id).note} onChange={(e) => setForm({ ...form, [r.id]: { ...f(r.id), note: e.target.value } })} /></div>
              <div className="row">
                <button className="btn red small" type="button" disabled={!f(r.id).reasonCode} onClick={() => resolve(r.id, "action_taken")}>Take action</button>
                <button className="btn ghost small" type="button" onClick={() => resolve(r.id, "no_action")}>No breach</button>
                {caps.has("escalation.handle") || <button className="btn ghost small" type="button" onClick={() => resolve(r.id, "escalated")}>Escalate</button>}
              </div>
            </>
          )}
          {chat?.id === r.id && (
            <div className="panel" style={{ marginTop: "0.75rem" }}>
              <div className="spread"><h3 style={{ margin: 0 }}>Chat transcript</h3><button className="btn ghost small" type="button" onClick={() => setChat(null)}>Close</button></div>
              {chat?.messages.map((m) => <p className="small" key={m.id}><strong>{m.senderId === r.subjectUserId ? "Reported member" : m.senderId === "system" ? "System" : "Other member"}</strong> {when(m.at)}: {m.text || `[${m.kind}]`} {m.flags.length > 0 && <span className="chip amber">{m.flags.join(", ")}</span>}</p>)}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function Members() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState("");
  const search = useCallback(async (query: string) => { try { setRows((await get<{ users: any[] }>(`/api/admin/users?q=${encodeURIComponent(query)}`)).users); } catch (err) { setError(messageOf(err)); } }, []);
  useEffect(() => { void search(""); }, [search]);
  return (
    <div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void search(q); }}>
        <label htmlFor="mq" className="sr-only">Search members</label>
        <input id="mq" type="search" placeholder="Email, name or member id" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 260px" }} />
        <button className="btn small">Search</button>
      </form>
      <ErrorText>{error}</ErrorText>
      <div className="table-wrap" role="region" aria-label="Members table, scrolls sideways" tabIndex={0} style={{ marginTop: "1rem" }}>
        <table className="data">
          <thead><tr><th>Member</th><th>Status</th><th>Risk</th><th>Joined</th></tr></thead>
          <tbody>{rows?.map((u) => <tr key={u.id}><td><Link to={`/admin/members/${u.id}`}>{u.name || u.email || u.id}</Link>{u.sample && <span className="chip amber" style={{ marginLeft: 6 }}>SAMPLE</span>}</td><td>{u.status}</td><td>{u.risk}</td><td>{when(u.createdAt)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function User360({ id, caps }: { id: string; caps: Set<string> }) {
  const { data: d, error, reload, setError } = useLoad<any>(`/api/admin/users/${id}`);
  const { data: reasons } = useLoad<{ reasons: Reason[] }>("/api/admin/reports?status=open");
  const [act, setAct] = useState({ kind: "warn", reasonCode: "", days: "7", note: "" });
  const [msg, setMsg] = useState("");
  async function enforce(e: FormEvent) {
    e.preventDefault();
    try { await post(`/api/admin/users/${id}/enforce`, { kind: act.kind, reasonCode: act.reasonCode, note: act.note, durationDays: act.kind === "restrict" || act.kind === "suspend" ? Number(act.days) : undefined }); setMsg("Action applied. The member has been told why and how to appeal."); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  async function lift(actionId: string) {
    const note = prompt("Why is this being lifted? The member sees this note.");
    if (!note) return;
    try { await post(`/api/admin/actions/${actionId}/lift`, { note }); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  if (!d) return error ? <ErrorText>{error}</ErrorText> : <p className="muted">Loading</p>;
  return (
    <div>
      <p><Link to="/admin/members">All members</Link></p>
      <div className="spread"><h2 style={{ margin: 0 }}>{d.profile?.displayName || d.user.email || d.user.id}</h2><span className={`chip ${d.user.status === "active" ? "volt" : "red"}`}>{d.user.status}</span></div>
      <p className="small muted">{d.user.email}. Joined {when(d.user.createdAt)}. Risk score {d.user.riskScore}. Id {d.user.id}.{d.user.sample ? " SAMPLE member." : ""} This view is logged.</p>
      <ErrorText>{error}</ErrorText>
      {msg && <p className="ok">{msg}</p>}
      <div className="kpis">
        <Kpi n={d.verification.age[0]?.status ?? "none"} label="Age check" />
        <Kpi n={d.verification.idv[0]?.status ?? "none"} label="ID + liveness (result only)" />
        <Kpi n={d.reportsAgainst.length} label="Reports against" alert={d.reportsAgainst.length > 0} />
        <Kpi n={d.reportsBy.length} label="Reports made" />
      </div>
      {d.profile && <section className="panel"><h3>Profile ({d.profile.status})</h3><p>{d.profile.bio}</p><p className="small muted">Born {d.profile.birthYear}, {d.profile.area}, looking for {d.profile.lookingFor}{d.identityShown && Object.keys(d.identityShown).length ? `, shows ${Object.values(d.identityShown).join(", ")}` : ""}.</p>
        {d.photos.length > 0 && <div className="photos">{d.photos.map((p: any) => <div className="ph" key={p.id}><img src={p.url} alt="Member photo" /><span className="chip">{p.status}</span></div>)}</div>}
        {d.quarantined > 0 && <p className="error small">{d.quarantined} item(s) quarantined. Not shown.</p>}
      </section>}
      <section className="panel"><h3>Actions</h3>
        {d.actions.length === 0 ? <p className="small muted">None.</p> : (
          <div className="table-wrap" role="region" aria-label="Table, scrolls sideways" tabIndex={0}><table className="data"><thead><tr><th>Action</th><th>Reason</th><th>When</th><th>Ends</th><th /></tr></thead><tbody>
            {d.actions.map((a: any) => <tr key={a.id}><td>{a.kind}</td><td>{a.reasonCode}</td><td>{when(a.at)}</td><td>{a.liftedAt ? `lifted ${when(a.liftedAt)}` : a.expiresAt ? when(a.expiresAt) : a.kind === "ban" ? "permanent" : ""}</td><td>{!a.liftedAt && caps.has("appeals.decide") && <button className="btn ghost small" type="button" onClick={() => lift(a.id)}>Lift</button>}</td></tr>)}
          </tbody></table></div>
        )}
        <form onSubmit={enforce} style={{ marginTop: "0.75rem" }}>
          <div className="row">
            <select aria-label="Action" value={act.kind} onChange={(e) => setAct({ ...act, kind: e.target.value })} style={{ width: "auto" }}>
              <option value="warn">Warn</option><option value="restrict">Restrict messaging</option><option value="suspend">Suspend</option>{caps.has("enforce.ban") && <option value="ban">Ban</option>}
            </select>
            {(act.kind === "restrict" || act.kind === "suspend") && <input aria-label="Days" type="number" min={1} value={act.days} onChange={(e) => setAct({ ...act, days: e.target.value })} style={{ width: 90 }} />}
            <select aria-label="Reason code" value={act.reasonCode} onChange={(e) => setAct({ ...act, reasonCode: e.target.value })} style={{ width: "auto", flex: "1 1 200px" }}>
              <option value="">Reason code</option>{reasons?.reasons.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginTop: "0.5rem" }}><label htmlFor="enote" className="sr-only">Note</label><input id="enote" type="text" placeholder="Internal note" value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} /></div>
          <button className="btn red small" disabled={!act.reasonCode}>Apply action</button>
        </form>
      </section>
      <section className="panel"><h3>Messages flagged by the system</h3>
        {d.flaggedMessages.length === 0 ? <p className="small muted">None.</p> : d.flaggedMessages.map((f: any) => <p className="small" key={f.id}><span className="chip amber">{f.flags.join(", ")}</span> {when(f.at)}: {f.excerpt}</p>)}
        <p className="small muted">Full chats open only from an open report.</p>
      </section>
      <section className="panel"><h3>Linked accounts (same device)</h3>{d.linkedAccounts.length === 0 ? <p className="small muted">None found.</p> : d.linkedAccounts.map((l: any) => <p key={l.id}><Link to={`/admin/members/${l.id}`}>{l.id}</Link> ({l.status})</p>)}</section>
      <section className="panel"><h3>Reports</h3>
        {[...d.reportsAgainst.map((r: any) => ({ ...r, dir: "against" })), ...d.reportsBy.map((r: any) => ({ ...r, dir: "by" }))].map((r: any) => <p className="small" key={r.id + r.dir}>{r.dir === "against" ? "Against them" : "Made by them"}: {r.reason}, {r.status}{r.outcome ? ` (${r.outcome.replace(/_/g, " ")})` : ""}, {when(r.at)}</p>)}
      </section>
    </div>
  );
}

function Appeals() {
  const { data, error, reload, setError } = useLoad<{ appeals: any[] }>("/api/admin/appeals");
  const [notes, setNotes] = useState<Record<string, string>>({});
  async function decide(id: string, decision: string) {
    try { await post(`/api/admin/appeals/${id}`, { decision, note: notes[id] ?? "" }); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <div>
      <p className="small muted">Decided by someone other than the person who took the action.</p>
      <ErrorText>{error}</ErrorText>
      {data?.appeals.length === 0 && <p className="ok">No open appeals.</p>}
      {data?.appeals.map((a) => (
        <section className="panel" key={a.id}>
          <div className="spread"><strong>Appeal against {a.action?.kind} ({a.action?.reasonCode})</strong><span className="small muted">{when(a.at)}</span></div>
          <p>“{a.body}”</p>
          <p className="small muted">Original note: {a.action?.note || "none"}. <Link to={`/admin/members/${a.userId}`}>User 360</Link></p>
          <div className="field"><label htmlFor={`an-${a.id}`} className="sr-only">Note to the member</label><input id={`an-${a.id}`} type="text" placeholder="Note to the member" value={notes[a.id] ?? ""} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} /></div>
          <div className="row"><button className="btn small" type="button" onClick={() => decide(a.id, "overturned")}>Overturn and lift</button><button className="btn ghost small" type="button" onClick={() => decide(a.id, "upheld")}>Uphold</button></div>
        </section>
      ))}
    </div>
  );
}

function Audit({ canExport }: { canExport: boolean }) {
  const [q, setQ] = useState("");
  const [path, setPath] = useState("/api/admin/audit");
  const { data, error } = useLoad<{ entries: any[] }>(path);
  return (
    <div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setPath(`/api/admin/audit?q=${encodeURIComponent(q)}`); }}>
        <label htmlFor="aq" className="sr-only">Search the audit log</label>
        <input id="aq" type="search" placeholder="Member id, staff id or action" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 260px" }} />
        <button className="btn small">Search</button>
        {canExport && <a className="btn ghost small" href="/api/admin/audit/export" download>Export for regulator or court</a>}
      </form>
      <p className="small muted">Append-only. Entries cannot be changed or deleted, even by an admin.</p>
      <ErrorText>{error}</ErrorText>
      <div className="table-wrap" role="region" aria-label="Table, scrolls sideways" tabIndex={0}><table className="data"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead><tbody>
        {data?.entries.map((e) => <tr key={e.id}><td>{when(e.createdAt)}</td><td>{e.actorRole} {e.actorId}</td><td>{e.action}</td><td>{e.targetType} {e.targetId}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}

function LawEnforcement() {
  const { data, error, reload, setError } = useLoad<{ requests: any[] }>("/api/admin/le");
  const [f, setF] = useState({ agency: "", reference: "", contact: "", subjectUserId: "", legalBasis: "", emergency: false });
  async function act(id: string, action: string) {
    const note = action === "disclose" || action === "refuse" ? prompt("Record what was disclosed or why it was refused.") ?? "" : "";
    try { await post(`/api/admin/le/${id}`, { action, note }); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <div>
      <div className="notice amber"><p>Process and legal bases need a solicitor's sign-off [LEGAL]. Threat-to-life requests go to the top and may be answered before the legal-basis check.</p></div>
      <section className="panel">
        <h3>Log a new request</h3>
        <form onSubmit={async (e) => { e.preventDefault(); try { await post("/api/admin/le", { ...f, subjectUserId: f.subjectUserId || undefined }); setF({ agency: "", reference: "", contact: "", subjectUserId: "", legalBasis: "", emergency: false }); await reload(); } catch (err) { setError(messageOf(err)); } }}>
          <div className="field"><label htmlFor="le-a">Agency</label><input id="le-a" type="text" value={f.agency} onChange={(e) => setF({ ...f, agency: e.target.value })} /></div>
          <div className="field"><label htmlFor="le-r">Their reference</label><input id="le-r" type="text" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></div>
          <div className="field"><label htmlFor="le-c">Officer contact</label><input id="le-c" type="text" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></div>
          <div className="field"><label htmlFor="le-s">Member id <span className="hint">From User 360, if known.</span></label><input id="le-s" type="text" value={f.subjectUserId} onChange={(e) => setF({ ...f, subjectUserId: e.target.value })} /></div>
          <div className="field"><label htmlFor="le-b">Legal basis given</label><textarea id="le-b" value={f.legalBasis} onChange={(e) => setF({ ...f, legalBasis: e.target.value })} /></div>
          <label className="check"><input type="checkbox" checked={f.emergency} onChange={(e) => setF({ ...f, emergency: e.target.checked })} /> <span>Emergency: threat to life</span></label>
          <button className="btn small">Log request</button>
        </form>
      </section>
      <ErrorText>{error}</ErrorText>
      {data?.requests.map((r) => (
        <section className={`panel ${r.emergency ? "tone-red" : ""}`} key={r.id}>
          <div className="spread"><strong>{r.agency} {r.reference}</strong><span className="chip">{r.status}</span></div>
          <p className="small">{r.emergency ? "EMERGENCY. " : ""}Legal basis {r.legalBasisChecked ? "checked" : "not yet checked"}. {r.preservationUntil ? `Preserved until ${when(r.preservationUntil)}.` : ""} Logged {when(r.createdAt)}.</p>
          <div className="row">
            {!r.legalBasisChecked && <button className="btn ghost small" type="button" onClick={() => act(r.id, "basis_checked")}>Mark legal basis checked</button>}
            {r.subjectUserId && <button className="btn ghost small" type="button" onClick={() => act(r.id, "preserve")}>Preserve records (90 days)</button>}
            <button className="btn ghost small" type="button" onClick={() => act(r.id, "disclose")}>Record disclosure</button>
            <button className="btn ghost small" type="button" onClick={() => act(r.id, "refuse")}>Refuse</button>
            <button className="btn ghost small" type="button" onClick={() => act(r.id, "close")}>Close</button>
          </div>
        </section>
      ))}
    </div>
  );
}

function Staff() {
  const { data, error, reload, setError } = useLoad<{ staff: any[] }>("/api/admin/staff");
  const [f, setF] = useState({ email: "", name: "", role: "moderator" });
  return (
    <div>
      <section className="panel">
        <h3>Add staff or change a role</h3>
        <p className="small muted">They sign up as a normal member with this email, then open the Staff console from Me.</p>
        <form onSubmit={async (e) => { e.preventDefault(); try { await post("/api/admin/staff", f); setF({ email: "", name: "", role: "moderator" }); await reload(); } catch (err) { setError(messageOf(err)); } }}>
          <div className="field"><label htmlFor="st-e">Email</label><input id="st-e" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="st-n">Name</label><input id="st-n" type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="st-r">Role</label><select id="st-r" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="moderator">Moderator (queues, warn, restrict, suspend up to 7 days)</option>
            <option value="senior_moderator">Senior moderator (bans, appeals, ban-evasion review)</option>
            <option value="ts_lead">Trust and safety lead (CSAM and law-enforcement escalations, policy)</option>
            <option value="admin">Admin (staff, settings, categories)</option>
            <option value="agency_staff">Agency staff (Phase 2 portfolios only)</option>
          </select></div>
          <button className="btn small">Save</button>
        </form>
      </section>
      <ErrorText>{error}</ErrorText>
      <div className="table-wrap" role="region" aria-label="Table, scrolls sideways" tabIndex={0}><table className="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th /></tr></thead><tbody>
        {data?.staff.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.email}</td><td>{s.role.replace(/_/g, " ")}</td><td>{s.active ? "yes" : "no"}</td><td>{s.active && <button className="btn ghost small" type="button" onClick={async () => { try { await post(`/api/admin/staff/${s.id}/deactivate`); await reload(); } catch (err) { setError(messageOf(err)); } }}>Deactivate</button>}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}

function Categories() {
  const { data, error, reload, setError } = useLoad<{ items: any[] }>("/api/admin/taxonomy");
  const [f, setF] = useState({ kind: "looking_for", slug: "", label: "" });
  const save = async (body: unknown) => { try { await post("/api/admin/taxonomy", body); await reload(); } catch (err) { setError(messageOf(err)); } };
  return (
    <div>
      <section className="panel">
        <h3>Add a category</h3>
        <form onSubmit={async (e) => { e.preventDefault(); await save({ ...f, active: true }); setF({ ...f, slug: "", label: "" }); }}>
          <div className="field"><label htmlFor="tx-k">Type</label><select id="tx-k" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="looking_for">Looking for</option><option value="gender">Gender</option><option value="orientation">Sexuality</option></select></div>
          <div className="field"><label htmlFor="tx-s">Short code <span className="hint">Lowercase letters, numbers and underscores.</span></label><input id="tx-s" type="text" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></div>
          <div className="field"><label htmlFor="tx-l">Label members see</label><input id="tx-l" type="text" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
          <button className="btn small">Add</button>
        </form>
      </section>
      <ErrorText>{error}</ErrorText>
      <div className="table-wrap" role="region" aria-label="Table, scrolls sideways" tabIndex={0}><table className="data"><thead><tr><th>Type</th><th>Label</th><th>Code</th><th>Shown</th><th /></tr></thead><tbody>
        {data?.items.map((t) => <tr key={t.id}><td>{t.kind.replace(/_/g, " ")}</td><td>{t.label}</td><td>{t.slug}</td><td>{t.active ? "yes" : "no"}</td><td><button className="btn ghost small" type="button" onClick={() => save({ kind: t.kind, slug: t.slug, label: t.label, active: !t.active })}>{t.active ? "Hide" : "Show"}</button></td></tr>)}
      </tbody></table></div>
    </div>
  );
}

function Policies({ canPublish }: { canPublish: boolean }) {
  const { data, error, reload, setError } = useLoad<{ versions: any[] }>("/api/admin/policy");
  const [f, setF] = useState({ kind: "terms", version: "", note: "" });
  return (
    <div>
      {canPublish && (
        <section className="panel">
          <h3>Record a published version</h3>
          <form onSubmit={async (e) => { e.preventDefault(); try { await post("/api/admin/policy", f); setF({ ...f, version: "", note: "" }); await reload(); } catch (err) { setError(messageOf(err)); } }}>
            <div className="field"><label htmlFor="pv-k">Document</label><select id="pv-k" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="terms">Terms</option><option value="privacy">Privacy notice</option><option value="guidelines">Community guidelines</option><option value="special_category_consent">Identity consent wording</option></select></div>
            <div className="field"><label htmlFor="pv-v">Version</label><input id="pv-v" type="text" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></div>
            <div className="field"><label htmlFor="pv-n">What changed</label><input id="pv-n" type="text" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
            <button className="btn small">Record version</button>
          </form>
        </section>
      )}
      <ErrorText>{error}</ErrorText>
      {data?.versions.length === 0 && <p className="muted">No versions recorded yet.</p>}
      <div className="table-wrap" role="region" aria-label="Table, scrolls sideways" tabIndex={0}><table className="data"><thead><tr><th>Document</th><th>Version</th><th>Published</th><th>Note</th></tr></thead><tbody>
        {data?.versions.map((v) => <tr key={v.id}><td>{v.kind}</td><td>{v.version}</td><td>{when(v.publishedAt)}</td><td>{v.note}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}

function ContactInbox() {
  const { data, error, reload } = useLoad<{ messages: any[] }>("/api/admin/contact");
  return (
    <div>
      <ErrorText>{error}</ErrorText>
      {data?.messages.length === 0 && <p className="ok">No messages.</p>}
      {data?.messages.map((m) => (
        <section className={`panel ${m.topic === "safety" || m.topic === "law_enforcement" ? "tone-amber" : ""}`} key={m.id}>
          <div className="spread"><strong>{m.topic.replace(/_/g, " ")}: {m.name}</strong><span className="small muted">{when(m.createdAt)}, {m.status}</span></div>
          <p>{m.body}</p>
          <div className="row"><a className="btn ghost small" href={`mailto:${m.email}`}>Reply by email</a>{m.status === "new" && <button className="btn ghost small" type="button" onClick={async () => { await post(`/api/admin/contact/${m.id}/handled`); await reload(); }}>Mark handled</button>}</div>
        </section>
      ))}
    </div>
  );
}

function Outbox() {
  const { data, error } = useLoad<{ messages: any[] }>("/api/admin/outbox");
  return (
    <div>
      <div className="notice amber"><p>SAMPLE: no email or text is really sent. This is what would have gone out. Viewing it is logged.</p></div>
      <ErrorText>{error}</ErrorText>
      {data?.messages.map((m) => (
        <section className="panel" key={m.id}>
          <div className="spread"><strong>{m.subject || m.template}</strong><span className="small muted">{m.channel} to {m.toAddress}, {when(m.createdAt)}</span></div>
          <p className="small" style={{ whiteSpace: "pre-wrap" }}>{m.body}</p>
        </section>
      ))}
    </div>
  );
}
