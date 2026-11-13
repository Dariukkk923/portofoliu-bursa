/**
 * Teste pentru monede, burse (program, listă de căutare) și pence (GBp/GBX), fără rețea:
 * providerii sunt simulați prin clientul Yahoo sau prin fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_CURRENCIES, CURRENCIES, ASSET_CURRENCIES } from '@shared/types';
import { BENCHMARKS } from '@shared/benchmarks';
import { EXCHANGES, exchangeForSymbol, isMarketOpen, listingDetail, listingLabel, marketStatus } from '@shared/exchanges';
import { crossSeries, toMajorUnits } from '@main/prices/provider';
import { YahooProvider } from '@main/prices/yahoo';
import { TwelveDataProvider } from '@main/prices/twelvedata';
import { AlphaVantageProvider } from '@main/prices/alphavantage';
import { fxSymbol, isFxSymbol, resolveFx, type CachedPrice } from '@main/prices/store';
import { parseFxSymbol } from '@main/prices/provider';

const at = (iso: string): Date => new Date(iso);
const ex = (symbol: string) => exchangeForSymbol(symbol)!;

describe('monede', () => {
  it('lista unică conține toate monedele cerute, iar GBP poate fi monedă de bază', () => {
    for (const c of ['RON', 'EUR', 'USD', 'GBP', 'CHF', 'PLN', 'SEK', 'DKK', 'NOK']) expect(CURRENCIES).toContain(c);
    expect(ASSET_CURRENCIES).toBe(CURRENCIES);
    expect(BASE_CURRENCIES).toContain('GBP');
    for (const b of BASE_CURRENCIES) expect(CURRENCIES).toContain(b);
  });

  it('simbolul perechii valutare se poate forma și citi pentru orice pereche', () => {
    for (const a of CURRENCIES) {
      for (const b of CURRENCIES) {
        if (a === b) continue;
        const s = fxSymbol(a, b);
        expect(isFxSymbol(s)).toBe(true);
        expect(parseFxSymbol(s)).toEqual({ from: a, to: b });
      }
    }
  });

  it('cursul aproximativ există pentru orice pereche, iar cel salvat are prioritate', () => {
    for (const a of CURRENCIES) {
      for (const b of CURRENCIES) {
        const r = resolveFx(new Map(), a, b);
        expect(r.rate).toBeGreaterThan(0);
        expect(r.approximate).toBe(a !== b);
        if (a !== b) expect(r.rate).not.toBe(1);
      }
    }
    const cache = new Map<string, CachedPrice>([['PLNGBP=X', { symbol: 'PLNGBP=X', price: 0.2, currency: 'GBP', asOf: '', provider: 'yahoo', fetchedAt: '' }]]);
    expect(resolveFx(cache, 'PLN', 'GBP')).toEqual({ rate: 0.2, approximate: false });
    expect(resolveFx(cache, 'GBP', 'PLN').rate).toBeCloseTo(5, 10); // inversul perechii opuse
  });
});

describe('registrul burselor', () => {
  it('mapează sufixele la bursă, monedă și fus orar', () => {
    expect(exchangeForSymbol('AAPL')).toMatchObject({ name: 'SUA', currency: 'USD', timeZone: 'America/New_York' });
    expect(exchangeForSymbol('BRK-B')).toMatchObject({ currency: 'USD' }); // clasa de acțiuni nu e crypto
    expect(exchangeForSymbol('TLV.RO')).toMatchObject({ name: 'BVB', currency: 'RON' });
    expect(exchangeForSymbol('vuag.l')).toMatchObject({ name: 'London', currency: 'GBP' });
    expect(exchangeForSymbol('VWCE.DE')?.currency).toBe('EUR');
    expect(exchangeForSymbol('NESN.SW')?.currency).toBe('CHF');
    expect(exchangeForSymbol('PKO.WA')?.currency).toBe('PLN');
    expect(exchangeForSymbol('VOLV-B.ST')?.currency).toBe('SEK');
    expect(exchangeForSymbol('NOVO-B.CO')?.currency).toBe('DKK');
    expect(exchangeForSymbol('EQNR.OL')?.currency).toBe('NOK');
    expect(EXCHANGES.map((e) => e.suffix).sort()).toEqual(['', 'AS', 'BR', 'CO', 'DE', 'L', 'LS', 'MC', 'MI', 'OL', 'PA', 'RO', 'ST', 'SW', 'WA']);
  });

  it('crypto, curs valutar, indici și sufixe necunoscute', () => {
    expect(exchangeForSymbol('BTC-USD', 'crypto')?.hours).toBeNull();
    expect(exchangeForSymbol('ETH-EUR')?.hours).toBeNull();
    expect(exchangeForSymbol('EURRON=X', 'fx')).toBeNull();
    expect(exchangeForSymbol('^GSPC')).toBeNull();
    expect(exchangeForSymbol('XYZ.TO')).toBeNull();
    expect(exchangeForSymbol('ROMGAZ', 'bond')).toBeNull();
  });

  it('eticheta de căutare arată bursa și moneda', () => {
    expect(listingLabel({ symbol: 'VUAG.L', exchange: 'LSE', currency: 'GBP' })).toBe('VUAG · London · GBP');
    expect(listingLabel({ symbol: 'TLV.RO', exchange: 'BVB', currency: null })).toBe('TLV · BVB · RON');
    expect(listingDetail({ symbol: 'VUSD.L', exchange: null, currency: 'USD' })).toBe('London · USD');
    expect(listingLabel({ symbol: 'AAPL', exchange: 'NasdaqGS', currency: 'USD' })).toBe('AAPL · SUA · USD');
    expect(listingLabel({ symbol: 'XYZ.TO', exchange: 'Toronto', currency: null })).toBe('XYZ.TO · Toronto');
  });
});

describe('piață deschisă / închisă', () => {
  it('SUA: 09:30-16:00 ora New York, cu ora de vară (EDT) și de iarnă (EST)', () => {
    const us = ex('AAPL');
    // iulie: EDT = UTC-4
    expect(isMarketOpen(us, at('2026-07-15T13:29:00Z'))).toBe(false);
    expect(isMarketOpen(us, at('2026-07-15T13:30:00Z'))).toBe(true);
    expect(isMarketOpen(us, at('2026-07-15T19:59:00Z'))).toBe(true);
    expect(isMarketOpen(us, at('2026-07-15T20:00:00Z'))).toBe(false);
    // ianuarie: EST = UTC-5
    expect(isMarketOpen(us, at('2026-01-14T14:29:00Z'))).toBe(false);
    expect(isMarketOpen(us, at('2026-01-14T14:30:00Z'))).toBe(true);
    expect(isMarketOpen(us, at('2026-01-14T20:59:00Z'))).toBe(true);
    expect(isMarketOpen(us, at('2026-01-14T21:00:00Z'))).toBe(false);
  });

  it('trece corect peste schimbarea orei: SUA mută ora pe 8 martie 2026, Europa pe 29 martie', () => {
    const us = ex('AAPL');
    expect(isMarketOpen(us, at('2026-03-06T14:30:00Z'))).toBe(true); // vineri, încă EST
    expect(isMarketOpen(us, at('2026-03-09T13:30:00Z'))).toBe(true); // luni, deja EDT
    expect(isMarketOpen(us, at('2026-03-09T13:29:00Z'))).toBe(false);
    const de = ex('SAP.DE');
    expect(isMarketOpen(de, at('2026-03-27T07:59:00Z'))).toBe(false); // vineri, CET: 09:00 = 08:00Z
    expect(isMarketOpen(de, at('2026-03-27T08:00:00Z'))).toBe(true);
    expect(isMarketOpen(de, at('2026-03-30T06:59:00Z'))).toBe(false); // luni, CEST: 09:00 = 07:00Z
    expect(isMarketOpen(de, at('2026-03-30T07:00:00Z'))).toBe(true);
  });

  it('Europa și BVB folosesc ora locală a bursei', () => {
    expect(isMarketOpen(ex('VUAG.L'), at('2026-07-15T07:00:00Z'))).toBe(true); // BST: 08:00 local
    expect(isMarketOpen(ex('VUAG.L'), at('2026-07-15T06:59:00Z'))).toBe(false);
    expect(isMarketOpen(ex('VUAG.L'), at('2026-07-15T15:30:00Z'))).toBe(false); // 16:30 local
    expect(isMarketOpen(ex('TLV.RO'), at('2026-07-15T07:00:00Z'))).toBe(true); // EEST: 10:00 local
    expect(isMarketOpen(ex('TLV.RO'), at('2026-01-14T07:59:00Z'))).toBe(false); // EET: 10:00 = 08:00Z
    expect(isMarketOpen(ex('TLV.RO'), at('2026-01-14T08:00:00Z'))).toBe(true);
    expect(isMarketOpen(ex('EQNR.OL'), at('2026-07-15T14:19:00Z'))).toBe(true); // 16:19 local
    expect(isMarketOpen(ex('EQNR.OL'), at('2026-07-15T14:20:00Z'))).toBe(false);
  });

  it('weekendul este închis, iar crypto este mereu deschis', () => {
    expect(isMarketOpen(ex('AAPL'), at('2026-07-18T15:00:00Z'))).toBe(false); // sâmbătă
    expect(isMarketOpen(ex('VUAG.L'), at('2026-07-19T11:00:00Z'))).toBe(false); // duminică
    expect(isMarketOpen(exchangeForSymbol('BTC-USD', 'crypto')!, at('2026-07-18T03:00:00Z'))).toBe(true);
    expect(marketStatus('BTC-USD', 'crypto', at('2026-07-19T03:00:00Z'))).toBe(true);
    expect(marketStatus('EURRON=X', 'fx')).toBeNull();
  });

  it('ziua săptămânii se ia din fusul bursei, nu din cel al calculatorului', () => {
    // Duminică 23:00 UTC este deja luni 01:00 la Oslo, dar piața încă nu se deschide.
    expect(isMarketOpen(ex('EQNR.OL'), at('2026-07-19T23:00:00Z'))).toBe(false);
    // Luni 08:00 UTC = 10:00 la Oslo (CEST), deschisă.
    expect(isMarketOpen(ex('EQNR.OL'), at('2026-07-20T08:00:00Z'))).toBe(true);
    // Vineri 21:30 UTC = 17:30 la New York: închis.
    expect(isMarketOpen(ex('AAPL'), at('2026-07-17T21:30:00Z'))).toBe(false);
  });
});

describe('pence (GBp / GBX)', () => {
  it('toMajorUnits împarte la 100 doar pentru subunități', () => {
    expect(toMajorUnits(1234, 'GBp')).toEqual({ price: 12.34, currency: 'GBP' });
    expect(toMajorUnits(250, 'GBX')).toEqual({ price: 2.5, currency: 'GBP' });
    expect(toMajorUnits(12.5, 'GBP')).toEqual({ price: 12.5, currency: 'GBP' });
    expect(toMajorUnits(142.8, 'usd')).toEqual({ price: 142.8, currency: 'USD' });
    expect(toMajorUnits(1, null)).toEqual({ price: 1, currency: null });
  });

  const yahooWith = (client: object): YahooProvider => {
    const y = new YahooProvider();
    (y as unknown as { client: object }).client = client;
    return y;
  };

  it('Yahoo: cotația, istoricul, dividendele și căutarea sunt în lire', async () => {
    const y = yahooWith({
      quote: async (symbols: string[]) =>
        symbols.map((s) => ({ symbol: s, regularMarketPrice: 98.52, currency: 'GBp', quoteType: 'EQUITY', regularMarketTime: new Date('2026-07-15T15:00:00Z') })),
      chart: async (_s: string, opts: { events?: string }) =>
        opts.events === 'div'
          ? { meta: { currency: 'GBp' }, events: { dividends: [{ date: new Date('2026-04-10T00:00:00Z'), amount: 2.11 }] } }
          : { meta: { currency: 'GBp' }, quotes: [{ date: new Date('2026-06-03T00:00:00Z'), close: 55.4 }, { date: new Date('2026-06-04T00:00:00Z'), close: 55.64 }] },
      quoteSummary: async () => ({}),
      search: async () => ({ quotes: [{ symbol: 'LLOY.L', longname: 'Lloyds', exchDisp: 'London', quoteType: 'EQUITY' }] })
    });
    const q = await y.getQuote({ symbol: 'LLOY.L', type: 'stock' });
    expect(q.price).toBeCloseTo(0.9852, 10);
    expect(q.currency).toBe('GBP');
    const h = await y.getHistory({ symbol: 'LLOY.L', type: 'stock' }, '2026-06-01', '2026-06-05');
    expect(h.points[0].close).toBeCloseTo(0.554, 10);
    expect(h.points[1].close).toBeCloseTo(0.5564, 10);
    const d = await y.getDividends({ symbol: 'LLOY.L', type: 'stock' }, '2026-01-01');
    expect(d?.[0].amount).toBeCloseTo(0.0211, 10);
    expect(d?.[0].currency).toBe('GBP');
    const s = await y.search('lloyds');
    expect(s[0]).toMatchObject({ symbol: 'LLOY.L', exchange: 'London', currency: 'GBP' });
  });

  it('Yahoo: un titlu din Londra cotat în USD rămâne neschimbat', async () => {
    const y = yahooWith({ quote: async () => [{ symbol: 'VUSD.L', regularMarketPrice: 142.8, currency: 'USD', quoteType: 'ETF' }] });
    expect(await y.getQuote({ symbol: 'VUSD.L', type: 'etf' })).toMatchObject({ price: 142.8, currency: 'USD' });
  });

  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (reply: (url: string) => unknown): string[] => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(reply(url)), { status: 200 });
    });
    return urls;
  };

  it('Twelve Data: cotația, istoricul și căutarea din Londra sunt în lire', async () => {
    stubFetch((url) => {
      if (url.includes('/quote')) return { symbol: 'LLOY', close: '98.52', currency: 'GBp', name: 'Lloyds' };
      if (url.includes('/time_series')) return { meta: { currency: 'GBp' }, values: [{ datetime: '2026-06-03', close: '55.4' }, { datetime: '2026-06-04', close: '55.64' }] };
      return { data: [{ symbol: 'LLOY', instrument_name: 'Lloyds', exchange: 'LSE', instrument_type: 'Common Stock', currency: 'GBp' }] };
    });
    const td = new TwelveDataProvider('k');
    // limitatorul de cereri așteaptă între apeluri; cu cronometrul real durează, deci îl scurtăm
    (td as unknown as { limiter: { schedule: <T>(fn: () => Promise<T>) => Promise<T> } }).limiter = { schedule: (fn) => fn() };
    expect(await td.getQuote({ symbol: 'LLOY.L', type: 'stock' })).toMatchObject({ price: 0.9852, currency: 'GBP' });
    const h = await td.getHistory({ symbol: 'LLOY.L', type: 'stock' }, '2026-06-01', '2026-06-05');
    expect(h.points[0].close).toBeCloseTo(0.554, 10);
    expect(h.points[1].close).toBeCloseTo(0.5564, 10);
    expect((await td.search('lloyds'))[0].currency).toBe('GBP');
  });

  it('Alpha Vantage: pentru Londra află moneda din căutare și convertește pence', async () => {
    const urls = stubFetch((url) => {
      if (url.includes('SYMBOL_SEARCH')) return { bestMatches: [{ '1. symbol': 'LLOY.LON', '2. name': 'Lloyds', '3. type': 'Equity', '4. region': 'United Kingdom', '8. currency': 'GBX' }] };
      if (url.includes('GLOBAL_QUOTE')) return { 'Global Quote': { '05. price': '98.52', '07. latest trading day': '2026-07-15' } };
      return { 'Time Series (Daily)': { '2026-06-03': { '4. close': '55.4' }, '2026-06-04': { '4. close': '55.64' } } };
    });
    const av = new AlphaVantageProvider('k');
    (av as unknown as { limiter: { schedule: <T>(fn: () => Promise<T>) => Promise<T> } }).limiter = { schedule: (fn) => fn() };
    expect(await av.getQuote({ symbol: 'LLOY.L', type: 'stock' })).toMatchObject({ price: 0.9852, currency: 'GBP' });
    const h = await av.getHistory({ symbol: 'LLOY.L', type: 'stock' }, '2026-06-01', '2026-06-05');
    expect(h.points[0].close).toBeCloseTo(0.554, 10);
    expect(h.points[1].close).toBeCloseTo(0.5564, 10);
    expect(urls.filter((u) => u.includes('SYMBOL_SEARCH')).length).toBe(1); // moneda se reține
    expect((await av.search('lloyds'))[0].currency).toBe('GBP');
  });

  it('Alpha Vantage: fără moneda cunoscută pentru Londra dă eroare, nu prețuri greșite', async () => {
    stubFetch((url) => (url.includes('SYMBOL_SEARCH') ? { bestMatches: [] } : { 'Global Quote': { '05. price': '98.52' } }));
    const av = new AlphaVantageProvider('k');
    (av as unknown as { limiter: { schedule: <T>(fn: () => Promise<T>) => Promise<T> } }).limiter = { schedule: (fn) => fn() };
    await expect(av.getQuote({ symbol: 'LLOY.L', type: 'stock' })).rejects.toMatchObject({ kind: 'notfound' });
  });

  it('Alpha Vantage: un titlu din Londra cotat în USD nu se împarte la 100', async () => {
    stubFetch((url) =>
      url.includes('SYMBOL_SEARCH')
        ? { bestMatches: [{ '1. symbol': 'VUSD.LON', '8. currency': 'USD' }] }
        : { 'Global Quote': { '05. price': '142.8' } }
    );
    const av = new AlphaVantageProvider('k');
    (av as unknown as { limiter: { schedule: <T>(fn: () => Promise<T>) => Promise<T> } }).limiter = { schedule: (fn) => fn() };
    expect(await av.getQuote({ symbol: 'VUSD.L', type: 'etf' })).toMatchObject({ price: 142.8, currency: null });
  });
});

describe('curs valutar prin dolar (Yahoo)', () => {
  it('crossSeries folosește ultimul punct disponibil din a doua serie', () => {
    const a = [{ date: '2026-01-05', close: 2 }, { date: '2026-01-06', close: 3 }, { date: '2026-01-07', close: 4 }];
    const b = [{ date: '2026-01-05', close: 10 }, { date: '2026-01-07', close: 20 }];
    expect(crossSeries(a, b)).toEqual([{ date: '2026-01-05', close: 20 }, { date: '2026-01-06', close: 30 }, { date: '2026-01-07', close: 80 }]);
    expect(crossSeries(a, [{ date: '2026-01-06', close: 1 }]).map((p) => p.date)).toEqual(['2026-01-06', '2026-01-07']); // fără curs înainte de prima zi
  });

  it('perechea lipsă (PLNRON=X) se calculează din PLNUSD=X și USDRON=X, la cotație și la istoric', async () => {
    const day = (d: string, close: number) => ({ date: new Date(`${d}T00:00:00Z`), close });
    const y = new YahooProvider();
    (y as unknown as { client: object }).client = {
      quote: async (symbols: string[]) =>
        symbols.filter((s) => s !== 'PLNRON=X').map((s) => ({ symbol: s, regularMarketPrice: s === 'PLNUSD=X' ? 0.25 : 4.8, currency: null })),
      chart: async (s: string) => {
        if (s === 'PLNRON=X') throw new Error('No data found, symbol may be delisted');
        return { meta: {}, quotes: s === 'PLNUSD=X' ? [day('2026-02-02', 0.25), day('2026-02-09', 0.26)] : [day('2026-02-02', 4.8), day('2026-02-09', 4.9)] };
      }
    };
    const q = await y.getQuote({ symbol: 'PLNRON=X', type: 'fx' });
    expect(q.price).toBeCloseTo(1.2, 10);
    expect(q.currency).toBe('RON');
    const h = await y.getHistory({ symbol: 'PLNRON=X', type: 'fx' }, '2026-02-01', '2026-02-20');
    expect(h.points.map((p) => p.date)).toEqual(['2026-02-02', '2026-02-09']);
    expect(h.points[0].close).toBeCloseTo(1.2, 10);
    expect(h.points[1].close).toBeCloseTo(0.26 * 4.9, 10);
  });
});

describe('indici de referință', () => {
  it('conține indicii europeni, fiecare cu moneda și simbolul unic', () => {
    const names = BENCHMARKS.map((b) => b.name);
    for (const n of ['S&P 500', 'Nasdaq 100', 'FTSE 100', 'DAX', 'CAC 40', 'Euro Stoxx 50']) expect(names).toContain(n);
    expect(names.some((n) => n.startsWith('BET'))).toBe(true);
    expect(new Set(BENCHMARKS.map((b) => b.symbol)).size).toBe(BENCHMARKS.length);
    for (const b of BENCHMARKS) expect(CURRENCIES as readonly string[]).toContain(b.currency);
    expect(BENCHMARKS.find((b) => b.symbol === '^FTSE')?.currency).toBe('GBP');
  });
});
