# Progress — ilves26 Operaatiokeskus

A running log of what's built, the key decisions, and what's left.

## Fork note

This repo is a **fork of `samvaol/operaatiokeskus`** re-skinned to the **ilves26** brand
(Hämeen Partiopiirin leiri, Evo 23.–31.7.2026). Everything below describes the shared
Operaatiokeskus base; the ilves26 changes are visual only:

- **Palette** → ilves26 red `#CE5738` / green `#80884f` (+ deep `#414a2c`) / gold `#D39C2F` /
  cream `#F5F1E8` / black (no blue; environment folds into green).
- **Type** → Nunito (headings, 900 italic greeting) + Jost (body); replaced Bricolage Grotesque.
- **Header** → solid red with the `assets/ilves26-logo-valk.svg` logo, faint tree silhouettes,
  and a cream **scalloped wave** bottom edge (the brand aaltoviiva — re-added on purpose here).
- **Camp dates** → 23.–31.7.2026 (`CAMP_START`/`CAMP_END`).
- **Board page** (`ticket-server/public`) recoloured to match; bucket colours remapped.
- **News + schedule repointed to ilves26** (reverse-engineered the ilves26 GoodBarber/Corego app):
  - News merges **Tiedotteet** (`75180339`) + **Ilves NYT** (`77682659`) from
    `api.ww-api.com/front/get_items/4406427/…`, newest-first.
  - Schedule: the **Aikataulu** plugin's `ICS_BUNDLE` (section `78357980`, all 9 feeds / 162 events)
    is **embedded** into `index.html` as `SCHED_ICS_EMBED` (snapshot from the saved `Ilves26.html`
    app copy) — no network fetch / CORS. Shows **Havus → Vaeltaja/Aikuinen** =
    `vaeltaja-aikuinen.ics` + `yleiset.ics` (69 events; tiny UTC-ICS parser, no RRULE).
    Configurable via `SCHED_AGE`/`SCHED_CAMP`; re-embed the bundle to refresh.
- **Tickets → Microsoft Planner** (replaced the SharePoint ticket-server). The server reads the
  *Operaatiokeskus tehtävät* plan (`w2Y2pqVlOkKDXrV2TiaYxJYAF5oR`) via **MS Graph**
  `/planner/plans/{id}/buckets`+`/tasks`, authenticated with the **Graph token from the logged-in
  session's MSAL cache** (`getGraphToken`), grouped by column (`groupByBucket`/`mapTask`).
  **Uudet tiketit** ← *Uudet tehtävät*, **Käsittelyssä** ← *Työn alla*. Board page recoloured to
  Planner columns. Needs the user's live Microsoft login to verify; diag at `/api/health`.
- **Removed the Osallistujaviestintä panel** (and its `/api/form` + xlsx code) and the caption
  **Havus · Vaeltaja / Aikuinen** was added to the schedule card.

## Status: working

The dashboard (`index.html`) and the `ticket-server` are functional and verified.
Hosted at <https://github.com/samvaol/operaatiokeskus>.

## Done

### Dashboard (`index.html`, single self-contained file)
- **Layout** — 1920×1080 TV, **4-column grid**, rem-scaled via `html{font-size:clamp(vw+vh)}`.
  Col 1: Leirikello + Työvuoro + Uudet tiketit · Col 2: Sää + Sadetutka · Col 3: Ohjelma · Col 4: Pääuutiset.
- **Greeting + clock** — Helsinki-time greeting (huomenta/päivää/iltaa/yötä) + live clock
  + date, plus the animated **kaiku equalizer / LIVE** signature.
- **Leirikello** — elapsed camp timer from `2026-07-10T09:00+03:00` to `18.7. 16:30`,
  with progress bar. **Confetti + "Leiri N % takana!" toast** fires each whole-percent
  advance (canvas confetti, no lib; respects `prefers-reduced-motion`).
- **Sää · Evo** — live FMI WFS forecast (temp, feels-like, wind, rain, humidity, day/night
  SmartSymbol strip) + `ForestFireWarning`. CORS-open (`*`).
- **Sadetutka · Evo** — Leaflet map centred on `61.204934767500795, 25.1210434592283`,
  FMI radar WMS (`Radar:suomi_dbz_eureffin`, CORS `*`) over a CARTO light base, refreshed
  every 5 min. Non-interactive. `.radarwrap` needs `isolation:isolate` so Leaflet's internal
  z-indexes (200–700) don't paint over the ticket modal.
- **Uudet tiketit** — the *Uudet tehtävät* Planner column, always on screen (col 1), 60 s refresh.
- **Käsittelyssä** — the *Työn alla* Planner column (col 3, under Ohjelma), 60 s refresh
  (reuses the same `/api/tickets` fetch as the Uudet-tiketit panel).
  *(ilves26: was "Käynnissä olevat operaatiot" / SharePoint status buckets.)*
- **Päivän ohjelma** — today's whole-camp events (nyt/seuraava), embedded snapshot +
  optional live `kaiku2026.fi/api/schedules`.
- **Työvuorossa nyt** — current 1./2. shift from `Operaatiokeskuksen työvuorolista.xlsx`
  (embedded), carried forward to now; overnight falls back to previous evening.
  "Operaatiokeskuksen päiväpalaveri" pinned to **16:00** every day.
