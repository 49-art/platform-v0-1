import QRCode from "qrcode";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { Turnstile } from "../../components/Turnstile";
import { ErrorText } from "../../components/ui";
import { messageOf, post } from "../../lib/api";
import { canPrompt, isInstalled, promptInstall } from "../../lib/pwa";
import { useSession } from "../../lib/session";

function Doc({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="auth" style={{ maxWidth: 720 }}>
      <h1>{title}</h1>
      <div className="notice amber"><p><strong>Draft for review, not legal advice.</strong> This text has not been checked by a solicitor (spec section 10).</p></div>
      {children}
    </article>
  );
}

export function Install() {
  const [qr, setQr] = useState("");
  const url = typeof location !== "undefined" ? location.origin : "";
  useEffect(() => { QRCode.toDataURL(url, { margin: 1, width: 440, color: { dark: "#120a26", light: "#ffffff" } }).then(setQr).catch(() => {}); }, [url]);
  return (
    <article className="auth" style={{ maxWidth: 720 }}>
      <h1>Download the app</h1>
      {isInstalled() ? <p className="ok">The app is already installed on this device.</p> : (
        <p>It installs straight from your browser: no app store, nothing to pay, and it updates itself.</p>
      )}
      {canPrompt() && <p><button className="btn" type="button" onClick={() => void promptInstall()}>Install now</button></p>}
      <section className="panel">
        <h2>iPhone or iPad</h2>
        <ol className="howto">
          <li>Open this page in Safari.</li>
          <li>Tap the Share button (the square with an arrow pointing up).</li>
          <li>Scroll down and tap Add to Home Screen.</li>
          <li>Tap Add. The app appears on your home screen.</li>
        </ol>
      </section>
      <section className="panel">
        <h2>Android</h2>
        <ol className="howto">
          <li>Open this page in Chrome.</li>
          <li>If an Install banner appears, tap Install.</li>
          <li>If not, tap the ⋮ menu at the top right, then Install app (or Add to Home screen).</li>
        </ol>
      </section>
      <section className="panel">
        <h2>On a computer</h2>
        <p>Scan this code with your phone camera to open the app there.</p>
        {qr ? <img className="qr" src={qr} alt={`QR code that opens ${url}`} width={220} height={220} /> : null}
        <p className="small muted">Or type: {url}</p>
      </section>
    </article>
  );
}

export function Contact() {
  const { me } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", topic: "general", message: "" });
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { await post("/api/contact", { ...form, turnstileToken: token }); setSent(true); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <article className="auth">
      <h1>Contact us</h1>
      <div className="notice red"><p>If someone is in immediate danger, call 999 now.</p></div>
      {sent ? <p className="ok" role="status">Thank you. Your message has reached us.</p> : (
        <form onSubmit={submit} noValidate>
          <div className="field"><label htmlFor="c-name">Your name</label><input id="c-name" type="text" autoComplete="name" value={form.name} onChange={set("name")} /></div>
          <div className="field"><label htmlFor="c-email">Email to reply to</label><input id="c-email" type="email" autoComplete="email" value={form.email} onChange={set("email")} /></div>
          <div className="field">
            <label htmlFor="c-topic">What is it about?</label>
            <select id="c-topic" value={form.topic} onChange={set("topic")}>
              <option value="general">A general question</option>
              <option value="safety">A safety concern</option>
              <option value="appeal">A moderation decision</option>
              <option value="privacy">My data and privacy</option>
              <option value="press">Press</option>
              <option value="law_enforcement">Law enforcement request</option>
            </select>
          </div>
          <div className="field"><label htmlFor="c-msg">Message</label><textarea id="c-msg" value={form.message} onChange={set("message")} /></div>
          {me?.config.turnstileSiteKey && <Turnstile siteKey={me.config.turnstileSiteKey} action="contact" onToken={setToken} />}
          <ErrorText>{error}</ErrorText>
          <button className="btn block">Send message</button>
        </form>
      )}
    </article>
  );
}

export function AboutSample() {
  return (
    <article className="auth" style={{ maxWidth: 720 }}>
      <h1>About this sample</h1>
      <p>This is a working sample of the platform, built from spec v0.1 so the founder can try every part of it. It is not open to the public and search engines are asked not to list it.</p>
      <h2>What is real</h2>
      <ul>
        <li>Accounts, sessions, sign-out everywhere, data export and account deletion.</li>
        <li>Profiles with human pre-moderation, browsing, likes and matches.</li>
        <li>Live chat with the contact-detail shield, reports, blocks, appeals.</li>
        <li>Date proposals, trusted contacts, check-in timers and SOS, all locked until both people are verified.</li>
        <li>The staff console: queues, User 360, enforcement, audit log, law-enforcement desk.</li>
      </ul>
      <h2>What is simulated</h2>
      <ul>
        <li>The age check and the ID + liveness check. A practice page stands in for the provider. No provider has been chosen yet.</li>
        <li>Emails and texts. Nothing is sent: links appear on screen instead, and only on the device that asked.</li>
        <li>Automatic image scanning. Every photo still waits for a person to approve it.</li>
        <li>Profiles marked SAMPLE are not real people. They like you back so you can see a match, and never send messages.</li>
      </ul>
      <p>Safety alerts in this sample do not reach anyone. In an emergency call 999.</p>
    </article>
  );
}

