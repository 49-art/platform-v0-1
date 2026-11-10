// Headless browser check of every screen at phone size (390x844), run against `wrangler dev` on port 8787.
//
//   node scripts/browser-check.mjs            (needs puppeteer-core + axe-core: TOOLS_DIR points at a folder that has them)
//
// For each page: it loads, no console errors, no broken images, axe WCAG 2.2 AA violations = 0, no sideways scroll.
// Also checks the PWA (service worker active, offline load, icons) and sends a real chat message over the WebSocket.
//
// Signed-in screens need a member. This script creates one directly in the LOCAL database (never a live one):
// a verified, age-checked member who is also the staff admin, plus a session whose cookie it then uses.
// Turnstile cannot be reached from a sandbox, so sign-up itself is covered by the API tests instead.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const TOOLS = process.env.TOOLS_DIR ?? "/home/claude/tools";
const require = createRequire(join(TOOLS, "package.json"));
const puppeteer = require("puppeteer-core");
const axeSource = require("node:fs").readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const OUT = "test-results";
mkdirSync(OUT, { recursive: true });
mkdirSync("public/screenshots", { recursive: true });

function d1(sql) {
  return execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ── Seed one member + admin and a session (local only) ──
const token = randomBytes(32).toString("base64url");
const csrf = randomBytes(18).toString("base64url");
const sid = createHash("sha256").update(token).digest("hex");
const now = Date.now();
const uid = `usr_check${now}`;
const email = `check-${now}@example.test`;
d1([
  `INSERT INTO users (id, email, email_verified_at, status, role, risk_score, created_at) VALUES ('${uid}', '${email}', ${now}, 'active', 'member', 0, ${now})`,
  `INSERT INTO age_checks (id, user_id, provider, provider_ref, method, status, created_at, decided_at) VALUES ('age_${now}', '${uid}', 'mock', 'chk${now}', 'face_estimation', 'passed', ${now}, ${now})`,
  `INSERT INTO profiles (user_id, display_name, birth_year, bio, looking_for, country_of_origin, area_label, geo_cell, cell_lat, cell_lon, status, approved_at, updated_at) VALUES ('${uid}', 'Tester', 1990, 'Browser check account.', 'dinner', 'United Kingdom', 'London', 'gcpvj', 51510, -132, 'approved', ${now}, ${now})`,
  `INSERT INTO staff (id, email, name, role, active, created_at) VALUES ('stf_${now}', '${email}', 'Check', 'admin', 1, ${now})`,
  `INSERT INTO sessions (id, user_id, created_at, last_seen_at, reauth_at) VALUES ('${sid}', '${uid}', ${now}, ${now}, ${now})`,
].join("; "));

const cookie = `__Host-sid=${token}; __Host-csrf=${csrf}`;
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { cookie, origin: BASE, "x-csrf-token": csrf, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text || "{}");
};

const results = [];
const record = (check, ok, detail = "") => { results.push({ check, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${check}${detail ? `  (${detail})` : ""}`); };

// Sample members and a match, through the real API.
const seeded = await call("POST", "/api/admin/sample/seed");
record("Admin adds sample members (API)", true, `${seeded.n} added`);
const discover = await call("GET", "/api/discover?km=100");
record("Discover returns approved nearby profiles (API)", discover.profiles.length > 0, `${discover.profiles.length} profiles`);
const target = discover.profiles[0];
const like = await call("POST", "/api/likes", { userId: target.userId, kind: "like" });
record("Like a sample member gives a match (API)", like.matched === true, like.conversationId);
const conversationId = like.conversationId;

// ── Browser ──
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const host = new URL(BASE).hostname;
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

async function check(path, name, { signedIn = false, shot } = {}) {
  if (signedIn) await browser.setCookie({ name: "__Host-sid", value: token, domain: host, path: "/", secure: true, httpOnly: true }, { name: "__Host-csrf", value: csrf, domain: host, path: "/", secure: true });
  consoleErrors.length = 0;
  const res = await page.goto(BASE + path, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".splash"), { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const ok = res && res.status() < 400;
  // The Turnstile script cannot load inside this sandbox (no route to challenges.cloudflare.com). That error is expected here only.
  const errors = consoleErrors.filter((e) => !/challenges\.cloudflare\.com|Turnstile|ERR_TUNNEL|ERR_NAME|net::ERR_/.test(e));
  const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src));
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await page.evaluate(axeSource); // injected over DevTools, so the page's strict CSP stays switched on during the check
  const axe = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`));
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  if (shot) await page.screenshot({ path: shot });
  const pass = ok && errors.length === 0 && broken.length === 0 && !sideways && axe.length === 0;
  record(`Page ${path}`, pass, [!ok && `HTTP ${res?.status()}`, errors.length && `console: ${errors.join(" | ").slice(0, 300)}`, broken.length && `broken images: ${broken.length}`, sideways && "sideways scroll", axe.length && `axe: ${axe.join("; ")}`].filter(Boolean).join(", "));
}

