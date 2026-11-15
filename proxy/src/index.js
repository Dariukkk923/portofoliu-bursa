/**
 * Proxy minimal pentru versiunea web a aplicației Portofoliu Bursa (Cloudflare Worker) + sincronizarea conturilor.
 *
 * Browserul nu poate cere direct Yahoo Finance, fișierele BNR și imaginile logo (nu trimit antete CORS),
 * așa că aceste cereri trec pe aici. Proxy-ul:
 *   - transmite doar adresele de mai jos, doar cu GET, doar către hosturile fixe din cod;
 *   - răspunde doar aplicației tale (originea din ALLOWED_ORIGIN); orice altă origine primește 403;
 *   - nu loghează nimic: nu există console.log sau analytics; răspunsurile nu intră în cache (cache-control: no-store).
 *
 * Singurul lucru ținut în memorie este „crumb”-ul Yahoo (un jeton public de sesiune, fără date ale tale),
 * ca să nu fie cerut la fiecare cotație; dispare când Cloudflare oprește instanța.
 *
 * Sincronizarea (/sync/*, baza D1 „SYNC_DB”, tabelele din schema.sql) păstrează doar: numele de utilizator,
 * sha256 al cheii de autentificare, momente de timp și copia criptată end-to-end. Parola și cheia de criptare
 * rămân pe dispozitive; serverul nu poate citi datele. Acceptă originea aplicației și cererile fără Origin
 * (aplicația desktop cere din Node).
 *   POST   /sync/register   { username, authKey }                      cont nou
 *   GET    /sync/head                                                   versiunea, momentul și dispozitivul ultimei copii
 *   GET    /sync/snapshot                                               copia criptată (204 dacă nu există)
 *   PUT    /sync/snapshot   { baseVersion, device, data }               copie nouă (compare-and-swap pe versiune)
 *   POST   /sync/password   { newAuthKey, baseVersion, device, data }   parolă nouă + copia recriptată
 *   DELETE /sync/account                                                șterge contul și copia
 *
 * Adrese proxy:
 *   GET /yahoo/chart/<simbol>?period1&period2&interval&events|range   istoric, dividende, meta (preț, monedă)
 *   GET /yahoo/quote?symbols=A,B                                      cotații (cu crumb)
 *   GET /yahoo/quoteSummary/<simbol>?modules=a,b                      profil, calendar dividende (cu crumb)
 *   GET /yahoo/search?q=&quotesCount=&newsCount=                      căutare simboluri
 *   GET /bnr?u=<adresa .xml de pe www.bnr.ro>                         cursurile oficiale BNR
 *   GET /logo?u=<adresa imaginii>                                     logo (Twelve Data, Polygon, Parqet, FMP, favicon Google)
 * Cursurile valutare (EURRON=X etc.) sunt simboluri Yahoo, deci trec prin /yahoo/chart și /yahoo/quote.
 */

const YAHOO = 'https://query1.finance.yahoo.com';
// Proxy-ul se prezintă cinstit (fără user-agent de browser fals).
const UA = 'portofoliu-bursa-proxy/1.0';
const MAX_LOGO_BYTES = 256 * 1024;

/**
 * Hosturile permise pentru /logo (se potrivește hostul exact): providerii cu cheie și sursele fără cheie
 * (Parqet, Financial Modeling Prep, favicon-urile Google; acesta din urmă redirecționează spre *.gstatic.com).
 */
const LOGO_HOSTS = new Set([
  'api.twelvedata.com',
  'logo.twelvedata.com',
  'api.polygon.io',
  'assets.parqet.com',
  'financialmodelingprep.com',
  'www.google.com'
]);
/** La www.google.com este permis doar serviciul de favicon-uri. */
const LOGO_PATHS = { 'www.google.com': /^\/s2\/favicons$/ };

const CHART_PARAMS = ['period1', 'period2', 'interval', 'events', 'range', 'includePrePost'];
const SYMBOL = /^[A-Za-z0-9.\-=^_/]{1,24}$/;
const MODULES = /^[A-Za-z]+(,[A-Za-z]+){0,5}$/;

