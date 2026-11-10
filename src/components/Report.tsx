import { useEffect, useState } from "react";
import { get, messageOf, post } from "../lib/api";
import { ErrorText, Sheet } from "./ui";

/** "Report bot" everywhere (spec 9), plus every other reason. The reporter is told we have it, and later the outcome. */
export function ReportSheet({ open, onClose, userId, name, conversationId, onDone, defaultReason = "bot" }: {
  open: boolean; onClose: () => void; userId: string; name: string; conversationId?: string; onDone?: (blocked: boolean) => void; defaultReason?: string;
}) {
  const [reasons, setReasons] = useState<{ key: string; label: string }[]>([]);
  const [reason, setReason] = useState(defaultReason);
  const [detail, setDetail] = useState("");
  const [block, setBlock] = useState(true);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  useEffect(() => { if (open) { setDone(""); setError(""); setReason(defaultReason); get<{ reasons: { key: string; label: string }[] }>("/api/report-reasons").then((r) => setReasons(r.reasons)).catch(() => {}); } }, [open, defaultReason]);
  async function send() {
    setError("");
    try {
      const r = await post<{ message: string; reference: string }>("/api/reports", { userId, reason, detail: detail || undefined, conversationId, block });
      setDone(`${r.message} Reference ${r.reference}.`);
      onDone?.(block);
    } catch (err) { setError(messageOf(err)); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={`Report ${name}`}>
      {done ? (
        <><p className="ok" role="status">{done}</p><button className="btn block" type="button" onClick={onClose}>Done</button></>
      ) : (
        <>
          <fieldset>
            <legend>What is wrong?</legend>
            {reasons.map((r) => (
              <label className="check" key={r.key}><input type="radio" name="reason" value={r.key} checked={reason === r.key} onChange={() => setReason(r.key)} /> <span>{r.label}</span></label>
            ))}
          </fieldset>
          <div className="field"><label htmlFor="rd">Anything else we should know? <span className="hint">Optional.</span></label><textarea id="rd" maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} /></div>
          <label className="check"><input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} /> <span>Also block {name}. They will not be told.</span></label>
          {(reason === "threat") && <div className="notice red"><p>If anyone is in immediate danger, call 999 now.</p></div>}
          <ErrorText>{error}</ErrorText>
          <button className="btn red block" type="button" onClick={send}>Send report</button>
        </>
      )}
    </Sheet>
  );
}