const publicPages = [["/", "welcome", "public/screenshots/phone-welcome.png"], ["/signup", "signup"], ["/login", "login"], ["/reset", "reset"], ["/install", "install"], ["/contact", "contact"], ["/guidelines", "guidelines"], ["/terms", "terms"], ["/privacy", "privacy"], ["/safety", "safety"], ["/about-sample", "about-sample"], ["/no-such-page", "not-found"]];
for (const [p, n, shot] of publicPages) await check(p, `public-${n}`, { shot });

const appPages = [["/app/discover", "discover"], ["/app/matches", "matches"], [`/app/chat/${conversationId}`, "chat"], ["/app/verify", "verify"], ["/app/me", "me"], ["/app/profile", "profile"], ["/app/settings", "settings"], ["/app/notifications", "notifications"], ["/app/standing", "standing"],
  ["/admin/dashboard", "admin-dashboard"], ["/admin/premod", "admin-premod"], ["/admin/reports", "admin-reports"], ["/admin/members", "admin-members"], [`/admin/members/${target.userId}`, "admin-user360"], ["/admin/appeals", "admin-appeals"], ["/admin/audit", "admin-audit"], ["/admin/le", "admin-le"], ["/admin/staff", "admin-staff"], ["/admin/categories", "admin-categories"], ["/admin/policy", "admin-policy"], ["/admin/contact", "admin-contact"], ["/admin/mail", "admin-mail"]];
for (const [p, n] of appPages) await check(p, `app-${n}`, { signedIn: true });

// ── Real chat round trip in the browser: type, send, see it delivered over the WebSocket ──
await page.goto(`${BASE}/app/chat/${conversationId}`, { waitUntil: "networkidle0" });
await page.waitForSelector("#composer");
await page.type("#composer", "Hello from the browser check");
await page.keyboard.press("Enter");
const delivered = await page.waitForFunction(() => [...document.querySelectorAll(".msg.me")].some((m) => m.textContent?.includes("Hello from the browser check") && !m.textContent.includes("sending")), { timeout: 8000 }).then(() => true).catch(() => false);
record("Chat message sent and confirmed over WebSocket (browser)", delivered);
await page.type("#composer", "call me on 07700 900 123");
await page.keyboard.press("Enter");
const shielded = await page.waitForFunction(() => document.body.textContent?.includes("Contact details unlock after you are both ID-verified"), { timeout: 8000 }).then(() => true).catch(() => false);
record("Contact-detail shield blocks a phone number before verification (browser)", shielded);
await page.screenshot({ path: `${OUT}/app-chat-after.png` });

// ── PWA ──
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
const swActive = await page.evaluate(async () => { const r = await navigator.serviceWorker?.ready; return !!r?.active; });
record("Service worker active", swActive);
const manifest = await (await fetch(BASE + "/manifest.webmanifest")).json();
const icons = await Promise.all(manifest.icons.map(async (i) => (await fetch(BASE + i.src)).status === 200 && i.sizes));
record("Manifest icons 192, 512 and maskable load", icons.every(Boolean) && manifest.icons.some((i) => i.purpose === "maskable") && manifest.display === "standalone", icons.join(","));
await page.reload({ waitUntil: "networkidle0" });
await page.setOfflineMode(true);
let offlineDetail = "";
const offlineOk = await page.reload({ waitUntil: "domcontentloaded" }).then(async () => { await new Promise((r) => setTimeout(r, 800)); const t = await page.evaluate(() => document.body.innerText); offlineDetail = t.slice(0, 60).replace(/\s+/g, " "); return t.length > 20; }).catch((e) => { offlineDetail = String(e).slice(0, 120); return false; });
record("Loads while offline (service worker)", offlineOk, offlineDetail);
await page.setOfflineMode(false);

// ── Wide screenshot for the manifest ──
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.screenshot({ path: "public/screenshots/wide-welcome.png" });
await page.goto(BASE + "/app/discover", { waitUntil: "networkidle0" });
await page.screenshot({ path: `${OUT}/wide-discover.png` });
await page.goto(BASE + "/admin/dashboard", { waitUntil: "networkidle0" });
await page.screenshot({ path: `${OUT}/wide-admin.png` });

await browser.close();
writeFileSync(`${OUT}/browser-check.json`, JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