let crumbCache = null; // { crumb, cookie, at }
const CRUMB_TTL_MS = 30 * 60_000;

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
    'cache-control': 'no-store'
  };
}

const reply = (status, body, origin, extra = {}) =>
  new Response(body, { status, headers: { ...(origin ? corsHeaders(origin) : { 'cache-control': 'no-store' }), ...extra } });

/** Cookie + crumb Yahoo, necesare pentru quote și quoteSummary. */
async function getCrumb(force) {
  if (!force && crumbCache && Date.now() - crumbCache.at < CRUMB_TTL_MS) return crumbCache;
  const first = await fetch('https://fc.yahoo.com', { headers: { 'user-agent': UA }, redirect: 'manual' });
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('fără cookie');
  const res = await fetch(`${YAHOO}/v1/test/getcrumb`, { headers: { 'user-agent': UA, cookie } });
  const crumb = (await res.text()).trim();
  if (!res.ok || !crumb || crumb.includes('<')) throw new Error('fără crumb');
  crumbCache = { crumb, cookie, at: Date.now() };
  return crumbCache;
}

async function yahooWithCrumb(path, params) {
  for (const force of [false, true]) {
    const { crumb, cookie } = await getCrumb(force);
    const qs = new URLSearchParams({ ...params, crumb });
    const res = await fetch(`${YAHOO}${path}?${qs}`, { headers: { 'user-agent': UA, cookie, accept: 'application/json' } });
    if (res.status !== 401 && res.status !== 403) return res;
  }
  return new Response('{}', { status: 401 });
}

async function passJson(res, origin) {
  return reply(res.status, await res.text(), origin, { 'content-type': 'application/json; charset=utf-8' });
}

// ---------------------------------------------------------------------------------------------------------
// Sincronizarea conturilor
// ---------------------------------------------------------------------------------------------------------

const USERNAME = /^[a-z0-9._-]{3,32}$/;
const AUTH_KEY = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_DATA_BYTES = 20 * 1024 * 1024; // după decodarea base64
const MAX_BODY_BYTES = 32 * 1024 * 1024; // corpul JSON (base64 ≈ 4/3 din date + câmpurile mici)
const MAX_SMALL_BODY = 4096;
/** Bucăți de base64 (multiplu de 4, deci fiecare e base64 valid), sub limita D1 de ~2 MB pe valoare. */
const CHUNK_CHARS = 1_500_000;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60_000;
const TOO_LARGE = Symbol('prea mare');

function syncHeaders(origin) {
  const h = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', vary: 'origin' };
  if (origin) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, PUT, POST, DELETE, OPTIONS';
    h['access-control-allow-headers'] = 'authorization, content-type';
    h['access-control-max-age'] = '86400';
  }
  return h;
}

async function sha256Hex(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Comparare în timp constant (pentru șiruri de aceeași lungime, cum sunt hash-urile hex). */
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request, limit) {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return TOO_LARGE;
  try {
    return (await request.json()) ?? {};
  } catch {
    return undefined;
  }
}

/**
 * `authorization: Sync base64(uname:authKey)`. Utilizator necunoscut și cheie greșită → același 401.
 * După MAX_FAILS greșeli la rând contul se blochează LOCK_MS (429), iar o autentificare reușită golește contorul.
 */
