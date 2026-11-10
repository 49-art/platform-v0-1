import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ReportSheet } from "../../components/Report";
import { ErrorText, Face, Sheet } from "../../components/ui";
import { api, get, messageOf, post, put, when } from "../../lib/api";
import { preparePhoto } from "../../lib/image";
import { useSession } from "../../lib/session";

interface Msg { id: string; senderId: string; kind: "text" | "image" | "system"; text: string; image: string | null; explicit: boolean; at: number; pending?: boolean }
interface Safety { trustedContactId: string | null; sharedAt: number | null; checkinDueAt: number | null; checkedInAt: number | null; alertedAt: number | null; sosAt: number | null }
interface DateRow { id: string; status: string; startsAt: number; mine: boolean; venue: { name: string; area: string } | null; safety: Safety | null }
interface Conv {
  conversation: { id: string; status: string };
  other: { userId: string; displayName: string; age: number | null; area: string; verified: boolean; photos: string[]; available: boolean } | null;
  verification: { mine: boolean; theirs: boolean; both: boolean };
  swap: Record<"phone" | "x", { mine: boolean; theirs: boolean; reveal: string | null }>;
  dates: DateRow[];
  restrictedUntil: number | null;
}

export default function Chat() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const navigate = useNavigate();
  const myId = me?.user?.id ?? "";
  const [conv, setConv] = useState<Conv | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [closed, setClosed] = useState("");
  const [typing, setTyping] = useState(false);
  const [sheet, setSheet] = useState<"" | "date" | "swap" | "report" | "safety">("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastTypingSent = useRef(0);

  const loadConv = useCallback(async () => {
    try { setConv(await get<Conv>(`/api/conversations/${id}`)); } catch (err) { setError(messageOf(err)); }
  }, [id]);
  useEffect(() => { void loadConv(); }, [loadConv]);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/conversations/${id}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { retry = 0; };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        let f: any;
        try { f = JSON.parse(e.data); } catch { return; }
        if (f.type === "ready") { setMsgs(f.messages); if (f.status && f.status !== "open") setClosed("This conversation is closed."); ws.send(JSON.stringify({ type: "read" })); }
        if (f.type === "message") {
          setMsgs((m) => (m.some((x) => x.id === f.message.id) ? m : [...m.filter((x) => !(x.pending && x.text === f.message.text && f.message.senderId === myId)), f.message]));
          if (f.message.senderId !== myId) { setTyping(false); ws.send(JSON.stringify({ type: "read" })); }
          if (f.message.kind === "system") void loadConv();
        }
        if (f.type === "rejected") {
          setNotice(f.notice);
          if (f.clientId) setMsgs((m) => m.filter((x) => x.id !== f.clientId));
        }
        if (f.type === "typing") { setTyping(true); clearTimeout(typingTimer.current); typingTimer.current = setTimeout(() => setTyping(false), 4000); }
        if (f.type === "closed") setClosed(f.reason === "blocked" || f.reason === "closed" ? "This conversation is closed." : "This conversation is paused while a moderator reviews an account.");
      };
      ws.onclose = (e) => {
        if (stopped) return;
        if (e.code === 4001 || e.code === 4002) return;
        timer = setTimeout(connect, Math.min(15_000, 800 * 2 ** retry++));
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); wsRef.current?.close(); };
  }, [id, myId, loadConv]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [msgs.length, typing]);

  function send(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || wsRef.current?.readyState !== 1) return;
    const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setNotice("");
    setMsgs((m) => [...m, { id: clientId, senderId: myId, kind: "text", text: body, image: null, explicit: false, at: Date.now(), pending: true }]);
    wsRef.current.send(JSON.stringify({ type: "send", clientId, text: body }));
    setText("");
  }

  function onType(v: string) {
    setText(v);
    if (Date.now() - lastTypingSent.current > 3000 && wsRef.current?.readyState === 1) { wsRef.current.send(JSON.stringify({ type: "typing" })); lastTypingSent.current = Date.now(); }
  }

  async function sendImage(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setNotice("");
    try {
      const prepared = await preparePhoto(f);
      const fd = new FormData();
      fd.set("file", prepared);
      fd.set("conversationId", id);
      await api("POST", "/api/photos", fd);
      setNotice("Your image is being checked. It is delivered as soon as it passes.");
    } catch (err) { setNotice(err instanceof Error && !("status" in err) ? err.message : messageOf(err)); }
  }

  const other = conv?.other;
  const name = other?.available ? other.displayName : "Member unavailable";
  const open = conv?.conversation.status === "open" && !closed;
  const nextDate = conv?.dates.find((d) => d.status === "accepted" || d.status === "proposed");

  return (
    <div className="chat">
      <div className="chat-head">
        <Link to="/app/matches" className="btn ghost small" aria-label="Back to matches">‹</Link>
        <Face src={other?.photos[0]} alt={name} verified={other?.verified} size={48} />
        <div className="grow">
          <strong style={{ display: "block" }}>{name}{other?.age ? `, ${other.age}` : ""}</strong>
          <span className="small muted">{typing ? "typing" : other?.verified ? "ID verified" : "Not ID verified yet"}</span>
        </div>
        {other && <button className="btn ghost small" type="button" onClick={() => setSheet("report")}>Report</button>}
      </div>

      <div className="chat-tools" role="toolbar" aria-label="Chat tools">
        <button className="btn cyan small" type="button" onClick={() => setSheet("date")}>{nextDate ? "Your date" : "Plan a date"}</button>
        <button className="btn ghost small" type="button" onClick={() => setSheet("swap")}>Swap contact details</button>
        {nextDate?.status === "accepted" && <button className="btn amber small" type="button" onClick={() => setSheet("safety")}>Safety</button>}
      </div>

      <div className="chat-log" ref={logRef} aria-live="polite" aria-label="Messages">
        {(conv?.swap.phone.reveal || conv?.swap.x.reveal) && (
          <div className="notice volt">
            {conv.swap.phone.reveal && <p>Their number: <a href={`tel:${conv.swap.phone.reveal}`}>{conv.swap.phone.reveal}</a></p>}
            {conv.swap.x.reveal && <p>Continue on X: <a href={conv.swap.x.reveal} target="_blank" rel="noopener noreferrer">{conv.swap.x.reveal.replace("https://", "")}</a></p>}
          </div>
        )}
        {msgs.length === 0 && <p className="muted center">Say hello. Contact details stay private until you are both verified and both agree to swap.</p>}
        {msgs.map((m) => {
          const mine = m.senderId === myId;
          if (m.kind === "system") return <p key={m.id} className="msg system">{m.text}</p>;
          return (
            <div key={m.id} className={`msg ${mine ? "me" : "them"}`}>
              {m.kind === "image" && m.image ? (
                m.explicit && !revealed[m.id] && !mine ? (
                  <button className="btn ghost small" type="button" onClick={() => setRevealed({ ...revealed, [m.id]: true })}>Explicit image: tap to show</button>
                ) : <img src={m.image} alt={mine ? "Image you sent" : `Image from ${name}`} />
              ) : m.text}
              <time dateTime={new Date(m.at).toISOString()}>{m.pending ? "sending" : new Date(m.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
          );
        })}
      </div>

      <div>
        {notice && <p className="notice amber small" role="status">{notice}</p>}
        <ErrorText>{error}</ErrorText>
        {closed || !open ? (
          <p className="muted center">{closed || "This conversation is closed."}</p>
        ) : conv?.restrictedUntil ? (
          <p className="notice red">Messaging is paused on your account until {when(conv.restrictedUntil)}. <Link to="/app/standing">See why and appeal</Link></p>
        ) : (
          <form className="composer" onSubmit={send}>
            <label className="btn ghost small" style={{ alignSelf: "stretch" }}>
              <span aria-hidden="true">＋</span><span className="sr-only">Send an image</span>
              <input className="sr-only" type="file" accept="image/*" onChange={(e) => { void sendImage(e.target.files); e.target.value = ""; }} />
            </label>
            <label htmlFor="composer" className="sr-only">Message</label>
            <textarea id="composer" value={text} maxLength={2000} rows={1} placeholder="Message" onChange={(e) => onType(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button className="btn" disabled={!text.trim()}>Send</button>
          </form>
        )}
      </div>

      {conv && <DateSheet open={sheet === "date"} onClose={() => setSheet("")} conv={conv} reload={loadConv} name={name} />}
      {conv && <SwapSheet open={sheet === "swap"} onClose={() => setSheet("")} conv={conv} reload={loadConv} name={name} />}
      {conv && nextDate && <SafetySheet open={sheet === "safety"} onClose={() => setSheet("")} date={nextDate} reload={loadConv} />}
      {other && <ReportSheet open={sheet === "report"} onClose={() => setSheet("")} userId={other.userId} name={name} conversationId={id} onDone={(blocked) => { if (blocked) setTimeout(() => navigate("/app/matches"), 1800); }} />}
    </div>
  );
}

function LockedNotice({ v, name }: { v: Conv["verification"]; name: string }) {
  return (
    <div className="notice">
      <p><strong>Unlocks when you are both ID-verified.</strong></p>
      <p>You: {v.mine ? "verified ✓" : "not verified yet"}. {name}: {v.theirs ? "verified ✓" : "not verified yet"}.</p>
      {!v.mine && <Link className="btn cyan small" to="/app/verify">Verify my identity</Link>}
    </div>
  );
}

function toLocalInput(ms: number) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function DateSheet({ open, onClose, conv, reload, name }: { open: boolean; onClose: () => void; conv: Conv; reload: () => Promise<void>; name: string }) {
  const [form, setForm] = useState({ at: toLocalInput(Date.now() + 2 * 86_400_000), venueName: "", venueArea: "" });
  const [error, setError] = useState("");
  const active = conv.dates.find((d) => d.status === "proposed" || d.status === "accepted");
  async function propose(e: FormEvent) {
    e.preventDefault();
    setError("");
    try { await post(`/api/conversations/${conv.conversation.id}/dates`, { startsAt: new Date(form.at).getTime(), venueName: form.venueName, venueArea: form.venueArea }); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  async function respond(action: "accept" | "decline" | "cancel") {
    setError("");
    try { await post(`/api/dates/${active!.id}/respond`, { action }); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={active ? "Your date" : "Plan a date"}>
      {!conv.verification.both ? <LockedNotice v={conv.verification} name={name} /> : active ? (
        <div className="stack">
          <div className="panel tone-cyan">
            <h3>{active.venue?.name}</h3>
            <p style={{ margin: 0 }}>{active.venue?.area}, {when(active.startsAt)}</p>
            <p className="small muted" style={{ margin: 0 }}>{active.status === "proposed" ? (active.mine ? `Waiting for ${name} to answer.` : `${name} suggested this.`) : "Accepted by both of you."}</p>
          </div>
          {active.status === "proposed" && !active.mine && (
            <div className="row"><button className="btn" type="button" onClick={() => respond("accept")}>Accept</button><button className="btn ghost" type="button" onClick={() => respond("decline")}>Decline</button></div>
          )}
          {active.status === "accepted" && <p className="small">Set up your safety check-in from the Safety button in the chat.</p>}
          <button className="btn ghost small" type="button" onClick={() => respond("cancel")}>Cancel this date</button>
        </div>
      ) : (
        <form onSubmit={propose}>
          <p className="small muted">Pick somewhere public and busy for a first meeting.</p>
          <div className="field"><label htmlFor="d-at">When</label><input id="d-at" type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} /></div>
          <div className="field"><label htmlFor="d-v">Where (venue name)</label><input id="d-v" type="text" maxLength={80} value={form.venueName} onChange={(e) => setForm({ ...form, venueName: e.target.value })} /></div>
          <div className="field"><label htmlFor="d-a">Area</label><input id="d-a" type="text" maxLength={60} value={form.venueArea} onChange={(e) => setForm({ ...form, venueArea: e.target.value })} /></div>
          <button className="btn cyan block">Suggest this date</button>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
    </Sheet>
  );
}

function SwapSheet({ open, onClose, conv, reload, name }: { open: boolean; onClose: () => void; conv: Conv; reload: () => Promise<void>; name: string }) {
  const [error, setError] = useState("");
  async function setSwap(kind: "phone" | "x", consent: boolean) {
    setError("");
    try { await post(`/api/conversations/${conv.conversation.id}/swap`, { kind, consent }); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  const row = (kind: "phone" | "x", label: string) => {
    const s = conv.swap[kind];
    return (
      <div className="panel">
        <h3>{label}</h3>
        <p className="small">You: {s.mine ? "agreed" : "not yet"}. {name}: {s.theirs ? "agreed" : "not yet"}.</p>
        {s.reveal ? <p className="ok">Shared. See the top of the chat.</p> : s.mine
          ? <button className="btn ghost small" type="button" onClick={() => setSwap(kind, false)}>Withdraw my agreement</button>
          : <button className="btn small" type="button" onClick={() => setSwap(kind, true)}>I agree to swap</button>}
      </div>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title="Swap contact details">
      {!conv.verification.both ? <LockedNotice v={conv.verification} name={name} /> : (
        <>
          <p className="small muted">Nothing is shared unless you both agree. You can withdraw before they agree. Add your number in <Link to="/app/settings">Settings</Link> first.</p>
          {row("phone", "Phone numbers")}
          {row("x", "Continue on X")}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Sheet>
  );
}

function SafetySheet({ open, onClose, date, reload }: { open: boolean; onClose: () => void; date: DateRow; reload: () => Promise<void> }) {
  const { me } = useSession();
  const [contacts, setContacts] = useState<{ id: string; name: string; channel: string }[]>([]);
  const [contactId, setContactId] = useState(date.safety?.trustedContactId ?? "");
  const [checkin, setCheckin] = useState(toLocalInput(date.safety?.checkinDueAt ?? date.startsAt + 2 * 3_600_000));
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (open) get<{ contacts: { id: string; name: string; channel: string }[] }>("/api/trusted-contacts").then((r) => setContacts(r.contacts)).catch(() => {}); }, [open]);
  async function save() {
    setError(""); setMsg("");
    try {
      const r = await put<{ shared: boolean }>(`/api/dates/${date.id}/safety`, { trustedContactId: contactId || null, share: !!contactId, checkinAt: checkin ? new Date(checkin).getTime() : null });
      setMsg(r.shared ? "Plan shared with your trusted contact. Check-in set." : "Check-in set.");
      await reload();
    } catch (err) { setError(messageOf(err)); }
  }
  async function checkIn() {
    setError("");
    try { await post(`/api/dates/${date.id}/checkin`); setMsg("Checked in. Glad you are OK."); await reload(); } catch (err) { setError(messageOf(err)); }
  }
  async function sos() {
    setError("");
    try { const r = await post<{ contacted: boolean; emergency: string }>(`/api/dates/${date.id}/sos`); setMsg(`${r.contacted ? "Your trusted contact has been alerted." : "We could not reach a trusted contact."} ${r.emergency}`); } catch (err) { setError(messageOf(err)); }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Date safety">
      <div className="notice red"><p>In immediate danger, call 999.</p></div>
      {me?.config.sample && <div className="notice amber"><p><strong>SAMPLE:</strong> alerts are recorded but not actually sent to anyone.</p></div>}
      <button className="btn sos" type="button" onClick={sos}>SOS: alert my trusted contact</button>
      <hr />
      <div className="field">
        <label htmlFor="tc">Share the plan with</label>
        <select id="tc" value={contactId} onChange={(e) => setContactId(e.target.value)}>
          <option value="">No one</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.channel === "sms" ? "text" : "email"})</option>)}
        </select>
        {contacts.length === 0 && <span className="hint">Add a trusted contact in <Link to="/app/settings">Settings</Link>.</span>}
      </div>
      <div className="field"><label htmlFor="ci">Check-in time <span className="hint">If you do not check in, we remind you, then alert your contact 30 minutes later.</span></label><input id="ci" type="datetime-local" value={checkin} onChange={(e) => setCheckin(e.target.value)} /></div>
      <div className="row">
        <button className="btn amber" type="button" onClick={save}>Save safety plan</button>
        {date.safety?.checkinDueAt && !date.safety.checkedInAt && <button className="btn" type="button" onClick={checkIn}>I am OK, check in</button>}
      </div>
      {date.safety?.checkedInAt && <p className="ok">Checked in at {when(date.safety.checkedInAt)}.</p>}
      {msg && <p className="ok" role="status">{msg}</p>}
      <ErrorText>{error}</ErrorText>
      <p className="small muted">Your match is never told whether you have set this up.</p>
    </Sheet>
  );
}
