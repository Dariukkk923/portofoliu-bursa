/**
 * Proxy minimal pentru versiunea web a aplicației Portofoliu Bursa (Cloudflare Worker).
 *
 * Browserul nu poate cere direct Yahoo Finance, fișierele BNR și imaginile logo (nu trimit antete CORS),
 * așa că aceste cereri trec pe aici. Proxy-ul:
 *   - transmite doar adresele de mai jos, doar cu GET, doar către hosturile fixe din cod;
 *   - răspunde doar aplicației tale (originea din ALLOWED_ORIGIN); orice altă origine primește 403;
 *   - nu salvează și nu loghează nimic: nu există KV, D1, R2, console.log sau analytics; răspunsurile
 *     nu intră în cache (cache-control: no-store).
 *
 * Singurul lucru ținut în memorie este „crumb”-ul Yahoo (un jeton public de sesiune, fără date ale tale),
 * ca să nu fie cerut la fiecare cotație; dispare când Cloudflare oprește instanța.
 *
 * Adrese:
 *   GET /yahoo/chart/<simbol>?period1&period2&interval&events|range   istoric, dividende, meta (preț, monedă)
 *   GET /yahoo/quote?symbols=A,B                                      cotații (cu crumb)
 *   GET /yahoo/quoteSummary/<simbol>?modules=a,b                      profil, calendar dividende (cu crumb)
 *   GET /yahoo/search?q=&quotesCount=&newsCount=                      căutare simboluri
 *   GET /bnr?u=<adresa .xml de pe www.bnr.ro>                         cursurile oficiale BNR
 *   GET /logo?u=<adresa imaginii>                                     logo (Twelve Data, Polygon)
 * Cursurile valutare (EURRON=X etc.) sunt simboluri Yahoo, deci trec prin /yahoo/chart și /yahoo/quote.
 */

const YAHOO = 'https://query1.finance.yahoo.com';
// Proxy-ul se prezintă cinstit (fără user-agent de browser fals).
const UA = 'portofoliu-bursa-proxy/1.0';
const MAX_LOGO_BYTES = 256 * 1024;

/** Hosturile permise pentru /logo (se potrivește hostul exact). */
const LOGO_HOSTS = new Set(['api.twelvedata.com', 'logo.twelvedata.com', 'api.polygon.io']);

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGIN ?? '').trim().replace(/\/+$/, '');
    if (!allowed || origin !== allowed) return reply(403, 'Origine nepermisă.', null);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return reply(405, 'Metodă nepermisă.', origin);

    const url = new URL(request.url);
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
        if (target.protocol !== 'https:' || !LOGO_HOSTS.has(target.hostname)) return reply(400, 'Adresă de logo nepermisă.', origin);
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