async function authenticate(db, request) {
  const m = /^Sync\s+([A-Za-z0-9+/]+={0,2})$/.exec(request.headers.get('authorization') ?? '');
  let username = '';
  let key = '';
  if (m) {
    try {
      const raw = atob(m[1]);
      const i = raw.lastIndexOf(':');
      if (i > 0) {
        username = raw.slice(0, i).trim().toLowerCase();
        key = raw.slice(i + 1).toLowerCase();
      }
    } catch {
      // antet stricat → 401 mai jos
    }
  }
  // Hash-ul se calculează mereu, ca timpul de răspuns să nu spună dacă utilizatorul există.
  const hash = await sha256Hex(key);
  if (!USERNAME.test(username) || !AUTH_KEY.test(key)) return { status: 401, body: { error: 'auth' } };
  const user = await db
    .prepare('SELECT username, key_hash, failed, locked_until, version, updated_at, device FROM sync_users WHERE username = ?')
    .bind(username)
    .first();
  if (!user) return { status: 401, body: { error: 'auth' } };
  const now = Date.now();
  if (user.locked_until > now) {
    const retryAfter = Math.ceil((user.locked_until - now) / 1000);
    return { status: 429, body: { error: 'locked', retryAfter }, headers: { 'retry-after': String(retryAfter) } };
  }
  if (!sameHex(hash, user.key_hash)) {
    await db
      .prepare(
        `UPDATE sync_users
            SET failed = CASE WHEN failed + 1 >= ? THEN 0 ELSE failed + 1 END,
                locked_until = CASE WHEN failed + 1 >= ? THEN ? ELSE locked_until END
          WHERE username = ?`
      )
      .bind(MAX_FAILS, MAX_FAILS, now + LOCK_MS, username)
      .run();
    return { status: 401, body: { error: 'auth' } };
  }
  if (user.failed) await db.prepare('UPDATE sync_users SET failed = 0 WHERE username = ?').bind(username).run();
  return { user };
}

const head = (row) => ({ version: row.version, updatedAt: row.updated_at ?? null, device: row.device ?? null });

/**
 * PUT /sync/snapshot și POST /sync/password. Bucățile se scriu sub o generație nouă, apoi un singur batch (tranzacție)
 * mută contul pe ea doar dacă versiunea este încă baseVersion (compare-and-swap) și șterge bucățile vechi.
 * Cine citește vede mereu fie copia veche întreagă, fie pe cea nouă întreagă.
 */
async function writeSnapshot(db, user, body, newKeyHash) {
  const { baseVersion, device, data } = body;
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0 || typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0) {
    return [400, { error: 'invalid' }];
  }
  if (device != null && typeof device !== 'string') return [400, { error: 'invalid' }];
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if ((data.length / 4) * 3 - pad > MAX_DATA_BYTES) return [413, { error: 'too_large' }];
  if (!BASE64.test(data)) return [400, { error: 'invalid' }];
  if (baseVersion !== user.version) return [409, { error: 'conflict', ...head(user) }];

  const gen = crypto.randomUUID();
  let chunks = 0;
  try {
    for (let i = 0; i < data.length; i += CHUNK_CHARS) {
      await db
        .prepare('INSERT INTO sync_chunks (username, gen, idx, data) VALUES (?, ?, ?, ?)')
        .bind(user.username, gen, chunks++, data.slice(i, i + CHUNK_CHARS))
        .run();
    }
    const now = Date.now();
    const [flip] = await db.batch([
      db
        .prepare(
          `UPDATE sync_users
              SET version = version + 1, updated_at = ?, device = ?, gen = ?, chunks = ?, key_hash = COALESCE(?, key_hash)
            WHERE username = ? AND version = ?
              AND (SELECT COUNT(*) FROM sync_chunks WHERE username = ? AND gen = ?) = ?`
        )
        .bind(now, device == null ? null : device.slice(0, 64), gen, chunks, newKeyHash ?? null, user.username, baseVersion, user.username, gen, chunks),
      // Doar dacă generația nouă a câștigat: restul bucăților (copia veche, scrieri pierdute) dispar.
      db
        .prepare('DELETE FROM sync_chunks WHERE username = ? AND gen <> ? AND EXISTS (SELECT 1 FROM sync_users WHERE username = ? AND gen = ?)')
        .bind(user.username, gen, user.username, gen)
    ]);
    if (flip.meta.changes === 1) return [200, { version: baseVersion + 1, updatedAt: now }];
  } catch (e) {
    await db.prepare('DELETE FROM sync_chunks WHERE username = ? AND gen = ?').bind(user.username, gen).run().catch(() => {});
    throw e;
  }
  // Altcineva a scris între timp: bucățile noastre nu mai folosesc nimănui.
  await db.prepare('DELETE FROM sync_chunks WHERE username = ? AND gen = ?').bind(user.username, gen).run();
  const current = await db.prepare('SELECT version, updated_at, device FROM sync_users WHERE username = ?').bind(user.username).first();
  return current ? [409, { error: 'conflict', ...head(current) }] : [401, { error: 'auth' }];
}

