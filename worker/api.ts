import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./env";
import { errorResponse } from "./lib/http";
import { csrfMiddleware, sessionMiddleware } from "./lib/session";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { chat } from "./routes/chat";
import { profiles } from "./routes/profiles";
import { internal, safety } from "./routes/safety";
import { devProvider, verification } from "./routes/verification";

/** The JSON API. Mounted by the Worker entry; the React app handles every other path. */
export const api = new Hono<AppEnv>();

api.onError((err, c) => errorResponse(c, err));
api.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", referrerPolicy: "strict-origin-when-cross-origin", xFrameOptions: "DENY" }));
api.use("*", sessionMiddleware);
api.use("*", csrfMiddleware);
api.use("/api/*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store"); // nothing from the API is ever cached by a shared cache
});

api.route("/", auth);
api.route("/", verification);
api.route("/", devProvider);
api.route("/", profiles);
api.route("/", chat);
api.route("/", safety);
api.route("/", internal);
api.route("/", admin);

api.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "No such API route." } }, 404));

/** Paths the API owns. Everything else is rendered by React Router. */
export const isApiPath = (pathname: string) => pathname.startsWith("/api/") || pathname.startsWith("/media/") || pathname.startsWith("/internal/");
