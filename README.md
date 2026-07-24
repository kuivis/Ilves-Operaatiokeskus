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
> **Data sources (all ilves26):** weather/radar (Evo); **news** (ilves26 app — Tiedotteet +
> Ilves NYT); the **schedule** (ilves26 app *Aikataulu* `ICS_BUNDLE`, **embedded** — showing
> **Havus → Vaeltaja/Aikuinen**); and **tickets** from a **Microsoft Planner** board via the
> `ticket-server` (**Uudet tiketit** ← *Uudet tehtävät* column, **Käsittelyssä** ← *Työn alla*).
> The Osallistujaviestintä panel was removed. See `CLAUDE.md` for details.

## Panels

- **Tervehdys + kello** — time-of-day greeting, live clock, and an animated "kaiku"
  equalizer / LIVE indicator.
- **Leirikello** — elapsed camp time since 10.7.2026 09:00 with a progress bar to 18.7.
  A **confetti burst + "Leiri N % takana!"** fires each time the camp advances a whole percent.
- **Sää · Evo, Hämeenlinna** — live forecast from the Finnish Meteorological Institute
  (Ilmatieteen laitos), including the forest-fire warning (*metsäpalovaroitus*).
- **Sadetutka · Evo** — live FMI weather radar (Leaflet map) centred on Evo, refreshed every 5 min.
- **Päivän ohjelma** — today's whole-camp programme with *nyt* / *seuraava* markers.
- **Työvuorossa tänään** — daily shift schedule (aamu, päivä, ilta, yö) with real-time active shift highlighting (`NYT`).
- **Uudet tiketit** — the **Uudet tehtävät** Planner column, always on screen, refreshed every 60 s.
- **Käsittelyssä** — the **Työn alla** Planner column, refreshed every 60 s.
- **Uutiset** — the latest articles from the ilves26 app (Tiedotteet + Ilves NYT).
- **Tehtävät** (🎫 button) — a popup of the full Planner board, **all columns** grouped.

## Data sources

| Panel | Source |
|-------|--------|
| Weather + forest-fire | Ilmatieteen laitos open data (WFS) |
| Sadetutka (radar) | FMI radar WMS (`Radar:suomi_dbz_eureffin`) + Leaflet/CARTO base |
| Uutiset | ilves26 app content API (Corego / GoodBarber) — Tiedotteet + Ilves NYT |
| Päivän ohjelma | ilves26 app *Aikataulu* `ICS_BUNDLE` (embedded) — Havus → Vaeltaja/Aikuinen |
| Työvuorot | `DUTY_SHIFTS` dataset embedded in `index.html` (23.–31.7.2026 shifts) |
| Tehtävät (Uudet tiketit / Käsittelyssä) | **Microsoft Planner** board, via the local `ticket-server` |

## Tickets — the `ticket-server` (Microsoft Planner)

Tickets come from a **Microsoft Planner** board (*Operaatiokeskus tehtävät*). The
[`ticket-server/`](ticket-server/) folder is a small Node backend that reads it:

1. On start it opens a **browser window to the Planner board — you log in once** with your
   Microsoft account (the session is saved to `ticket-server/.auth`, so you don't log in
   again next time).
2. It then reads the plan's **tasks + buckets** every **60 s** via **Microsoft Graph**
   (`/planner/plans/{planId}/tasks` + `/buckets`), authenticated with the Graph access token
   from the logged-in session's MSAL cache, and groups tasks by their Planner column.
3. It serves them CORS-open at `http://localhost:8137/api/tickets` (`{status, buckets,
   uusi, …}`; **`uusi` = the *Uudet tehtävät* column**), plus an ilves-styled **board** at
   `http://localhost:8137/`. Diagnostics at `http://localhost:8137/api/health`.

The dashboard's **Uudet tiketit** panel shows *Uudet tehtävät*, **Käsittelyssä** shows *Työn
alla*, and the 🎫 popup shows the full board. Override the plan with `PLAN_ID=<id>` and the
API host with `?ticketApi=http://HOST:8137/api/tickets`.

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
