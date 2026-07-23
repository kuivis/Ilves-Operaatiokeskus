'use strict';
/*
 * ilves26 Operaatiokeskus · Tehtävä-palvelin (Microsoft Planner)
 * -------------------------------------------------------------
 * Avaa Planner-taulun selainikkunassa, jossa kirjaudut kerran Microsoft-
 * tunnuksilla. Sen jälkeen palvelin lukee 60 s välein taulun tehtävät
 * Microsoft Graphista kirjautuneen istunnon tokenilla, ryhmittelee ne
 * Planner-sarakkeisiin ja tarjoaa ne CORS-avoimena JSON:ina + ilves-
 * tyylisenä taulusivuna.
 *
 * Token luetaan selaimen MSAL-välimuistista (Graph-scope) ja Graph-kutsut
 * tehdään Playwrightin context.request-rajapinnalla (Node-puolella, ei CORSia).
 *
 * Käyttö:  npm install  &&  npm start
 * Ympäristö:  PORT=8137   PLAN_ID=<plan>   HEADLESS=1 (vaatii valmiin .auth-istunnon)
 */
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 8137);
const HEADLESS = process.env.HEADLESS === '1';
const USER_DATA_DIR = path.join(__dirname, '.auth');

// --- Planner-taulu (Operaatiokeskus tehtävät) ---
const PLAN_ID = process.env.PLAN_ID || 'w2Y2pqVlOkKDXrV2TiaYxJYAF5oR';
const PLANNER_URL = `https://planner.cloud.microsoft/webui/plan/${PLAN_ID}/view/board`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
// Panelointi: "Uudet tehtävät" → Uudet tiketit, "Työn alla" → Käsittelyssä.
const NEW_BUCKET = 'Uudet tehtävät';
// Sarakejärjestys näyttöä varten (tuntemattomat sarakkeet loppuun aakkosjärjestyksessä).
const BUCKET_ORDER = ['Uudet tehtävät', 'Työn alla', 'Valmis', 'Tehty', 'Done'];

// --- palvelimen tila (välimuisti dashboardille) ---
const state = { status: 'starting', buckets: [], uusi: [], count: 0, updatedAt: null, error: null, diag: null };
let context = null;
let plannerPage = null;

// --- Graph-token kirjautuneen istunnon MSAL-välimuistista ---
// Etsitään AccessToken-credential, jonka scope viittaa Planner-lukuun
// (group.*, tasks.*, .default). Palautetaan { token, exp, target }.
async function getGraphToken(page) {
  return page.evaluate(() => {
    const wanted = /(^|[ .])(group|tasks|planner)\.|\.default/i; // Planner-luku vaatii Group/Tasks-scopet
    let best = null;
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i); const v = store.getItem(k);
        if (!v || v[0] !== '{') continue;
        let o; try { o = JSON.parse(v); } catch (e) { continue; }
        if (!o || !/AccessToken/i.test(o.credentialType || '') || !o.secret) continue;
        const target = String(o.target || '');
        // Vain Graph-tokenit (Planner-scopet). Ohita mars/muut resurssit.
        if (!wanted.test(target)) continue;
        const exp = Number(o.expiresOn || o.extendedExpiresOn || 0);
        if (!best || exp > best.exp) best = { token: o.secret, exp, target };
      }
    }
    return best;
  });
}

async function graphGet(token, urlPath) {
  const r = await context.request.get(GRAPH + urlPath, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, timeout: 20000
  });
  const status = r.status();
  return { status, ok: status >= 200 && status < 300, json: (status >= 200 && status < 300) ? await r.json().catch(() => null) : null };
}

// Planner-tehtävä → tiketti-muoto, jota dashboard odottaa.
function mapTask(t, bucketName) {
  const shortId = String(t.id || '').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
  return {
    id: shortId || '—',
    status: bucketName,
    title: String(t.title || '(nimetön tehtävä)').trim(),
    desc: '',
    location: '',
    reporter: '',
    topic: '',
    safety: Number(t.priority) > 0 && Number(t.priority) <= 3, // Planner-prioriteetti: pieni = kiireellinen
    created: t.createdDateTime || null,
    due: t.dueDateTime || null,
    percent: typeof t.percentComplete === 'number' ? t.percentComplete : null,
    order: t.orderHint || ''
  };
}

