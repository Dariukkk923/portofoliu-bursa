/**
 * Randamentul (TWR) se calculează doar din profit: depunerile, retragerile și cash-ul neinvestit
 * nu sunt câștig sau pierdere. Primul test reproduce situația raportată: cumpărări de ~5.955 USD
 * fără depuneri înregistrate, apoi soldul de cash setat la 4.000 USD printr-o ajustare.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/types';
import { performanceLooksOff } from '@shared/calc';
import { addDays } from '@shared/dates';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { updateSettings } from '@main/services/settings';
import { addPurchase, createTransaction } from '@main/services/transactions';
import { getOverview, getPerformance } from '@main/services/portfolio';
import { saveHistory, saveQuote } from '@main/prices/store';

let db: Db;
let user: User;
const TODAY = '2026-03-02';

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'randament', password: 'parola-randament-1' });
  updateSettings(db, user.id, { baseCurrency: 'USD' });
});
afterAll(() => db.close());
beforeEach(() => {
  for (const table of ['transactions', 'assets', 'brokers', 'prices', 'price_history']) db.prepare(`DELETE FROM ${table}`).run();
});

/** Istoric zilnic liniar între puncte (data, preț), plus cotația de azi. */
function prices(symbol: string, points: [string, number][]): void {
  const rows: { date: string; close: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [d0, p0] = points[i];
    const [d1, p1] = points[i + 1];
    for (let d = d0, k = 0; d < d1; d = addDays(d, 1), k++) {
      const total = Math.round((Date.parse(d1) - Date.parse(d0)) / 86_400_000);
      rows.push({ date: d, close: p0 + ((p1 - p0) * k) / total });
    }
  }
  const [lastDate, lastPrice] = points[points.length - 1];
  rows.push({ date: lastDate, close: lastPrice });
  saveHistory(db, user.id, symbol, rows, true, 'yahoo');
  saveQuote(db, user.id, { symbol, price: lastPrice, currency: 'USD', asOf: `${TODAY}T12:00:00Z`, provider: 'yahoo' });
}

const stock = (symbol: string) => ({ type: 'stock' as const, symbol, currency: 'USD' });

