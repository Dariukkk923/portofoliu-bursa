/**
 * Previzualizarea unui simbol căutat (graficul 1L / 3L / 6L / YTD / 1A): tăierea istoricului pe perioadă,
 * variația, cache-ul din memorie, rezerva între provideri, eșecurile fără excepții și faptul că nimic
 * nu ajunge în baza de date (sincronizarea contului compară datele utilizatorului).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId, User } from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import { openDatabase, type Db } from '@main/db/database';
import { createAesBox } from '@main/secrets';
import { register } from '@main/services/auth';
import { setApiKey, updateSettings } from '@main/services/settings';
import { ProviderError, type HistoryOptions, type HistoryResult, type PriceProvider, type SymbolRef } from '@main/prices/provider';
import { PriceService } from '@main/prices/service';
import { saveQuote } from '@main/prices/store';
import { MemoCache, sliceSymbolHistory, symbolRangeStart, thinPoints } from '@main/prices/symbolHistory';

/** Serie zilnică (și în weekend, pentru simplitate): prețul crește cu 1 pe zi, de la 100. */
function dailySeries(from: string, to: string, step = 1): { date: string; close: number }[] {
  const out: { date: string; close: number }[] = [];
  for (let d = from, v = 100; d <= to; d = addDays(d, step), v++) out.push({ date: d, close: v });
  return out;
}

class HistoryProvider implements PriceProvider {
  calls: string[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly behavior: 'data' | 'empty' | ProviderError,
    private readonly currency: string | null = 'USD',
    private readonly rates: Record<string, number> = {}
  ) {}

  async getQuote(ref: SymbolRef) {
    this.calls.push(`quote:${ref.symbol}`);
    const price = this.rates[ref.symbol];
    if (price === undefined) throw new ProviderError('notfound', 'negăsit');
    return { symbol: ref.symbol, price, currency: null, asOf: new Date().toISOString() };
  }

  async getHistory(ref: SymbolRef, from: string, to: string, opts?: HistoryOptions): Promise<HistoryResult> {
    this.calls.push(`history:${ref.symbol}:${from}:${to}${opts?.weekly ? ':weekly' : ''}`);
    if (this.behavior instanceof ProviderError) throw this.behavior;
    if (this.behavior === 'empty') return { points: [], splitAdjusted: true };
    return { points: dailySeries(from < '2000-01-01' ? '2000-01-03' : from, to, opts?.weekly ? 7 : 1), splitAdjusted: true, currency: this.currency };
  }

  async search() {
    return [];
  }
}

let db: Db;
let user: User;
const secrets = createAesBox(randomBytes(32));

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'previzualizare', password: 'parola-prev-1' });
});
afterAll(() => db.close());

beforeEach(() => {
  for (const table of ['prices', 'price_history', 'history_sync', 'api_keys']) db.prepare(`DELETE FROM ${table}`).run();
  updateSettings(db, user.id, { primaryProvider: 'yahoo', baseCurrency: 'RON' });
});
afterEach(() => vi.useRealTimers());

const service = (providers: Partial<Record<ProviderId, PriceProvider>>): PriceService =>
  new PriceService({ db, secrets, keylessLogos: null, providerFactory: (id) => providers[id] ?? null });