- **Pääuutiset** — live from `api.ww-api.com/front/get_items/4554399/78074354/`
  (section 78074354 = Pääuutiset), 5-article embedded fallback.
- **Tiketit** — 🎫 header button opens a Kaiku popup modal of the **full board (all status
  columns grouped)**, refreshed every 60 s from the `ticket-server`.

### Ticket server (`ticket-server/`, Node + Express + Playwright)
- Opens a login window to the SharePoint Tiketin site; session persisted in `.auth`.
- Reads **all tickets** from the *Opke/Ospa* list (referenced by URL
  `/sites/Tiketin/Lists/OpkeOspa`, not the GUID) every 60 s, groups them by the `Status`
  field into the 7 status buckets, and picks display fields by their SharePoint column titles.
- Extraction uses **`context.request`** (carries the logged-in cookies; immune to tab
  navigation), with a server-owned background page as fallback. This replaced the earlier
  `page.evaluate`-in-a-visible-tab approach, which broke on SPA navigation / tab switches.
- Serves CORS-open `GET /api/tickets` → `{status, buckets, uusi, count}` (+ `/api/health`)
  and a Kaiku all-statuses board at `/`.
- Also serves `GET /api/form` → `{status, entries}` — the **3 latest** responses from the
  *Osallistujaviestintä* Excel workbook (site `UudenmaanPiirileiri2026`, referenced by its
  sourcedoc GUID via `GetFileById`). Downloads the `.xlsx` binary with `context.request` and
  parses it in-process with a **dependency-free zip + OOXML reader** (`unzip`/`parseSheet`/
  `parseSharedStrings`/`parseStyles`/`extractForm`), detecting the date column from `styles.xml`
  and mapping columns to who/subject/message/extras by header. Refreshed every 60 s (live).
  The startup is guarded by `require.main === module` so the parser can be unit-tested without
  launching Playwright (`module.exports` exposes the helpers).
- **Cross-site-collection auth fix (c2b63d8):** the workbook is on a *different* site collection
  than the Tiketin login, and SharePoint's `FedAuth` cookie is per site collection — so the first
  version silently returned empty. `ensureFormPage` now warms `FORM_SITE` with a real page visit
  (SSO handshake), and the download rejects `text/html` + verifies the zip magic `PK\x03\x04`
  (an unauth SharePoint request returns the sign-in HTML with HTTP 200). See gotchas below.
- **Needs live verification** against a logged-in SharePoint session (restart the server to
  load new code). Verified locally: syntax, endpoints, `awaiting-login` fallback; REST list
  paths return 403 unauth (valid).

### Design
- Kaiku 2026 V1 identity throughout (Bricolage Grotesque; metsä/savu + punainen/oranssi/
  kulta). Kaiku-1 gradient header edge (replaced the disliked stretched aaltoviiva — do not re-add).
- **Anti-"vibe-coded" polish pass:** replaced the per-card rainbow top-stripe with a disciplined
  4-role colour system (kulta=camp heartbeat, meri=environment, punainen=attention, metsä=
  structural), plain white cards with a hairline + soft shadow, and a curated inline-SVG icon
  set (sprite of `<symbol>`s + `mi()` helper) replacing emoji chrome. Emoji kept only as data
  glyphs (weather symbols, schedule category markers). Solid-gold progress bar.
- **Second pass (brand-icon fidelity):** icons rebuilt in the Kaiku **"Symboli" idiom** — solid
  accent-colour **circular** header chips with **bold rounded** marks (not thin generic lines).
  **Removed the "LIVE" indicators entirely** (header badge + the news "● Live" dot) — they read
  vibe-coded; liveness = the ticking clock + "Päivitetty HH.MM" per card. Schedule recoloured
  **by state** (now=punainen / next=kulta / neutral) with a clean left-border, which also fixed
  the notched corners and stopped it from mixing Kaiku-1 & Kaiku-2 colours (a brand no-no).
  Fire banner uses `#i-flame` / `#i-shield` instead of 🔥/✅.

## Key decisions / gotchas
- **SharePoint can't be read from the browser directly** — `Access-Control-Allow-Origin: *`
  without `Access-Control-Allow-Credentials` blocks the auth cookie cross-origin, and the
  list page sets `X-Frame-Options` (no iframe). Hence the separate `ticket-server`.
- **SharePoint `FedAuth` is per SITE COLLECTION**, not tenant-wide — one login does not authorize
  another site collection's files. Warm each site collection with a real page visit first.
- **An unauthenticated SharePoint request returns the sign-in HTML with HTTP 200**, not a 401 —
  binary downloads must reject `text/html` and verify the xlsx zip magic, or a login page parses
  to an empty (but "ok") result.
- **kuosi pattern** must use a wide viewBox (`0 0 1920 220`) or it scales ~5× on a TV.
- Preview screenshots render at ~½ size here due to devicePixelRatio 2 — trust DOM
  measurements over screenshots.

## Possible next steps
- Auto-launch `ticket-server` on the TV machine at boot (e.g. `pm2` / a login item).
- Optional: run the server headless after the first login (`HEADLESS=1`) once `.auth` is warm.
- Wire live `kaiku2026.fi/api/schedules` if/when CORS allows, instead of the snapshot.
- Refresh embedded snapshots (news/schedule/shifts) if the source data changes.
