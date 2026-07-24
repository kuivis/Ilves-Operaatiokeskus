'use strict';
/*
 * ilves26 Operaatiokeskus · Tehtävä-palvelin (Microsoft Planner, DOM-scrape)
 * -------------------------------------------------------------------------
 * Avaa Planner-taulun selainikkunassa, jossa kirjaudut kerran Microsoft-
 * tunnuksilla. Sen jälkeen palvelin lukee 60 s välein taulun tehtävät suoraan
 * renderöidystä sivusta (kirjautuneen istunnon näkymästä) ja tarjoaa ne
 * CORS-avoimena JSON:ina + ilves-tyylisenä taulusivuna.
 *
 * Ei Graph-tokeneita: luetaan mitä käyttäjä näkee taululla. Sarakkeet ja
 * tehtäväkortit tunnistetaan niiden aria-labelien perusteella.
 *
 * Käyttö:  npm install  &&  npm start
 * Ympäristö:  PORT=8137   PLAN_ID=<plan>   HEADLESS=1 (vaatii valmiin .auth-istunnon)
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8137);
const HEADLESS = process.env.HEADLESS === '1';
const USER_DATA_DIR = path.join(__dirname, '.auth');
// Kirjautumisen istuntoevästeet (mm. Microsoftin ESTSAUTH) elävät vain muistissa
// eivätkä tallennu persistent-profiiliin. Kirjoitetaan koko storage-tila tänne
// jokaisen onnistuneen luvun jälkeen ja palautetaan käynnistyksessä, jottei
// kirjautumista tarvitse tehdä uudelleen joka npm start -kerralla.
const STATE_FILE = path.join(USER_DATA_DIR, 'storage-state.json');

// --- Planner-taulu (Operaatiokeskus tehtävät) ---
const PLAN_ID = process.env.PLAN_ID || 'w2Y2pqVlOkKDXrV2TiaYxJYAF5oR';
const PLANNER_URL = `https://planner.cloud.microsoft/webui/plan/${PLAN_ID}/view/board`;
// Panelointi: "Uudet tehtävät" → Uudet tiketit, "Työn alla" → Käsittelyssä.
const NEW_BUCKET = 'Uudet tehtävät';
// Sarakejärjestys näyttöä varten (tuntemattomat loppuun aakkosjärjestyksessä).
const BUCKET_ORDER = ['Uudet tehtävät', 'Työn alla', 'Valmiit', 'Valmis', 'Tehty', 'Done'];

// --- palvelimen tila (välimuisti dashboardille) ---
const state = { status: 'starting', buckets: [], uusi: [], count: 0, updatedAt: null, error: null, diag: null };
let debugInfo = { addButtons: [], taskCards: 0, url: '', sampleLabels: [] };
let context = null;
let plannerPage = null;
let firstPoll = true;

// Lyhyt vakaa id otsikosta (näyttöä varten, esim. #A1B2)
function shortId(s) {
  let h = 0; const str = String(s);
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return h.toString(36).toUpperCase().slice(-4).padStart(4, '0');
}
function mapScraped(title, bucketName) {
  return {
    id: shortId(bucketName + '|' + title), status: bucketName, title: String(title).trim(),
    desc: '', location: '', reporter: '', topic: '', safety: false, created: null, order: ''
  };
}
// Rakenna dashboardin bucket-rakenne scrapatuista sarakkeista.
function buildBuckets(columns) {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const ordered = BUCKET_ORDER.filter((n) => byName.has(n));
  const rest = columns.map((c) => c.name).filter((n) => !BUCKET_ORDER.includes(n));
  return [...ordered, ...rest].map((name) => {
    const titles = (byName.get(name) || { titles: [] }).titles;
    return { name, count: titles.length, tickets: titles.map((t) => mapScraped(t, name)) };
  });
}

// --- Taulun luku renderöidystä sivusta ---
// Sarakkeet tunnistetaan niiden otsikko-aria-labelista ("Column {nimi}, …" / "Sarake {nimi}, …")
// ja kunkin sarakkeen kortit sen sisältä ("Task {otsikko}" / "Tehtävä {otsikko}"). Toimii FI + EN.
// (Aiemmin luettiin "lisää tehtäväkortti" -painikkeista, mutta Planner muutti niiden labelin
//  muotoon "Add task card in {nimi} column" — sarakeotsikko on vakaampi ankkuri.)
async function scrapeBoard(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const all = [...document.querySelectorAll('[aria-label]')];
    // Sarakeotsikko: "Column Uudet tehtävät, Use Ctrl+…" (EN) / "Sarake Uudet tehtävät, …" (FI).
    const colRe = /^(?:column|sarake)\s+(.+?)\s*(?:,|$)/i;
    // Lisää-kortti-painike (vain diagnostiikkaan / renderöitymisen odotukseen). Useita muotoja:
    //  "Add task card in {nimi} column", "Add task to bucket {nimi}", "Lisää tehtäväkortti sarakkeeseen {nimi}".
    const addPrefix = /(lisää tehtäväkortti|add task|add card|new task)/i;
    const taskRe = /^(?:tehtävä|task)\s+(.+)$/i;                                        // "Task {otsikko}"

    const addButtons = all
      .map((e) => norm(e.getAttribute('aria-label')))
      .filter((l) => addPrefix.test(l));

    // Kullekin sarakeotsikolle: etsi kontti = suurin esi-isä, jossa on täsmälleen tämä yksi
    // sarakeotsikko, ja kerää sen sisältä tehtäväkortit.
    const isCol = (e) => colRe.test(norm(e.getAttribute('aria-label')));
    const columns = [];
    for (const h of all) {
      if (!isCol(h)) continue;
      const name = norm(colRe.exec(norm(h.getAttribute('aria-label')))[1]);
      if (!name || columns.some((c) => c.name === name)) continue;
      let best = h.parentElement, node = h.parentElement;
      while (node && node !== document.body) {
        const heads = [...node.querySelectorAll('[aria-label]')].filter(isCol).length;
        if (heads === 1) best = node; else if (heads > 1) break;
        node = node.parentElement;
      }
      const titles = [];
      for (const e of (best || h.parentElement).querySelectorAll('[aria-label]')) {
        const m = taskRe.exec(norm(e.getAttribute('aria-label')));
        if (m) { const t = norm(m[1]); if (t && !titles.includes(t)) titles.push(t); }
      }
      columns.push({ name, titles });
    }
    const taskCards = all.filter((e) => taskRe.test(norm(e.getAttribute('aria-label')))).length;
    const sampleLabels = [...new Set(all.map((e) => norm(e.getAttribute('aria-label'))).filter(Boolean))].slice(0, 40);
    return { columns, addButtons, taskCards, url: location.href, sampleLabels };
  });
}

async function poll() {
  if (!context || !plannerPage) return;
  try {
    // Päivitä sivu joka kierros (60 s), jotta taulu näyttää tuoreen tilan.
    if (!firstPoll) await plannerPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    firstPoll = false;
    // Odota että taulu renderöityy (sarakeotsikko tai add-painike ilmestyy), sitten pieni asettuminen.
    await plannerPage.waitForSelector('[aria-label]', { timeout: 30000 }).catch(() => {});
    await plannerPage.waitForFunction(
      () => [...document.querySelectorAll('[aria-label]')].some((e) => /(^(?:column|sarake)\s|lisää tehtäväkortti|add task|add card)/i.test(e.getAttribute('aria-label') || '')),
      { timeout: 30000 }
    ).catch(() => {});
    await plannerPage.waitForTimeout(1500).catch(() => {});

    const res = await scrapeBoard(plannerPage);
    debugInfo = { addButtons: res.addButtons, taskCards: res.taskCards, url: res.url, sampleLabels: res.sampleLabels };

    if (!res.columns.length) {
      // Ei sarakkeita → todennäk. kirjautuminen kesken tai näkymä ei latautunut.
      const loggedOut = /login\.microsoft|signin|\/oauth2|login\.live/i.test(res.url);
      state.status = 'awaiting-login'; state.error = null;
      state.diag = `ei sarakkeita luettu (${loggedOut ? 'kirjautuminen kesken' : 'taulu ei renderöitynyt?'}) — url: ${res.url.slice(0, 60)}`;
      console.log('[planner] ' + state.diag); return;
    }
    state.buckets = buildBuckets(res.columns);
    state.uusi = (state.buckets.find((b) => b.name === NEW_BUCKET) || { tickets: [] }).tickets;
    state.count = state.buckets.reduce((n, b) => n + b.count, 0);
    state.status = 'ok'; state.updatedAt = new Date().toISOString(); state.error = null;
    state.diag = `ok — ${state.count} tehtävää, sarakkeet: ${res.columns.map((c) => `${c.name}(${c.titles.length})`).join(', ')}`;
    console.log(`[planner] ${new Date().toLocaleTimeString('fi-FI')} — ${state.count} tehtävää (Uudet: ${state.uusi.length})`);
    // Talleta tuore istuntotila (evästeet + localStorage) levylle, jotta kirjautuminen
    // säilyy myös uudelleenkäynnistyksen yli — myös istuntoevästeet, joita profiili ei tallenna.
    try { await context.storageState({ path: STATE_FILE }); }
    catch (e) { console.log('[auth] tilan tallennus epäonnistui:', (e && e.message) || e); }
  } catch (e) {
    state.status = 'error'; state.error = String((e && e.message) || e);
    console.log('[planner] virhe:', state.error);
  }
}

// --- HTTP-palvelin ---
const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/api/tickets', (_req, res) => res.json({
  status: state.status, updatedAt: state.updatedAt, count: state.count,
  buckets: state.buckets, uusi: state.uusi, tickets: state.uusi, error: state.error, diag: state.diag
}));
app.get('/api/health', (_req, res) => res.json({
  status: state.status, updatedAt: state.updatedAt, count: state.count, uusi: state.uusi.length, diag: state.diag, planId: PLAN_ID
}));
// Diagnostiikka: mitä sivulta luettiin (auttaa jos scrape ei löydä tehtäviä)
app.get('/api/debug', (_req, res) => res.json({
  status: state.status, planId: PLAN_ID, diag: state.diag,
  addButtons: debugInfo.addButtons, taskCards: debugInfo.taskCards, url: debugInfo.url,
  buckets: state.buckets.map((b) => ({ name: b.name, count: b.count, titles: b.tickets.map((t) => t.title) })),
  sampleLabels: debugInfo.sampleLabels
}));
app.use(express.static(path.join(__dirname, 'public')));

const start = async () => {
  console.log('Käynnistetään tehtävä-palvelin (Microsoft Planner, scrape)…');
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-first-run']
  });
  // Palauta aiemmin talletetut evästeet (myös istuntoevästeet) ennen navigointia.
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.cookies && saved.cookies.length) {
        await context.addCookies(saved.cookies);
        console.log(`[auth] palautettiin ${saved.cookies.length} evästettä (${STATE_FILE})`);
      }
    }
  } catch (e) { console.log('[auth] tilan palautus epäonnistui:', (e && e.message) || e); }

  plannerPage = context.pages()[0] || await context.newPage();
  await plannerPage.goto(PLANNER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  if (!HEADLESS) { try { await plannerPage.bringToFront(); } catch (_) {} }
  context.on('close', () => { console.log('Selain suljettiin — käynnistä palvelin uudelleen (npm start).'); process.exit(0); });

  app.listen(PORT, () => {
    console.log(`\n  Tehtävä-palvelin:  http://localhost:${PORT}`);
    console.log(`  JSON-rajapinta:    http://localhost:${PORT}/api/tickets`);
    console.log(`  Diagnostiikka:     http://localhost:${PORT}/api/health  ·  /api/debug`);
    console.log(`  → Kirjaudu avautuneessa Planner-ikkunassa Microsoft-tunnuksilla.\n`);
  });

  await poll();
  setInterval(poll, 60000); // 60 s

  const shutdown = async () => { try { await context.close(); } catch (_) {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

// Käynnistä vain suorana ajona; require() (testit) saa apufunktiot ilman selainta.
if (require.main === module) start().catch((e) => { console.error('Palvelin ei käynnistynyt:', e); process.exit(1); });
module.exports = { shortId, mapScraped, buildBuckets };
