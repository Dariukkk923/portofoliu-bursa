/**
 * Știri și raportări financiare, fără rețea: parserii pe răspunsuri-model ale providerilor, apoi serviciile
 * cu surse simulate (cache, rezervă pe cache la eșec, dedublare, ETF-uri fără raportări, funcții pentru alerte).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssetType, User } from '@shared/types';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase } from '@main/services/transactions';
import { addWatchlistItem, listWatchlists } from '@main/services/watchlist';
import { createBackup } from '@main/services/backup';
import { ProviderError } from '@main/prices/provider';
import {
  parseAlphaCalendar,
  parseAlphaEarnings,
  parseAlphaNews,
  parseAlphaStatements,
  parsePolygonFinancials,
  parsePolygonNews,
  parseYahooNews,
  parseYahooStatements,
  parseYahooSummary,
  reportLinks,
  titleKey,
  type CalendarData,
  type FinancialsData,
  type RawNews
} from '@main/research/parsers';
import { isPublicHttps, type ResearchSources } from '@main/research/sources';
import { getNews, NEWS_TTL_MS } from '@main/services/news';
import { computeLatest, FIN_TTL_MS, getEarningsCalendar, getFinancials, latestReportDates, upcomingReports } from '@main/services/financials';
import { emptySet } from '@main/research/parsers';

/* ------------------------------------------------------------- răspunsuri-model */

const yahooSearch = {
  news: [
    {
      uuid: 'a',
      title: 'Apple lansează un produs nou',
      publisher: 'Trefis',
      link: 'https://finance.yahoo.com/markets/stocks/articles/apple-nou-162548783.html',
      providerPublishTime: '2026-11-13T16:25:48.000Z',
      thumbnail: {
        resolutions: [
          { url: 'https://media.zenfs.com/original.jpg', width: 1280, height: 802, tag: 'original' },
          { url: 'https://s.yimg.com/small.jpg', width: 140, height: 140, tag: '140x140' }
        ]
      },
      relatedTickers: ['AAPL', 'MSFT']
    },
    { uuid: 'b', title: 'Link nesigur', publisher: 'X', link: 'http://example.com/a', providerPublishTime: '2026-11-13T10:00:00.000Z' },
    { uuid: 'c', title: 'Fără dată', publisher: 'X', link: 'https://example.com/c' }
  ]
};

const yahooSummary = {
  calendarEvents: { earnings: { earningsDate: ['2027-01-28T21:00:00.000Z'], isEarningsDateEstimate: true, earningsAverage: 2.91, revenueAverage: 156e9 } },
  earnings: {
    financialCurrency: 'USD',
    earningsChart: {
      quarterly: [
        { date: '2Q2026', actual: 2.02, estimate: 1.89, periodEndDate: '2026-06-30T00:00:00.000Z', reportedDate: '2026-07-30T20:30:28.000Z' },
        { date: '3Q2026', actual: 2.1, estimate: 1.98, periodEndDate: '2026-09-30T00:00:00.000Z', reportedDate: '2026-11-02T21:30:00.000Z' }
      ]
    }
  },
  assetProfile: { website: 'https://www.apple.com', irWebsite: 'https://investor.apple.com' }
};

/** Rânduri fundamentalsTimeSeries (modulul „all”): trimestre, primul incomplet. */
const yahooRows = [
  { date: new Date('2025-09-30'), totalRevenue: 100, netIncome: 20, dilutedEPS: 1.0, totalAssets: 500, totalLiabilitiesNetMinorityInterest: 300, stockholdersEquity: 200, operatingCashFlow: 30, capitalExpenditure: -5, freeCashFlow: 25 },
  { date: new Date('2025-12-31'), totalRevenue: 130, netIncome: 30, dilutedEPS: 1.5 },
  { date: new Date('2026-03-31') },
  { date: new Date('2026-06-30'), totalRevenue: 110, netIncome: 22, dilutedEPS: 1.1 },
  { date: new Date('2026-09-30'), totalRevenue: 120, grossProfit: 60, operatingIncome: 35, netIncome: 33, dilutedEPS: 1.65 }
];

const polygonNews = {
  results: [
    {
      title: 'Apple lansează un produs nou!',
      publisher: { name: 'Benzinga' },
      article_url: 'https://www.benzinga.com/apple-nou',
      published_utc: '2026-11-13T16:30:00Z',
      image_url: 'https://cdn.example.com/p.jpg',
      tickers: ['AAPL'],
      description: 'Rezumat'
    }
  ]
};

