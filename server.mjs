// ZeroProof Twin - mini prototype. Run: node server.mjs  -> http://localhost:3000
// No npm install needed (Node 18+). Reads .env from this folder.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const l of (fs.existsSync(path.join(dir, '.env')) ? fs.readFileSync(path.join(dir, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const E = process.env;
const BASE = E.FOODOSCOPE_BASE || 'https://api.foodoscope.com';
let MOCK = E.MOCK === '1' || !E.FOODOSCOPE_API_KEY;
const LIVE_KEY = !!E.FOODOSCOPE_API_KEY;
// >>> If an endpoint 404s, copy the exact path from Playground into .env (use {name} / {id}).
const URL_COCKTAIL = E.COCKTAIL_URL_TEMPLATE || BASE + '/cocktaildb/recipe/name?name={name}';
const URL_ENTITY = E.ENTITY_URL_TEMPLATE || BASE + '/flavordb/entities/by-name-and-category?entity_alias={name}&category={category}';
const URL_MOLS = E.MOLECULES_URL_TEMPLATE || BASE + '/flavordb/entities/by-id/{id}/molecules';
const HDR = E.API_KEY_HEADER || 'Authorization';
const PFX = E.API_KEY_PREFIX ?? 'Bearer ';

const CANDIDATES = (E.CANDIDATES || 'orange,lemon,lime,ginger,mint,vanilla,honey,pineapple').split(',');
const ALCOHOL = /\b(rum|vodka|gin|brandy|cognac|whisk(e)?y|bourbon|tequila|mezcal|wine|champagne|prosecco|beer|vermouth|liqueur|amaretto|triple sec|curacao|schnapps|sake|port|sherry|absinthe|bitters|campari|aperol)\b/i;
const FRUITY_CAT_BAD = /beverage|alcohol|essentialoil/i;

// ---------- cache + throttle (Trial plan = 25 req/min) ----------
const cacheFile = path.join(dir, 'cache.json');
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const save = () => fs.writeFileSync(cacheFile, JSON.stringify(cache));
let last = 0;
async function api(url) {
  if (cache[url]) return cache[url];
  const wait = 2600 - (Date.now() - last); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  for (let i = 0; i < 3; i++) {
    last = Date.now();
    console.log('GET', url);
    let r;
    try { r = await fetch(url, { headers: { [HDR]: PFX + E.FOODOSCOPE_API_KEY }, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw new Error('No response in 15s (check internet/VPN): ' + url); }
    console.log('  ->', r.status);
    if (r.status === 429) { await new Promise(r => setTimeout(r, 15000)); continue; }
    if (!r.ok) throw new Error(`API ${r.status} for ${url}`);
    const j = await r.json(); cache[url] = j; save(); return j;
  }
  throw new Error('Rate limit (429) - wait a minute and retry');
}
const list = j => Array.isArray(j) ? j : (j?.data || j?.entities || j?.results || j?.payload || (j && typeof j === 'object' ? [j] : []));
const fill = (t, o) => t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(o[k]));

// ---------- data access ----------
async function getCocktail(name) {
  if (MOCK) return MOCKDATA.cocktails[name.toLowerCase()] || MOCKDATA.cocktails.mojito;
  const arr = list(await api(fill(URL_COCKTAIL, { name })));
  const c = arr.find(x => (x.Cocktail_Title || x.name || '').toLowerCase() === name.toLowerCase()) || arr[0];
  if (!c) throw new Error('Cocktail not found: ' + name);
  let ing = c.ingredients || c.Ingredients || c.ingredient_list || [];
  if (typeof ing === 'string') ing = ing.split(/[,;|]/);
  ing = ing.map(x => typeof x === 'string' ? x : (x.ingredient || x.name || x.ingredient_name || '')).map(s => s.trim()).filter(Boolean);
  if (!ing.length) { // this endpoint has no ingredient list: read the spirits from the recipe text
    const text = (c.Instructions || '') + ' ' + (c.Categories || '');
    ing = [...new Set((text.match(new RegExp(ALCOHOL.source, 'gi')) || []).map(w => w.toLowerCase()))];
  }
  const m = MOCKDATA.cocktails[name.toLowerCase()];
  if (m && !ing.some(i => !ALCOHOL.test(i))) ing = [...new Set([...m.ingredients.filter(i => ALCOHOL.test(i)).slice(0, 0), ...m.ingredients])]; // live data lacked the non-alcohol parts
  return { name: c.Cocktail_Title || c.name || c.Name || name, ingredients: ing };
}
async function flavourOf(ing) {
  const key = ing.toLowerCase().replace(/^(white|dark|light|golden|fresh|fresh-squeezed)\s+/, '');
  if (MOCK) return MOCKDATA.flavours[key] || null;
  const CAT = { ginger: 'spice', cinnamon: 'spice', mint: 'herb', vanilla: 'fruit-essence', honey: 'plantderivative', tea: 'beverage-caffeinated', coffee: 'beverage-caffeinated', milk: 'dairy', sugar: 'additive' };
  const first = CAT[key] || (ALCOHOL.test(key) ? 'beverage-alcoholic' : 'fruit');
  let pick;
  for (const cat of [first, 'essentialoil']) { // fruit first, essential-oil entry as fallback
    let ents = [];
    try { ents = list(await api(fill(URL_ENTITY, { name: key, category: cat }))); } catch (e) { if (/Rate limit|No response/.test(e.message)) throw e; console.log('  not found:', key, cat); continue; }
    pick = ents.find(e => (e.entity_id ?? e.id) != null);
    if (pick) break;
  }
  if (!pick) return null;
  const id = pick.entity_id ?? pick.id;
  const mols = list(await api(fill(URL_MOLS, { id })));
  const counts = {}; let n = 0;
  for (const m of mols) {
    let f = m.flavor_profile ?? m.flavorProfile ?? m.flavours ?? m.flavors ?? '';
    if (typeof f === 'string') f = f.split(/[@,;|]/);
    f = [...new Set(f.map(s => s.trim().toLowerCase()).filter(Boolean))];
    if (!f.length) continue; n++;
    for (const w of f) counts[w] = (counts[w] || 0) + 1;
  }
  if (!n) return null;
  const w = {}; for (const k in counts) w[k] = counts[k] / n; // weight = share of molecules carrying the word
  return w;
}
// weighted Jaccard: words found in more molecules count more
function score(a, b) {
  let mn = 0, mx = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const x = a[k] || 0, y = b[k] || 0; mn += Math.min(x, y); mx += Math.max(x, y); }
  const shared = Object.keys(a).filter(k => b[k]).sort((p, q) => Math.min(b[q], a[q]) - Math.min(b[p], a[p])).slice(0, 5);
  return { pct: mx ? Math.round(100 * mn / mx) : 0, shared };
}

