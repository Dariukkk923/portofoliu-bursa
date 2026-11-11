/**
 * Watchlist și logo-uri: listele (creare, redenumire, ordine, ștergere), instrumentele
 * urmărite cu preț țintă și notă, prețul și variația de azi din cache, cumpărarea
 * (eticheta „În portofoliu”), izolarea între utilizatori, backup-ul, actualizarea
 * prețurilor pentru simbolurile urmărite și cache-ul local de logo-uri.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId, User } from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import { openDatabase, type Db } from '@main/db/database';
import { createAesBox } from '@main/secrets';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase } from '@main/services/transactions';
import { setApiKey } from '@main/services/settings';
import { createBackup, restoreBackup } from '@main/services/backup';
import {
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  listWatchlistItems,
  listWatchlists,
  removeWatchlistItem,
  renameWatchlist,
  reorderWatchlistItems,
  reorderWatchlists,
  updateWatchlistItem
} from '@main/services/watchlist';
import { fetchImage, ProviderError, type LogoImage, type PriceProvider, type SymbolRef } from '@main/prices/provider';
import { PriceService } from '@main/prices/service';
import { getCachedPrices, getHistorySync, getLogos, saveHistory, saveQuote } from '@main/prices/store';

let db: Db;
let ana: User;
let dan: User;
const secrets = createAesBox(randomBytes(32));
const tmp = mkdtempSync(join(tmpdir(), 'portofoliu-watch-'));
const today = todayIso();

beforeAll(async () => {
  db = openDatabase(':memory:');
  ana = await register(db, { username: 'ana', password: 'parola-ana-1' });
  dan = await register(db, { username: 'dan', password: 'parola-dan-1' });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  for (const table of ['transactions', 'watchlist_items', 'watchlists', 'assets', 'brokers', 'prices', 'price_history', 'history_sync', 'logos', 'api_keys']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});
afterEach(() => vi.unstubAllGlobals());

const mainList = (user: User) => listWatchlists(db, user.id)[0];

describe('listele din watchlist', () => {
  it('la prima folosire există lista „De urmărit”; listele se creează, se redenumesc și se ordonează', () => {
    expect(listWatchlists(db, ana.id)).toEqual([{ id: expect.any(Number), name: 'De urmărit', sortOrder: 0, itemCount: 0 }]);
    const buy = createWatchlist(db, ana.id, '  De   cumpărat ');
    const div = createWatchlist(db, ana.id, 'Dividende');
    expect(buy.name).toBe('De cumpărat');
    expect(() => createWatchlist(db, ana.id, 'dividende')).toThrow(/Există deja/);
    expect(() => createWatchlist(db, ana.id, '')).toThrow(/între 1 și 40/);
    expect(renameWatchlist(db, ana.id, div.id, 'Dividende lunare').name).toBe('Dividende lunare');

    reorderWatchlists(db, ana.id, [div.id, buy.id, mainList(ana).id]);
    expect(listWatchlists(db, ana.id).map((w) => w.name)).toEqual(['Dividende lunare', 'De cumpărat', 'De urmărit']);

    deleteWatchlist(db, ana.id, div.id);
    deleteWatchlist(db, ana.id, buy.id);
    // Ultima listă nu se poate șterge.
    expect(() => deleteWatchlist(db, ana.id, mainList(ana).id)).toThrow(/cel puțin o listă/);
  });

  it('listele și instrumentele sunt ale fiecărui utilizator', () => {
    const list = mainList(ana);
    const item = addWatchlistItem(db, ana.id, list.id, { symbol: 'NVDA', type: 'stock', currency: 'USD' });
    expect(() => listWatchlistItems(db, dan.id, list.id)).toThrow(/nu a fost găsită/);
    expect(() => addWatchlistItem(db, dan.id, list.id, { symbol: 'AAPL', type: 'stock', currency: 'USD' })).toThrow(/nu a fost găsită/);
    expect(() => updateWatchlistItem(db, dan.id, item.id, { note: 'x' })).toThrow(/nu a fost găsit/);
    expect(() => removeWatchlistItem(db, dan.id, item.id)).toThrow(/nu a fost găsit/);
    expect(() => renameWatchlist(db, dan.id, list.id, 'A mea')).toThrow(/nu a fost găsită/);
    expect(listWatchlists(db, dan.id)).toMatchObject([{ name: 'De urmărit', itemCount: 0 }]);
  });
});

describe('instrumentele urmărite', () => {
  it('adaugă instrumente cu preț țintă și notă, fără dubluri în aceeași listă', () => {
    const list = mainList(ana);
    const item = addWatchlistItem(db, ana.id, list.id, { symbol: ' nvda ', type: 'stock', currency: 'usd', name: 'NVIDIA', targetPrice: '120,5', note: 'după rezultate' });
    expect(item).toMatchObject({ symbol: 'NVDA', type: 'stock', currency: 'USD', name: 'NVIDIA', targetPrice: 120.5, note: 'după rezultate', price: null, held: false });
    expect(() => addWatchlistItem(db, ana.id, list.id, { symbol: 'NVDA', type: 'stock', currency: 'USD' })).toThrow(/deja în această listă/);
    expect(() => addWatchlistItem(db, ana.id, list.id, { symbol: 'X Y', type: 'stock', currency: 'USD' })).toThrow(/Simbolul/);
    expect(() => addWatchlistItem(db, ana.id, list.id, { symbol: 'XYZ', type: 'stock', currency: 'JPY' })).toThrow(/Moneda/);
    expect(() => addWatchlistItem(db, ana.id, list.id, { symbol: 'XYZ', type: 'stock', currency: 'USD', targetPrice: '-3' })).toThrow(/Prețul țintă/);
    // Același instrument poate fi în mai multe liste.
    const other = createWatchlist(db, ana.id, 'Dividende');
    addWatchlistItem(db, ana.id, other.id, { symbol: 'NVDA', type: 'stock', currency: 'USD' });

    expect(updateWatchlistItem(db, ana.id, item.id, { targetPrice: null, note: '' })).toMatchObject({ targetPrice: null, note: null });
    expect(() => updateWatchlistItem(db, ana.id, item.id, { watchlistId: other.id })).toThrow(/deja în lista aleasă/);
  });

  it('un activ cunoscut își păstrează tipul și moneda', () => {
    const broker = createBroker(db, ana.id, { name: 'XTB' });
    addPurchase(db, ana.id, { asset: { type: 'etf', symbol: 'VWCE.DE', currency: 'EUR', name: 'Vanguard FTSE All-World' }, brokerId: broker.id, date: '2025-01-10', quantity: 2, price: 120, fee: 0 });
    const item = addWatchlistItem(db, ana.id, mainList(ana).id, { symbol: 'VWCE.DE', type: 'stock', currency: 'USD' });
    expect(item).toMatchObject({ type: 'etf', currency: 'EUR', name: 'Vanguard FTSE All-World', held: true });
  });

  it('prețul, variația de azi, graficul pe trei luni și distanța până la țintă vin din cache', () => {
    const list = mainList(ana);
    addWatchlistItem(db, ana.id, list.id, { symbol: 'NVDA', type: 'stock', currency: 'USD', targetPrice: 100 });
    saveHistory(
      db,
      ana.id,
      'NVDA',
      [
        { date: addDays(today, -200), close: 50 }, // prea vechi pentru grafic
        { date: addDays(today, -30), close: 100 },
        { date: addDays(today, -1), close: 110 }
      ],
      true,
      'yahoo'
    );
    saveQuote(db, ana.id, { symbol: 'NVDA', price: 121, currency: 'USD', asOf: `${today}T15:30:00.000Z`, provider: 'yahoo' });
    const [item] = listWatchlistItems(db, ana.id, list.id, today);
    expect(item.price).toBe(121);
    expect(item.previousClose).toBe(110);
    expect(item.changePct).toBeCloseTo(0.1, 10);
    expect(item.toTargetPct).toBeCloseTo(0.21, 10); // 21% peste prețul țintă
    expect(item.sparkline.map((p) => p.close)).toEqual([100, 110]);
  });

  it('după cumpărare instrumentul apare „În portofoliu”; se mută între liste și se reordonează', () => {
    const list = mainList(ana);
    const a = addWatchlistItem(db, ana.id, list.id, { symbol: 'AAPL', type: 'stock', currency: 'USD' });
    const b = addWatchlistItem(db, ana.id, list.id, { symbol: 'KO', type: 'stock', currency: 'USD' });
    const c = addWatchlistItem(db, ana.id, list.id, { symbol: 'BTC-USD', type: 'crypto', currency: 'USD' });
    reorderWatchlistItems(db, ana.id, list.id, [c.id, a.id, b.id]);
    expect(listWatchlistItems(db, ana.id, list.id).map((i) => i.symbol)).toEqual(['BTC-USD', 'AAPL', 'KO']);

    const broker = createBroker(db, ana.id, { name: 'XTB' });
    addPurchase(db, ana.id, { asset: { type: 'stock', symbol: 'KO', currency: 'USD' }, brokerId: broker.id, date: '2025-03-03', quantity: 5, price: 70, fee: 0 });
    expect(listWatchlistItems(db, ana.id, list.id).map((i) => `${i.symbol} ${i.held}`)).toEqual(['BTC-USD false', 'AAPL false', 'KO true']);

    const dividends = createWatchlist(db, ana.id, 'Dividende');
    updateWatchlistItem(db, ana.id, b.id, { watchlistId: dividends.id });
    expect(listWatchlistItems(db, ana.id, dividends.id).map((i) => i.symbol)).toEqual(['KO']);
    removeWatchlistItem(db, ana.id, a.id);
    expect(listWatchlists(db, ana.id).map((w) => `${w.name} ${w.itemCount}`)).toEqual(['De urmărit 1', 'Dividende 1']);
    // Ștergerea listei șterge și ce conține.
    deleteWatchlist(db, ana.id, dividends.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM watchlist_items WHERE user_id = ?').get(ana.id)).toEqual({ n: 1 });
  });

  it('backup-ul păstrează listele și instrumentele urmărite', () => {
    addWatchlistItem(db, ana.id, mainList(ana).id, { symbol: 'NVDA', type: 'stock', currency: 'USD' });
    const div = createWatchlist(db, ana.id, 'Dividende');
    addWatchlistItem(db, ana.id, div.id, { symbol: 'KO', type: 'stock', currency: 'USD', targetPrice: 58, note: 'randament 3%' });
    const file = join(tmp, 'backup-watch.db');
    createBackup(db, ana.id, file);
    restoreBackup(db, dan.id, file);
    const lists = listWatchlists(db, dan.id);
    expect(lists.map((w) => `${w.name} ${w.itemCount}`)).toEqual(['De urmărit 1', 'Dividende 1']);
    expect(listWatchlistItems(db, dan.id, lists[1].id)).toMatchObject([{ symbol: 'KO', targetPrice: 58, note: 'randament 3%' }]);
  });
});

/* ---------------------------------------------- prețurile și logo-urile */