const alphaNews = {
  feed: [{ title: 'Altă știre', url: 'https://example.org/alta', time_published: '20261113T101500', source: 'Reuters', summary: 's', banner_image: 'https://example.org/b.png', ticker_sentiment: [{ ticker: 'AAPL' }] }]
};

/* ---------------------------------------------------------------- parseri */

describe('parserii providerilor', () => {
  it('Yahoo: știri cu imaginea cea mai mică, fără adrese nesigure', () => {
    const news = parseYahooNews(yahooSearch);
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ source: 'Trefis', publishedAt: '2026-11-13T16:25:48.000Z', thumbUrl: 'https://s.yimg.com/small.jpg', symbols: ['AAPL', 'MSFT'], provider: 'yahoo' });
    expect(parseYahooNews(null)).toEqual([]);
  });

  it('Polygon și Alpha Vantage: știri', () => {
    expect(parsePolygonNews(polygonNews)[0]).toMatchObject({ source: 'Benzinga', summary: 'Rezumat', thumbUrl: 'https://cdn.example.com/p.jpg', provider: 'polygon' });
    expect(parseAlphaNews(alphaNews)[0]).toMatchObject({ source: 'Reuters', publishedAt: '2026-11-13T10:15:00.000Z', symbols: ['AAPL'], provider: 'alphavantage' });
  });

  it('Yahoo: data următoarei raportări, EPS real/estimat și ultima raportare publicată', () => {
    const s = parseYahooSummary(yahooSummary);
    expect(s.next).toEqual({ date: '2027-01-28', estimated: true, epsEstimate: 2.91, revenueEstimate: 156e9 });
    expect(s.eps.map((q) => [q.periodEnd, q.epsActual, q.epsEstimate])).toEqual([
      ['2026-06-30', 2.02, 1.89],
      ['2026-09-30', 2.1, 1.98]
    ]);
    expect(s.eps[1].surprisePct).toBeCloseTo(0.0606, 3);
    expect(s).toMatchObject({ currency: 'USD', website: 'https://www.apple.com/', investors: 'https://investor.apple.com/', lastReportedDate: '2026-11-02', lastPeriodEnd: '2026-09-30' });
    expect(parseYahooSummary({}).next).toBeNull();
  });

  it('Yahoo: situațiile financiare pe tipuri; rândurile goale se ignoră', () => {
    const set = parseYahooStatements(yahooRows);
    expect(set.income.map((p) => p.end)).toEqual(['2025-09-30', '2025-12-31', '2026-06-30', '2026-09-30']);
    expect(set.income[3].values).toEqual({ revenue: 120, grossProfit: 60, operatingIncome: 35, netIncome: 33, eps: 1.65 });
    expect(set.balance).toHaveLength(1);
    expect(set.balance[0].values).toMatchObject({ totalAssets: 500, totalLiabilities: 300, equity: 200 });
    expect(set.cashflow[0].values).toMatchObject({ operating: 30, capex: -5, freeCashFlow: 25 });
  });

  it('Polygon: situații financiare', () => {
    const set = parsePolygonFinancials({
      results: [
        {
          end_date: '2026-06-30',
          financials: {
            income_statement: { revenues: { value: 500 }, net_income_loss: { value: 50 }, diluted_earnings_per_share: { value: 0.5 } },
            balance_sheet: { assets: { value: 900 }, liabilities: { value: 400 }, equity: { value: 500 } },
            cash_flow_statement: { net_cash_flow_from_operating_activities: { value: 70 } }
          }
        }
      ]
    });
    expect(set.income[0]).toEqual({ end: '2026-06-30', values: { revenue: 500, grossProfit: null, operatingIncome: null, netIncome: 50, eps: 0.5 } });
    expect(set.balance[0].values.equity).toBe(500);
    expect(set.cashflow[0].values.operating).toBe(70);
  });

  it('Alpha Vantage: situații, EPS și calendar (CSV)', () => {
    const set = parseAlphaStatements(
      { quarterlyReports: [{ fiscalDateEnding: '2026-06-30', totalRevenue: '1000', netIncome: 'None', grossProfit: '400', operatingIncome: '150' }], annualReports: [] },
      { quarterlyReports: [{ fiscalDateEnding: '2026-06-30', totalAssets: '5000', totalLiabilities: '3000', totalShareholderEquity: '2000' }] },
      { quarterlyReports: [{ fiscalDateEnding: '2026-06-30', operatingCashflow: '300', capitalExpenditures: '50' }] }
    );
    expect(set.quarterly.income[0].values).toMatchObject({ revenue: 1000, netIncome: null, grossProfit: 400 });
    expect(set.quarterly.balance[0].values.equity).toBe(2000);
    // capex-ul pozitiv de la provider devine ieșire de bani (negativ)
    expect(set.quarterly.cashflow[0].values).toMatchObject({ operating: 300, capex: -50, freeCashFlow: 250 });
    expect(set.annual.income).toEqual([]);

    const eps = parseAlphaEarnings({ quarterlyEarnings: [{ fiscalDateEnding: '2026-06-30', reportedDate: '2026-07-30', reportedEPS: '2.02', estimatedEPS: '1.89' }] });
    expect(eps[0]).toMatchObject({ periodEnd: '2026-06-30', reportedDate: '2026-07-30', epsActual: 2.02 });

    const csv = 'symbol,name,reportDate,fiscalDateEnding,estimate,currency\nIBM,International Business,2027-01-20,2026-12-31,3.5,USD\nIBM,International Business,2026-10-20,2026-09-30,2.1,USD\nAAPL,Apple,2027-01-28,2026-12-31,2.9,USD\n';
    expect(parseAlphaCalendar(csv, 'IBM', '2026-11-13')).toEqual({ date: '2027-01-20', estimated: true, epsEstimate: 3.5, revenueEstimate: null });
    expect(parseAlphaCalendar('Information,x', 'IBM', '2026-11-13')).toBeNull();
  });

  it('linkurile oficiale: BVB pentru .RO, SEC pentru SUA, nimic pentru ceilalți', () => {
    expect(reportLinks('TLV.RO', 'stock', 'https://www.bancatransilvania.ro/', null)).toMatchObject({
      website: 'https://www.bancatransilvania.ro/',
      bvb: 'https://bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=TLV',
      sec: null
    });
    expect(reportLinks('AAPL', 'stock', null, null).sec).toContain('CIK=AAPL');
    expect(reportLinks('SAP.DE', 'stock', null, null)).toMatchObject({ bvb: null, sec: null });
  });

  it('titlurile se compară fără diacritice și semne; imaginile vin doar de la adrese publice https', () => {
    expect(titleKey('Apple lansează un produs nou!')).toBe(titleKey('apple lanseaza un  produs nou'));
    expect(isPublicHttps('https://media.example.com/a.jpg')).toBe(true);
    for (const bad of ['http://a.com/x.jpg', 'https://localhost/x.jpg', 'https://127.0.0.1/x.jpg', 'https://[::1]/x.jpg', 'file:///c:/x.jpg']) expect(isPublicHttps(bad)).toBe(false);
  });
});