// Ryhmittele tehtävät sarakkeittain (bucketId → nimi), BUCKET_ORDER edellä.
function groupByBucket(tasks, bucketMap) {
  const by = new Map();
  for (const t of tasks) {
    const name = bucketMap[t.bucketId] || 'Muu';
    if (!by.has(name)) by.set(name, []);
    by.get(name).push(mapTask(t, name));
  }
  const ordered = BUCKET_ORDER.filter((n) => by.has(n));
  const rest = [...by.keys()].filter((n) => !BUCKET_ORDER.includes(n)).sort();
  return [...ordered, ...rest].map((name) => {
    const list = (by.get(name) || []).sort((a, b) => String(a.order).localeCompare(String(b.order)));
    return { name, count: list.length, tickets: list };
  });
}

async function poll() {
  if (!context || !plannerPage) return;
  try {
    // 1) Graph-token kirjautuneesta istunnosta
    const tok = await getGraphToken(plannerPage).catch(() => null);
    if (!tok || !tok.token) {
      state.status = 'awaiting-login'; state.error = null; state.diag = 'ei Graph-tokenia MSAL-välimuistissa';
      console.log('[planner] ei Graph-tokenia — kirjaudu avautuneessa Planner-ikkunassa'); return;
    }
    if (tok.exp && tok.exp * 1000 < Date.now() + 30000) {
      // token vanhentumassa → lataa Planner-sivu uudelleen, jotta MSAL uusii sen
      await plannerPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      console.log('[planner] token vanhentumassa — päivitetään istunto');
    }
    // 2) sarakkeet
    const bk = await graphGet(tok.token, `/planner/plans/${PLAN_ID}/buckets`);
    if (!bk.ok) {
      state.diag = `buckets HTTP ${bk.status} (scope: ${tok.target.slice(0, 60)})`;
      if (bk.status === 401) { state.status = 'awaiting-login'; state.error = null; await plannerPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
      else { state.status = 'error'; state.error = `Graph buckets ${bk.status} — tarkista oikeudet/PLAN_ID`; }
      console.log(`[planner] buckets HTTP ${bk.status} — ${state.diag}`); return;
    }
    const bucketMap = {}; for (const b of (bk.json.value || [])) bucketMap[b.id] = b.name;
    // 3) tehtävät
    const tk = await graphGet(tok.token, `/planner/plans/${PLAN_ID}/tasks`);
    if (!tk.ok) {
      state.diag = `tasks HTTP ${tk.status}`; state.status = 'error'; state.error = `Graph tasks ${tk.status}`;
      console.log(`[planner] tasks HTTP ${tk.status}`); return;
    }
    const tasks = tk.json.value || [];
    state.buckets = groupByBucket(tasks, bucketMap);
    state.uusi = (state.buckets.find((b) => b.name === NEW_BUCKET) || { tickets: [] }).tickets;
    state.count = tasks.length;
    state.status = 'ok'; state.updatedAt = new Date().toISOString(); state.error = null;
    state.diag = `ok — ${tasks.length} tehtävää, sarakkeet: ${Object.values(bucketMap).join(', ')}`;
    console.log(`[planner] ${new Date().toLocaleTimeString('fi-FI')} — ${tasks.length} tehtävää (Uudet: ${state.uusi.length})`);
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
app.use(express.static(path.join(__dirname, 'public')));

const start = async () => {
  console.log('Käynnistetään tehtävä-palvelin (Microsoft Planner)…');
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run']
  });
  plannerPage = context.pages()[0] || await context.newPage();
  await plannerPage.goto(PLANNER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  if (!HEADLESS) { try { await plannerPage.bringToFront(); } catch (_) {} }
  context.on('close', () => { console.log('Selain suljettiin — käynnistä palvelin uudelleen (npm start).'); process.exit(0); });

  app.listen(PORT, () => {
    console.log(`\n  Tehtävä-palvelin:  http://localhost:${PORT}`);
    console.log(`  JSON-rajapinta:    http://localhost:${PORT}/api/tickets`);
    console.log(`  Diagnostiikka:     http://localhost:${PORT}/api/health`);
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
module.exports = { mapTask, groupByBucket, getGraphToken };