class FakeProvider implements PriceProvider {
  calls: string[] = [];
  constructor(readonly id: ProviderId) {}
  async getQuote(ref: SymbolRef) {
    this.calls.push(`quote:${ref.symbol}`);
    return { symbol: ref.symbol, price: 10, currency: 'USD', asOf: new Date().toISOString() };
  }
  async getHistory(ref: SymbolRef, from: string) {
    this.calls.push(`history:${ref.symbol}:${from}`);
    return { points: [{ date: from, close: 9 }], splitAdjusted: true };
  }
  async search() {
    return [];
  }
}

class LogoProvider extends FakeProvider {
  constructor(
    id: ProviderId,
    private readonly images: Record<string, LogoImage | null | Error>
  ) {
    super(id);
  }
  async getLogo(ref: SymbolRef): Promise<LogoImage | null> {
    this.calls.push(`logo:${ref.symbol}`);
    const r = this.images[ref.symbol];
    if (r instanceof Error) throw r;
    return r ?? null;
  }
}

const png = (byte: number): LogoImage => ({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, byte]), mime: 'image/png' });

describe('prețurile pentru watchlist', () => {
  it('actualizarea cere cotația și istoricul recent și pentru simbolurile urmărite (fără obligațiuni)', async () => {
    const list = mainList(ana);
    addWatchlistItem(db, ana.id, list.id, { symbol: 'NVDA', type: 'stock', currency: 'USD' });
    addWatchlistItem(db, ana.id, list.id, { symbol: 'R2710A', type: 'bond', currency: 'RON' });
    const yahoo = new FakeProvider('yahoo');
    const result = await new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? yahoo : null) }).refresh(ana.id);
    expect(result).toMatchObject({ ok: true, failed: [] });
    expect(yahoo.calls).toEqual(['quote:NVDA', `history:NVDA:${addDays(today, -100)}`]);
    expect(getCachedPrices(db, ana.id).get('NVDA')).toMatchObject({ price: 10 });
    expect(getHistorySync(db, ana.id, 'NVDA')).toMatchObject({ fromDate: addDays(today, -100) });
    expect(listWatchlistItems(db, ana.id, list.id)[0]).toMatchObject({ symbol: 'NVDA', price: 10, previousClose: 9 });
  });
});

