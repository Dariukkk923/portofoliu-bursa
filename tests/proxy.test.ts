/**
 * Proxy-ul Cloudflare (proxy/src/index.js): doar originea aplicației, doar adresele permise,
 * doar hosturile fixe, fără cache și fără alte antete trimise mai departe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://dariukkk923.github.io';
const env = { ALLOWED_ORIGIN: ORIGIN };

async function worker(): Promise<{ fetch(req: Request, env: unknown): Promise<Response> }> {
  const path = '../proxy/src/index.js';
  return (await import(/* @vite-ignore */ path)).default;
}

const upstream: { url: string; headers: Headers }[] = [];
const stubFetch = (handler: (url: URL) => Response): void => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    upstream.push({ url: url.href, headers: new Headers(init?.headers) });
    return handler(url);
  });
};
const call = async (path: string, origin: string | null = ORIGIN, method = 'GET'): Promise<Response> =>
  (await worker()).fetch(new Request(`https://proxy.example/${path}`, { method, headers: origin ? { origin } : {} }), env);

afterEach(() => {
  vi.unstubAllGlobals();
  upstream.length = 0;
});

describe('proxy-ul de prețuri', () => {
  it('refuză orice origine în afară de aplicație (și cererile fără origine)', async () => {
    stubFetch(() => new Response('{}'));
    expect((await call('yahoo/search?q=apple', 'https://alt-site.ro')).status).toBe(403);
    expect((await call('yahoo/search?q=apple', null)).status).toBe(403);
    expect(upstream).toHaveLength(0);
    const ok = await call('yahoo/search?q=apple');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('preflight-ul răspunde 204; alte metode sunt respinse; fără ALLOWED_ORIGIN nu răspunde nimănui', async () => {
    expect((await call('yahoo/search?q=a', ORIGIN, 'OPTIONS')).status).toBe(204);
    expect((await call('yahoo/search?q=a', ORIGIN, 'POST')).status).toBe(405);
    const none = await (await worker()).fetch(new Request('https://p.example/yahoo/search?q=a', { headers: { origin: ORIGIN } }), {});
    expect(none.status).toBe(403);
  });

  it('chart: transmite doar parametrii cunoscuți, către Yahoo, fără antetele browserului', async () => {
    stubFetch(() => new Response('{"chart":{}}', { headers: { 'content-type': 'application/json' } }));
    const res = await call('yahoo/chart/TLV.RO?period1=1&period2=2&interval=1d&events=div&evil=1');
    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toBe('https://query1.finance.yahoo.com/v8/finance/chart/TLV.RO?period1=1&period2=2&interval=1d&events=div');
    expect(upstream[0].headers.has('origin')).toBe(false);
    expect((await call('yahoo/chart/' + encodeURIComponent('a b;c'))).status).toBe(404);
  });

  it('quote și quoteSummary cer crumb o singură dată și îl refolosesc', async () => {
    stubFetch((url) => {
      if (url.hostname === 'fc.yahoo.com') return new Response('', { headers: { 'set-cookie': 'A3=abc; Path=/' } });
      if (url.pathname === '/v1/test/getcrumb') return new Response('CRUMB1');
      return new Response('{"ok":true}');
    });
    expect((await call('yahoo/quote?symbols=AAPL,EURRON%3DX')).status).toBe(200);
    expect((await call('yahoo/quoteSummary/AAPL?modules=assetProfile,calendarEvents')).status).toBe(200);
    const apiCalls = upstream.filter((u) => /v7|v10/.test(u.url));
    expect(apiCalls[0].url).toContain('/v7/finance/quote?symbols=AAPL%2CEURRON%3DX&crumb=CRUMB1');
    expect(apiCalls[1].url).toContain('/v10/finance/quoteSummary/AAPL?modules=assetProfile%2CcalendarEvents&crumb=CRUMB1');
    expect(upstream.filter((u) => u.url.includes('getcrumb'))).toHaveLength(1);
    expect(apiCalls[0].headers.get('cookie')).toBe('A3=abc');
    expect((await call('yahoo/quote?symbols=')).status).toBe(400);
    expect((await call('yahoo/quoteSummary/AAPL?modules=a;b')).status).toBe(400);
  });

  it('BNR: doar fișiere .xml de pe www.bnr.ro', async () => {
    stubFetch(() => new Response('<xml/>'));
    const good = encodeURIComponent('https://www.bnr.ro/files/xml/years/nbrfxrates2024.xml');
    expect((await call(`bnr?u=${good}`)).status).toBe(200);
    for (const bad of ['https://evil.example/files/xml/years/x.xml', 'http://www.bnr.ro/files/xml/x.xml', 'https://www.bnr.ro/admin', 'https://www.bnr.ro/files/xml/../../x.xml']) {
      expect((await call(`bnr?u=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
  });

  it('logo: doar hosturile Twelve Data și Polygon, doar imagini mici', async () => {
    stubFetch((url) =>
      url.pathname.endsWith('big.png')
        ? new Response(new Uint8Array(300_000), { headers: { 'content-type': 'image/png' } })
        : url.pathname.endsWith('page.html')
          ? new Response('<html>', { headers: { 'content-type': 'text/html' } })
          : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    );
    const enc = (u: string): string => `logo?u=${encodeURIComponent(u)}`;
    const ok = await call(enc('https://api.polygon.io/v1/reference/company-branding/x/icon.png?apiKey=K'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect((await call(enc('https://api.twelvedata.com/logo/apple.com'))).status).toBe(200);
    expect((await call(enc('https://api.polygon.io/big.png'))).status).toBe(413);
    expect((await call(enc('https://api.polygon.io/page.html'))).status).toBe(415);
    expect((await call(enc('https://evil.example/icon.png'))).status).toBe(400);
    expect((await call(enc('http://api.polygon.io/icon.png'))).status).toBe(400);
  });

  it('nu loghează și nu dezvăluie detalii când Yahoo nu răspunde', async () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    vi.stubGlobal('fetch', async () => {
      throw new Error('detalii interne cu cheia=SECRET');
    });
    const res = await call('yahoo/chart/AAPL');
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('SECRET');
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