async function twin(name) {
  if (!MOCK) {
    try { return await twinCore(name); }
    catch (e) { console.log('LIVE failed -> demo fallback:', e.message); const was = MOCK; MOCK = true; try { const d = await twinCore(name); d.fallback = e.message; return d; } finally { MOCK = was; } }
  }
  return twinCore(name);
}
async function twinCore(name) {
  const c = await getCocktail(name);
  const alc = c.ingredients.filter(i => ALCOHOL.test(i));
  const keep = c.ingredients.filter(i => !ALCOHOL.test(i));
  const cand = {};
  for (const x of CANDIDATES) { try { const f = await flavourOf(x); if (f) cand[x] = f; } catch (e) { console.log('skip', x, '-', e.message); if (/Rate limit|No response/.test(e.message)) throw e; } }
  const swaps = [];
  for (const a of alc) {
    const k0 = a.toLowerCase().replace(/^(white|dark|light|golden)\s+/, '');
    let fa = null; try { fa = await flavourOf(a); } catch (e) { if (/Rate limit/.test(e.message)) throw e; }
    fa = fa || MOCKDATA.flavours[k0] || null;
    if (!fa) { swaps.push({ alcohol: a, options: [], note: 'No flavour data for this ingredient.' }); continue; }
    const options = Object.entries(cand).map(([n, f]) => ({ name: n, ...score(fa, f) })).sort((x, y) => y.pct - x.pct).slice(0, 3);
    swaps.push({ alcohol: a, options });
  }
  return { cocktail: c.name, keep, swaps, mock: MOCK };
}

// ---------- tiny demo data (used when MOCK=1 or no API key) ----------
const MOCKDATA = {
  cocktails: {
    mojito: { name: 'Mojito', ingredients: ['White rum', 'Mint', 'Lime', 'Sugar', 'Soda water'] },
    daiquiri: { name: 'Daiquiri', ingredients: ['White rum', 'Lime', 'Sugar'] },
  },
  flavours: {
    rum: { sweet: .8, caramel: .6, vanilla: .5, fruity: .5, woody: .4, spicy: .3 },
    orange: { sweet: .7, citrus: .9, fruity: .6, fresh: .5 }, lemon: { citrus: .9, fresh: .7, sweet: .3 },
    lime: { citrus: .9, fresh: .6, green: .3 }, ginger: { spicy: .9, warm: .7, woody: .3, citrus: .2 },
    mint: { fresh: .9, green: .6, sweet: .2 }, cinnamon: { spicy: .8, sweet: .5, woody: .5, warm: .6 },
    vanilla: { sweet: .9, vanilla: .9, caramel: .4, woody: .3 }, tea: { woody: .5, green: .4, fruity: .3 },
    coffee: { roasted: .8, caramel: .5, woody: .4, sweet: .3 }, honey: { sweet: .9, caramel: .5, fruity: .3 },
    pineapple: { fruity: .8, sweet: .7, citrus: .3 }, papaya: { fruity: .6, sweet: .5 },
  },
};

// ---------- http ----------
const inflight = {};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/twin') {
    try { const nm = u.searchParams.get('name') || 'mojito'; inflight[nm] ??= twin(nm).finally(() => delete inflight[nm]); const d = await inflight[nm]; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(dir, 'index.html')));
}).listen(3000, () => console.log(`ZeroProof Twin on http://localhost:3000  (${MOCK ? 'DEMO DATA mode' : 'LIVE API mode'})`));
