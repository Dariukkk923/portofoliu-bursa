/**
 * Riscul și comparația cu indicele de referință: volatilitatea, scăderea maximă și
 * beta pe serii cunoscute, scorul de diversificare, indicele convertit în moneda
 * portofoliului, raportul de risc (concentrare, expuneri) și profilul activelor.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderId, User } from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import { annualizedVolatility, assessDiversification, beta, maxDrawdown, type ReturnPoint } from '@shared/calc';
import { assetCountry, assetSector, sectorLabel } from '@shared/riskLabels';
import { openDatabase, type Db } from '@main/db/database';
import { createAesBox } from '@main/secrets';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { listAssets, updateAsset } from '@main/services/assets';
import { addPurchase, createTransaction } from '@main/services/transactions';
import { getPerformance } from '@main/services/portfolio';
import { createPortfolio } from '@main/services/portfolios';
import { getSettings, updateSettings } from '@main/services/settings';
import { getRiskReport } from '@main/services/risk';
import { PriceService } from '@main/prices/service';
import { saveHistory, saveQuote } from '@main/prices/store';
import type { AssetProfile, PriceProvider, SymbolRef } from '@main/prices/provider';

/** O serie cumulată (TWR) din randamentele pe pas, cu un pas pe zi de la `start`. */
function series(returns: number[], start = '2025-01-01'): ReturnPoint[] {
  const out: ReturnPoint[] = [{ date: start, twr: 0 }];
  let wealth = 1;
  returns.forEach((r, i) => {
    wealth *= 1 + r;
    out.push({ date: addDays(start, i + 1), twr: wealth - 1 });
  });
  return out;
}

const MARKET = [0.01, -0.005, 0.02, -0.01, 0.004, 0.012, -0.008, 0.003, -0.015, 0.009, 0.006, -0.002];

describe('indicatorii de risc pe serii cunoscute', () => {
  it('volatilitatea anualizată: abaterea standard a randamentelor zilnice × √365', () => {
    // +1%, −1% alternativ: media 0, abaterea standard (n − 1) = 1% × √(10/9).
    const alternating = series(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)));
    expect(annualizedVolatility(alternating)).toBeCloseTo(0.01 * Math.sqrt(10 / 9) * Math.sqrt(365), 10);
    // Creștere constantă: nicio variație.
    expect(annualizedVolatility(series(Array(12).fill(0.001)))).toBeCloseTo(0, 12);
    // Prea puține date: fără cifră.
    expect(annualizedVolatility(series([0.01, 0.02]))).toBeNull();
  });

  it('scăderea maximă, cu vârful, minimul și ziua revenirii', () => {
    // 1 → 1,2 → 1,08 → 0,9 → 1,1 → 1,25: scăderea maximă = 0,9 / 1,2 − 1 = −25%.
    const s: ReturnPoint[] = [
      { date: '2025-01-01', twr: 0 },
      { date: '2025-02-01', twr: 0.2 },
      { date: '2025-03-01', twr: 0.08 },
      { date: '2025-04-01', twr: -0.1 },
      { date: '2025-05-01', twr: 0.1 },
      { date: '2025-06-01', twr: 0.25 }
    ];
    const dd = maxDrawdown(s);
    expect(dd?.value).toBeCloseTo(-0.25, 12);
    expect(dd).toMatchObject({ peakDate: '2025-02-01', troughDate: '2025-04-01', recoveryDate: '2025-06-01' });
    expect(maxDrawdown(s.slice(0, 5))?.recoveryDate).toBeNull(); // încă sub vârf
    expect(maxDrawdown(series([0.01, 0.02, 0.03]))).toBeNull(); // nicio scădere
  });

  it('beta: dublul pieței = 2, invers = −1, independent de piață ≈ 0', () => {
    const market = series(MARKET);
    expect(beta(series(MARKET.map((r) => 2 * r)), market)).toBeCloseTo(2, 10);
    expect(beta(series(MARKET.map((r) => -r)), market)).toBeCloseTo(-1, 10);
    expect(beta(series(MARKET.map((r) => 0.5 * r + 0.001)), market)).toBeCloseTo(0.5, 10);
    expect(beta(market, market)).toBeCloseTo(1, 12);
    // O serie constantă (fără mișcare) nu depinde de piață.
    expect(beta(series(Array(MARKET.length).fill(0.0005)), market)).toBeCloseTo(0, 10);
    // Se folosesc doar zilele comune; prea puține zile = fără cifră.
    expect(beta(series(MARKET.slice(0, 5)), market)).toBeNull();
  });
});

