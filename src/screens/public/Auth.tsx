import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Turnstile } from "../../components/Turnstile";
import { ErrorText, SampleLinkBox } from "../../components/ui";
import { ApiFailure, type SampleLink, messageOf, post } from "../../lib/api";
import { pathForStep, useSession } from "../../lib/session";

function useTurnstile() {
  const { me } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const siteKey = me?.config.turnstileSiteKey ?? "";
  return { token, setToken, siteKey };
}

export function Signup() {
  const { token, setToken, siteKey } = useTurnstile();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [over18, setOver18] = useState(false);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ message: string; sample?: SampleLink } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!over18 || !terms) return setError("Tick both boxes to continue.");
    setBusy(true);
    try {
      const res = await post<{ message: string; sample?: SampleLink }>("/api/auth/signup", { email, password, over18: true, acceptTerms: true, turnstileToken: token });
      setDone(res);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="auth">
        <h1>Check your inbox</h1>
        <p>{done.message}</p>
        <SampleLinkBox sample={done.sample} />
        <p className="muted small">The link works once and expires in 24 hours.</p>
      </div>
    );
  }
  return (
    <div className="auth">
      <ol className="steps" aria-label="Step 1 of 5: create your account"><li className="now" /><li /><li /><li /><li /></ol>
      <h1>Join free</h1>
      <p className="muted">Next you will confirm your email, then a quick age check, then your profile.</p>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password <span className="hint">At least 10 characters. A short phrase is easiest to remember.</span></label>
          <input id="password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <label className="check"><input type="checkbox" checked={over18} onChange={(e) => setOver18(e.target.checked)} /> <span>I am 18 or over. I understand I will be asked to prove it.</span></label>
        <label className="check"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /> <span>I accept the <Link to="/terms">terms</Link> and <Link to="/guidelines">community guidelines</Link>, and I have read the <Link to="/privacy">privacy notice</Link>.</span></label>
        {siteKey && <Turnstile siteKey={siteKey} action="signup" onToken={setToken} />}
        <ErrorText>{error}</ErrorText>
        <button className="btn block" disabled={busy}>{busy ? "Creating your account" : "Create account"}</button>
      </form>
      <p className="center" style={{ marginTop: "1.25rem" }}>Already a member? <Link to="/login">Sign in</Link></p>
    </div>
  );
}

export function Login() {
  const { token, setToken, siteKey } = useTurnstile();
  const { refresh, me } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sample, setSample] = useState<SampleLink | undefined>();
  const xError = params.get("error");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSample(undefined);
    setBusy(true);
    try {
      await post("/api/auth/login", { email, password, turnstileToken: token });
      const fresh = await refresh();
      const next = params.get("next");
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : pathForStep(fresh?.step), { replace: true });
    } catch (err) {
      setError(messageOf(err));
      if (err instanceof ApiFailure) setSample(err.error.sample);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <h1>Sign in</h1>
      {xError && <p className="error" role="alert">{xError === "x_unavailable" ? "Sign in with X is not switched on yet. Use your email instead." : "Sign in with X did not work. Try again or use your email."}</p>}
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {siteKey && <Turnstile siteKey={siteKey} action="login" onToken={setToken} />}
        <ErrorText>{error}</ErrorText>
        <SampleLinkBox sample={sample} />
        <button className="btn block" disabled={busy}>{busy ? "Signing in" : "Sign in"}</button>
      </form>
      {me?.config.xEnabled && (
        <p style={{ marginTop: "1rem" }}><a className="btn ghost block" href={`/api/auth/x/start?ts=${encodeURIComponent(token ?? "")}`}>Sign in with X</a></p>
      )}
      <p className="center" style={{ marginTop: "1.25rem" }}><Link to="/reset">Forgot your password?</Link></p>
      <p className="center">New here? <Link to="/signup">Join free</Link></p>
    </div>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const token = params.get("token") ?? "";
  useEffect(() => {
    let done = false;
    (async () => {
      try {
        await post("/api/auth/verify-email", { token });
        if (done) return;
        const fresh = await refresh();
        navigate(pathForStep(fresh?.step), { replace: true });
      } catch (err) {
        if (!done) setError(messageOf(err));
      }
    })();
    return () => { done = true; };
  }, [token, refresh, navigate]);
  return (
    <div className="auth" aria-live="polite">
      <h1>Confirming your email</h1>
      {error ? (<><ErrorText>{error}</ErrorText><Link className="btn" to="/login">Sign in</Link></>) : <p className="muted">One moment.</p>}
    </div>
  );
}

export function ResetRequest() {
  const { token, setToken, siteKey } = useTurnstile();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ message: string; sample?: SampleLink } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try { setDone(await post("/api/auth/reset/request", { email, turnstileToken: token })); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <div className="auth">
      <h1>Reset your password</h1>
      {done ? (
        <><p>{done.message}</p><SampleLinkBox sample={done.sample} /></>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {siteKey && <Turnstile siteKey={siteKey} action="reset" onToken={setToken} />}
          <ErrorText>{error}</ErrorText>
          <button className="btn block" disabled={busy}>Send reset link</button>
        </form>
      )}
    </div>
  );
}

export function ResetConfirm() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { await post("/api/auth/reset/confirm", { token: params.get("token") ?? "", password }); setDone(true); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <div className="auth">
      <h1>Choose a new password</h1>
      {done ? (
        <><p className="ok">Password changed. You have been signed out everywhere for safety.</p><Link className="btn" to="/login">Sign in</Link></>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="password">New password <span className="hint">At least 10 characters.</span></label>
            <input id="password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <ErrorText>{error}</ErrorText>
          <button className="btn block">Save new password</button>
        </form>
      )}
    </div>
  );
}
