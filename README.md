# ilves26 · Operaatiokeskus

A single-page TV dashboard for the **ilves26** scout camp operations centre
(*operaatiokeskus*) — **Hämeen Partiopiirin leiri, Evo 23.–31.7.2026** — built in the
**ilves26** visual identity (Brändiopas v0.2). Everything lives in one self-contained
`index.html` (HTML + CSS + vanilla JS, no build step) sized for a 1920×1080 TV.

> **This is a fork of [Operaatiokeskus](https://github.com/samvaol/operaatiokeskus)**,
> re-skinned to the ilves26 brand. The dashboard structure and the `ticket-server` are
> unchanged; the visual identity (colours, typography, logo, wave, camp dates) is ilves26.
>
> **Brand:** red `#CE5738`, green `#80884f`, gold `#D39C2F`, black `#101010`, cream
> `#F5F1E8`; type **Nunito** (headings) + **Jost** (body); logos in [`assets/`](assets/).
>
> **Data sources:** weather/radar (Evo), **news** (ilves26 app — Tiedotteet + Ilves NYT) and
> the **schedule** (ilves26 app *Aikataulu*, showing **Havus → Vaeltaja/Aikuinen**) are all
> live from ilves26. Only **tickets/Osallistujaviestintä** still point at Kaiku's SharePoint via
> the `ticket-server` — repoint those for the real ilves26 deployment (see `CLAUDE.md`). A
> Microsoft Planner/Teams board is a candidate future source for tasks.

## Panels

- **Tervehdys + kello** — time-of-day greeting, live clock, and an animated "kaiku"
  equalizer / LIVE indicator.
- **Leirikello** — elapsed camp time since 10.7.2026 09:00 with a progress bar to 18.7.
  A **confetti burst + "Leiri N % takana!"** fires each time the camp advances a whole percent.
- **Sää · Evo, Hämeenlinna** — live forecast from the Finnish Meteorological Institute
  (Ilmatieteen laitos), including the forest-fire warning (*metsäpalovaroitus*).
- **Sadetutka · Evo** — live FMI weather radar (Leaflet map) centred on Evo, refreshed every 5 min.
- **Päivän ohjelma** — today's whole-camp programme with *nyt* / *seuraava* markers.
- **Työvuorossa nyt** — who is on shift right now (from the työvuorolista).
- **Uudet tiketit** — the "Uusi" SharePoint tickets, always on screen, refreshed every 60 s.
- **Käynnissä olevat operaatiot** — the "Käsittelyssä operaatiokeskuksessa" tickets, refreshed every 60 s.
- **Pääuutiset** — the latest articles from the Kaiku 2026 app.
- **Osallistujaviestintä** — the three latest entries from the participant-messaging form
  (a SharePoint Excel workbook), refreshed live every 60 s via the `ticket-server`.
- **Tiketit** (🎫 button) — a popup of the full board, **all status columns** grouped.

## Data sources

| Panel | Source |
|-------|--------|
| Weather + forest-fire | Ilmatieteen laitos open data (WFS) |
| Sadetutka (radar) | FMI radar WMS (`Radar:suomi_dbz_eureffin`) + Leaflet/CARTO base |
| Pääuutiset | Kaiku 2026 app content API (Corego / GoodBarber) |
| Päivän ohjelma | Leirilukkari camp schedule + embedded snapshot |
| Työvuorot | `Operaatiokeskuksen työvuorolista.xlsx` (embedded) |
| Tiketit (kaikki tilat) | SharePoint list *Opke/Ospa*, all statuses, via the local `ticket-server` |
| Osallistujaviestintä | SharePoint Excel workbook *Osallistujaviestintä.xlsx*, 3 latest rows, via the local `ticket-server` |

Each source has an embedded fallback so the dashboard keeps working offline.

## Tickets — the `ticket-server`

A browser cannot read the SharePoint list directly: SharePoint returns
`Access-Control-Allow-Origin: *` **without** `Access-Control-Allow-Credentials`, so it
won't accept the login cookie cross-origin. The [`ticket-server/`](ticket-server/)
folder solves this with a small Node backend:

1. On start it opens a **browser window to the Tiketin site — you log in once** with your
   partio account (the session is saved to `ticket-server/.auth`, so you don't log in
   again next time).
2. It then reads **all tickets** from the *Opke/Ospa* list every **60 s** and groups them
   by status (Uusi, Käsittelemättömät, … Valmis), by calling the SharePoint REST API with
   Playwright's `context.request` (which carries the logged-in cookies — immune to which
   browser tab is open).
3. It serves them CORS-open at `http://localhost:8137/api/tickets` (`{status, buckets,
   uusi, …}`), plus a Kaiku-styled **all-statuses board** at `http://localhost:8137/`.

It also downloads the **Osallistujaviestintä** Excel workbook (on the
`UudenmaanPiirileiri2026` site — the same partio login covers the whole tenant), parses it
in-process (no dependencies — a small zip + OOXML reader), and serves the **three latest
form responses** at `http://localhost:8137/api/form` (`{status, entries, …}`), refreshed
every 60 s. Override the workbook with the `FORM_DOC_ID` env var if the file changes.

The dashboard's 🎫 **Tiketit** popup reads that endpoint (override with
`?ticketApi=http://HOST:8137/api/tickets`). If the server is down, the popup says so; if
you haven't logged in yet, it says "Kirjaudu tiketti-palvelimen ikkunassa".

```bash
cd ticket-server
npm install      # installs Express + Playwright (downloads Chromium once)
npm start        # opens the login window, then serves on :8137
```

Never commit `ticket-server/.auth` — it holds your login session (already git-ignored).

## Run it

The dashboard itself is a static file — any file server works:

```bash
python3 -m http.server 8133   # then open http://localhost:8133
```

On the TV, open `index.html` and go full-screen (F11). Run the `ticket-server` alongside
it (on the same machine) so the Tiketit popup can reach `localhost:8137`.

## Installing Node.js quickly on Windows

The `ticket-server` needs Node.js (v18+). Fastest ways on Windows:

**Option A — winget (built into Windows 10/11), one command in PowerShell:**

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen the terminal, then check it worked:

```powershell
node -v
npm -v
```

**Option B — installer:** download the **LTS** `.msi` from <https://nodejs.org/en/download>,
run it, and keep the default options (this also installs `npm`).

Then run the ticket-server:

```powershell
cd ticket-server
npm install
npm start
```

## Visual identity

Kaiku 2026 V1 — Bricolage Grotesque, metsä `#005448`, savu `#F9F3E6`, and the
punainen / oranssi / kulta accent trio. Each panel is colour-coded with a Kaiku accent.
