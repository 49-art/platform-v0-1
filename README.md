# [NAME TBD] — verified dating platform (SAMPLE)

A free dating app for adults where both people prove who they are before they can plan a date. Built from **Platform Spec v0.1** (`docs/spec/SPEC-v0.1.md`, original PDF beside it). Owner: Travis Lee Swift, HVT Innovations.

**Live sample:** https://platform-v0-1.hvtinnovations1.workers.dev
Not public: every page asks search engines not to list it, and a SAMPLE banner shows on every screen.

## What it does

A real, installable app (download it from any page), not a page to look at:

- **Join and get in:** email sign-up with a one-time link, bot check, 18+ age check, profile with photos, human approval of every profile and photo.
- **Meet people:** browse with filters, like or pass, a mutual like opens a live chat.
- **Verify before you meet:** ID + liveness check gives a cyan verified ring. Date planning, number swaps and "Continue on X" unlock only when both people are verified and both agree.
- **Stay safe:** trusted contacts, a shared date plan, a check-in timer that alerts your contact if you miss it, an SOS button, report and block from anywhere, appeals for every decision.
- **Your data:** sessions list and sign-out everywhere, download all your data, delete your account.
- **Staff console** at `/admin`: dashboard, pre-moderation queue with keyboard shortcuts, report queue, User 360, enforcement with reason codes, appeals, append-only audit log with export, law-enforcement desk, staff roles, categories, policy versions, contact inbox.

### Sample mode: what is simulated

- The age check and the ID check: a practice page stands in for the provider (no provider chosen yet, spec 14).
- Emails and texts are not sent. The link an email would carry shows on screen, and only on the device that asked.
- Automatic image scanning: every photo still goes to a person.
- Safety alerts are recorded but reach no one. In an emergency call 999.
- Admins can add 8 labelled SAMPLE members near London so there is someone to browse. They like back but never send messages.

What it takes to go from sample to launch is listed in `docs/OPEN-ITEMS.md`, and the staff console shows the launch blockers at the top.

## First time on the live sample

1. Open the live link and press **Join free**. Sign up with your own email. The confirm link appears on screen: tap it.
2. Do the age check (choose "18 or over" on the practice page), build your profile, add a photo, press **Send for approval**.
3. Go to **Me**, then **Staff console**, then **Make me the admin**. The first verified account gets this, once. Do it straight away.
4. In the staff console: **Pre-moderation**, approve your photo, then your profile. On **Dashboard**, press **Add sample members**.
5. Back in the app: **Discover**, like someone, open the chat. For the full date flow, sign up a second account on another phone, verify both on the **Verify** tab, and match.

## Cloudflare set-up (one time, done by Travis)

1. Open https://dash.cloudflare.com/?to=/:account/workers-and-pages/create
2. Click **Import a repository** and choose `platform-v0-1`.
3. Fill in the boxes:
   - **Project name:** `platform-v0-1`
   - **Build command:** `npm ci && npm run build`
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** leave this box blank and type nothing in it.
4. Click **Save and Deploy**.

After that, every push to `main` goes live by itself. The database is created on the first deploy and the app sets itself up on first use (decisions D-020, D-021). Everything runs on the free plan.

## Tests (last run 10 Nov 2026, before the first push)

| Check | Result |
|---|---|
| `npm ci` | Pass, 212 packages |
| Unit and API tests (`npm test`, Vitest in the Workers runtime, real D1 and Durable Objects) | **81 / 81 pass** |
| `npm run build` (migrations embedded, TypeScript strict, Vite) | Pass |
| `wrangler dev` + `/api/health` | `{"ok":true}`, fresh database migrated and secrets generated on first use |
| Headless Chrome at 390×844, 34 screens: loads, no console errors, no broken images, no sideways scroll | **34 / 34 pass** |
| axe WCAG 2.2 AA on all 34 screens | **0 violations** |
| Real chat message sent and delivered over the WebSocket in the browser | Pass |
| Contact shield blocks a phone number before both are verified (browser) | Pass |
| PWA: service worker active, loads offline, icons 192 / 512 / maskable | Pass |
| `wrangler deploy --dry-run` | Pass, 242 KB gzipped |
| Secret scan (`secretlint`, recommended rules) | Clean |
| Live checks on the deployed site | See below, after the first deploy |

The API tests cover every acceptance criterion in spec section 3 "Auth and account", the verification flow (spec 7), chat and the shield (spec 6), dates and safety timers, moderation, the CSAM path, erasure and legal holds, the staff console's role checks and audit trail, and the free-plan adapters. Screenshots from the browser check: `test-results/` (not committed) and `public/screenshots/`.

## Run it locally (for developers)

```
npm ci
cp .dev.vars.example .dev.vars
npm run build
npx wrangler dev            # http://localhost:8787
npm test
node scripts/browser-check.mjs   # needs puppeteer-core and axe-core in TOOLS_DIR, and Chrome
```

## Where things are

| Path | What |
|---|---|
| `docs/spec/` | The spec PDF, its transcription, and `DERIVED.md` (parts the PDF did not include, filled in for sign-off) |
| `docs/DECISIONS.md` | Every decision and why |
| `docs/DESIGN.md` | Colours, type, the verification ring |
| `docs/OPEN-ITEMS.md` | What is needed to launch |
| `AGENTS.md` | Rules for any AI working on this repo |
| `worker/`, `core/`, `src/`, `migrations/`, `tests/` | The code (see `AGENTS.md`) |
