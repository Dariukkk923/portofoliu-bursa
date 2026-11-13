/**
 * Piesele care înlocuiesc Node în browser: Buffer, SHA-256, DEFLATE (xlsx), rutarea cererilor de rețea
 * (direct sau prin proxy) și clientul Yahoo prin proxy, citit de același YahooProvider ca pe desktop.
 */
import { createHash, randomBytes as nodeRandom } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { YahooProvider } from '@main/prices/yahoo';
import { WebBuffer } from '../src/web/shims/buffer';
import { createHash as shimHash, randomBytes as shimRandom } from '../src/web/shims/node-crypto';
import { inflateRawSync } from '../src/web/shims/node-zlib';
import { createRoutedFetch, normalizeProxyUrl } from '../src/web/net';
import { createWebYahooClient } from '../src/web/yahooWeb';

describe('Buffer pentru browser', () => {
  it('codări: utf8, latin1, utf16le, hex, base64, base64url', () => {
    const b = WebBuffer.from('Țară € ok');
    expect(b.toString('utf8')).toBe('Țară € ok');
    expect(b.toString('base64')).toBe(Buffer.from('Țară € ok').toString('base64'));
    expect(Array.from(WebBuffer.from(Buffer.from([251, 255, 254]).toString('base64url'), 'base64url'))).toEqual([251, 255, 254]);
    expect(Array.from(WebBuffer.from('ff00', 'hex'))).toEqual([255, 0]);
    expect(WebBuffer.from('ab', 'utf16le').toString('utf16le')).toBe('ab');
    expect(WebBuffer.from([0xe9]).toString('latin1')).toBe('é');
    expect(WebBuffer.byteLength('Țară')).toBe(Buffer.byteLength('Țară'));
  });

  it('citiri întregi, subarray, concat, isBuffer', () => {
    const b = WebBuffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b.readUInt16LE(0)).toBe(0x0201);
    expect(b.readUInt32LE(0)).toBe(0x04030201);
    expect(b.readUInt32BE(0)).toBe(0x01020304);
    const part = b.subarray(2, 5);
    expect(part).toBeInstanceOf(WebBuffer);
    expect(part.toString('hex')).toBe('030405');
    expect(WebBuffer.concat([part, WebBuffer.from([9])]).length).toBe(4);
    expect(WebBuffer.isBuffer(b)).toBe(true);
    expect(WebBuffer.isBuffer(new Uint8Array(1))).toBe(false);
  });
});

describe('SHA-256 și octeți aleatorii', () => {
  it('SHA-256 este identic cu cel din Node (inclusiv la granițele blocurilor)', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ț'.repeat(100), nodeRandom(300).toString('base64')]) {
      expect(shimHash('sha256').update(text).digest('hex')).toBe(createHash('sha256').update(text).digest('hex'));
    }
  });

  it('tokenul aleator are lungimea și alfabetul base64url', () => {
    const token = shimRandom(32).toString('base64url');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(shimRandom(32).toString('hex')).not.toBe(shimRandom(32).toString('hex'));
  });
});

describe('DEFLATE (fișiere .xlsx în browser)', () => {
  const same = (data: Uint8Array): void => expect(Buffer.from(inflateRawSync(deflateRawSync(data)))).toEqual(Buffer.from(data));

  it('decomprimă ca zlib: text repetitiv, date aleatoare, gol, blocuri mari', () => {
    same(new TextEncoder().encode('foaie,de,calcul;'.repeat(5000)));
    same(nodeRandom(70_000)); // aproape necompresibil: blocuri stocate
    same(new Uint8Array(0));
    same(new TextEncoder().encode('un singur rând'));
    same(Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7 + (i >> 5)) & 0xff)));
  });

  it('respectă limita de ieșire și refuză datele corupte', () => {
    const packed = deflateRawSync(Buffer.alloc(10_000, 1));
    expect(() => inflateRawSync(packed, { maxOutputLength: 100 })).toThrow(/prea mare/);
    expect(() => inflateRawSync(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
  });
});

describe('rețeaua web', () => {
  const calls: string[] = [];
  const base = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response('{}');
  }) as typeof fetch;

  it('providerii cu CORS se apelează direct; BNR și imaginile trec prin proxy', async () => {
    calls.length = 0;
    const f = createRoutedFetch(() => 'https://proxy.exemplu.workers.dev', base);
    await f('https://api.twelvedata.com/quote?symbol=AAPL', { headers: { accept: 'application/json' } });
    await f('https://www.bnr.ro/files/xml/years/nbrfxrates2024.xml', { headers: { accept: 'application/xml, text/xml' } });
    await f('https://api.polygon.io/v1/reference/company-branding/x/icon.png?apiKey=K', { headers: { accept: 'image/png, image/jpeg' } });
    expect(calls).toEqual([
      'https://api.twelvedata.com/quote?symbol=AAPL',
      `https://proxy.exemplu.workers.dev/bnr?u=${encodeURIComponent('https://www.bnr.ro/files/xml/years/nbrfxrates2024.xml')}`,
      `https://proxy.exemplu.workers.dev/logo?u=${encodeURIComponent('https://api.polygon.io/v1/reference/company-branding/x/icon.png?apiKey=K')}`
    ]);
  });

  it('fără proxy, cererile care îl cer dau eroare de rețea; alte hosturi nu se trimit', async () => {
    const none = createRoutedFetch(() => null, base);
    await expect(none('https://www.bnr.ro/x.xml')).rejects.toThrow(/proxy/);
    const f = createRoutedFetch(() => 'https://p.dev', base);
    await expect(f('https://exemplu.ro/a')).rejects.toThrow(/nepermisă/);
    expect(await none('https://www.alphavantage.co/query?x=1')).toBeInstanceOf(Response);
  });

  it('adresa proxy-ului: doar https (sau localhost), fără „/” la final', () => {
    expect(normalizeProxyUrl(' https://p.dev/ ')).toBe('https://p.dev');
    expect(normalizeProxyUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeProxyUrl('http://p.dev')).toBeNull();
    expect(normalizeProxyUrl('nu e adresă')).toBeNull();
  });
});

