/**
 * Staff identity for the in-app admin console (decision D-018).
 *
 * Spec 8 puts the admin console on its own subdomain behind Cloudflare Access. The free sample keeps the console
 * inside this Worker at /admin so it can go live with no extra accounts; the staff table and the capability
 * matrix in @platform/core (policy.ts) are exactly the ones the separate console will use.
 */
import { type Actor, type Capability, type StaffRole, can, schema } from "../../core";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { forbidden, requireUser } from "./http";

export async function staffFor(c: Context<AppEnv>): Promise<{ actor: Actor; role: StaffRole; staffId: string } | null> {
  const user = c.get("user");
  if (!user?.email || !user.emailVerifiedAt) return null;
  const [row] = await c.get("db").select().from(schema.staff).where(and(eq(schema.staff.email, user.email), eq(schema.staff.active, true)));
  if (!row) return null;
  return { actor: { id: row.id, role: row.role }, role: row.role, staffId: row.id };
}

export async function requireStaff(c: Context<AppEnv>, capability?: Capability) {
  requireUser(c);
  const staff = await staffFor(c);
  if (!staff) throw forbidden("not_staff", "This area is for staff only.");
  if (capability && !can(staff.role, capability)) throw forbidden("insufficient_role", "Your role cannot do this.");
  return staff;
}
