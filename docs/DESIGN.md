# Design system

Brief from Travis: "high tech layout, bright fluorescent colours and the best you can do."

## Idea

The product's one promise is that both people are verified before they meet. So the visual identity is built on a single device: **the verification ring**. A cyan, glowing ring around a face means "this person proved who they are". A dashed ring means "not yet". It appears on the welcome screen (two verified rings joined by a line), in matches, in chat, on the Verify screen and in the app icon. Everything else stays quiet so that ring is what people remember.

## Colour: each fluorescent has one job

| Name | Hex | Meaning, everywhere |
|---|---|---|
| Deep | `#0c061c` | Furthest background, inputs |
| Ink | `#120a26` | Base background, text on bright buttons |
| Panel | `#1d1240` / `#271a58` | Surfaces |
| Line | `#44337f` | Borders, grid |
| Text | `#f3eeff` | Body text |
| Muted | `#c3b8e6` | Secondary text (AA on Ink) |
| Volt | `#c6ff1a` | The next action to take; your own chat messages |
| Pink | `#ff2e9a` | People: likes, matches, unread |
| Cyan | `#18f0ff` | Identity: verified, focus rings |
| Amber | `#ffb020` | Safety: check-ins, SOS, sample warnings |
| Red | `#ff6b7a` | Destructive actions, errors |

Bright buttons always carry dark Ink text (contrast 9:1 and above). The background has a faint 32 px grid: the "high tech" layer.

## Type

- **Unbounded** (variable, OFL): headings. Wide, geometric, techy.
- **Atkinson Hyperlegible** (OFL, by the Braille Institute): everything else. Built for legibility; long safety text stays readable on a dark screen.
- Self-hosted through Fontsource: no calls to Google Fonts, nothing leaves the app.
- Scale: 0.82, 1.06 (body 17 px), 1.25, 1.56, 2, 2.6 rem. Sentence case throughout, no all-caps labels.

## Shape

Chamfered corners (one cut corner pair) on panels, buttons and cards, instead of rounded corners. Chat bubbles use a single cut corner pointing at the sender.

## Layout

- Phones: top bar, one screen per section, bottom tab bar (Discover, Matches, Verify, Me), sheets slide up from the bottom.
- 900 px and up: the tab bar becomes a left rail.
- Content is left-aligned; line length stays under 70 characters.

## Motion

One orchestrated moment: the verified ring settles in once when it first appears. Sheets slide up when opened. Nothing moves on its own otherwise. `prefers-reduced-motion` switches all of it off.

## Accessibility (checked on every screen by `scripts/browser-check.mjs`)

WCAG 2.2 AA with axe: 0 violations on all 34 screens. Visible focus (cyan), 44 px minimum touch targets, native `<dialog>` for sheets, labels on every field, live regions for chat and status messages.
