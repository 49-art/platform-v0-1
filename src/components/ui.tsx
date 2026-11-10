import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { SampleLink as SampleLinkData } from "../lib/api";
import { canPrompt, isInstalled, onInstallChange, promptInstall } from "../lib/pwa";

/** The signature device: a cyan ring means "identity verified". A dashed ring means "not yet". */
export function Face({ src, alt, verified, size = 64 }: { src?: string | null; alt: string; verified?: boolean; size?: number }) {
  return (
    <span className={`face ${verified ? "verified" : "unverified"}`} style={{ ["--size" as string]: `${size}px` }}>
      {src ? <img src={src} alt={alt} loading="lazy" decoding="async" /> : <span role="img" aria-label={alt} style={{ display: "block", width: "100%", height: "100%", borderRadius: "50%", background: "var(--deep)" }} />}
    </span>
  );
}

export function VerifiedChip({ verified }: { verified: boolean }) {
  return verified ? <span className="chip cyan">✓ ID verified</span> : <span className="chip">Not ID verified yet</span>;
}

export function SampleLinkBox({ sample }: { sample?: SampleLinkData | null }) {
  if (!sample?.link) return null;
  const local = sample.link.replace(/^https?:\/\/[^/]+/, "");
  return (
    <div className="notice amber" role="status">
      <p><strong>{sample.note}</strong></p>
      <p><Link className="sample-link" to={local}>{local.startsWith("/login") ? "Go to sign in" : "Open the link"}</Link></p>
    </div>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="error" role="alert">{children}</p>;
}

/** A bottom sheet on phones, a centred dialog on larger screens. Uses the native <dialog> for focus handling. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} aria-label={title} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="sheet-body">
        <div className="spread" style={{ marginBottom: "0.75rem" }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost small" type="button" onClick={onClose}>Close</button>
        </div>
        {open ? children : null}
      </div>
    </dialog>
  );
}

/** Always visible. If the browser can install straight away it does; otherwise it opens the step-by-step page. */
export function InstallButton({ className = "btn ghost small install-btn" }: { className?: string }) {
  const [, force] = useState(0);
  const navigate = useNavigate();
  useEffect(() => onInstallChange(() => force((n) => n + 1)), []);
  if (isInstalled()) return null;
  return (
    <button type="button" className={className} onClick={async () => { if (!(canPrompt() && (await promptInstall()))) navigate("/install"); }}>
      Download the app
    </button>
  );
}

export function Brand({ name }: { name: string }) {
  return (
    <Link to="/" className="brand" aria-label={`${name} home`}>
      <span className="brand-mark" aria-hidden="true" />
      <span>{name}</span>
    </Link>
  );
}

export function SampleBar() {
  return (
    <div className="sample-bar" role="note">
      SAMPLE BUILD: not open to the public. Age and ID checks are simulated. <Link to="/about-sample">What this means</Link>
    </div>
  );
}

export const Icon = {
  discover: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>,
  matches: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>,
  verify: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>,
  me: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" width="22" height="22"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>,
};
