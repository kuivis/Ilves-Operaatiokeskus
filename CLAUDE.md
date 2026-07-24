# ilves26 · Operaatiokeskus — project guide

A single-page **TV dashboard** for the **ilves26** scout-camp operations centre (Hämeen
Partiopiirin leiri, **Evo 23.–31.7.2026**), plus a small **Node ticket-server** that feeds it
**Microsoft Planner** tickets. Everything is Finnish-first and uses the **ilves26** visual identity
(Brändiopas v0.2).

> **Fork of `samvaol/operaatiokeskus`** re-skinned to ilves26. Structure, data logic and the
> `ticket-server` are unchanged from upstream — only the visual identity differs.

## ilves26 visual identity (overrides the palette/type notes below)
- **Colours (only these — no blue):** red `#CE5738` (signature / header / attention),
  green `#80884f` (structural) + deep `#414a2c` for dark cards, gold `#D39C2F` (camp
  heartbeat / hero), cream `#F5F1E8` (bg), black `#101010`. Same 4-role discipline as
  upstream: `--kulta`=heartbeat, `--punainen`=attention, `--metsa`/green=structural,
  environment folds into green (no blue in the brand).
- **Type:** **Nunito** for headings/display/UI (900 *italic* for the greeting — the brand's
  signature black-italic voice); **Jost** for body/reading text (`--body`). Both from Google
  Fonts.
- **Logo:** `assets/ilves26-logo-valk.svg` (forest-badge mark + white "ilves26" wordmark) in
  the header; other cuts in `assets/`. **Header** is solid red with faint tree silhouettes and
  a cream **scalloped wave** bottom edge (the brand aaltoviiva) — this is wanted here (unlike
  upstream, where the header wave was removed).
- **Camp dates:** `CAMP_START`/`CAMP_END` = 23.–31.7.2026 (Evo).
- **Data sources (ilves26):**
  - **News** = ilves26 GoodBarber app (`api.ww-api.com/front/get_items/4406427/<section>/`),
    merging **Tiedotteet** `75180339` + **Ilves NYT** `77682659` (sorted newest-first).
  - **Schedule** = the app's **Aikataulu** plugin `ICS_BUNDLE` (section `78357980`; all 9 per-feed
    `.ics` strings, 162 events) **embedded directly** into `index.html` as `SCHED_ICS_EMBED` — no
    network fetch, no CORS dependency (a snapshot from the saved `Ilves26.html` app copy). At load
    we pick `${SCHED_AGE}-${SCHED_CAMP}.ics` (or `${SCHED_AGE}.ics` when the age isn't split by
    subcamp) **+ `yleiset.ics`** and parse the simple UTC VEVENTs (no RRULE/all-day/TZID → tiny
    parser). Config near the top of the schedule code: `SCHED_AGE='vaeltaja-aikuinen'`,
    `SCHED_CAMP='havus'` — change to show a different ikäkausi/alaleiri (all feeds are embedded).
    **To refresh** when the camp updates the schedule, re-embed `ICS_BUNDLE` from the plugin
    (`…/section/78357980/index.html`) or a fresh app-page save.
  - **Tickets** = a **Microsoft Planner** board (*Operaatiokeskus tehtävät*, plan
    `w2Y2pqVlOkKDXrV2TiaYxJYAF5oR`) via the `ticket-server` (see below). **Uudet tiketit** ←
    *Uudet tehtävät* column, **Käsittelyssä** ← *Työn alla* column. The Osallistujaviestintä
    panel was removed.

## ⚠️ Read first
- The dashboard is **one self-contained `index.html`** — HTML + CSS + vanilla JS, **no
  build step, no framework, no dependencies**. Keep it that way. Edit the file directly.
- It targets a **1920×1080 TV**. Sizing is rem-based via `html{font-size:clamp(9px,calc(.42vw+.60vh),24px)}`
  — size things in `rem`, not `px`.
- **Bilingual context but UI is Finnish.** Match the surrounding Finnish copy.

## Structure
```
index.html              # the whole dashboard (styles + markup + script in one file)
README.md               # user-facing setup (incl. Node-on-Windows)
progress.md             # running dev log
ticket-server/
  server.js             # Express + Playwright: login → read all tickets (grouped) → serve JSON
  public/index.html     # Kaiku-styled all-statuses ticket board served by the server
  package.json          # express + playwright
  .gitignore            # node_modules/ .auth/   (NEVER commit .auth — login session)
```

