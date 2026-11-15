/**
 * Pagina unei companii găsite la căutare (poate să nu fie în portofoliu sau în watchlist): știrile,
 * raportările și profilul vin de la surse, stau doar în memorie și nu schimbă nimic în baza de date
 * (sincronizarea contului compară datele utilizatorului). Surse simulate, fără rețea.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssetType, User } from '@shared/types';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase } from '@main/services/transactions';
import { ProviderError } from '@main/prices/provider';
import { emptySet, parseYahooProfile, type CalendarData, type FinancialsData, type ProfileData, type RawNews } from '@main/research/parsers';
import type { ResearchSources } from '@main/research/sources';
import { getNews } from '@main/services/news';
import { getCompanyProfile, getFinancials } from '@main/services/financials';

class FakeSources implements ResearchSources {
  calls: string[] = [];
  failWith: Error | null = null;
  newsBySymbol: Record<string, RawNews[]> = {};
  fin: Record<string, FinancialsData | null> = {};
  profiles: Record<string, ProfileData | null> = {};
  async news(symbol: string, _type: AssetType, opts: { extra: boolean }) {
    this.calls.push(`news:${symbol}${opts.extra ? '+' : ''}`);
    if (this.failWith) throw this.failWith;
    return this.newsBySymbol[symbol] ?? [];
  }
  async thumbnail(url: string) {
    this.calls.push(`thumb:${url}`);
    return { data: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' };
  }
  async financials(symbol: string) {
    this.calls.push(`fin:${symbol}`);
    if (this.failWith) throw this.failWith;
    return this.fin[symbol] ?? null;
  }
  async calendar(): Promise<CalendarData | null> {
    return null;
  }
  async profile(symbol: string) {
    this.calls.push(`profile:${symbol}`);
    if (this.failWith) throw this.failWith;
    return this.profiles[symbol] ?? null;
  }
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

const finData = (): FinancialsData => ({
  name: null,
  currency: 'USD',
  next: { date: '2099-02-20', estimated: false, epsEstimate: 0.85, revenueEstimate: null },
  eps: [{ periodEnd: '2026-07-31', reportedDate: '2026-08-27', epsActual: 0.68, epsEstimate: 0.64, surprisePct: 0.06 }],
  statements: { quarterly: emptySet(), annual: emptySet() },
  website: 'https://www.nvidia.com',
  investors: null,
  sources: ['yahoo']
});

let db: Db;
let ana: User;
const networkDown = () => new ProviderError('network', 'Conexiune eșuată');
const changes = (): number => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
const cacheRows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM research_cache').get() as { n: number }).n;

beforeAll(async () => {
  db = openDatabase(':memory:');
  ana = await register(db, { username: 'ana-companie', password: 'parola-ana-1' });
  const broker = createBroker(db, ana.id, { name: 'XTB' });
  addPurchase(db, ana.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD', name: 'Apple' }, brokerId: broker.id, date: '2026-01-05', quantity: 2, price: 100, fee: 0 });
});
afterAll(() => db.close());
beforeEach(() => db.prepare('DELETE FROM research_cache').run());

describe('știrile unui simbol oarecare', () => {
  it('cu tipul dat: se descarcă, se combină dublurile, stau în memorie și nu se scrie nimic în baza de date', async () => {
    const src = new FakeSources();
    src.newsBySymbol.TSLA = [
      raw({ title: 'Tesla livrează mai multe mașini', url: 'https://ex.com/a', publishedAt: '2026-11-12T10:00:00.000Z', thumbUrl: 'https://img.ex.com/a.jpg' }),
      raw({ title: 'Tesla livrează mai multe mașini!', url: 'https://alt.com/a2', publishedAt: '2026-11-12T09:00:00.000Z' }),
      raw({ title: 'Raport nou', url: 'https://ex.com/b', publishedAt: '2026-11-13T08:00:00.000Z' })
    ];
    const before = changes();
    const feed = await getNews(db, ana.id, { symbol: 'tsla', type: 'stock' }, src);
    expect(feed).toMatchObject({ error: null, offline: false, symbolCount: 1 });
    expect(feed.items.map((i) => i.title)).toEqual(['Raport nou', 'Tesla livrează mai multe mașini']);
    expect(feed.items[1].thumbnail).toMatch(/^data:image\/jpeg;base64,/);
    expect(feed.items[0].symbols).toEqual(['TSLA']);

    await getNews(db, ana.id, { symbol: 'TSLA', type: 'stock' }, src);
    expect(src.calls.filter((c) => c.startsWith('news:'))).toEqual(['news:TSLA+']);
    await getNews(db, ana.id, { symbol: 'TSLA', type: 'stock', force: true }, src);
    expect(src.calls.filter((c) => c.startsWith('news:'))).toHaveLength(2);

    expect(cacheRows()).toBe(0);
    expect(changes()).toBe(before);
  });

  it('fără tip, un simbol străin rămâne refuzat (comportamentul paginii Știri)', async () => {
    await expect(getNews(db, ana.id, { symbol: 'TSLA' }, new FakeSources())).rejects.toThrow(/nu este în portofoliu/);
  });

  it('un simbol din portofoliu folosește în continuare cache-ul obișnuit', async () => {
    const src = new FakeSources();
    src.newsBySymbol.AAPL = [raw({ title: 'Apple', url: 'https://ex.com/apple' })];
    await getNews(db, ana.id, { symbol: 'AAPL', type: 'stock' }, src);
    expect(cacheRows()).toBeGreaterThan(0);
  });

  it('fără internet: mesaj „offline”, fără excepție, iar eșecul nu rămâne în memorie', async () => {
    const src = new FakeSources();
    src.failWith = networkDown();
    const feed = await getNews(db, ana.id, { symbol: 'AMD', type: 'stock' }, src);
    expect(feed).toMatchObject({ items: [], offline: true, error: 'Fără conexiune la internet.' });
    src.failWith = null;
    src.newsBySymbol.AMD = [raw({ title: 'AMD', url: 'https://ex.com/amd' })];
    expect((await getNews(db, ana.id, { symbol: 'AMD', type: 'stock' }, src)).items).toHaveLength(1);
  });
});

describe('raportările unui simbol oarecare', () => {
  it('se calculează la fel, stau în memorie (o singură cerere) și nu ating baza de date', async () => {
    const src = new FakeSources();
    src.fin.NVDA = finData();
    const before = changes();
    const first = await getFinancials(db, ana.id, 'nvda', 'stock', src);
    expect(first).toMatchObject({ symbol: 'NVDA', supported: true, currency: 'USD', error: null });
    expect(first.next?.date).toBe('2099-02-20');
    expect(first.eps).toHaveLength(1);
    await getFinancials(db, ana.id, 'NVDA', 'stock', src);
    expect(src.calls).toEqual(['fin:NVDA']);
    await getFinancials(db, ana.id, 'NVDA', 'stock', src, { force: true });
    expect(src.calls).toEqual(['fin:NVDA', 'fin:NVDA']);
    expect(cacheRows()).toBe(0);
    expect(changes()).toBe(before);
  });

  it('fără internet: eroare „offline”, fără excepție; fără raportări: „nesuportat”', async () => {
    const src = new FakeSources();
    src.failWith = networkDown();
    expect(await getFinancials(db, ana.id, 'INTC', 'stock', src)).toMatchObject({ offline: true, error: 'Fără conexiune la internet.' });
    src.failWith = null;
    expect(await getFinancials(db, ana.id, 'INTC', 'stock', src)).toMatchObject({ supported: false, error: null });
    expect(await getFinancials(db, ana.id, 'SPY', 'etf', src)).toMatchObject({ supported: false });
  });
});

describe('profilul companiei', () => {
  it('parserul Yahoo: acțiune, ETF, crypto; fără date, null', () => {
    expect(
      parseYahooProfile({
        assetProfile: { sector: 'Technology', industry: 'Semiconductors', country: 'United States', website: 'https://www.nvidia.com', longBusinessSummary: ' NVIDIA ... ', fullTimeEmployees: 36000 },
        price: { longName: 'NVIDIA Corporation', exchangeName: 'NasdaqGS', currency: 'USD' }
      })
    ).toEqual({
      name: 'NVIDIA Corporation',
      sector: 'Technology',
      industry: 'Semiconductors',
      country: 'United States',
      website: 'https://www.nvidia.com/',
      description: 'NVIDIA ...',
      employees: 36000,
      exchange: 'NasdaqGS',
      currency: 'USD',
      fundFamily: null
    });
    const etf = parseYahooProfile({ fundProfile: { categoryName: 'Global Large-Stock Blend', family: 'Vanguard' }, summaryProfile: { longBusinessSummary: 'Fond' }, price: { shortName: 'VWCE', currency: 'EUR' } });
    expect(etf).toMatchObject({ sector: 'Global Large-Stock Blend', fundFamily: 'Vanguard', description: 'Fond', name: 'VWCE' });
    expect(parseYahooProfile({ summaryProfile: { description: 'Bitcoin', website: 'javascript:alert(1)' } })).toMatchObject({ description: 'Bitcoin', website: null });
    expect(parseYahooProfile({ price: { currency: 'GBp' } })?.currency).toBe('GBP');
    expect(parseYahooProfile({})).toBeNull();
  });

  it('serviciul: o singură cerere (memorie), fără DB, offline fără excepție, obligațiunile fără cereri', async () => {
    const src = new FakeSources();
    src.profiles.MSFT = { name: 'Microsoft', sector: 'Technology', industry: null, country: 'United States', website: null, description: 'Software', employees: null, exchange: null, currency: 'USD', fundFamily: null };
    const before = changes();
    const p = await getCompanyProfile(ana.id, 'msft', 'stock', src);
    expect(p).toMatchObject({ symbol: 'MSFT', name: 'Microsoft', sector: 'Technology', description: 'Software', offline: false, error: null });
    await getCompanyProfile(ana.id, 'MSFT', 'stock', src);
    expect(src.calls).toEqual(['profile:MSFT']);
    expect(changes()).toBe(before);

    const down = new FakeSources();
    down.failWith = networkDown();
    expect(await getCompanyProfile(ana.id, 'ORCL', 'stock', down)).toMatchObject({ name: null, offline: true, error: 'Fără conexiune la internet.' });

    const none = new FakeSources();
    expect(await getCompanyProfile(ana.id, 'RO1234', 'bond', none)).toMatchObject({ name: null, error: null });
    expect(none.calls).toEqual([]);
    expect(await getCompanyProfile(ana.id, 'XYZ', 'stock', none)).toMatchObject({ name: null, description: null, error: null });
  });
});