describe('Yahoo prin proxy', () => {
  const day = (d: string): number => Date.parse(`${d}T14:30:00Z`) / 1000;
  const server = (log: string[]): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      log.push(url.pathname + url.search);
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
      if (url.pathname === '/yahoo/quote')
        return json({ quoteResponse: { result: [{ symbol: 'TLV.RO', regularMarketPrice: 28.4, regularMarketTime: day('2024-05-02'), currency: 'RON', longName: 'Banca Transilvania', quoteType: 'EQUITY' }] } });
      if (url.pathname === '/yahoo/chart/TLV.RO')
        return json({
          chart: {
            result: [
              {
                meta: { currency: 'RON', symbol: 'TLV.RO', regularMarketPrice: 28.4, regularMarketTime: day('2024-05-03'), instrumentType: 'EQUITY', longName: 'Banca Transilvania' },
                timestamp: [day('2024-05-01'), day('2024-05-02'), day('2024-05-03')],
                indicators: { quote: [{ close: [27, null, 28.4] }] },
                events: { dividends: { [day('2024-05-02')]: { amount: 0.5, date: day('2024-05-02') } } }
              }
            ],
            error: null
          }
        });
      if (url.pathname === '/yahoo/quoteSummary/TLV.RO')
        return json({ quoteSummary: { result: [{ assetProfile: { sector: 'Financial Services', country: 'Romania' }, calendarEvents: { exDividendDate: { raw: day('2024-07-01'), fmt: '2024-07-01' } } }] } });
      if (url.pathname === '/yahoo/search')
        return json({ quotes: [{ symbol: 'TLV.RO', shortname: 'BT', longname: 'Banca Transilvania', exchDisp: 'Bucharest', quoteType: 'EQUITY' }] });
      return json({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }, 404);
    }) as typeof fetch;

  const provider = (log: string[] = []): YahooProvider => {
    const y = new YahooProvider();
    (y as unknown as { client: unknown }).client = createWebYahooClient(() => 'https://proxy.dev', server(log));
    return y;
  };

  it('cotație, istoric (cu zile fără preț sărite), dividende, profil și căutare', async () => {
    const log: string[] = [];
    const y = provider(log);
    const q = await y.getQuote({ symbol: 'TLV.RO', type: 'stock' });
    expect(q).toMatchObject({ symbol: 'TLV.RO', price: 28.4, currency: 'RON', name: 'Banca Transilvania', assetType: 'stock' });

    const h = await y.getHistory({ symbol: 'TLV.RO', type: 'stock' }, '2024-05-01', '2024-05-03');
    expect(h.points).toEqual([
      { date: '2024-05-01', close: 27 },
      { date: '2024-05-03', close: 28.4 }
    ]);
    expect(log.find((l) => l.startsWith('/yahoo/chart/TLV.RO'))).toMatch(/period1=\d+&period2=\d+&interval=1d/);

    const d = await y.getDividends({ symbol: 'TLV.RO', type: 'stock' }, '2024-01-01');
    expect(d).toEqual([
      { exDate: '2024-05-02', payDate: null, amount: 0.5, currency: 'RON' },
      { exDate: '2024-07-01', payDate: null, amount: 0.5, currency: 'RON', amountEstimated: true }
    ]);
    expect(await y.getProfile({ symbol: 'TLV.RO', type: 'stock' })).toEqual({ sector: 'Financial Services', country: 'Romania' });
    const found = await y.search('banca');
    expect(found[0]).toMatchObject({ symbol: 'TLV.RO', name: 'Banca Transilvania', type: 'stock' });
  });

  it('dacă „quote” (cu crumb) nu merge, cotația vine din „chart”; simbolul necunoscut dă „negăsit”', async () => {
    const failing = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/yahoo/quote') return new Response('{}', { status: 401 });
      return server([])(input);
    }) as typeof fetch;
    const y = new YahooProvider();
    (y as unknown as { client: unknown }).client = createWebYahooClient(() => 'https://proxy.dev', failing);
    expect(await y.getQuote({ symbol: 'TLV.RO', type: 'stock' })).toMatchObject({ price: 28.4, currency: 'RON', assetType: 'stock' });
    await expect(y.getQuote({ symbol: 'NIMIC', type: 'stock' })).rejects.toThrow(/nu are preț/);
  });

  it('fără proxy, eroarea este una de rețea (aplicația rămâne pe prețurile salvate)', async () => {
    const y = new YahooProvider();
    (y as unknown as { client: unknown }).client = createWebYahooClient(() => null, server([]));
    await expect(y.getQuote({ symbol: 'TLV.RO', type: 'stock' })).rejects.toMatchObject({ kind: 'network' });
  });
});
