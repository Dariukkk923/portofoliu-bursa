/**
 * Teste pentru actualizarea prețurilor, cu provideri simulați (fără rețea):
 * rezervă automată între provideri, cache, mod offline și prețul manual.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderId, User } from '@shared/types';
import { parseCsv, parseNumberLoose, toCsv, usesDecimalComma } from '@shared/csv';
import { openDatabase, type Db } from '@main/db/database';
import { createAesBox } from '@main/secrets';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { updateAsset } from '@main/services/assets';
import { addPurchase } from '@main/services/transactions';
import { getOverview } from '@main/services/portfolio';
import { setApiKey, updateSettings } from '@main/services/settings';
import { ProviderError, RateLimiter, parseCryptoSymbol, parseFxSymbol, type PriceProvider, type SymbolRef } from '@main/prices/provider';
import { PriceService } from '@main/prices/service';
import { getCachedPrices } from '@main/prices/store';

/** Provider simulat: prețuri fixe pe simbol sau o eroare aruncată la fiecare apel. */
class FakeProvider implements PriceProvider {
  calls: string[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly prices: Record<string, number>,
    private readonly failWith: ProviderError | null = null
  ) {}

  async getQuote(ref: SymbolRef) {
    this.calls.push(`quote:${ref.symbol}`);
    if (this.failWith) throw this.failWith;
    const price = this.prices[ref.symbol];
    if (price === undefined) throw new ProviderError('notfound', `fără preț pentru ${ref.symbol}`);
    return { symbol: ref.symbol, price, currency: null, asOf: new Date().toISOString() };
  }

  async getHistory(ref: SymbolRef, from: string) {
    this.calls.push(`history:${ref.symbol}`);
    if (this.failWith) throw this.failWith;
    const price = this.prices[ref.symbol];
    return { points: price === undefined ? [] : [{ date: from, close: price }], splitAdjusted: true };
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
  user = await register(db, { username: 'dana', password: 'parola-dana-1' });
});
afterAll(() => db.close());

beforeEach(() => {
  for (const table of ['transactions', 'assets', 'brokers', 'prices', 'price_history', 'history_sync', 'api_keys']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  updateSettings(db, user.id, { primaryProvider: 'yahoo', refreshIntervalMin: 5, baseCurrency: 'RON' });
  const broker = createBroker(db, user.id, { name: 'XTB' });
  addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: broker.id, date: '2024-02-12', quantity: 10, price: 187, fee: 0 });
  addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'SNP.RO', currency: 'RON' }, brokerId: broker.id, date: '2024-03-04', quantity: 100, price: 0.6, fee: 0 });
});

function service(providers: Partial<Record<ProviderId, PriceProvider>>): PriceService {
  return new PriceService({ db, secrets, providerFactory: (id) => providers[id] ?? null });
}