async function handleSync(request, env, url, origin, allowed) {
  if (origin !== null && (!allowed || origin !== allowed)) {
    return new Response(JSON.stringify({ error: 'origin' }), { status: 403, headers: syncHeaders(null) });
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: syncHeaders(origin) });
  const send = (status, body, extra = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...syncHeaders(origin), ...extra } });
  const db = env.SYNC_DB;
  if (!db) return send(503, { error: 'unavailable' });
  const route = `${request.method} ${url.pathname}`;

  try {
    if (route === 'POST /sync/register') {
      const body = await readJson(request, MAX_SMALL_BODY);
      if (body === TOO_LARGE) return send(413, { error: 'too_large' });
      const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
      const authKey = typeof body?.authKey === 'string' ? body.authKey.toLowerCase() : '';
      if (!USERNAME.test(username) || !AUTH_KEY.test(authKey)) return send(400, { error: 'invalid' });
      const res = await db
        .prepare('INSERT INTO sync_users (username, key_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(username) DO NOTHING')
        .bind(username, await sha256Hex(authKey), Date.now())
        .run();
      return res.meta.changes === 1 ? send(201, {}) : send(409, { error: 'taken' });
    }

    const known = ['GET /sync/head', 'GET /sync/snapshot', 'PUT /sync/snapshot', 'POST /sync/password', 'DELETE /sync/account'];
    if (!known.includes(route)) return send(404, { error: 'not_found' });

    const auth = await authenticate(db, request);
    if (!auth.user) return send(auth.status, auth.body, auth.headers);
    const user = auth.user;

    if (route === 'GET /sync/head') return send(200, head(user));

    if (route === 'GET /sync/snapshot') {
      if (!user.version) return send(204, null);
      const { results } = await db
        .prepare(
          `SELECT u.version, u.updated_at, u.device, u.chunks, c.data
             FROM sync_users u JOIN sync_chunks c ON c.username = u.username AND c.gen = u.gen
            WHERE u.username = ? ORDER BY c.idx`
        )
        .bind(user.username)
        .all();
      if (results.length === 0) return send(204, null);
      if (results.length !== results[0].chunks) return send(500, { error: 'server' });
      // Base64 validat la scriere: nu are nevoie de escape, deci corpul se lipește direct (fără o copie prin JSON.stringify).
      const meta = JSON.stringify(head(results[0])).slice(0, -1);
      return new Response(`${meta},"data":"${results.map((r) => r.data).join('')}"}`, { status: 200, headers: syncHeaders(origin) });
    }

    if (route === 'DELETE /sync/account') {
      await db.batch([
        db.prepare('DELETE FROM sync_chunks WHERE username = ?').bind(user.username),
        db.prepare('DELETE FROM sync_users WHERE username = ?').bind(user.username)
      ]);
      return send(200, {});
    }

    // PUT /sync/snapshot, POST /sync/password
    const body = await readJson(request, MAX_BODY_BYTES);
    if (body === TOO_LARGE) return send(413, { error: 'too_large' });
    if (body === undefined || typeof body !== 'object') return send(400, { error: 'invalid' });
    let newKeyHash = null;
    if (route === 'POST /sync/password') {
      const newKey = typeof body.newAuthKey === 'string' ? body.newAuthKey.toLowerCase() : '';
      if (!AUTH_KEY.test(newKey)) return send(400, { error: 'invalid' });
      newKeyHash = await sha256Hex(newKey);
    }
    const [status, out] = await writeSnapshot(db, user, body, newKeyHash);
    return send(status, out);
  } catch {
    // Fără detalii și fără log.
    return send(500, { error: 'server' });
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGIN ?? '').trim().replace(/\/+$/, '');
    const url = new URL(request.url);
    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return handleSync(request, env, url, origin, allowed);

    if (!allowed || origin !== allowed) return reply(403, 'Origine nepermisă.', null);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return reply(405, 'Metodă nepermisă.', origin);

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const q = url.searchParams;

    try {
      if (parts[0] === 'yahoo' && parts[1] === 'chart' && parts.length === 3 && SYMBOL.test(parts[2])) {
        const params = new URLSearchParams();
        for (const key of CHART_PARAMS) if (q.has(key)) params.set(key, q.get(key));
        const res = await fetch(`${YAHOO}/v8/finance/chart/${encodeURIComponent(parts[2])}?${params}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
        return passJson(res, origin);
      }
      if (parts[0] === 'yahoo' && parts[1] === 'search' && parts.length === 2) {
        const query = (q.get('q') ?? '').slice(0, 80);
        if (!query) return reply(400, 'Lipsește q.', origin);
        const params = new URLSearchParams({ q: query, quotesCount: String(Math.min(Number(q.get('quotesCount')) || 10, 20)), newsCount: String(Math.min(Number(q.get('newsCount')) || 0, 20)) });
        const res = await fetch(`${YAHOO}/v1/finance/search?${params}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
        return passJson(res, origin);
      }
      if (parts[0] === 'yahoo' && parts[1] === 'quote' && parts.length === 2) {
        const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean);
        if (symbols.length === 0 || symbols.length > 50 || !symbols.every((s) => SYMBOL.test(s))) return reply(400, 'Simboluri invalide.', origin);
        return passJson(await yahooWithCrumb('/v7/finance/quote', { symbols: symbols.join(',') }), origin);
      }
      if (parts[0] === 'yahoo' && parts[1] === 'quoteSummary' && parts.length === 3 && SYMBOL.test(parts[2])) {
        const modules = q.get('modules') ?? '';
        if (!MODULES.test(modules)) return reply(400, 'Module invalide.', origin);
        return passJson(await yahooWithCrumb(`/v10/finance/quoteSummary/${encodeURIComponent(parts[2])}`, { modules }), origin);
      }
      if (parts[0] === 'bnr' && parts.length === 1) {
        const target = new URL(q.get('u') ?? '', 'https://invalid.invalid');
        if (target.protocol !== 'https:' || target.hostname !== 'www.bnr.ro' || !/^\/files\/xml\/[\w\-./]+\.xml$/.test(target.pathname)) {
          return reply(400, 'Adresă BNR invalidă.', origin);
        }
        const res = await fetch(target.href, { headers: { 'user-agent': UA, accept: 'application/xml, text/xml' } });
        return reply(res.status, await res.text(), origin, { 'content-type': 'application/xml; charset=utf-8' });
      }
      if (parts[0] === 'logo' && parts.length === 1) {
        const target = new URL(q.get('u') ?? '', 'https://invalid.invalid');
        const pathRule = LOGO_PATHS[target.hostname];
        if (target.protocol !== 'https:' || !LOGO_HOSTS.has(target.hostname) || (pathRule && !pathRule.test(target.pathname))) {
          return reply(400, 'Adresă de logo nepermisă.', origin);
        }
        const res = await fetch(target.href, { headers: { 'user-agent': UA, accept: 'image/png, image/jpeg, image/webp, image/gif, image/svg+xml' } });
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!res.ok || !type.startsWith('image/')) return reply(res.ok ? 415 : res.status, 'Nu este o imagine.', origin);
        const data = await res.arrayBuffer();
        if (data.byteLength > MAX_LOGO_BYTES) return reply(413, 'Imagine prea mare.', origin);
        return reply(200, data, origin, { 'content-type': type });
      }
      return reply(404, 'Adresă necunoscută.', origin);
    } catch {
      // Fără detalii și fără log: aplicația primește doar „nu merge acum” și rămâne pe prețurile salvate.
      return reply(502, 'Serviciul amonte nu răspunde.', origin);
    }
  }
};
