# Third-party notices

All open source and more than a year old. No paid service is needed to run the sample.

## Shipped in the app or the Worker

| Package | Version | Licence | Use |
|---|---|---|---|
| hono | 4.13 | MIT | API routing on Workers |
| drizzle-orm | 0.45 | Apache-2.0 | Typed queries for D1 |
| zod | 4.6 | MIT | Input validation |
| @noble/hashes | 2.4 | MIT | Argon2id password hashing (paid plan) |
| react, react-dom | 19.3 | MIT | User interface |
| react-router | 8.5 | MIT | Screens and navigation |
| qrcode | 1.5 | MIT | QR code on the install page |
| Unbounded (via @fontsource-variable/unbounded) | 5.3 | SIL Open Font License 1.1 | Headings |
| Atkinson Hyperlegible (via @fontsource/atkinson-hyperlegible) | 5.3 | SIL Open Font License 1.1, © Braille Institute of America | Body text |

## Build and test only (not shipped)

| Package | Version | Licence |
|---|---|---|
| vite, @vitejs/plugin-react | 8.3, 6.3 | MIT |
| typescript | 5.9 | Apache-2.0 |
| wrangler | 4.160 | MIT or Apache-2.0 |
| vitest, @cloudflare/vitest-plugin | 5.1, 1.7 | MIT |
| drizzle-kit | 0.31 | MIT |
| secretlint + preset | 13.1 | MIT |
| puppeteer-core (browser check, installed outside the repo) | 25.17 | Apache-2.0 |
| axe-core (browser check, installed outside the repo) | 4.14 | MPL-2.0 |

## Images

All images are original and made in this repo: app icons and the share image (`scripts/make-icons.mjs`), sample member avatars (`worker/lib/png.ts`, abstract gradients marked with a band so they are never mistaken for a real person), screenshots of the app itself. No stock photos, no third-party characters or brands.

## Services the code can talk to (only when configured)

Cloudflare Turnstile, Resend, Sightengine, X (Sign in with X), and an age / ID provider still to be chosen. In the sample none of these are called except Turnstile (with Cloudflare's public test keys).
