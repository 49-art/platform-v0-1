# Derived parts: for Travis to sign off

The spec PDF printed only the panels that were open. For the parts below, the build follows the complete sections of the spec (1, 2, 6, 7, 8, 9, 10, 11) and fills the detail in. Each item says where it came from. If the full spec text turns up, compare it here and change what differs.

## Section 3: features (collapsed modules)

| Module | What the build does | Taken from |
|---|---|---|
| Age assurance (18+) | Straight after email confirmation, before any profile. Provider result only, never a document or date of birth. Three failed attempts: account suspended and profile and photos deleted. | Spec 2 step 2, spec 7 nodes D and X2, spec 10 HEAA |
| Profiles | Up to 6 photos (JPEG, PNG, WebP; checked by the file's bytes, not its name), first name, year of birth (age only shown), bio up to 600 characters, looking for, country of origin, area. No contact details allowed in name or bio. Optional identity fields under explicit consent (D-010). | Spec 2 step 3, spec 1 privacy |
| Pre-moderation | Every photo and every profile goes to a person. Auto-scores shown to the moderator. Clear-cut nudity is rejected automatically, still appealable. Hash match goes to the CSAM path. SLA 4 hours, 1 hour for possible minors. | Spec 1, spec 2 step 4, spec 8 |
| Discovery and matching | Filters: age range, distance (10 to 800 km), looking for, verified only. Pass or like; mutual like opens a chat. 150 likes a day maximum (bot signal). Blocked people never appear either way. | Spec 2 step 5 |
| Chat | One-to-one, live, text and images. Images delivered only after scanning. Explicit images only to members who opted in, still hidden until tapped. Contact shield (D-008). Read state, typing indicator, unread counts. | Spec 6 |
| Dates and safety | Unlocks only when both are ID-verified. Propose (time, venue, area), accept, decline, cancel. Each person privately sets a trusted contact, shares the plan and a check-in time; reminder at check-in, contact alerted 30 minutes later; SOS button. The other person is never told. | Spec 2 step 7, spec 6 date timers, spec 7 node P |
| Swaps | Phone number or "Continue on X", each needing both people verified and both agreeing; withdrawable; shown to the two of them only. X link falls back to the X profile URL. | Spec 2 step 8, spec 6 note, spec 7 nodes Q to S |
| Notifications | In-app list, live via UserHub, Web Push with no payload, email digest at most every 6 hours with no message content. | Spec 6 offline delivery |
| Site and contact | Public welcome, guidelines, terms, privacy, safety pages, contact form with Turnstile; no profiles visible to visitors. Legal pages are marked draft, not legal advice. | Spec 2 Visitor, spec 3 bot gate, spec 10 |
| Creator agency, Payments | Not built (Phase 2 and 3). | Spec 13 |

## Section 4: tables beyond "Identity and auth"

Verification: `age_checks`, `id_verifications` (result, face-match flag, provider's duplicate-person token stored only as a keyed hash). Profiles and discovery: `profiles`, `photos`, `likes`, `matches`, `blocks`, `taxonomy`. Chat and dates: `conversations`, `messages` (encrypted archive copy), `user_contacts`, `trusted_contacts`, `dates`, `date_safety`. Trust and safety: `reports`, `mod_queue`, `enforcement_actions`, `appeals`, `ban_signals`, `flagged_messages`, `audit_log` (append-only by database trigger), `staff`, `le_requests`, `legal_holds`, `policy_versions`. Site: `notifications`, `push_subscriptions`, `contact_messages`, `outbox`, `bot_events`. Free-plan extras: `media_blobs`, `app_config`. Full definitions: `core/schema.ts` and `migrations/`.

## Section 5: API tabs beyond "Auth"

All routes, with the spec's Auth tab exactly as written:

```
Verification  POST /api/age/start · POST /api/verification/start · GET /api/verification/status · POST /api/webhooks/age · POST /api/webhooks/idv
Profiles      GET|PUT /api/profile · POST /api/profile/submit · POST /api/photos · DELETE /api/photos/:id · GET /media/* · GET /api/taxonomy
              GET|POST /api/consents · GET /api/discover · GET /api/profiles/:id · POST /api/likes · GET /api/matches
Chat          GET /api/hub/ws · GET /api/conversations/:id · GET /api/conversations/:id/ws · POST /api/conversations/:id/swap · PUT /api/me/phone
Dates         POST /api/conversations/:id/dates · POST /api/dates/:id/respond · PUT /api/dates/:id/safety · POST /api/dates/:id/checkin
              POST /api/dates/:id/sos · GET|POST /api/trusted-contacts · DELETE /api/trusted-contacts/:id
Safety        GET /api/report-reasons · POST /api/reports · GET|POST /api/blocks · DELETE /api/blocks/:userId · GET /api/standing
              POST /api/appeals · GET /api/notifications · POST /api/notifications/read · POST /api/push/subscribe|unsubscribe · POST /api/contact
Admin         /api/admin/* (me, claim, dashboard, premod, media, reports, users, enforce, actions/lift, appeals, audit, audit/export,
              staff, taxonomy, le, policy, contact, outbox, sample)
Account extra POST /api/auth/resend-verification · POST /api/auth/reauth · POST /api/me/email · POST /api/me/password · DELETE /api/me/sessions
Health        GET /api/health
```

## Section 13: build plan beyond P1-1 and P1-2

The build covers what Phase 0 and Phase 1 would need to deliver the dater journey end to end (spec 2), plus the staff console (spec 8). Status of each area is in the README.