## Data sources (all reached from the browser except tickets)
- **Weather + forest-fire**: FMI WFS `fmi::forecast::edited::weather::scandinavia::point::timevaluepair`,
  `latlon=61.208,25.128`, params incl. `SmartSymbol` (night = code+100) and `ForestFireWarning`
  (NaN/1 = none, ≥2 = active). CORS `*`.
- **Pääuutiset**: `https://api.ww-api.com/front/get_items/4554399/78074354/` → `{items:[…]}`,
  CORS `*`. Section **78074354 = Pääuutiset** (not the widget 78074355). Content URL discovered
  via `kaiku2026.coregoapp.com/apiv4/getSettings?platform=webapp`
  (`gbsettings.sections.<id>.contentSource.url`).
- **Sadetutka (radar)**: Leaflet map on `61.204934767500795,25.1210434592283`; FMI radar WMS
  `openwms.fmi.fi/geoserver/wms` layer `Radar:suomi_dbz_eureffin` (EPSG:3857, CORS `*`) over a
  CARTO light base. Leaflet loaded from unpkg CDN. `.radarwrap` uses `isolation:isolate` so
  Leaflet's z-index 200–700 panes don't paint over the ticket modal (z 900).
- **Schedule**: embedded whole-camp snapshot + optional live `kaiku2026.fi/api/schedules`
  (usually CORS-blocked → snapshot used).
- **Työvuorot**: embedded `WORKSHIFTS` object parsed from `Operaatiokeskuksen työvuorolista.xlsx`.
- **Tiketit**: from a **Microsoft Planner** board via the local `ticket-server` (see below).
  (The old SharePoint tickets + Osallistujaviestintä form were removed.)
- **Konfetti**: `tickTimer` fires `celebrate(pct)` (canvas confetti + toast) on each whole-percent
  advance of the camp progress; `#confetti`/`#celebrateToast` at z 1000/1100.

Every source has an **embedded fallback** so the dashboard never goes blank.

## Ticket server (Microsoft Planner — DOM scrape)
- The board (*Operaatiokeskus tehtävät*, `PLAN_ID=w2Y2pqVlOkKDXrV2TiaYxJYAF5oR`) is read by
  **scraping the rendered board** — no Graph/token. `planner.cloud.microsoft` doesn't cache a
  readable Graph token and reads its data from Microsoft's internal *taskmars* backend, so token/
  Graph approaches failed (`diag: "ei Graph-tokenia…"`). On start the Node server opens the **board
  in a visible Playwright window** (`plannerPage`) — you log in once (session persists in `.auth`).
- **`scrapeBoard(page)`** reads the DOM by **aria-labels** (works FI + EN): columns are anchored on
  the **column-header** label (`"Column {bucket}, Use Ctrl+Alt+…"` / `"Sarake {bucket}, …"`, regex
  `colRe`), and each column's container = the largest ancestor holding exactly that one header; task
  cards inside it are `aria-label="Task {title}"` (`"Tehtävä {title}"`, `taskRe`). **Note:** it used
  to key off the add-card button (`"Lisää tehtäväkortti sarakkeeseen {bucket}"`), but Planner renamed
  that label to `"Add task card in {bucket} column"` (name moved to the middle) — the header anchor is
  more stable, so the add-button is now only used for diagnostics + the render-wait. `buildBuckets`
  orders by `BUCKET_ORDER` (`Uudet tehtävät`, `Työn alla`, **`Valmiit`**, …); `mapScraped` → the
  ticket shape (`id` = short hash of the title; no priority/date from scraping).
- Each 60 s poll **reloads `plannerPage`**, waits for the board to render (`waitForFunction` on a
  column-header or add-card label, ~30 s), then scrapes. First poll skips the reload (`goto` just
  loaded it).
- Serves `GET /api/tickets` (CORS `*`) → `{status:'ok'|'awaiting-login'|'error', buckets:[…],
  uusi:[…], count, diag}`. **`uusi` = the `Uudet tehtävät` column.** Dashboard's Uudet-tiketit
  panel reads `j.uusi`; the **Käsittelyssä** panel (`opsFrom`) pulls the **`Työn alla`** column;
  the popup reads `j.buckets`. Override host with `?ticketApi=`, plan with env `PLAN_ID`.
- **Diagnose** via `GET /api/debug` (add-button labels found, task-card count, per-column titles,
  and a `sampleLabels` dump) + `[planner]` console lines. `awaiting-login` + "ei sarakkeita luettu"
  = login not finished / board didn't render / the aria-labels changed (check `sampleLabels` — that's
  how the header-anchor change above was diagnosed).