const historyCalls = (p: HistoryProvider): string[] => p.calls.filter((c) => c.startsWith('history:'));
const rowCount = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('tăierea istoricului pe perioadă', () => {
  const today = '2026-11-15';
  const points = dailySeries('2025-11-08', today);

  it('începutul fiecărei perioade', () => {
    expect(symbolRangeStart('1M', today)).toBe('2026-10-15');
    expect(symbolRangeStart('3M', today)).toBe('2026-08-15');
    expect(symbolRangeStart('6M', today)).toBe('2026-05-15');
    expect(symbolRangeStart('YTD', today)).toBe('2025-12-31');
    expect(symbolRangeStart('1Y', today)).toBe('2025-11-15');
    expect(symbolRangeStart('ALL', today) < '1900-01-01').toBe(true);
  });

  it('pornește de la ultima închidere de dinaintea perioadei și calculează variația', () => {
    const m1 = sliceSymbolHistory(points, '1M', today);
    expect(m1.points[0].date).toBe('2026-10-15');
    expect(m1.points[m1.points.length - 1].date).toBe(today);
    const first = m1.points[0].close;
    const last = m1.points[m1.points.length - 1].close;
    expect(m1.change).toBeCloseTo(last / first - 1, 12);

    const ytd = sliceSymbolHistory(points, 'YTD', today);
    expect(ytd.points[0].date).toBe('2025-12-31');

    const y1 = sliceSymbolHistory(points, '1Y', today);
    expect(y1.points[0].date).toBe('2025-11-15');
    expect(y1.points.length).toBeGreaterThan(sliceSymbolHistory(points, '6M', today).points.length);
  });

  it('cu zile lipsă (weekend) folosește închiderea de dinainte', () => {
    const gappy = [
      { date: '2026-10-09', close: 50 },
      { date: '2026-10-16', close: 55 },
      { date: '2026-11-13', close: 60 }
    ];
    const r = sliceSymbolHistory(gappy, '1M', today);
    expect(r.points.map((p) => p.date)).toEqual(['2026-10-09', '2026-10-16', '2026-11-13']);
    expect(r.change).toBeCloseTo(0.2, 12);
  });

  it('istoric mai scurt decât perioada: de la primul punct; fără date sau un singur punct: variație necunoscută', () => {
    const short = dailySeries('2026-11-01', today);
    expect(sliceSymbolHistory(short, '1Y', today).points[0].date).toBe('2026-11-01');
    expect(sliceSymbolHistory([], '6M', today)).toEqual({ points: [], change: null });
    expect(sliceSymbolHistory([{ date: today, close: 10 }], '6M', today).change).toBeNull();
  });
});