/* --------------------------------------------------------------- servicii */

type Fn<T> = (symbol: string, type: AssetType) => Promise<T>;

/** Surse simulate: răspunsuri fixe pe simbol, contor de apeluri și eșec la cerere. */
class FakeSources implements ResearchSources {
  calls: string[] = [];
  failWith: Error | null = null;
  newsBySymbol: Record<string, RawNews[]> = {};
  fin: Record<string, FinancialsData | null> = {};
  cal: Record<string, CalendarData | null> = {};
  thumbs = 0;
  async news(symbol: string, _type: AssetType, opts: { extra: boolean }) {
    this.calls.push(`news:${symbol}${opts.extra ? '+' : ''}`);
    if (this.failWith) throw this.failWith;
    return this.newsBySymbol[symbol] ?? [];
  }
  async thumbnail(url: string) {
    this.thumbs++;
    if (this.failWith || url.includes('bad')) return null;
    return { data: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' };
  }
  financials: Fn<FinancialsData | null> = async (symbol) => {
    this.calls.push(`fin:${symbol}`);
    if (this.failWith) throw this.failWith;
    return this.fin[symbol] ?? null;
  };
  calendar: Fn<CalendarData | null> = async (symbol) => {
    this.calls.push(`cal:${symbol}`);
    if (this.failWith) throw this.failWith;
    return this.cal[symbol] ?? null;
  };
}

const raw = (over: Partial<RawNews> & { title: string; url: string }): RawNews => ({
  source: 'Sursa',
  publishedAt: '2026-11-13T10:00:00.000Z',
  summary: null,
  thumbUrl: null,
  symbols: [],
  provider: 'yahoo',
  ...over
});

let db: Db;
let ana: User;
let dan: User;
const NOW = Date.parse('2026-11-13T12:00:00Z');
const networkDown = () => new ProviderError('network', 'Conexiune eșuată');

beforeAll(async () => {
  db = openDatabase(':memory:');
  ana = await register(db, { username: 'ana', password: 'parola-ana-1' });
  dan = await register(db, { username: 'dan', password: 'parola-dan-1' });
});
afterAll(() => db.close());

beforeEach(() => {
  for (const table of ['research_cache', 'transactions', 'watchlist_items', 'assets', 'brokers']) db.prepare(`DELETE FROM ${table}`).run();
  const broker = createBroker(db, ana.id, { name: 'XTB' });
  const buy = (type: AssetType, symbol: string, currency: string) =>
    addPurchase(db, ana.id, { asset: { type, symbol, currency, name: symbol === 'AAPL' ? 'Apple' : symbol }, brokerId: broker.id, date: '2026-01-05', quantity: 2, price: 100, fee: 0 });
  buy('stock', 'AAPL', 'USD');
  buy('stock', 'TLV.RO', 'RON');
  buy('etf', 'VWCE.DE', 'EUR');
  addWatchlistItem(db, ana.id, listWatchlists(db, ana.id)[0].id, { symbol: 'NVDA', type: 'stock', currency: 'USD' });
});

describe('știri', () => {
  it('combină providerii și elimină dublurile (aceeași adresă sau același titlu)', async () => {
    const src = new FakeSources();
    src.newsBySymbol.AAPL = [
      raw({ title: 'Apple lansează un produs nou', url: 'https://finance.yahoo.com/a', thumbUrl: 'https://s.yimg.com/s.jpg', symbols: ['AAPL', 'NVDA'] }),
      raw({ title: 'Apple lansează un produs nou!', url: 'https://www.benzinga.com/apple', provider: 'polygon', summary: 'Rezumat', publishedAt: '2026-11-13T09:55:00.000Z' }),
      raw({ title: 'Alta', url: 'https://example.org/alta', publishedAt: '2026-11-12T10:00:00.000Z', provider: 'alphavantage' })
    ];
    const feed = await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW);
    expect(feed.items.map((i) => i.title)).toEqual(['Apple lansează un produs nou', 'Alta']);
    expect(feed.items[0]).toMatchObject({ summary: 'Rezumat', providers: ['yahoo', 'polygon'], symbols: ['AAPL', 'NVDA'] });
    expect(feed.items[0].thumbnail).toBe(`data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
    expect(feed).toMatchObject({ stale: false, offline: false, error: null, symbolCount: 1 });
    // un singur simbol: se cer și providerii cu cheie
    expect(src.calls).toEqual(['news:AAPL+']);
  });

  it('filtrele: toate (portofoliu + watchlist), doar portofoliul; ETF-ul are știri, obligațiunile nu', async () => {
    const src = new FakeSources();
    await getNews(db, ana.id, {}, src, NOW);
    expect(src.calls.sort()).toEqual(['news:AAPL', 'news:NVDA', 'news:TLV.RO', 'news:VWCE.DE']);
    src.calls = [];
    const feed = await getNews(db, ana.id, { portfolioOnly: true, force: true }, src, NOW);
    expect(src.calls.sort()).toEqual(['news:AAPL', 'news:TLV.RO', 'news:VWCE.DE']);
    expect(feed.symbolCount).toBe(3);
    await expect(getNews(db, ana.id, { symbol: 'TSLA' }, src, NOW)).rejects.toThrow(/nu este în portofoliu/);
  });

  it('cache de 30 de minute; „force” și expirarea cer din nou', async () => {
    const src = new FakeSources();
    src.newsBySymbol.AAPL = [raw({ title: 'Una', url: 'https://example.org/1' })];
    await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW);
    await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW + NEWS_TTL_MS - 1000);
    expect(src.calls).toHaveLength(1);
    await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW + NEWS_TTL_MS + 1000);
    await getNews(db, ana.id, { symbol: 'AAPL', force: true }, src, NOW + NEWS_TTL_MS + 2000);
    expect(src.calls).toHaveLength(3);
  });

  it('la eșec se arată cache-ul (stale); fără cache și fără internet: eroare „offline”', async () => {
    const src = new FakeSources();
    src.newsBySymbol.AAPL = [raw({ title: 'Una', url: 'https://example.org/1' })];
    await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW);
    src.failWith = networkDown();
    const later = await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW + 2 * NEWS_TTL_MS);
    expect(later.items).toHaveLength(1);
    expect(later).toMatchObject({ stale: true, offline: true, error: null, fetchedAt: new Date(NOW).toISOString() });

    const none = await getNews(db, ana.id, { symbol: 'NVDA' }, src, NOW);
    expect(none).toMatchObject({ items: [], offline: true, error: 'Fără conexiune la internet.' });
    src.failWith = new Error('boom');
    expect((await getNews(db, ana.id, { symbol: 'NVDA' }, src, NOW)).error).toMatch(/Nu am putut încărca/);
  });

  it('imaginile se descarcă o singură dată; cele eșuate nu blochează știrea', async () => {
    const src = new FakeSources();
    src.newsBySymbol.AAPL = [raw({ title: 'Una', url: 'https://example.org/1', thumbUrl: 'https://img.example.org/ok.jpg' }), raw({ title: 'Doua', url: 'https://example.org/2', thumbUrl: 'https://img.example.org/bad.jpg' })];
    const first = await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW);
    expect(first.items.find((i) => i.title === 'Una')!.thumbnail).toMatch(/^data:image\/jpeg;base64,/);
    const bad = first.items.find((i) => i.title === 'Doua')!;
    expect(bad.thumbnail).toBeNull();
    const downloads = src.thumbs;
    await getNews(db, ana.id, { symbol: 'AAPL', force: true }, src, NOW + 1000);
    expect(src.thumbs).toBe(downloads); // și cea eșuată se reîncearcă abia după o zi
  });

  it('cache-ul este al fiecărui utilizator și nu intră în backup', async () => {
    const src = new FakeSources();
    src.newsBySymbol.AAPL = [raw({ title: 'Una', url: 'https://example.org/1' })];
    await getNews(db, ana.id, { symbol: 'AAPL' }, src, NOW);
    // Dan nu are active: nimic de arătat, și nicio cerere.
    expect(await getNews(db, dan.id, {}, src, NOW)).toMatchObject({ items: [], symbolCount: 0 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM research_cache WHERE user_id = ?').get(dan.id) as { n: number }).n).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), 'pb-research-'));
    try {
      const file = join(dir, 'backup.db');
      createBackup(db, ana.id, file);
      const backup = new Database(file, { readonly: true });
      const tables = (backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      // Schema este aceeași, dar cache-ul (știri, raportări, imagini) nu se exportă.
      const cached = tables.includes('research_cache') ? (backup.prepare('SELECT COUNT(*) AS n FROM research_cache').get() as { n: number }).n : 0;
      backup.close();
      expect(tables).toContain('transactions');
      expect(cached).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const aaplFin = (over: Partial<FinancialsData> = {}): FinancialsData => ({
  name: null,
  currency: 'USD',
  next: { date: '2026-11-20', estimated: false, epsEstimate: 2.9, revenueEstimate: 150e9 },
  eps: [
    { periodEnd: '2025-09-30', reportedDate: '2025-10-30', epsActual: 1.0, epsEstimate: 1.0, surprisePct: 0 },
    { periodEnd: '2026-09-30', reportedDate: '2026-11-02', epsActual: 1.65, epsEstimate: 1.5, surprisePct: 0.1 }
  ],
  statements: parseYahooStatementsFor(),
  website: 'https://www.apple.com/',
  investors: null,
  sources: ['yahoo'],
  ...over
});

function parseYahooStatementsFor() {
  return { quarterly: parseYahooStatements(yahooRows), annual: emptySet() };
}

describe('raportări financiare', () => {
  it('ultimele rezultate: față de anul trecut și față de estimare', () => {
    const latest = computeLatest(parseYahooStatementsFor(), aaplFin().eps);
    expect(latest).toMatchObject({ periodEnd: '2026-09-30', reportedDate: '2026-11-02', revenue: 120, netIncome: 33, epsActual: 1.65, epsEstimate: 1.5, verdict: 'beat' });
    // aceeași perioadă din 2025: venituri 100, profit 20, EPS 1,0
    expect(latest!.revenueChangePct).toBeCloseTo(0.2, 10);
    expect(latest!.netIncomeChangePct).toBeCloseTo(0.65, 10);
    expect(latest!.epsChangePct).toBeCloseTo(0.65, 10);

    const miss = computeLatest(parseYahooStatementsFor(), [{ periodEnd: '2026-09-30', reportedDate: null, epsActual: 1.0, epsEstimate: 1.5, surprisePct: -0.33 }]);
    expect(miss!.verdict).toBe('miss');
    const inline = computeLatest(parseYahooStatementsFor(), [{ periodEnd: '2026-09-30', reportedDate: null, epsActual: 1.505, epsEstimate: 1.5, surprisePct: 0.003 }]);
    expect(inline!.verdict).toBe('inline');
    expect(computeLatest({ quarterly: emptySet(), annual: emptySet() }, [])).toBeNull();
  });

  it('ETF-urile, obligațiunile și crypto: stare „nesuportat”, fără cereri și fără eroare', async () => {
    const src = new FakeSources();
    const etf = await getFinancials(db, ana.id, 'VWCE.DE', 'etf', src, { now: NOW });
    expect(etf).toMatchObject({ supported: false, error: null, offline: false });
    expect(etf.reason).toMatch(/nu publică/);
    const crypto = await getFinancials(db, ana.id, 'BTC-USD', 'crypto', src, { now: NOW });
    expect(crypto.supported).toBe(false);
    expect(src.calls).toEqual([]);
  });

  it('o companie: date complete, cache de 12 ore, rezervă pe cache fără internet', async () => {
    const src = new FakeSources();
    src.fin.AAPL = aaplFin();
    const first = await getFinancials(db, ana.id, 'aapl', 'stock', src, { now: NOW });
    expect(first).toMatchObject({ symbol: 'AAPL', name: 'Apple', supported: true, currency: 'USD', error: null, stale: false });
    expect(first.next).toMatchObject({ date: '2026-11-20', estimated: false });
    expect(first.links.sec).toContain('AAPL');
    expect(first.eps).toHaveLength(2);

    await getFinancials(db, ana.id, 'AAPL', 'stock', src, { now: NOW + FIN_TTL_MS - 1000 });
    expect(src.calls).toEqual(['fin:AAPL']);

    src.failWith = networkDown();
    const offline = await getFinancials(db, ana.id, 'AAPL', 'stock', src, { now: NOW + FIN_TTL_MS + 1000 });
    expect(offline).toMatchObject({ stale: true, offline: true, error: null, fetchedAt: new Date(NOW).toISOString() });
    expect(offline.latest?.revenue).toBe(120);

    // Fără cache și fără internet: eroare cu „Încearcă din nou”, nu excepție.
    const nvda = await getFinancials(db, ana.id, 'NVDA', 'stock', src, { now: NOW });
    expect(nvda).toMatchObject({ supported: true, offline: true, error: 'Fără conexiune la internet.' });
  });

  it('o acțiune fără raportări la nicio sursă este „nesuportată”, nu eroare', async () => {
    const src = new FakeSources();
    const r = await getFinancials(db, ana.id, 'TLV.RO', 'stock', src, { now: NOW });
    expect(r).toMatchObject({ supported: false, error: null });
    expect(r.links.bvb).toContain('s=TLV');
  });

  it('calendarul: data următoare, acțiunile fără dată la final, ETF-urile nu apar', async () => {
    const src = new FakeSources();
    src.cal.AAPL = { next: { date: '2026-11-20', estimated: false, epsEstimate: 2.9, revenueEstimate: null }, lastReportedDate: '2026-11-02', lastPeriodEnd: '2026-09-30' };
    src.cal['TLV.RO'] = { next: { date: '2026-11-16', estimated: true, epsEstimate: null, revenueEstimate: null }, lastReportedDate: null, lastPeriodEnd: null };
    // o dată din trecut înseamnă că sursa nu a trecut încă la următoarea: se ignoră
    src.cal.NVDA = { next: { date: '2026-11-01', estimated: false, epsEstimate: null, revenueEstimate: null }, lastReportedDate: null, lastPeriodEnd: null };
    const cal = await getEarningsCalendar(db, ana.id, {}, src, NOW);
    expect(cal.entries.map((e) => [e.symbol, e.date, e.daysUntil, e.held])).toEqual([
      ['TLV.RO', '2026-11-16', 3, true],
      ['AAPL', '2026-11-20', 7, true],
      ['NVDA', null, null, false]
    ]);
    expect(cal.entries[0].estimated).toBe(true);
    expect(src.calls.some((c) => c.includes('VWCE'))).toBe(false);
    const held = await getEarningsCalendar(db, ana.id, { portfolioOnly: true }, src, NOW);
    expect(held.entries.map((e) => e.symbol)).toEqual(['TLV.RO', 'AAPL']);
  });

  it('calendarul fără internet și fără cache: eroare; cu cache vechi: datele din cache', async () => {
    const src = new FakeSources();
    src.failWith = networkDown();
    expect(await getEarningsCalendar(db, ana.id, {}, src, NOW)).toMatchObject({ offline: true, error: 'Fără conexiune la internet.' });
    src.failWith = null;
    src.cal.AAPL = { next: { date: '2026-11-20', estimated: false, epsEstimate: null, revenueEstimate: null }, lastReportedDate: null, lastPeriodEnd: null };
    await getEarningsCalendar(db, ana.id, {}, src, NOW);
    src.failWith = networkDown();
    const cached = await getEarningsCalendar(db, ana.id, {}, src, NOW + 24 * 3_600_000);
    expect(cached.error).toBeNull();
    expect(cached.entries.find((e) => e.symbol === 'AAPL')?.date).toBe('2026-11-20');
  });
});

describe('funcții pentru alerte', () => {
  it('upcomingReports: doar companiile deținute, în fereastra cerută, cele mai apropiate întâi', async () => {
    const src = new FakeSources();
    src.cal.AAPL = { next: { date: '2026-11-16', estimated: false, epsEstimate: 2.9, revenueEstimate: null }, lastReportedDate: '2026-08-01', lastPeriodEnd: '2026-06-30' };
    src.cal['TLV.RO'] = { next: { date: '2026-12-30', estimated: true, epsEstimate: null, revenueEstimate: null }, lastReportedDate: null, lastPeriodEnd: null };
    src.cal.NVDA = { next: { date: '2026-11-14', estimated: false, epsEstimate: null, revenueEstimate: null }, lastReportedDate: null, lastPeriodEnd: null };
    const soon = await upcomingReports(db, ana.id, src, { withinDays: 7, now: NOW });
    expect(soon).toEqual([{ symbol: 'AAPL', name: 'Apple', date: '2026-11-16', daysUntil: 3, estimated: false, epsEstimate: 2.9 }]);
    const month = await upcomingReports(db, ana.id, src, { now: NOW });
    expect(month.map((r) => r.symbol)).toEqual(['AAPL']);
    const quarter = await upcomingReports(db, ana.id, src, { withinDays: 60, now: NOW });
    expect(quarter.map((r) => [r.symbol, r.daysUntil])).toEqual([
      ['AAPL', 3],
      ['TLV.RO', 47]
    ]);
    // utilizatorul fără active nu primește nimic
    expect(await upcomingReports(db, dan.id, src, { now: NOW })).toEqual([]);
  });

  it('latestReportDates: data ultimei raportări publicate pentru fiecare companie deținută', async () => {
    const src = new FakeSources();
    src.cal.AAPL = { next: null, lastReportedDate: '2026-11-02', lastPeriodEnd: '2026-09-30' };
    const dates = await latestReportDates(db, ana.id, src, { now: NOW });
    expect(dates).toEqual([
      { symbol: 'AAPL', name: 'Apple', reportedDate: '2026-11-02', periodEnd: '2026-09-30' },
      { symbol: 'TLV.RO', name: 'TLV.RO', reportedDate: null, periodEnd: null }
    ]);
  });

  it('o sursă care eșuează nu strică celelalte simboluri', async () => {
    const src = new FakeSources();
    src.cal.AAPL = { next: { date: '2026-11-16', estimated: false, epsEstimate: null, revenueEstimate: null }, lastReportedDate: null, lastPeriodEnd: null };
    const orig = src.calendar;
    src.calendar = async (symbol, type) => {
      if (symbol === 'TLV.RO') throw networkDown();
      return orig(symbol, type);
    };
    expect((await upcomingReports(db, ana.id, src, { now: NOW })).map((r) => r.symbol)).toEqual(['AAPL']);
  });
});
