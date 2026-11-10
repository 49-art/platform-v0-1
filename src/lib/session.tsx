import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";

export type Step = "banned" | "suspended" | "email_capture" | "email_verify" | "age" | "profile" | "pending" | "ready";

export interface Me {
  user: { id: string; email: string | null; role: string; status: string; hasPassword: boolean; xHandle: string | null; restrictedUntil: number | null; suspendedUntil: number | null } | null;
  flags?: { emailVerified: boolean; agePassed: boolean; idVerified: boolean; idStatus: string; profileStatus: string; profileRejection: string | null; ageAttemptsLeft: number };
  step?: Step;
  config: { appName: string; turnstileSiteKey: string; xEnabled: boolean; vapidPublicKey: string | null; dev: boolean; sample: boolean };
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
}

const SessionContext = createContext<SessionValue>({ me: null, loading: true, refresh: async () => null });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const data = await get<Me>("/api/me");
      setMe(data);
      return data;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <SessionContext.Provider value={{ me, loading, refresh }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

/** Where the verification flow (spec 7) says this member should be right now. */
export function pathForStep(step: Step | undefined): string {
  switch (step) {
    case "banned":
    case "suspended": return "/app/standing";
    case "email_capture":
    case "email_verify": return "/app/email";
    case "age": return "/app/age";
    case "profile": return "/app/profile";
    case "pending": return "/app/pending";
    default: return "/app/discover";
  }
}
