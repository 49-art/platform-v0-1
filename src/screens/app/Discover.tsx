import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ReportSheet } from "../../components/Report";
import { ErrorText, Sheet, VerifiedChip } from "../../components/ui";
import { get, messageOf, post } from "../../lib/api";

export interface PublicProfile {
  userId: string; displayName: string; age: number | null; bio: string; lookingFor: string; countryOfOrigin: string; area: string;
  identity: Record<string, string>; verified: boolean; distanceKm: number | null; photos: string[];
}

const LOOKING: Record<string, string> = { relationship: "A relationship", dating: "Dating, see where it goes", dinner: "Dinner dates", friendship: "New friends" };

export function ProfileCard({ p }: { p: PublicProfile }) {
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [p.userId]);
  const n = p.photos.length;
  return (
    <article className="card-person" aria-label={`${p.displayName}${p.age ? `, ${p.age}` : ""}`}>
      <div className="photo">
        {n > 0 && <img src={p.photos[i]} alt={`Photo ${i + 1} of ${n} of ${p.displayName}`} />}
        {n > 1 && <div className="dots" aria-hidden="true">{p.photos.map((_, k) => <span key={k} className={k === i ? "on" : ""} />)}</div>}
        {n > 1 && <button className="prev" type="button" aria-label="Previous photo" onClick={() => setI((i - 1 + n) % n)} />}
        {n > 1 && <button className="next" type="button" aria-label="Next photo" onClick={() => setI((i + 1) % n)} />}
        <span className="verified-tag"><VerifiedChip verified={p.verified} /></span>
      </div>
      <div className="body">
        <h2>{p.displayName}{p.age ? `, ${p.age}` : ""}</h2>
        <p className="muted" style={{ margin: 0 }}>{p.area}{p.distanceKm !== null ? `, about ${Math.max(1, Math.round(p.distanceKm))} km away` : ""}</p>
        <div className="facts">
          {p.lookingFor && <span className="chip pink">{LOOKING[p.lookingFor] ?? p.lookingFor}</span>}
          {p.countryOfOrigin && <span className="chip">From {p.countryOfOrigin}</span>}
          {Object.entries(p.identity).map(([k, v]) => <span className="chip" key={k}>{v.replace(/_/g, " ")}</span>)}
        </div>
        {p.bio && <p>{p.bio}</p>}
      </div>
    </article>
  );
}

export default function Discover() {
  const navigate = useNavigate();
  const [list, setList] = useState<PublicProfile[] | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ minAge: "18", maxAge: "99", km: "50", lookingFor: "", verifiedOnly: false });
  const [match, setMatch] = useState<{ name: string; conversationId: string } | null>(null);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const q = new URLSearchParams({ minAge: filters.minAge, maxAge: filters.maxAge, km: filters.km, verifiedOnly: filters.verifiedOnly ? "1" : "0" });
    if (filters.lookingFor) q.set("lookingFor", filters.lookingFor);
    try { setList((await get<{ profiles: PublicProfile[] }>(`/api/discover?${q}`)).profiles); } catch (err) { setError(messageOf(err)); setList([]); }
  }, [filters]);
  useEffect(() => { void load(); }, [load]);

  const current = list?.[0];
  async function decide(kind: "like" | "pass") {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await post<{ matched: boolean; conversationId?: string }>("/api/likes", { userId: current.userId, kind });
      if (r.matched && r.conversationId) setMatch({ name: current.displayName, conversationId: r.conversationId });
      setList((l) => (l ? l.slice(1) : l));
      if ((list?.length ?? 0) <= 2) void load();
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="spread">
        <h1 style={{ margin: 0 }}>Discover</h1>
        <details className="filters">
          <summary>Filters</summary>
          <div className="panel" style={{ marginTop: "0.5rem" }}>
            <div className="grid2">
              <div className="field"><label htmlFor="fmin">Age from</label><input id="fmin" type="number" min={18} max={99} value={filters.minAge} onChange={(e) => setFilters({ ...filters, minAge: e.target.value })} /></div>
              <div className="field"><label htmlFor="fmax">to</label><input id="fmax" type="number" min={18} max={99} value={filters.maxAge} onChange={(e) => setFilters({ ...filters, maxAge: e.target.value })} /></div>
            </div>
            <div className="field">
              <label htmlFor="fkm">Within</label>
              <select id="fkm" value={filters.km} onChange={(e) => setFilters({ ...filters, km: e.target.value })}>
                {["10", "25", "50", "100", "250", "800"].map((k) => <option key={k} value={k}>{k} km</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="flf">Looking for</label>
              <select id="flf" value={filters.lookingFor} onChange={(e) => setFilters({ ...filters, lookingFor: e.target.value })}>
                <option value="">Anything</option>
                {Object.entries(LOOKING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <label className="check"><input type="checkbox" checked={filters.verifiedOnly} onChange={(e) => setFilters({ ...filters, verifiedOnly: e.target.checked })} /> <span>Only show ID-verified people</span></label>
          </div>
        </details>
      </div>
      <ErrorText>{error}</ErrorText>
      {list === null && <p className="muted">Finding people near you</p>}
      {list && !current && (
        <div className="panel" style={{ marginTop: "1rem" }}>
          <h2>No one new nearby right now</h2>
          <p className="muted">Try a wider distance or age range in Filters, or check back later. New profiles appear as soon as a moderator approves them.</p>
        </div>
      )}
      {current && (
        <div style={{ marginTop: "1rem", maxWidth: 520 }}>
          <ProfileCard p={current} />
          <div className="decide">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => decide("pass")}>Pass</button>
            <button className="btn pink" type="button" disabled={busy} onClick={() => decide("like")}>Like</button>
          </div>
          <p className="center"><button className="linkish" type="button" onClick={() => setReporting(true)}>Report a bot or a fake profile</button></p>
          <ReportSheet open={reporting} onClose={() => setReporting(false)} userId={current.userId} name={current.displayName}
            onDone={(blocked) => { if (blocked) setList((l) => (l ? l.slice(1) : l)); }} />
        </div>
      )}
      <Sheet open={!!match} onClose={() => setMatch(null)} title="It's a match">
        <p>You and {match?.name} liked each other. Say hello.</p>
        <p className="muted small">Date planning unlocks when you are both ID-verified. <Link to="/app/verify">Verify now</Link></p>
        <div className="row">
          <button className="btn pink" type="button" onClick={() => match && navigate(`/app/chat/${match.conversationId}`)}>Open the chat</button>
          <button className="btn ghost" type="button" onClick={() => setMatch(null)}>Keep browsing</button>
        </div>
      </Sheet>
    </div>
  );
}