describe('scorul de diversificare', () => {
  const base = { sectors: [], countries: [], currencies: [], types: [], unknownSector: { pct: 0, symbols: [] }, limit: 0.2 };

  it('20 de poziții egale, în sectoare, țări și monede diferite: 10', () => {
    const positions = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, weight: 0.05 }));
    const r = assessDiversification({
      ...base,
      positions,
      sectors: Array.from({ length: 5 }, (_, i) => ({ label: `Sector ${i}`, pct: 0.2 })),
      countries: [
        { label: 'SUA', pct: 0.4 },
        { label: 'Germania', pct: 0.3 },
        { label: 'România', pct: 0.3 }
      ],
      currencies: [
        { label: 'USD', pct: 0.5 },
        { label: 'EUR', pct: 0.3 },
        { label: 'RON', pct: 0.2 }
      ],
      types: [
        { label: 'Acțiuni', pct: 0.6 },
        { label: 'ETF-uri', pct: 0.3 },
        { label: 'Obligațiuni', pct: 0.1 }
      ]
    });
    expect(r.score).toBe(10);
    expect(r.effectivePositions).toBeCloseTo(20, 10);
    expect(r.suggestions).toEqual(['Portofoliul este bine diversificat după toate criteriile de mai sus.']);
  });

  it('portofoliu concentrat: scor mic și sugestii concrete', () => {
    const r = assessDiversification({
      ...base,
      positions: [
        { symbol: 'NVDA', weight: 0.5 },
        { symbol: 'AAPL', weight: 0.2 },
        { symbol: 'TLV.RO', weight: 0.3 }
      ],
      sectors: [
        { label: 'Tehnologie', pct: 0.7 },
        { label: 'Servicii financiare', pct: 0.3 }
      ],
      countries: [
        { label: 'SUA', pct: 0.7 },
        { label: 'România', pct: 0.3 }
      ],
      currencies: [
        { label: 'USD', pct: 0.7 },
        { label: 'RON', pct: 0.3 }
      ],
      types: [{ label: 'Acțiuni', pct: 1 }]
    });
    expect(r.score).toBeLessThanOrEqual(3);
    expect(r.suggestions).toEqual([
      'NVDA reprezintă 50% din portofoliu, peste pragul tău de 20%.',
      'TLV.RO reprezintă 30% din portofoliu, peste pragul tău de 20%.',
      'Practic doar 3 poziții contează: o problemă la una dintre ele afectează mult tot portofoliul.',
      '70% din portofoliu e în tehnologie. Un ETF pe toată piața sau poziții din alte sectoare reduc dependența de un singur domeniu.',
      '70% din investiții sunt în companii din SUA.'
    ]);
  });

  it('o singură poziție: scorul minim', () => {
    const r = assessDiversification({ ...base, positions: [{ symbol: 'BTC-USD', weight: 1 }], sectors: [{ label: 'Crypto', pct: 1 }], currencies: [{ label: 'USD', pct: 1 }], types: [{ label: 'Crypto', pct: 1 }] });
    expect(r.score).toBe(1);
    expect(r.suggestions).toContain('Tot portofoliul este într-o singură poziție.');
    expect(r.suggestions).toContain('100% din portofoliu este în USD: rezultatul depinde și de cursul acestei monede.');
  });
});

describe('sectorul și țara activelor', () => {
  it('denumiri în română și valori implicite după tipul activului și bursă', () => {
    expect(sectorLabel('Technology')).toBe('Tehnologie');
    expect(assetSector({ type: 'stock', sector: 'Financial Services' })).toBe('Servicii financiare');
    expect(assetSector({ type: 'stock', sector: null })).toBe('Necunoscut');
    expect(assetSector({ type: 'etf', sector: null })).toBe('ETF (mai multe)');
    expect(assetSector({ type: 'etf', sector: 'Obligațiuni corporative' })).toBe('Obligațiuni corporative');
    expect(assetSector({ type: 'crypto', sector: null })).toBe('Crypto');
    expect(assetCountry({ type: 'stock', symbol: 'AAPL', currency: 'USD', country: 'United States' })).toBe('SUA');
    expect(assetCountry({ type: 'stock', symbol: 'TLV.RO', currency: 'RON', country: null })).toBe('România');
    expect(assetCountry({ type: 'stock', symbol: 'SAP.DE', currency: 'EUR', country: null })).toBe('Germania');
    expect(assetCountry({ type: 'bond', symbol: 'R2710A', currency: 'RON', country: null })).toBe('România');
    expect(assetCountry({ type: 'etf', symbol: 'VWCE.DE', currency: 'EUR', country: null })).toBe('ETF (mai multe)');
    expect(assetCountry({ type: 'etf', symbol: 'TVBETETF.RO', currency: 'RON', country: 'Romania' })).toBe('România');
    expect(assetCountry({ type: 'etf', symbol: 'SPY', currency: 'USD', country: null })).toBe('ETF (mai multe)');
    expect(assetCountry({ type: 'crypto', symbol: 'BTC-USD', currency: 'USD', country: null })).toBe('Fără țară (crypto)');
  });
});