export function Guidelines() {
  return (
    <Doc title="Community guidelines">
      <p>These rules apply to the dating side of the service. They come from spec section 9.</p>
      <ul>
        <li><strong>Adults only.</strong> You must be 18 or over. Any sign that someone is under 18 leads to immediate suspension and review.</li>
        <li><strong>Real people only.</strong> No bots, fake accounts, AI-generated profile photos or pretending to be someone else.</li>
        <li><strong>Photos must show you.</strong> No nudity or sexual acts, no children in any photo, no weapons or drugs.</li>
        <li><strong>Flirting is fine.</strong> Harassment, pressure and unwanted explicit images are not.</li>
        <li><strong>No selling or buying sex.</strong> No escorting, rates or sugar arrangements, and no paid performers.</li>
        <li><strong>No scams.</strong> Never ask anyone for money, crypto, gift cards or investment.</li>
        <li><strong>No hate or abuse.</strong> No hate speech, threats, doxxing, stalking or intimate image abuse.</li>
        <li><strong>Contact details stay private</strong> until you are both verified and both agree to swap.</li>
      </ul>
      <h2>What happens if rules are broken</h2>
      <p>Warning, then a pause on messaging, then suspension, then a permanent ban. Child abuse material, trafficking, threats, involving minors and selling sex go straight to a ban and are escalated. Every decision has a reason, is logged, and can be appealed.</p>
    </Doc>
  );
}

export function Terms() {
  return (
    <Doc title="Terms of service">
      <p>The service is free. You must be 18 or over and must pass an age check. You agree to follow the community guidelines.</p>
      <p>You keep ownership of what you post. You allow us to show it to other members as part of the service, and to review it for safety.</p>
      <p>We can warn, restrict, suspend or close accounts that break the rules. You can appeal any decision from Settings.</p>
      <p>You can delete your account at any time from Settings.</p>
      <p className="muted">[OPERATOR LEGAL NAME], [REGISTERED ADDRESS] and governing law to be confirmed by a solicitor.</p>
    </Doc>
  );
}

export function Privacy() {
  return (
    <Doc title="Privacy notice">
      <p>We collect what we need to run a safe dating service: your email, your profile and photos, your messages, and the results of age and identity checks.</p>
      <p><strong>We never store ID documents.</strong> The check provider keeps them. We keep only the result.</p>
      <p><strong>Sexuality and gender identity are optional.</strong> We store them only with your explicit consent, encrypted, and show them only if you choose. You can withdraw consent at any time and they are deleted straight away.</p>
      <p>Your location is stored only as a rough area of about 5 km, never your exact position.</p>
      <p>You can download all your data, and delete your account, from Settings. Deleted accounts are hidden at once and erased within 30 days, except records we must keep for safety or the law.</p>
      <p>No advertising trackers. One security cookie keeps you signed in, and one recognises your device to stop banned people coming back.</p>
      <p className="muted">Controller details, ICO registration number, retention schedule and processor list: [TO CONFIRM].</p>
    </Doc>
  );
}

export function Safety() {
  return (
    <article className="auth" style={{ maxWidth: 720 }}>
      <h1>Staying safe</h1>
      <div className="notice red"><p>If you are in immediate danger, call 999.</p></div>
      <ul>
        <li>Meet in a busy public place the first time.</li>
        <li>Share your plan with a trusted contact from the date panel, and set a check-in time.</li>
        <li>Keep the chat in the app until you are both verified and both happy to swap numbers.</li>
        <li>Never send money to someone you have not met. Report anyone who asks.</li>
        <li>Report a bot, a scam or anything that feels wrong from the chat. You will hear back.</li>
      </ul>
      <p><Link to="/contact">Contact us</Link> about a safety concern.</p>
    </article>
  );
}

export function NotFound() {
  return (
    <div className="auth">
      <h1>That page does not exist</h1>
      <p className="muted">The link may be old, or the page may have moved.</p>
      <Link className="btn" to="/">Go to the start</Link>
    </div>
  );
}