- **Login persistence:** the `.auth` **persistent profile** does *not* keep Microsoft's **session
  cookies** (they live in memory), and Planner in Playwright Chromium **doesn't show the "Pysytäänkö
  kirjautuneena?" (KMSI) prompt** that would make them persistent. So after each successful read the
  server writes the full `context.storageState()` (cookies **incl. session** + localStorage) to
  `.auth/storage-state.json`, and re-injects those cookies via `context.addCookies()` on startup
  (logs `[auth] palautettiin N evästettä`). Sign in once → later `npm start`s skip the login. The
  state is only saved on `status:'ok'`, so a failed scrape never overwrites a good session. Session
  cookies still expire eventually (hours–~day cold), so an occasional re-login is normal.
- Startup is guarded by `if (require.main === module) start()`; `module.exports` exposes
  `shortId`/`mapScraped`/`buildBuckets` for unit tests (no Playwright needed).
- Run: `cd ticket-server && npm install && npx playwright install chromium && npm start`.
  `HEADLESS=1` runs headless (only works once `.auth` is warm). Cross-platform (macOS/Windows) — the
  "Windows" bits are only the README's Node setup notes, since the TV is a Windows box. Session
  persists in `ticket-server/.auth` (git-ignored, secret — includes `storage-state.json`).

## Conventions
- **Visual identity**: Bricolage Grotesque; colors metsä `#005448`, meri `#00445E`, rusko
  `#542337`, savu `#F9F3E6`, punainen `#FF633A`, oranssi `#FF8940`, kulta `#FFAE40`.
- **Two colour groups that must NOT be mixed** (brand rule, PDF p.6): *Kaiku 1* =
  punainen/oranssi/kulta, *Kaiku 2* = magenta/laventeli/sininen. The dashboard uses **only
  Kaiku 1 + luonnonvärit** (metsä/meri/rusko/savu) — do **not** pull magenta/laventeli/sininen
  back in (an earlier per-category schedule palette wrongly did).
- **Colour carries meaning, it doesn't decorate** (deliberate anti-"vibe-coded" system):
  each `.card` sets a `--accent` from **four roles only** — `kulta` = the camp heartbeat
  (Leirikello), `meri` = environment (Sää, Sadetutka), `punainen` = needs attention (Uudet
  tiketit; also NYT + palovaroitus), `metsä` = structural/informational (everything else).
  Don't reintroduce a per-card rainbow. Cards are a plain white surface + `1px var(--line)`
  hairline + soft shadow — **no coloured top stripe**; the accent shows only in the header
  **icon chip** (and data). Text uses the `--ink`/`--ink-2`/`--ink-3` scale. The **schedule**
  is state-coloured, not category-coloured: left border + time go punainen (`.now`) / kulta
  (`.next`) / neutral, so it never rainbows.
- **Icons follow the Kaiku "Symboli" idiom**, NOT thin generic line icons: a curated inline-SVG
  set defined once as `<symbol>`s in a hidden sprite at the top of `<body>` (`#i-clock`,
  `#i-ticket`, `#i-weather`, `#i-radar`, `#i-agenda`, `#i-activity`, `#i-megaphone`, `#i-mail`,
  `#i-flame`, `#i-pin`/`#i-user`/`#i-tag`/`#i-swap`/`#i-shield`), referenced via `<use>`.
  Header chips are a **solid accent-colour circle** (`.card-h .ic`, `border-radius:50%`) with a
  **bold, rounded** mark (`stroke-width ~2.3`, round caps) — echoing the brand's round Symboli
  marks. JS meta rows use the `mi('name')` helper (thinner, `currentColor`). **No emoji as UI
  chrome**; the only emoji kept are genuine *data glyphs* — weather SmartSymbol + the per-event
  schedule category markers.
- **No "LIVE" / status-dot badges** — those read as vibe-coded. Liveness is shown by the ticking
  clock and per-card "Päivitetty HH.MM" timestamps, not a pulsing dot.
- The header has a **Kaiku-1 gradient edge** (`header::after`). The old stretched aaltoviiva
  was removed on purpose — **do not re-add the header wave.**
- The **kuosi** background SVG must use a wide viewBox (`0 0 1920 220`) or it scales ~5× too
  large on a TV.
- Comments explain *why*, in Finnish, matching the file.

## Verify
- Run a static server and open the dashboard: `python3 -m http.server 8133`.
- Preview **screenshots render at ~½ size** here (devicePixelRatio 2) — trust
  `getComputedStyle` / bounding-rect measurements over screenshots.
- Check `getElementById` targets still exist after edits; no console errors.

## Deploy / workflow
- Repo: <https://github.com/samvaol/operaatiokeskus> (branch `main`). Commit/push only when asked.
- No CI. The dashboard is static; the ticket-server runs on the TV's machine next to it.
