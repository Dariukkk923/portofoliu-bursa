/**
 * Rețeaua versiunii web. Providerii care acceptă CORS (Alpha Vantage, Twelve Data, Polygon) se apelează
 * direct din browser; Yahoo, cursurile BNR și imaginile logo trec prin proxy-ul Cloudflare din /proxy.
 */

/**
 * Proxy-ul publicat al aplicației (Cloudflare Worker din /proxy), folosit când utilizatorul nu și-a pus altul în Setări:
 * așa prețurile merg imediat după instalare, fără nicio setare. Se poate înlocui la build cu VITE_PROXY_URL.
 */
export const DEFAULT_PROXY_URL: string | null = normalizeProxyUrl(import.meta.env.VITE_PROXY_URL ?? 'https://portofoliu-proxy.portofoliu-bursa.workers.dev');

/** Adresa proxy-ului: cea din Setări sau, dacă nu există, cea implicită. */
export const proxyConfig: { url: string | null } = { url: null };

/** Adresa curățată: https (sau http pe localhost, pentru dezvoltare), fără „/” la final. Null dacă nu e validă. */
export function normalizeProxyUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Hosturile apelate direct (răspund cu antete CORS). */
const DIRECT_HOSTS = new Set(['www.alphavantage.co', 'api.twelvedata.com', 'api.polygon.io']);
/** Sursele de logo-uri care răspund cu CORS (merg și fără proxy). Parqet și Google nu au CORS: trec prin proxy. */
const DIRECT_IMAGE_HOSTS = new Set(['financialmodelingprep.com']);

export const PROXY_MISSING = 'Pentru această funcție este nevoie de proxy-ul de prețuri. Adaugă adresa lui în Setări.';

export function createRoutedFetch(getProxy: () => string | null, base: typeof fetch = (i, o) => fetch(i, o)): typeof fetch {
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    // Imaginile (logo-urile) cer antetul „accept: image/…”; JSON-ul și XML-ul nu.
    const wantsImage = new Headers(init?.headers).get('accept')?.includes('image/') ?? false;
    if (wantsImage ? DIRECT_IMAGE_HOSTS.has(url.hostname) : DIRECT_HOSTS.has(url.hostname)) return base(input, init);
    const proxy = getProxy();
    if (!proxy) throw new TypeError(`network: ${PROXY_MISSING}`);
    const target = wantsImage ? `${proxy}/logo?u=${encodeURIComponent(href)}` : `${proxy}/bnr?u=${encodeURIComponent(href)}`;
    if (!wantsImage && url.hostname !== 'www.bnr.ro') throw new TypeError(`network: adresă nepermisă (${url.hostname})`);
    return base(target, { ...init, headers: undefined });
  };
}
