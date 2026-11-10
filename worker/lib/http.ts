import { DomainError, ProviderConfigError } from "../../core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppEnv } from "../env";

export class HttpError extends Error {
  constructor(public status: ContentfulStatusCode, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export const bad = (code: string, message: string, extra?: Record<string, unknown>) => new HttpError(400, code, message, extra);
export const unauthorised = () => new HttpError(401, "unauthorised", "Please sign in.");
export const forbidden = (code: string, message: string, extra?: Record<string, unknown>) => new HttpError(403, code, message, extra);
export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);
export const tooMany = (retryAfterS: number) => new HttpError(429, "rate_limited", "Too many attempts. Please wait a moment and try again.", { retryAfter: retryAfterS });

export function errorResponse(c: Context<AppEnv>, err: unknown) {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  if (err instanceof DomainError) return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode);
  if (err instanceof z.ZodError) return c.json({ error: { code: "invalid", message: "Please check the details you entered.", fields: z.flattenError(err).fieldErrors } }, 400);
  if (err instanceof ProviderConfigError) {
    console.error("provider configuration", err.message);
    return c.json({ error: { code: "unavailable", message: "This step is not available right now. Please try again later." } }, 503);
  }
  console.error("unhandled", err);
  return c.json({ error: { code: "server_error", message: "Something went wrong on our side." } }, 500);
}

export async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw bad("invalid_json", "Request body must be JSON.");
  }
  return schema.parse(raw);
}

export function requireUser(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!user) throw unauthorised();
  return user;
}

/** Most of the app needs a member in good standing. Suspended and banned members can still read their standing and appeal. */
export function requireActive(c: Context<AppEnv>) {
  const user = requireUser(c);
  if (user.status !== "active") throw forbidden("account_" + user.status, "Your account cannot do this right now.");
  if (!user.emailVerifiedAt) throw forbidden("email_unverified", "Please confirm your email address first.");
  return user;
}
