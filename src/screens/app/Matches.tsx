import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ErrorText, Face } from "../../components/ui";
import { ago, get, messageOf } from "../../lib/api";
import { useHub } from "../../lib/hub";

interface MatchRow {
  conversationId: string; status: string; lastMessageAt: number | null; unread: number; online: boolean;
  other: { userId: string; displayName: string; age: number | null; area: string; verified: boolean; photo: string | null; available: boolean };
}

export default function Matches() {
  const [rows, setRows] = useState<MatchRow[] | null>(null);
  const [error, setError] = useState("");
  const { unread } = useHub();
  useEffect(() => { get<{ matches: MatchRow[] }>("/api/matches").then((r) => setRows(r.matches)).catch((e) => { setError(messageOf(e)); setRows([]); }); }, []);
  return (
    <div>
      <h1>Matches</h1>
      <ErrorText>{error}</ErrorText>
      {rows === null && <p className="muted">Loading your matches</p>}
      {rows?.length === 0 && (
        <div className="panel">
          <h2>No matches yet</h2>
          <p className="muted">When you and someone both like each other, the chat opens here.</p>
          <Link className="btn" to="/app/discover">Discover people</Link>
        </div>
      )}
      {rows && rows.length > 0 && (
        <ul className="list">
          {rows.map((m) => {
            const n = unread[m.conversationId] ?? m.unread;
            return (
              <li key={m.conversationId}>
                <Link className="item" to={`/app/chat/${m.conversationId}`}>
                  <Face src={m.other.photo} alt={m.other.displayName} verified={m.other.verified} size={56} />
                  <span className="who">
                    <strong>{m.other.displayName}{m.other.age ? `, ${m.other.age}` : ""}</strong>
                    <span>
                      {m.status !== "open" ? "Conversation closed" : m.other.verified ? "ID verified" : "Not verified yet"}
                      {m.online ? ", online now" : m.lastMessageAt ? `, last message ${ago(m.lastMessageAt)}` : ", say hello"}
                    </span>
                  </span>
                  {n > 0 && <span className="unread" aria-label={`${n} unread`}>{n}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
