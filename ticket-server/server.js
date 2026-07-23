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
let firstPoll = true;

// --- Verkkoliikenteen nuuskinta ---
// planner.cloud.microsoft ei tallenna Graph-tokenia luettavaan välimuistiin, joten
// napataan sovelluksen OMAT tokenit ja data-vastaukset sen verkkopyynnöistä. Sivu
// ladataan joka 60 s uudelleen, joten sovellus hakee datan aina uudelleen.
const sniff = { tokens: {}, responses: {}, seenUrls: [] };
function decodeJwt(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
}
function attachSniffer(page) {
  page.on('request', (req) => {
    try {
      const url = req.url();
      if (!/graph\.microsoft\.com|taskmars|planner\.cloud|office\.com/i.test(url)) return;
      const auth = req.headers()['authorization'];
      if (auth && /^bearer /i.test(auth)) {
        const tok = auth.slice(7);
        const p = decodeJwt(tok) || {};
        const aud = String(p.aud || '?').replace(/^https?:\/\//, '').replace(/\/$/, '');
        sniff.tokens[aud] = { token: tok, scp: String(p.scp || (p.roles || []).join(' ') || ''), exp: Number(p.exp || 0), seenAt: Date.now() };
      }
    } catch (e) { /* ohita */ }
  });
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/graph\.microsoft\.com|taskmars/i.test(url)) return;
      const ct = String(resp.headers()['content-type'] || '');
      if (!/json/i.test(ct)) return;
      const bare = url.split('?')[0];
      if (sniff.seenUrls.length < 60 && !sniff.seenUrls.includes(bare)) sniff.seenUrls.push(bare);
      const kind = /bucket/i.test(url) ? 'buckets' : (/task/i.test(url) ? 'tasks' : null);
      if (kind) { const body = await resp.json().catch(() => null); if (body) sniff.responses[kind] = { url: bare, body }; }
    } catch (e) { /* ohita */ }
  });
}
// Palauta Graph-token, jolla on Planner-lukuoikeus (aud=graph, scope group/tasks/planner/.default)
function pickGraphToken() {
  let best = null;
  for (const [aud, info] of Object.entries(sniff.tokens)) {
    if (!/graph\.microsoft\.com/i.test(aud)) continue;
    if (!/group|tasks|planner|\.default/i.test(info.scp)) continue;
    if (info.exp * 1000 < Date.now() + 10000) continue; // ei vanhentunutta
    if (!best || info.exp > best.exp) best = info;
  }
  return best;
}
// Graph-muotoinen ({value:[…]}) tehtävä/bucket-vastaus napattuna → tila
function useCapturedGraphResponses() {
  const t = sniff.responses.tasks, b = sniff.responses.buckets;
  const tasks = t && Array.isArray(t.body.value) ? t.body.value : null;
  const buckets = b && Array.isArray(b.body.value) ? b.body.value : null;
  if (!tasks || !tasks[0] || !('bucketId' in tasks[0])) return false; // ei Graph-muotoa
  const bucketMap = {}; for (const x of (buckets || [])) bucketMap[x.id] = x.name;
  applyTasks(tasks, bucketMap, 'napattu Graph-vastaus');
  return true;
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

function applyTasks(tasks, bucketMap, source) {
  state.buckets = groupByBucket(tasks, bucketMap);
  state.uusi = (state.buckets.find((b) => b.name === NEW_BUCKET) || { tickets: [] }).tickets;
  state.count = tasks.length;
  state.status = 'ok'; state.updatedAt = new Date().toISOString(); state.error = null;
  state.diag = `ok (${source}) — ${tasks.length} tehtävää, sarakkeet: ${Object.values(bucketMap).join(', ') || '—'}`;
  console.log(`[planner] ${new Date().toLocaleTimeString('fi-FI')} — ${tasks.length} tehtävää (Uudet: ${state.uusi.length}) [${source}]`);
}

async function poll() {
  if (!context || !plannerPage) return;
  try {
    // Päivitä Planner-sivu joka kierros (60 s), jotta sovellus hakee datan uudelleen ja
    // token pysyy tuoreena. Ensimmäisellä kerralla sivu on juuri ladattu (goto).
    if (!firstPoll) await plannerPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    firstPoll = false;
    await plannerPage.waitForTimeout(3500).catch(() => {}); // anna sovelluksen hakea data (napataan pyynnöt)

    // 1) Graph-token napattuna sovelluksen omista pyynnöistä → Graph /planner
    const gt = pickGraphToken();
    if (gt) {
      const bk = await graphGet(gt.token, `/planner/plans/${PLAN_ID}/buckets`);
      const tk = bk.ok ? await graphGet(gt.token, `/planner/plans/${PLAN_ID}/tasks`) : null;
      if (bk.ok && tk && tk.ok) {
        const bucketMap = {}; for (const b of (bk.json.value || [])) bucketMap[b.id] = b.name;
        applyTasks(tk.json.value || [], bucketMap, 'Graph');
        return;
      }
      state.diag = `Graph buckets=${bk.status}${tk ? ' tasks=' + tk.status : ''} (scope: ${gt.scp.slice(0, 50)})`;
      console.log('[planner] ' + state.diag);
    }
    // 2) fallback: sovelluksen omat napatut data-vastaukset (jos Graph-muotoisia)
    if (useCapturedGraphResponses()) return;

    // 3) ei (vielä) dataa — kerro mitä nähtiin (auttaa diagnosoinnissa)
    const auds = Object.keys(sniff.tokens).join(', ') || 'ei tokeneita';
    state.status = 'awaiting-login'; state.error = null;
    state.diag = `ei Planner-dataa vielä — token-aud: [${auds}]; data-URLeja nähty: ${sniff.seenUrls.length}. Kirjaudu Planner-ikkunassa ja odota; ks. /api/debug`;
    console.log('[planner] ' + state.diag);
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
// Diagnostiikka: mitä tokeneita/dataa sovelluksen liikenteestä on napattu
app.get('/api/debug', (_req, res) => {
  const summarize = (b) => {
    if (!b) return null;
    if (Array.isArray(b.value)) return { valueLen: b.value.length, firstKeys: b.value[0] ? Object.keys(b.value[0]).slice(0, 20) : [] };
    return { topKeys: Object.keys(b).slice(0, 20) };
  };
  res.json({
    status: state.status, planId: PLAN_ID, diag: state.diag,
    tokens: Object.fromEntries(Object.entries(sniff.tokens).map(([aud, i]) =>
      [aud, { scp: i.scp.slice(0, 220), expiresInSec: Math.round(i.exp - Date.now() / 1000) }])),
    seenUrls: sniff.seenUrls,
    captured: {
      tasks: sniff.responses.tasks ? { url: sniff.responses.tasks.url, shape: summarize(sniff.responses.tasks.body) } : null,
      buckets: sniff.responses.buckets ? { url: sniff.responses.buckets.url, shape: summarize(sniff.responses.buckets.body) } : null
    }
  });
});
app.use(express.static(path.join(__dirname, 'public')));

const start = async () => {
  console.log('Käynnistetään tehtävä-palvelin (Microsoft Planner)…');
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run']
  });
  plannerPage = context.pages()[0] || await context.newPage();
  attachSniffer(plannerPage); // nappaa sovelluksen tokenit + data-vastaukset
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
module.exports = { mapTask, groupByBucket, decodeJwt, pickGraphToken };