describe('actualizarea prețurilor', () => {
  it('salvează cotațiile, cursul valutar și istoricul', async () => {
    const yahoo = new FakeProvider('yahoo', { AAPL: 210, 'SNP.RO': 0.8, 'USDRON=X': 4.6 });
    const result = await service({ yahoo }).refresh(user.id);

    expect(result).toMatchObject({ ok: true, offline: false, updated: 3, failed: [] });
    expect(result.lastPriceUpdate).not.toBeNull();
    const cache = getCachedPrices(db, user.id);
    expect(cache.get('AAPL')).toMatchObject({ price: 210, provider: 'yahoo', currency: 'USD' });
    expect(cache.get('USDRON=X')?.price).toBe(4.6);
    expect(getOverview(db, user.id).totals.totalValue).toBeCloseTo(10 * 210 * 4.6 + 100 * 0.8, 6);
    // Istoricul a fost descărcat o dată pentru fiecare simbol, de la data primei tranzacții.
    expect(yahoo.calls.filter((c) => c.startsWith('history:')).sort()).toEqual(['history:AAPL', 'history:SNP.RO', 'history:USDRON=X', 'history:^GSPC']); // și indicele de referință (doar istoric)
    expect(db.prepare("SELECT from_date FROM history_sync WHERE symbol = 'AAPL'").get()).toEqual({ from_date: '2024-02-12' });
  });

  it('folosește cache-ul: a doua actualizare nu mai apelează providerul, decât la cerere', async () => {
    const yahoo = new FakeProvider('yahoo', { AAPL: 210, 'SNP.RO': 0.8, 'USDRON=X': 4.6 });
    const svc = service({ yahoo });
    await svc.refresh(user.id);
    const callsAfterFirst = yahoo.calls.length;

    await svc.refresh(user.id);
    expect(yahoo.calls.length).toBe(callsAfterFirst); // totul din cache

    await svc.refresh(user.id, { force: true }); // „Actualizează acum”
    expect(yahoo.calls.filter((c) => c.startsWith('quote:')).length).toBe(6);
    expect(yahoo.calls.filter((c) => c.startsWith('history:')).length).toBe(4); // istoricul rămâne în cache
  });

  it('trece automat la alt provider când cel principal dă eroare sau nu are simbolul', async () => {
    setApiKey(db, secrets, user.id, 'polygon', 'cheie-polygon');
    setApiKey(db, secrets, user.id, 'twelvedata', 'cheie-td');
    updateSettings(db, user.id, { primaryProvider: 'polygon' });
    const polygon = new FakeProvider('polygon', { AAPL: 211 }); // nu acoperă BVB și nici cursul
    const yahoo = new FakeProvider('yahoo', {}, new ProviderError('other', 'Yahoo indisponibil'));
    const twelvedata = new FakeProvider('twelvedata', { 'SNP.RO': 0.81, 'USDRON=X': 4.61 });
    const svc = service({ polygon, yahoo, twelvedata });

    expect(svc.providerChain(user.id).map((p) => p.id)).toEqual(['polygon', 'yahoo', 'twelvedata']);
    const result = await svc.refresh(user.id);
    expect(result).toMatchObject({ ok: true, offline: false, updated: 3 });
    const cache = getCachedPrices(db, user.id);
    expect(cache.get('AAPL')).toMatchObject({ price: 211, provider: 'polygon' });
    expect(cache.get('SNP.RO')).toMatchObject({ price: 0.81, provider: 'twelvedata' });
    expect(cache.get('USDRON=X')).toMatchObject({ price: 4.61, provider: 'twelvedata' });
  });

  it('providerii fără cheie API sunt săriți', () => {
    updateSettings(db, user.id, { primaryProvider: 'alphavantage' });
    const svc = service({ yahoo: new FakeProvider('yahoo', {}), alphavantage: new FakeProvider('alphavantage', {}) });
    expect(svc.providerChain(user.id).map((p) => p.id)).toEqual(['yahoo']);
  });

  it('fără internet păstrează ultimele prețuri salvate și semnalează modul offline', async () => {
    await service({ yahoo: new FakeProvider('yahoo', { AAPL: 210, 'SNP.RO': 0.8, 'USDRON=X': 4.6 }) }).refresh(user.id);
    const before = getOverview(db, user.id).totals.totalValue;

    const offlineSvc = service({ yahoo: new FakeProvider('yahoo', {}, new ProviderError('network', 'fetch failed')) });
    const result = await offlineSvc.refresh(user.id, { force: true });
    expect(result).toMatchObject({ ok: false, offline: true, updated: 0 });
    expect(result.message).toMatch(/Fără conexiune/);
    expect(offlineSvc.status(user.id)).toMatchObject({ offline: true, refreshing: false });
    expect(getOverview(db, user.id).totals.totalValue).toBeCloseTo(before, 6); // valorile vechi rămân
  });

  it('raportează simbolurile fără preț și folosește prețul introdus manual ca rezervă', async () => {
    const yahoo = new FakeProvider('yahoo', { AAPL: 210, 'USDRON=X': 4.6 });
    const result = await service({ yahoo }).refresh(user.id);
    expect(result.ok).toBe(false);
    expect(result.offline).toBe(false);
    expect(result.failed).toEqual(['SNP.RO']);
    expect(getOverview(db, user.id).missingPrices).toEqual(['SNP.RO']);

    const snp = getOverview(db, user.id).positions.find((p) => p.symbol === 'SNP.RO')!;
    updateAsset(db, user.id, snp.assetId, { manualPrice: 0.75 });
    const after = getOverview(db, user.id).positions.find((p) => p.symbol === 'SNP.RO')!;
    expect(after).toMatchObject({ price: 0.75, priceSource: 'manual' });
    expect(getOverview(db, user.id).missingPrices).toEqual([]);
  });

  it('activele cu preț manual nu sunt cerute de la provider', async () => {
    const snp = getOverview(db, user.id).positions.find((p) => p.symbol === 'SNP.RO')!;
    updateAsset(db, user.id, snp.assetId, { priceMode: 'manual', manualPrice: 0.9 });
    const yahoo = new FakeProvider('yahoo', { AAPL: 210, 'SNP.RO': 123, 'USDRON=X': 4.6 });
    await service({ yahoo }).refresh(user.id);
    expect(yahoo.calls).not.toContain('quote:SNP.RO');
    expect(getOverview(db, user.id).positions.find((p) => p.symbol === 'SNP.RO')?.price).toBe(0.9);
  });
});

