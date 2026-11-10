import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The member's live connection to their UserHub Durable Object (spec 6): unread counts, new-match and moderation
 * notifications. Reconnects with back-off; the app works without it, just less live.
 */
interface HubState {
  unread: Record<string, number>;
  notices: number;
  bumpNotices: () => void;
  clearNotices: () => void;
  lastEvent: { type: string; [k: string]: unknown } | null;
}

const HubContext = createContext<HubState>({ unread: {}, notices: 0, bumpNotices: () => {}, clearNotices: () => {}, lastEvent: null });

export function HubProvider({ enabled, initialNotices, children }: { enabled: boolean; initialNotices: number; children: ReactNode }) {
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [notices, setNotices] = useState(initialNotices);
  const [lastEvent, setLastEvent] = useState<HubState["lastEvent"]>(null);
  const retry = useRef(0);

  useEffect(() => setNotices(initialNotices), [initialNotices]);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/hub/ws`);
      ws.onopen = () => { retry.current = 0; ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 30_000); };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        let ev: any;
        try { ev = JSON.parse(e.data); } catch { return; }
        setLastEvent(ev);
        if (ev.type === "hello") setUnread(ev.unread ?? {});
        if (ev.type === "unread") setUnread((u) => ({ ...u, [ev.conversationId]: ev.count }));
        if (ev.type === "notification") setNotices((n) => n + 1);
      };
      ws.onclose = (e) => {
        clearInterval(ping);
        if (stopped || e.code === 4001) return; // 4001: account standing changed, the app will re-route
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry.current++));
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); clearInterval(ping); ws?.close(); };
  }, [enabled]);

  return (
    <HubContext.Provider value={{ unread, notices, lastEvent, bumpNotices: () => setNotices((n) => n + 1), clearNotices: () => setNotices(0) }}>
      {children}
    </HubContext.Provider>
  );
}

export const useHub = () => useContext(HubContext);
