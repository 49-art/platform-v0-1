import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ErrorText, SampleLinkBox } from "../../components/ui";
import { type SampleLink, api, del, get, messageOf, post, put } from "../../lib/api";
import { preparePhoto } from "../../lib/image";
import { pathForStep, useSession } from "../../lib/session";

/** The sign-up journey is a real sequence (spec 2 steps 1 to 4), so it is shown as one. */
function Steps({ at }: { at: number }) {
  const names = ["Account", "Email", "Age check", "Profile", "Approval"];
  return (
    <ol className="steps" aria-label={`Step ${at + 1} of 5: ${names[at]}`}>
      {names.map((n, i) => <li key={n} className={i < at ? "done" : i === at ? "now" : ""} />)}
    </ol>
  );
}

export function EmailStep() {
  const { me, refresh } = useSession();
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [sample, setSample] = useState<SampleLink | undefined>();
  const capture = me?.step === "email_capture";
  async function resend() {
    setError("");
    try { const r = await post<{ sample?: SampleLink }>("/api/auth/resend-verification"); setSample(r.sample); setMsg("We have sent a fresh link."); } catch (err) { setError(messageOf(err)); }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { const r = await post<{ sample?: SampleLink }>("/api/me/email", { email }); setSample(r.sample); setMsg("Check your inbox for a link to confirm it."); await refresh(); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <div className="auth">
      <Steps at={1} />
      {capture ? (
        <>
          <h1>Add your email</h1>
          <p className="muted">We use it for sign-in links and safety notices only. No marketing.</p>
          <form onSubmit={save}>
            <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <button className="btn block">Save email</button>
          </form>
        </>
      ) : (
        <>
          <h1>Confirm your email</h1>
          <p>We sent a link to <strong>{me?.user?.email}</strong>. Open it on this device to carry on.</p>
          <button className="btn ghost" type="button" onClick={resend}>Send the link again</button>
        </>
      )}
      {msg && <p className="ok" role="status">{msg}</p>}
      <SampleLinkBox sample={sample} />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

export function AgeStep() {
  const { me } = useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const left = me?.flags?.ageAttemptsLeft ?? 3;
  async function start() {
    setBusy(true);
    setError("");
    try {
      const r = await post<{ url?: string; alreadyPassed?: boolean }>("/api/age/start");
      if (r.url) window.location.assign(r.url);
      else window.location.assign("/app");
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return (
    <div className="auth">
      <Steps at={2} />
      <h1>Prove you are 18 or over</h1>
      <p>A quick check with our age provider: a selfie for face age estimation, or a photo of your ID. It takes about a minute.</p>
      <p className="muted">We never see or keep your ID document. The provider only tells us pass or fail.</p>
      {me?.config.sample && <div className="notice amber"><p><strong>SAMPLE:</strong> no real check happens. A practice page lets you choose the result.</p></div>}
      {left < 3 && <p className="error">That check did not pass. You have {left} {left === 1 ? "try" : "tries"} left.</p>}
      <ErrorText>{error}</ErrorText>
      <button className="btn block" type="button" disabled={busy} onClick={start}>{busy ? "Opening the check" : "Start the age check"}</button>
    </div>
  );
}

interface ProfileData {
  profile: { displayName: string; birthYear: number | null; bio: string; lookingFor: string; countryOfOrigin: string; area: string; hasLocation: boolean; status: string; rejectionReason: string | null } | null;
  identity: { gender?: string; orientation?: string; pronouns?: string; show: ("gender" | "orientation" | "pronouns")[] } | null;
  specialCategoryConsent: boolean;
  photos: { id: string; status: string; url: string }[];
  limits: { maxPhotos: number; maxPhotoBytes: number };
}
interface Taxonomy { lookingFor: { slug: string; label: string }[]; gender: { slug: string; label: string }[]; orientation: { slug: string; label: string }[]; areas: string[] }

const photoStatus: Record<string, string> = { pending: "Waiting for review", approved: "Approved", rejected: "Not accepted" };

export function ProfileEditor() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const [data, setData] = useState<ProfileData | null>(null);
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [form, setForm] = useState({ displayName: "", birthYear: "", bio: "", lookingFor: "", countryOfOrigin: "", area: "" });
  const [identity, setIdentity] = useState<{ gender: string; orientation: string; pronouns: string; show: string[] }>({ gender: "", orientation: "", pronouns: "", show: [] });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const [p, t] = await Promise.all([get<ProfileData>("/api/profile"), get<Taxonomy>("/api/taxonomy")]);
    setData(p);
    setTax(t);
    setConsent(p.specialCategoryConsent);
    if (p.profile) setForm({ displayName: p.profile.displayName, birthYear: p.profile.birthYear ? String(p.profile.birthYear) : "", bio: p.profile.bio, lookingFor: p.profile.lookingFor, countryOfOrigin: p.profile.countryOfOrigin, area: t.areas.includes(p.profile.area) ? p.profile.area : "" });
    if (p.identity) setIdentity({ gender: p.identity.gender ?? "", orientation: p.identity.orientation ?? "", pronouns: p.identity.pronouns ?? "", show: p.identity.show ?? [] });
  }
  useEffect(() => { load().catch((e) => setError(messageOf(e))); }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const prepared = await preparePhoto(f);
        const fd = new FormData();
        fd.set("file", prepared);
        await api("POST", "/api/photos", fd);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error && !("status" in err) ? err.message : messageOf(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function toggleConsent(granted: boolean) {
    setError("");
    try { await post("/api/consents", { kind: "special_category", granted }); setConsent(granted); if (!granted) setIdentity({ gender: "", orientation: "", pronouns: "", show: [] }); } catch (err) { setError(messageOf(err)); }
  }

  async function save(submit: boolean) {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      const body: Record<string, unknown> = { displayName: form.displayName, birthYear: Number(form.birthYear), bio: form.bio, lookingFor: form.lookingFor, countryOfOrigin: form.countryOfOrigin };
      if (form.area) body.location = { area: form.area };
      if (consent) body.identity = (identity.gender || identity.orientation || identity.pronouns) ? { gender: identity.gender || undefined, orientation: identity.orientation || undefined, pronouns: identity.pronouns || undefined, show: identity.show } : null;
      const r = await put<{ status: string }>("/api/profile", body);
      if (submit && (r.status === "draft" || r.status === "rejected")) await post("/api/profile/submit");
      const fresh = await refresh();
      await load();
      if (submit) navigate(pathForStep(fresh?.step), { replace: true });
      else setSaved(r.status === "pending" ? "Saved. Your changes go to a moderator before others see them." : "Saved.");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data || !tax) return <p className="muted">{error || "Loading your profile"}</p>;
  const status = data.profile?.status ?? "draft";
  const live = status === "approved" || status === "pending" || status === "hidden";
  const year = new Date().getFullYear();

  return (
    <div>
      {!live && <Steps at={3} />}
      <h1>{live ? "Your profile" : "Build your profile"}</h1>
      {status === "rejected" && <div className="notice red"><p><strong>A moderator asked for a change.</strong> {data.profile?.rejectionReason}</p></div>}
      {status === "pending" && <div className="notice"><p>Your profile is with a moderator. You will hear back soon.</p></div>}

      <section className="panel">
        <h2>Photos</h2>
        <p className="muted small">Up to {data.limits.maxPhotos}. They must clearly show you. A person checks every photo before anyone else sees it.</p>
        <div className="photos">
          {data.photos.map((p) => (
            <div className="ph" key={p.id}>
              <img src={p.url} alt="One of your photos" />
              <span className={`chip ${p.status === "approved" ? "volt" : p.status === "rejected" ? "red" : "amber"}`}>{photoStatus[p.status] ?? p.status}</span>
              <button className="btn ghost small" type="button" aria-label="Remove this photo" onClick={async () => { await del(`/api/photos/${p.id}`).catch((e) => setError(messageOf(e))); await load(); }}>✕</button>
            </div>
          ))}
          {data.photos.length < data.limits.maxPhotos && (
            <label className="ph add">
              <span>{busy ? "Uploading" : "+ Add photo"}</span>
              <input ref={fileRef} className="sr-only" type="file" accept="image/*" multiple onChange={(e) => upload(e.target.files)} />
            </label>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>About you</h2>
        <div className="field"><label htmlFor="dn">First name or nickname</label><input id="dn" type="text" maxLength={30} value={form.displayName} onChange={set("displayName")} /></div>
        <div className="field">
          <label htmlFor="by">Year of birth <span className="hint">Only your age is shown.</span></label>
          <input id="by" type="number" inputMode="numeric" min={year - 99} max={year - 18} value={form.birthYear} onChange={set("birthYear")} />
        </div>
        <div className="field">
          <label htmlFor="bio">About me <span className="hint">No phone numbers, usernames or links. Those unlock later, once you are both verified.</span></label>
          <textarea id="bio" maxLength={600} value={form.bio} onChange={set("bio")} />
        </div>
        <div className="field">
          <label htmlFor="lf">Looking for</label>
          <select id="lf" value={form.lookingFor} onChange={set("lookingFor")}>
            <option value="">Choose one</option>
            {tax.lookingFor.map((o) => <option key={o.slug} value={o.slug}>{o.label}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="co">Country of origin <span className="hint">Optional.</span></label><input id="co" type="text" maxLength={60} value={form.countryOfOrigin} onChange={set("countryOfOrigin")} /></div>
        <div className="field">
          <label htmlFor="ar">Your area <span className="hint">Others see the area and a rough distance, never your exact location.</span></label>
          <select id="ar" value={form.area} onChange={set("area")}>
            <option value="">{data.profile?.hasLocation ? `Keep: ${data.profile.area}` : "Choose the nearest"}</option>
            {tax.areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </section>

      <section className="panel tone-cyan">
        <h2>Identity (optional)</h2>
        <p className="small">Sexuality and gender identity are sensitive information. We only store them if you agree below. They are encrypted, shown only where you choose, and deleted the moment you withdraw.</p>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => toggleConsent(e.target.checked)} />
          <span>I give my explicit consent for my gender, sexuality and pronouns to be stored and used to match me, as described in the <Link to="/privacy">privacy notice</Link>.</span>
        </label>
        {consent && (
          <>
            <div className="field">
              <label htmlFor="g">Gender</label>
              <select id="g" value={identity.gender} onChange={(e) => setIdentity({ ...identity, gender: e.target.value })}>
                <option value="">Prefer not to say</option>
                {tax.gender.map((o) => <option key={o.slug} value={o.slug}>{o.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="o">Sexuality</label>
              <select id="o" value={identity.orientation} onChange={(e) => setIdentity({ ...identity, orientation: e.target.value })}>
                <option value="">Prefer not to say</option>
                {tax.orientation.map((o) => <option key={o.slug} value={o.slug}>{o.label}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="pn">Pronouns</label><input id="pn" type="text" maxLength={20} value={identity.pronouns} onChange={(e) => setIdentity({ ...identity, pronouns: e.target.value })} /></div>
            <fieldset>
              <legend>Show on my profile</legend>
              {(["gender", "orientation", "pronouns"] as const).map((k) => (
                <label className="check" key={k}>
                  <input type="checkbox" checked={identity.show.includes(k)} onChange={(e) => setIdentity({ ...identity, show: e.target.checked ? [...identity.show, k] : identity.show.filter((x) => x !== k) })} />
                  <span>{k === "orientation" ? "Sexuality" : k[0]!.toUpperCase() + k.slice(1)}</span>
                </label>
              ))}
            </fieldset>
          </>
        )}
      </section>

      <ErrorText>{error}</ErrorText>
      {saved && <p className="ok" role="status">{saved}</p>}
      <div className="row" style={{ marginTop: "1rem" }}>
        {!live ? (
          <button className="btn" type="button" disabled={busy} onClick={() => save(true)}>Send for approval</button>
        ) : (
          <button className="btn" type="button" disabled={busy} onClick={() => save(false)}>Save changes</button>
        )}
        {!live && <button className="btn ghost" type="button" disabled={busy} onClick={() => save(false)}>Save draft</button>}
      </div>
      {me?.step === "ready" && <p style={{ marginTop: "1rem" }}><Link to="/app/me">Back</Link></p>}
    </div>
  );
}

export function Pending() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  async function check() {
    const fresh = await refresh();
    navigate(pathForStep(fresh?.step), { replace: true });
  }
  return (
    <div className="auth">
      <Steps at={4} />
      <h1>Your profile is with a moderator</h1>
      <p>A person checks every new profile and photo before anyone else can see it. You will get a notification as soon as it is approved.</p>
      <p className="muted">Target: within {4} hours.</p>
      <div className="row">
        <button className="btn" type="button" onClick={check}>Check again</button>
        <Link className="btn ghost" to="/app/profile">Edit my profile</Link>
      </div>
    </div>
  );
}

/** SAMPLE ONLY. Plays the part of the age or ID provider's hosted page so the whole flow can be walked through. */
export function ProviderPractice() {
  const [params] = useSearchParams();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const kind = params.get("kind") === "idv" ? "idv" : "age";
  const ref = params.get("ref") ?? "";
  const [error, setError] = useState("");
  async function finish(status: "passed" | "failed" | "review", faceMatch?: boolean) {
    setError("");
    try {
      await post("/api/dev/provider/complete", { kind, ref, status, faceMatch: kind === "idv" ? faceMatch : undefined });
      const fresh = await refresh();
      navigate(kind === "idv" ? "/app/verify" : pathForStep(fresh?.step), { replace: true });
    } catch (err) { setError(messageOf(err)); }
  }
  return (
    <div className="auth">
      <div className="notice amber"><p><strong>SAMPLE: practice provider page.</strong> In the real app this is the age or ID provider's own secure page. Nothing is checked here: choose a result to see what happens next.</p></div>
      <h1>{kind === "age" ? "Age check" : "ID + liveness check"}</h1>
      <div className="stack">
        <button className="btn block" type="button" onClick={() => finish("passed", true)}>{kind === "age" ? "Result: 18 or over" : "Result: passed, face matches photos"}</button>
        {kind === "idv" && <button className="btn ghost block" type="button" onClick={() => finish("passed", false)}>Result: passed, face does not match photos</button>}
        {kind === "idv" && <button className="btn ghost block" type="button" onClick={() => finish("review")}>Result: provider asks for manual review</button>}
        <button className="btn red block" type="button" onClick={() => finish("failed")}>{kind === "age" ? "Result: could not confirm 18+" : "Result: failed"}</button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