describe('prices.symbolHistory', () => {
  it('descarcă o singură dată un an de istoric; schimbarea perioadei vine din cache', async () => {
    const yahoo = new HistoryProvider('yahoo', 'data', 'USD');
    const prices = service({ yahoo });
    const r6 = await prices.symbolHistory(user.id, { symbol: 'nvda', type: 'stock' }, '6M');
    const r1 = await prices.symbolHistory(user.id, { symbol: 'NVDA', type: 'stock' }, '1M');
    const ry = await prices.symbolHistory(user.id, { symbol: 'NVDA', type: 'stock' }, '1Y');

    expect(yahoo.calls.filter((c) => c.startsWith('history:'))).toHaveLength(1);
    const [, , from, to] = yahoo.calls[0].split(':');
    expect(to).toBe(todayIso());
    expect(from <= addDays(todayIso(), -365)).toBe(true);

    expect(r6).toMatchObject({ symbol: 'NVDA', currency: 'USD' });
    expect(r6.last).toBe(r6.points[r6.points.length - 1].close);
    expect(r1.last).toBe(r6.last);
    expect(r1.points.length).toBeLessThan(r6.points.length);
    expect(r6.points.length).toBeLessThan(ry.points.length);
    expect(r6.change).toBeCloseTo(r6.last! / r6.points[0].close - 1, 12);
    expect(r6.change!).toBeGreaterThan(0);
  });

  it('cererile simultane pentru același simbol împart descărcarea', async () => {
    const yahoo = new HistoryProvider('yahoo', 'data');
    const prices = service({ yahoo });
    await Promise.all(['1M', '3M', '6M', 'YTD', '1Y'].map((r) => prices.symbolHistory(user.id, { symbol: 'AAPL', type: 'stock' }, r as '6M')));
    expect(historyCalls(yahoo)).toHaveLength(1);
  });

  it('cache-ul expiră după 10 minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    const yahoo = new HistoryProvider('yahoo', 'data');
    const prices = service({ yahoo });
    await prices.symbolHistory(user.id, { symbol: 'MSFT', type: 'stock' }, '6M');
    vi.setSystemTime(Date.now() + 9 * 60_000);
    await prices.symbolHistory(user.id, { symbol: 'MSFT', type: 'stock' }, '3M');
    expect(historyCalls(yahoo)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await prices.symbolHistory(user.id, { symbol: 'MSFT', type: 'stock' }, '3M');
    expect(historyCalls(yahoo)).toHaveLength(2);
  });

  it('trece la următorul provider când primul nu are date', async () => {
    updateSettings(db, user.id, { primaryProvider: 'twelvedata' });
    setApiKey(db, secrets, user.id, 'twelvedata', 'cheie-td');
    const twelvedata = new HistoryProvider('twelvedata', 'empty');
    const yahoo = new HistoryProvider('yahoo', 'data', 'EUR');
    const r = await service({ twelvedata, yahoo }).symbolHistory(user.id, { symbol: 'VWCE.DE', type: 'etf' }, '6M');
    expect(historyCalls(twelvedata)).toHaveLength(1);
    expect(historyCalls(yahoo)).toHaveLength(1);
    expect(r.currency).toBe('EUR');
    expect(r.points.length).toBeGreaterThan(100);
  });

  it('fără internet sau fără date: rezultat gol, fără excepție; eșecul nu rămâne în cache', async () => {
    const offline = new HistoryProvider('yahoo', new ProviderError('network', 'fără internet'));
    const prices = service({ yahoo: offline });
    const r = await prices.symbolHistory(user.id, { symbol: 'NVDA', type: 'stock', currency: 'USD' }, '6M');
    expect(r).toEqual({ symbol: 'NVDA', currency: 'USD', points: [], last: null, change: null, dayChange: null, weekly: false, fx: null });
    await prices.symbolHistory(user.id, { symbol: 'NVDA', type: 'stock' }, '6M');
    expect(historyCalls(offline)).toHaveLength(2);

    const broken = new HistoryProvider('yahoo', new ProviderError('other', 'HTTP 500'));
    await expect(service({ yahoo: broken }).symbolHistory(user.id, { symbol: 'X', type: 'stock' }, '1Y')).resolves.toMatchObject({ points: [], last: null });

    const empty = new HistoryProvider('yahoo', 'empty');
    await expect(service({ yahoo: empty }).symbolHistory(user.id, { symbol: 'X', type: 'crypto' }, '1M')).resolves.toMatchObject({ points: [], change: null });
  });

  it('„Tot”: cerere separată, săptămânală, de la începutul datelor, rărită la ~300 de puncte; nu încetinește anul', async () => {
    const yahoo = new HistoryProvider('yahoo', 'data', 'USD');
    const prices = service({ yahoo });
    const year = await prices.symbolHistory(user.id, { symbol: 'AAPL', type: 'stock' }, '6M');
    expect(historyCalls(yahoo)).toHaveLength(1);
    expect(historyCalls(yahoo)[0]).not.toContain('weekly');
    expect(year.weekly).toBe(false);
    expect(year.dayChange).toBeCloseTo(year.points[year.points.length - 1].close / year.points[year.points.length - 2].close - 1, 12);

    const all = await prices.symbolHistory(user.id, { symbol: 'AAPL', type: 'stock' }, 'ALL');
    await prices.symbolHistory(user.id, { symbol: 'AAPL', type: 'stock' }, 'ALL');
    await prices.symbolHistory(user.id, { symbol: 'AAPL', type: 'stock' }, '1Y');
    const calls = historyCalls(yahoo);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/^history:AAPL:19\d\d-\d\d-\d\d:.*:weekly$/);
    expect(all.weekly).toBe(true);
    expect(all.dayChange).toBeNull();
    expect(all.points.length).toBeLessThanOrEqual(300);
    expect(all.points.length).toBeGreaterThan(250);
    expect(all.points[0].date).toBe('2000-01-03');
    expect(all.change).toBeCloseTo(all.last! / all.points[0].close - 1, 12);
  });

  it('obligațiunile și simbolurile goale nu se cer providerului', async () => {
    const yahoo = new HistoryProvider('yahoo', 'data');
    const prices = service({ yahoo });
    expect((await prices.symbolHistory(user.id, { symbol: 'RO1234', type: 'bond' }, '6M')).points).toEqual([]);
    expect((await prices.symbolHistory(user.id, { symbol: '  ', type: 'stock' }, '6M')).points).toEqual([]);
    expect(yahoo.calls).toHaveLength(0);
  });

  it('cursul față de moneda de bază: din cotațiile salvate, inversul lor sau cerut providerului', async () => {
    saveQuote(db, user.id, { symbol: 'USDRON=X', price: 4.5, currency: 'RON', asOf: new Date().toISOString(), provider: 'yahoo' });
    const yahoo = new HistoryProvider('yahoo', 'data', 'USD', { 'GBPRON=X': 5.9 });
    const prices = service({ yahoo });
    expect((await prices.symbolHistory(user.id, { symbol: 'NVDA', type: 'stock' }, '6M')).fx).toEqual({ currency: 'RON', rate: 4.5 });
    // Moneda cerută explicit (ex. alt portofoliu): RON -> USD din inversul cursului salvat.
    const ron = new HistoryProvider('yahoo', 'data', 'RON');
    expect((await service({ yahoo: ron }).symbolHistory(user.id, { symbol: 'TLV.RO', type: 'stock' }, '6M', 'USD')).fx?.rate).toBeCloseTo(1 / 4.5, 12);
    // Aceeași monedă: fără curs.
    expect((await service({ yahoo: ron }).symbolHistory(user.id, { symbol: 'TLV.RO', type: 'stock' }, '6M')).fx).toBeNull();
    // Curs nesalvat: cerut providerului, ținut în memorie.
    const gbp = new HistoryProvider('yahoo', 'data', 'GBP', { 'GBPRON=X': 5.9 });
    const p2 = service({ yahoo: gbp });
    expect((await p2.symbolHistory(user.id, { symbol: 'VOD.L', type: 'stock' }, '6M')).fx).toEqual({ currency: 'RON', rate: 5.9 });
    await p2.symbolHistory(user.id, { symbol: 'VOD.L', type: 'stock' }, '1M');
    expect(gbp.calls.filter((c) => c.startsWith('quote:'))).toEqual(['quote:GBPRON=X']);
  });

  it('nu scrie nimic în baza de date (nici istoric, nici cotații)', async () => {
    saveQuote(db, user.id, { symbol: 'USDRON=X', price: 4.5, currency: 'RON', asOf: new Date().toISOString(), provider: 'yahoo' });
    const before = { history: rowCount('price_history'), sync: rowCount('history_sync'), prices: rowCount('prices') };
    const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const yahoo = new HistoryProvider('yahoo', 'data', 'GBP', { 'GBPRON=X': 5.9 });
    const prices = service({ yahoo });
    for (const range of ['1M', '3M', '6M', 'YTD', '1Y'] as const) {
      await prices.symbolHistory(user.id, { symbol: 'NVDA', type: 'stock' }, range);
      await prices.symbolHistory(user.id, { symbol: 'BTC-USD', type: 'crypto' }, range);
    }
    expect({ history: rowCount('price_history'), sync: rowCount('history_sync'), prices: rowCount('prices') }).toEqual(before);
    expect(rowCount('price_history')).toBe(0);
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(changes);
  });
});