describe('randamentul nu numără depunerile ca profit', () => {
  it('situația din captură: cost ~5.955 USD, cash setat la 4.000 USD, profit −18,35 USD → TWR ≈ −0,3%, nu +138%', () => {
    const xtb = createBroker(db, user.id, { name: 'XTB' });
    const { asset } = addPurchase(db, user.id, { asset: stock('AAA'), brokerId: xtb.id, date: '2025-02-03', quantity: 10, price: 595.538, fee: 0 });
    createTransaction(db, user.id, { assetId: asset.id, brokerId: xtb.id, type: 'dividend', date: '2025-09-15', grossAmount: 16.02, taxWithheld: 0 });
    // Soldul calculat era −5.939,36 USD; utilizatorul l-a setat la 4.000 USD (ajustare +9.939,36).
    createTransaction(db, user.id, { type: 'adjustment', assetId: null, brokerId: xtb.id, date: '2026-01-10', currency: 'USD', amount: 9939.36 });
    prices('AAA', [['2025-02-03', 595.538], ['2025-06-02', 640], ['2025-10-01', 570], [TODAY, 592.101]]);

    const o = getOverview(db, user.id, {}, TODAY);
    expect(o.totals.totalValue).toBeCloseTo(9921.01, 2);
    expect(o.totals.totalPnl).toBeCloseTo(-18.35, 2);

    const perf = getPerformance(db, user.id, 'ALL', {}, TODAY);
    expect(perf.allTime.netContributions).toBeCloseTo(9939.36, 2);
    expect(perf.allTime.gain).toBeCloseTo(-18.35, 2);
    // Profit / bani puși = −0,18%; TWR-ul (−0,8%) diferă puțin pentru că după ajustare 4.000 USD stau în
    // cash și nu cresc odată cu acțiunile. Important: același semn și aceeași mărime, nu +138%.
    expect(perf.twr as number).toBeGreaterThan(-0.015);
    expect(perf.twr as number).toBeLessThan(0);
    expect(perf.xirr as number).toBeLessThan(0);
    // Graficul nu sare la sute de procente pe parcurs.
    expect(Math.max(...perf.points.map((p) => p.twr))).toBeLessThan(0.1);
  });

  it('depunere la mijlocul perioadei: cash-ul neinvestit nu câștigă și nu pierde', () => {
    const b = createBroker(db, user.id, { name: 'Broker' });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: b.id, date: '2025-01-02', currency: 'USD', amount: 1000 });
    addPurchase(db, user.id, { asset: stock('BBB'), brokerId: b.id, date: '2025-01-02', quantity: 10, price: 100, fee: 0 });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: b.id, date: '2025-07-01', currency: 'USD', amount: 5000 });
    prices('BBB', [['2025-01-02', 100], ['2025-07-01', 110], ['2025-12-31', 121], [TODAY, 121]]);
    const perf = getPerformance(db, user.id, 'ALL', {}, TODAY);
    // +10% pe 1.100 USD, apoi +10% pe acțiuni din 6.100 USD (cash 5.000 la 0%): 1,1 × 1,018 − 1 ≈ 12%.
    expect(perf.twr as number).toBeGreaterThan(0.1);
    expect(perf.twr as number).toBeLessThan(0.14);
    expect(perf.allTime.netContributions).toBeCloseTo(6000, 6);
    expect(perf.allTime.gain).toBeCloseTo(210, 6);
  });

  it('retragere: banii scoși nu sunt pierdere', () => {
    const b = createBroker(db, user.id, { name: 'Broker' });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: b.id, date: '2025-01-02', currency: 'USD', amount: 2000 });
    addPurchase(db, user.id, { asset: stock('CCC'), brokerId: b.id, date: '2025-01-02', quantity: 10, price: 100, fee: 0 });
    createTransaction(db, user.id, { type: 'withdrawal', assetId: null, brokerId: b.id, date: '2025-07-01', currency: 'USD', amount: 500 });
    prices('CCC', [['2025-01-02', 100], ['2025-07-01', 120], ['2025-12-31', 132], [TODAY, 132]]);
    const perf = getPerformance(db, user.id, 'ALL', {}, TODAY);
    // 2.000 → 2.200 (+10%), retragere 500, apoi 1.700 → 1.820 (+7,06%): ≈ +17,8%.
    expect(perf.twr as number).toBeGreaterThan(0.15);
    expect(perf.twr as number).toBeLessThan(0.2);
    expect(perf.allTime.netContributions).toBeCloseTo(1500, 6);
    expect(perf.allTime.gain).toBeCloseTo(320, 6);
  });

  it('cumpărări mai mari decât depunerile: lipsa se tratează ca depunere, nu ca pierdere', () => {
    const b = createBroker(db, user.id, { name: 'Broker' });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: b.id, date: '2025-01-02', currency: 'USD', amount: 100 });
    addPurchase(db, user.id, { asset: stock('DDD'), brokerId: b.id, date: '2025-01-02', quantity: 10, price: 100, fee: 0 });
    prices('DDD', [['2025-01-02', 100], [TODAY, 110]]);
    const perf = getPerformance(db, user.id, 'ALL', {}, TODAY);
    expect(perf.twr as number).toBeCloseTo(0.1, 2);
    expect(perf.allTime.netContributions).toBeCloseTo(1000, 6);
    expect(perf.allTime.gain).toBeCloseTo(100, 6);
  });

  it('S&P 500 pe aceeași perioadă: închiderea de la începutul și de la sfârșitul intervalului, ambele curbe de la 0%', () => {
    updateSettings(db, user.id, { benchmark: '^GSPC' });
    const b = createBroker(db, user.id, { name: 'Broker' });
    addPurchase(db, user.id, { asset: stock('EEE'), brokerId: b.id, date: '2025-01-02', quantity: 10, price: 100, fee: 0 });
    prices('EEE', [['2025-01-02', 100], [TODAY, 120]]);
    prices('^GSPC', [['2025-01-02', 5000], [TODAY, 6000]]);
    const perf = getPerformance(db, user.id, '1Y', {}, TODAY);
    const start = perf.points[0].date;
    const close = (d: string) => 5000 + (1000 * Math.round((Date.parse(d) - Date.parse('2025-01-02')) / 86_400_000)) / Math.round((Date.parse(TODAY) - Date.parse('2025-01-02')) / 86_400_000);
    expect(perf.benchmark?.from).toBe(start);
    expect(perf.benchmark?.return as number).toBeCloseTo(6000 / close(start) - 1, 6);
    expect(perf.points[0].twr).toBe(0);
    expect(perf.points[0].benchmark).toBe(0);
    expect(perf.benchmark?.portfolioReturn as number).toBeCloseTo(120 / (100 + (20 * Math.round((Date.parse(start) - Date.parse('2025-01-02')) / 86_400_000)) / Math.round((Date.parse(TODAY) - Date.parse('2025-01-02')) / 86_400_000)) - 1, 3);
  });

  it('verificarea de bun-simț semnalează un randament cu alt semn sau enorm față de profit', () => {
    expect(performanceLooksOff(1.387, -18.35, 9939.36)).toMatch(/alt semn/);
    expect(performanceLooksOff(2.5, 50, 10000)).toMatch(/diferă enorm/);
    expect(performanceLooksOff(-0.003, -18.35, 9939.36)).toBeNull();
    expect(performanceLooksOff(0.12, 210, 6000)).toBeNull();
  });
});