/* ------------------------------------------------- cu baza de date */

let db: Db;
let user: User;
const secrets = createAesBox(randomBytes(32));
const today = todayIso();

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'riscant', password: 'parola-risc-1' });
});
afterAll(() => db.close());
beforeEach(() => {
  for (const table of ['transactions', 'assets', 'brokers', 'prices', 'price_history', 'history_sync']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM portfolios WHERE name <> 'Principal'").run();
  updateSettings(db, user.id, { baseCurrency: 'RON', benchmark: '^GSPC', concentrationLimit: 0.2 });
});

describe('indicele de referință', () => {
  it('se alege din setări, cu prag de concentrare validat', () => {
    expect(getSettings(db, user.id)).toMatchObject({ benchmark: '^GSPC', concentrationLimit: 0.2 });
    expect(updateSettings(db, user.id, { benchmark: '^NDX', concentrationLimit: 0.25 })).toMatchObject({ benchmark: '^NDX', concentrationLimit: 0.25 });
    expect(() => updateSettings(db, user.id, { benchmark: 'XYZ' })).toThrow(/necunoscut/);
    expect(() => updateSettings(db, user.id, { concentrationLimit: 0.01 })).toThrow(/între 5% și 90%/);
  });

  it('randamentul indicelui se compară în moneda portofoliului, de la prima zi cu date', () => {
    const start = addDays(today, -60);
    const broker = createBroker(db, user.id, { name: 'XTB' });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: broker.id, date: start, currency: 'RON', amount: 10000 });
    addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'TLV.RO', currency: 'RON' }, brokerId: broker.id, date: start, quantity: 100, price: 30, fee: 0 });
    saveHistory(db, user.id, 'TLV.RO', [{ date: start, close: 30 }], true, 'yahoo');
    saveQuote(db, user.id, { symbol: 'TLV.RO', price: 33, currency: 'RON', asOf: `${today}T12:00:00Z`, provider: 'yahoo' });
    // S&P 500: +10% în USD; cursul USD/RON: +10% → +21% în lei.
    saveHistory(db, user.id, '^GSPC', [{ date: start, close: 5000 }, { date: addDays(today, -1), close: 5500 }], true, 'yahoo');
    saveHistory(db, user.id, 'USDRON=X', [{ date: start, close: 4.5 }, { date: addDays(today, -1), close: 4.95 }], true, 'yahoo');
    saveQuote(db, user.id, { symbol: 'USDRON=X', price: 4.95, currency: 'RON', asOf: `${today}T12:00:00Z`, provider: 'yahoo' });

    const perf = getPerformance(db, user.id, '3M', {}, today);
    expect(perf.benchmark).toMatchObject({ symbol: '^GSPC', name: 'S&P 500', currency: 'USD', from: start });
    expect(perf.benchmark?.return).toBeCloseTo(0.21, 10);
    // Portofoliul: 3.000 RON în acțiuni (+10%) și 7.000 RON cash: +3%.
    expect(perf.benchmark?.portfolioReturn).toBeCloseTo(0.03, 10);
    expect(perf.points[0].benchmark).toBe(0);
    expect(perf.points[perf.points.length - 1].benchmark).toBeCloseTo(0.21, 10);

    // Un portofoliu cu indicele lui (BET prin ETF, în lei), care are date doar de la o dată ulterioară.
    const ro = createPortfolio(db, user.id, { name: 'BVB', color: 'teal', icon: 'landmark', baseCurrency: 'RON', benchmark: 'TVBETETF.RO' });
    addPurchase(db, user.id, { portfolioId: ro.id, asset: { type: 'stock', symbol: 'TLV.RO', currency: 'RON' }, brokerId: broker.id, date: start, quantity: 10, price: 30, fee: 0 });
    saveHistory(db, user.id, 'TVBETETF.RO', [{ date: addDays(today, -20), close: 50 }, { date: addDays(today, -1), close: 55 }], true, 'yahoo');
    const bvb = getPerformance(db, user.id, '3M', { portfolioId: ro.id }, today);
    expect(bvb.benchmark).toMatchObject({ symbol: 'TVBETETF.RO', currency: 'RON' });
    expect(bvb.benchmark?.from && bvb.benchmark.from >= addDays(today, -20)).toBe(true);
    expect(bvb.benchmark?.return).toBeCloseTo(0.1, 10);
    expect(bvb.points[0].benchmark).toBeNull(); // înainte de prima zi cu date
  });
});