describe('rărirea seriilor lungi', () => {
  it('păstrează primul și ultimul punct și cel mult max puncte', () => {
    const long = dailySeries('2000-01-01', '2026-11-15');
    const thin = thinPoints(long, 300);
    expect(thin.length).toBeLessThanOrEqual(300);
    expect(thin[0]).toEqual(long[0]);
    expect(thin[thin.length - 1]).toEqual(long[long.length - 1]);
    const short = dailySeries('2026-01-01', '2026-02-01');
    expect(thinPoints(short, 300)).toBe(short);
  });
});

describe('MemoCache', () => {
  it('păstrează cel mult `max` intrări, scoțând-o pe cea mai veche folosită', async () => {
    const cache = new MemoCache<number>(60_000, 2);
    const loads: string[] = [];
    const load = (k: string) => () => {
      loads.push(k);
      return Promise.resolve(1);
    };
    await cache.get('a', load('a'));
    await cache.get('b', load('b'));
    await cache.get('a', load('a')); // „a” devine cea mai recentă
    await cache.get('c', load('c')); // pleacă „b”
    expect(cache.size).toBe(2);
    await cache.get('a', load('a'));
    await cache.get('b', load('b'));
    expect(loads).toEqual(['a', 'b', 'c', 'b']);
  });

  it('o încărcare care aruncă devine null și nu se păstrează', async () => {
    const cache = new MemoCache<number>(60_000, 5);
    await expect(cache.get('x', () => Promise.reject(new Error('boom')))).resolves.toBeNull();
    await Promise.resolve();
    expect(cache.size).toBe(0);
  });
});
