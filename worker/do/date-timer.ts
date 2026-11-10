import { DurableObject } from "cloudflare:workers";
import { makeDb, notify, schema } from "../../core";
import { and, eq } from "drizzle-orm";
import type { Env } from "../env";
import { ensureReady } from "../lib/bootstrap";
import { dispatch } from "../lib/dispatch";
import { raiseSafetyAlert } from "../lib/safety";

interface TimerState {
  dateId: string;
  userId: string;
  checkinDueAt: number;
  stage: "remind" | "alert";
}

/** Grace period between the check-in reminder and alerting the trusted contact. */
export const CHECKIN_GRACE_MS = 30 * 60_000;

/**
 * One per (date, member). Durable Object alarms are persisted, so a check-in reminder still fires after a
 * deploy or a restart (spec 6: "alarms fire check-in reminders and alerts at the set time, surviving restarts").
 */
export class DateTimer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Alerts decrypt the plan and contact details, so the runtime secrets must be loaded first (D-021).
    ctx.blockConcurrencyWhile(() => ensureReady(env));
  }

  async schedule(dateId: string, userId: string, checkinDueAt: number): Promise<void> {
    await this.ctx.storage.put<TimerState>("state", { dateId, userId, checkinDueAt, stage: "remind" });
    await this.ctx.storage.setAlarm(checkinDueAt);
  }

  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("state");
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<TimerState>("state");
    if (!state) return;
    const db = makeDb(this.env.DB);
    const now = Date.now();
    const [safety] = await db.select().from(schema.dateSafety).where(and(eq(schema.dateSafety.dateId, state.dateId), eq(schema.dateSafety.userId, state.userId)));
    const [date] = await db.select().from(schema.dates).where(eq(schema.dates.id, state.dateId));
    // Checked in already, or the date was called off: nothing to do.
    if (!safety || !date || safety.checkedInAt || date.status !== "accepted") return this.cancel();

    if (state.stage === "remind") {
      await db.update(schema.dateSafety).set({ remindedAt: now }).where(and(eq(schema.dateSafety.dateId, state.dateId), eq(schema.dateSafety.userId, state.userId)));
      await notify(db, state.userId, { kind: "safety", title: "Time to check in", body: "Tap to tell us you are OK. If we do not hear from you in 30 minutes we will alert your trusted contact.", href: `/app/chat/${date.conversationId}` }, now);
      await dispatch(this.env, { kind: "notify", userId: state.userId, reason: "safety" });
      await this.ctx.storage.put<TimerState>("state", { ...state, stage: "alert" });
      await this.ctx.storage.setAlarm(state.checkinDueAt + CHECKIN_GRACE_MS);
      return;
    }
    await raiseSafetyAlert(this.env, db, state.dateId, state.userId, "missed_checkin", now);
    await dispatch(this.env, { kind: "notify", userId: state.userId, reason: "safety" });
    await this.cancel();
  }
}