describe('raportul de risc', () => {
  it('concentrare, expuneri pe sector, țară, monedă și tip, sugestii', () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    const buy = (symbol: string, type: 'stock' | 'etf' | 'crypto', currency: string, value: number) => {
      addPurchase(db, user.id, { asset: { type, symbol, currency }, brokerId: broker.id, date: '2025-01-10', quantity: 1, price: value, fee: 0 });
      saveQuote(db, user.id, { symbol, price: value, currency, asOf: `${today}T12:00:00Z`, provider: 'yahoo' });
    };
    buy('NVDA', 'stock', 'RON', 5000);
    buy('TLV.RO', 'stock', 'RON', 3000);
    buy('VWCE.DE', 'etf', 'RON', 1500);
    buy('BTC-USD', 'crypto', 'RON', 500);
    const nvda = listAssets(db, user.id).find((a) => a.symbol === 'NVDA')!;
    updateAsset(db, user.id, nvda.id, { sector: 'Technology', country: 'United States' });

    const report = getRiskReport(db, user.id, '1Y', {}, today);
    expect(report.holdingsValue).toBe(10000);
    expect(report.positions.map((p) => `${p.symbol} ${p.weight} ${p.sector} ${p.country}`)).toEqual([
      'NVDA 0.5 Tehnologie SUA',
      'TLV.RO 0.3 Necunoscut România',
      'VWCE.DE 0.15 ETF (mai multe) ETF (mai multe)',
      'BTC-USD 0.05 Crypto Fără țară (crypto)'
    ]);
    expect(report.bySector.map((s) => `${s.label} ${s.pct}`)).toEqual(['Tehnologie 0.5', 'Necunoscut 0.3', 'ETF (mai multe) 0.15', 'Crypto 0.05']);
    expect(report.byCountry.map((s) => s.label)).toEqual(['SUA', 'România', 'ETF (mai multe)', 'Fără țară (crypto)']);
    expect(report.byType.map((s) => `${s.label} ${s.pct}`)).toEqual(['Acțiuni 0.8', 'ETF-uri 0.15', 'Crypto 0.05']);
    expect(report.unknownSector).toEqual(['TLV.RO']);
    expect(report.benchmark).toEqual({ symbol: '^GSPC', name: 'S&P 500' });
    expect(report.suggestions[0]).toBe('NVDA reprezintă 50% din portofoliu, peste pragul tău de 20%.');
    expect(report.suggestions.some((s) => s.startsWith('50% din portofoliu e în tehnologie'))).toBe(true);
    expect(report.suggestions.some((s) => s.includes('sectorul nu este cunoscut (TLV.RO)'))).toBe(true);

    // Pragul de concentrare se schimbă din setări.
    updateSettings(db, user.id, { concentrationLimit: 0.6 });
    expect(getRiskReport(db, user.id, '1Y', {}, today).suggestions.some((s) => s.includes('peste pragul'))).toBe(false);
  });
});

describe('profilul activelor (sector și țară)', () => {
  class ProfileProvider implements PriceProvider {
    readonly id: ProviderId = 'yahoo';
    calls: string[] = [];
    async getQuote(ref: SymbolRef) {
      return { symbol: ref.symbol, price: 10, currency: 'USD', asOf: new Date().toISOString() };
    }
    async getHistory() {
      return { points: [], splitAdjusted: true };
    }
    async search() {
      return [];
    }
    async getProfile(ref: SymbolRef): Promise<AssetProfile | null> {
      this.calls.push(ref.symbol);
      return ref.symbol === 'AAPL' ? { sector: 'Technology', country: 'United States' } : null;
    }
  }

  it('se completează de la provider pentru activele deținute; cele completate manual rămân', async () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    for (const symbol of ['AAPL', 'XYZ', 'KO']) {
      addPurchase(db, user.id, { asset: { type: 'stock', symbol, currency: 'USD' }, brokerId: broker.id, date: '2025-01-10', quantity: 1, price: 10, fee: 0 });
    }
    const ko = listAssets(db, user.id).find((a) => a.symbol === 'KO')!;
    updateAsset(db, user.id, ko.id, { sector: 'Consum de bază', country: 'SUA' });
    const provider = new ProfileProvider();
    await new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? provider : null) }).refresh(user.id);
    expect(provider.calls.sort()).toEqual(['AAPL', 'XYZ']);
    const bySymbol = Object.fromEntries(listAssets(db, user.id).map((a) => [a.symbol, `${a.sector} ${a.country} ${a.profileSource}`]));
    expect(bySymbol).toMatchObject({ AAPL: 'Technology United States api', XYZ: 'null null none', KO: 'Consum de bază SUA manual' });

    // A doua actualizare nu mai cere profilurile (se reîmprospătează la 90 de zile).
    await new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? provider : null) }).refresh(user.id, { force: true });
    expect(provider.calls).toHaveLength(2);
    // Golirea câmpurilor manuale le dă înapoi providerului.
    expect(updateAsset(db, user.id, ko.id, { sector: '', country: '' })).toMatchObject({ sector: null, country: null, profileSource: null });
  });
});