describe('logo-urile', () => {
  it('se descarcă doar de la providerii configurați care le oferă și se păstrează local', async () => {
    const twelve = new LogoProvider('twelvedata', { AAPL: png(1), XYZ: null });
    const polygon = new LogoProvider('polygon', { XYZ: new ProviderError('ratelimit', 'limită') });
    const make = () => new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? new FakeProvider('yahoo') : id === 'twelvedata' ? twelve : id === 'polygon' ? polygon : null) });

    // Fără nicio cheie API: doar Yahoo, care nu dă logo-uri; nu se cere nimic.
    expect(make().logosToFetch(ana.id, [{ symbol: 'AAPL', type: 'stock' }])).toEqual([]);

    setApiKey(db, secrets, ana.id, 'twelvedata', 'cheie-td');
    setApiKey(db, secrets, ana.id, 'polygon', 'cheie-pg');
    const service = make();
    const refs: SymbolRef[] = [
      { symbol: 'AAPL', type: 'stock' },
      { symbol: 'XYZ', type: 'stock' },
      { symbol: 'BTC-USD', type: 'crypto' }, // iconițele crypto sunt incluse în aplicație
      { symbol: 'R2710A', type: 'bond' }
    ];
    const wanted = service.logosToFetch(ana.id, refs);
    expect(wanted.map((r) => r.symbol)).toEqual(['AAPL', 'XYZ']);
    expect(await service.fetchLogos(ana.id, wanted)).toEqual(['AAPL']);
    expect(twelve.calls).toEqual(['logo:AAPL', 'logo:XYZ']);
    expect(polygon.calls).toEqual(['logo:XYZ']); // rezerva, pentru simbolul fără logo la primul provider

    const cached = getLogos(db, ana.id, ['AAPL', 'XYZ']);
    expect(cached.get('AAPL')?.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png(1).data).toString('base64')}`);
    expect(cached.get('XYZ')?.dataUrl).toBeNull(); // „fără logo”, reîncercat peste 30 de zile
    // Apoi nu se mai cere nimic: logo-urile sunt în cache.
    expect(service.logosToFetch(ana.id, refs)).toEqual([]);
    // Cache-ul este al fiecărui utilizator.
    expect(getLogos(db, dan.id, ['AAPL']).size).toBe(0);
  });

  it('fără internet se oprește fără să marcheze simbolurile ca „fără logo”', async () => {
    setApiKey(db, secrets, ana.id, 'twelvedata', 'cheie-td');
    const offline = new LogoProvider('twelvedata', { AAPL: new ProviderError('network', 'fetch failed'), MSFT: png(2) });
    const service = new PriceService({ db, secrets, providerFactory: (id) => (id === 'twelvedata' ? offline : id === 'yahoo' ? new FakeProvider('yahoo') : null) });
    expect(await service.fetchLogos(ana.id, [{ symbol: 'AAPL', type: 'stock' }, { symbol: 'MSFT', type: 'stock' }])).toEqual([]);
    expect(offline.calls).toEqual(['logo:AAPL']);
    expect(getLogos(db, ana.id, ['AAPL', 'MSFT']).size).toBe(0);
  });

  it('acceptă doar imagini mici, în formatele obișnuite', async () => {
    const respond = (body: ConstructorParameters<typeof Response>[0], type: string, status = 200) => vi.stubGlobal('fetch', async () => new Response(body, { status, headers: { 'content-type': type } }));
    respond(new Uint8Array([1, 2, 3]), 'image/png');
    expect(await fetchImage('https://exemplu.test/logo.png')).toEqual({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    respond('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml; charset=utf-8');
    expect((await fetchImage('https://exemplu.test/logo.svg'))?.mime).toBe('image/svg+xml');
    respond('<html></html>', 'text/html');
    expect(await fetchImage('https://exemplu.test/pagina')).toBeNull();
    respond(new Uint8Array(300 * 1024), 'image/png');
    expect(await fetchImage('https://exemplu.test/mare.png')).toBeNull();
    respond('', 'image/png', 404);
    expect(await fetchImage('https://exemplu.test/lipsa.png')).toBeNull();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchImage('https://exemplu.test/logo.png')).rejects.toMatchObject({ kind: 'network' });
  });
});
