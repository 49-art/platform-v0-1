# Open items

Things the sample does not do yet, and what each one needs. Launch blockers first.

## Launch blockers (also shown to admins in the staff console)

| Item | Needs | Cost |
|---|---|---|
| Real age assurance and ID + liveness | Choose a provider (spec 14: quotes from Yoti and Persona), then add its adapter beside the mock in `core/providers.ts` | Persona from $250/month; others per quote (spec 12) |
| Real secrets in Cloudflare | Set `APP_SECRET`, `INTERNAL_SECRET`, `PROVIDER_WEBHOOK_SECRET` as Worker secrets (D-021) | Free |
| Real Turnstile keys | Create a widget in the Cloudflare dashboard; put the site key in `wrangler.jsonc`, the secret as a Worker secret (D-022) | Free |
| Argon2id passwords | Workers Paid plan, then remove `PASSWORD_ALGO` (D-016) | $5/month |
| Email | A domain, a Resend account, `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `MAIL_FROM` | Domain ~£10/year; Resend free up to 3,000/month |
| SMS for trusted contacts | Choose a provider (spec 12: quote needed) and add an adapter | Per message |
| Image scanning | Sightengine adapter is written but not run against a live account; needs `SCAN_PROVIDER=sightengine` and credentials | From $29/month |
| CSAM hash matching | Cloudflare CSAM Scanning Tool (needs a custom domain with Cloudflare caching in front of media) now; IWF when eligible | Free / £5,000+ a year |
| Separate admin console behind Cloudflare Access | Custom domain, Access application, then deploy the admin routes as their own Worker (D-018) | Access free up to 50 users |
| Legal checklist | Every item in spec section 10 is still open | Solicitor quote |
| Moderators | At least two trained before public launch (spec 14) | |
| Remove sample mode | `SAMPLE_MODE` off, `ENVIRONMENT=production`, remove sample members, lift noindex | |

## Paid-plan upgrades (same code, add the bindings back)

R2 for media (D-015), Queues for retries (D-014), KV if wanted. The full config is in `docs/archive/wrangler.paid-plan.jsonc`.

## Not built (by design)

Phase 2 creator agency and Phase 3 payments (D-011). Native apps (spec 11: PWA first). Group chats (spec 6: out of scope for v1).

## Spec gaps

Parts of the spec were not in the PDF (see `docs/spec/DERIVED.md`). If the full text turns up, compare and adjust.
