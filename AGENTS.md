# Rules for any AI agent working in this repo (Claude, Grok, or another)

Travis Lee Swift (HVT Innovations) decides. Agents build. Read this, `README.md`, `docs/DECISIONS.md` and `docs/spec/SPEC-v0.1.md` before changing anything.

## Working with Travis
- He is not a coder and does not use a terminal. Plain English, short, no jargon. Click-by-click instructions with direct links.
- Never change or delete existing work without asking. Replace, and say so. Superseded decisions are marked SUPERSEDED, never removed.
- Flag a real concern once, plainly, then move on.
- Free and open-source tools only, established for at least a year. If anything costs money, say what and how much before building it.
- Ask at most one question, and only if a wrong guess is costly.

## This product
- An 18+ dating platform where both people are ID-verified before any date tool, contact swap or "Continue on X" unlocks. Spec v0.1 is the baseline (D-001).
- **Hard line:** the paid creator side (Phase 2) must never facilitate, advertise or arrange in-person meetings. No Phase 2 or 3 code until a solicitor has signed off (spec 10, D-011).
- Safety rules are not optional: pre-moderation of every profile and photo, the contact shield, reason codes on every action, the append-only audit log, appeals.
- Special category data (sexuality, gender identity) only under explicit consent, encrypted, minimal display (D-010). Never store ID documents.

## How the code is laid out
- `worker/` the Cloudflare Worker: Hono API (`routes/`), Durable Objects (`do/`), helpers (`lib/`).
- `core/` domain code shared by everything: schema, policy (roles, reason codes, thresholds), crypto, shield, providers.
- `src/` the installable app (React, React Router). `public/` manifest, service worker, icons, headers.
- `migrations/` D1 SQL. After adding one, run `node scripts/gen-migrations.mjs` (the build does this too).
- `tests/` API and Durable Object tests (Vitest in the Workers runtime). `scripts/browser-check.mjs` checks every screen in headless Chrome.

## Before every push
`npm ci`, `npm test`, `npm run build`, `wrangler dev` + `node scripts/browser-check.mjs`, `npx wrangler deploy --dry-run`, `npx secretlint "**/*"`. Update the test table in the README.

## Never
- Put a secret, key or token in the repo. Names go in `.dev.vars.example`; values go in Cloudflare.
- Turn on sample mode or mock providers with `ENVIRONMENT=production` (the code refuses, keep it that way).
- Remove `noindex` until Travis says the site can go public.
- Invent reviews, ratings, testimonials, members or credentials. Sample members are labelled SAMPLE.
- Use third-party characters, brands or stock photos of real people.