describe('utilitare pentru provideri', () => {
  it('interpretează simbolurile crypto și valutare', () => {
    expect(parseCryptoSymbol('BTC-USD')).toEqual({ base: 'BTC', quote: 'USD' });
    expect(parseCryptoSymbol('eth-eur')).toEqual({ base: 'ETH', quote: 'EUR' });
    expect(parseCryptoSymbol('AAPL')).toBeNull();
    expect(parseFxSymbol('EURRON=X')).toEqual({ from: 'EUR', to: 'RON' });
    expect(parseFxSymbol('TLV.RO')).toBeNull();
  });

  it('limitatorul păstrează ordinea și pauza dintre cereri', async () => {
    const limiter = new RateLimiter(40);
    const stamps: number[] = [];
    const results = await Promise.all([1, 2, 3].map((n) => limiter.schedule(async () => (stamps.push(Date.now()), n))));
    expect(results).toEqual([1, 2, 3]);
    expect(stamps[2] - stamps[0]).toBeGreaterThanOrEqual(70);
  });
});

describe('CSV', () => {
  it('citește ghilimele, separatori în celule și linii noi', () => {
    const text = 'a,b,c\r\n"unu, doi","spune ""salut""","linia 1\nlinia 2"\r\n\r\n3,,5\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['unu, doi', 'spune "salut"', 'linia 1\nlinia 2'],
      ['3', '', '5']
    ]);
  });

  it('scrierea urmată de citire întoarce aceleași valori', () => {
    const rows = [
      ['note', 'valoare'],
      ['text cu, virgulă și "ghilimele"', '12.5'],
      ['două\nlinii', '']
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    expect(parseCsv('﻿a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });

  it('interpretează numere cu punct sau virgulă zecimală', () => {
    expect(parseNumberLoose('1234.56')).toBe(1234.56);
    expect(parseNumberLoose('1234,56')).toBe(1234.56);
    expect(parseNumberLoose('1.234,56')).toBe(1234.56);
    expect(parseNumberLoose('1,234.56')).toBe(1234.56);
    expect(parseNumberLoose(' 0,00012345 ')).toBe(0.00012345);
    expect(parseNumberLoose('7.2%')).toBe(7.2);
    expect(parseNumberLoose('')).toBeNull();
    expect(parseNumberLoose('abc')).toBeNull();
    // „1.000” este ambiguu: în format european (detectat pe tot fișierul) înseamnă o mie.
    expect(parseNumberLoose('1.000')).toBe(1);
    expect(parseNumberLoose('1.000', true)).toBe(1000);
    expect(usesDecimalComma(['5000', '0,621', ''])).toBe(true);
    expect(usesDecimalComma(['5000', '0.621', '1,234.5'])).toBe(false);
  });
});
