/**
 * Simulatorul „ce-ar fi fost dacă” și obiectivele financiare: investiția simulată (comision,
 * curs valutar, dividende reinvestite, retrageri), contribuția medie, anualizarea randamentului,
 * calculul determinist fără volatilitate, contribuția lunară necesară, Monte Carlo, plus
 * serviciile (simulare pe istoricul salvat, obiective cu date din aplicație).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/types';
import { addDays, addMonths } from '@shared/dates';
import {
  annualize,
  averageMonthlyContribution,
  cagr,
  futureValue,
  monteCarlo,
  monthlyFlows,
  monthlyVolatility,
  monthsToTarget,
  requiredMonthlyContribution,
  simulateInvestment
} from '@shared/calc';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase, createTransaction } from '@main/services/transactions';
import { updateSettings } from '@main/services/settings';
import { runSimulation } from '@main/services/simulator';
import { createGoal, deleteGoal, listGoals, updateGoal } from '@main/services/goals';
import { saveHistory, saveQuote } from '@main/prices/store';
import { saveDividendEvents } from '@main/services/dividends';

const flat = (dates: string[], close: number) => dates.map((date) => ({ date, close }));

describe('investiția simulată', () => {
  const prices = [
    { date: '2024-01-02', close: 100 },
    { date: '2024-06-03', close: 120 },
    { date: '2025-01-02', close: 150 }
  ];

  it('investiție unică: valoarea crește cu prețul; comisionul se scade la cumpărare', () => {
    const r = simulateInvestment([{ date: '2024-01-02', amount: 1000 }], { prices, fxOn: () => 1, dividends: null, feePct: 0, dates: ['2024-01-02', '2025-01-02'] });
    expect(r.units).toBe(10);
    expect(r.finalValue).toBe(1500);
    expect(r.points).toEqual([
      { date: '2024-01-02', value: 1000, invested: 1000 },
      { date: '2025-01-02', value: 1500, invested: 1000 }
    ]);
    const withFee = simulateInvestment([{ date: '2024-01-02', amount: 1000 }], { prices, fxOn: () => 1, dividends: null, feePct: 0.01, dates: ['2025-01-02'] });
    expect(withFee.fees).toBe(10);
    expect(withFee.finalValue).toBeCloseTo(1485, 10);
  });

  it('conversia valutară: lei → dolari la cursul zilei, înapoi la cursul de azi', () => {
    const fx = (d: string): number => (d < '2025-01-01' ? 4 : 5);
    const r = simulateInvestment([{ date: '2024-01-02', amount: 4000 }], { prices, fxOn: fx, dividends: null, feePct: 0, dates: ['2025-01-02'] });
    expect(r.units).toBe(10);
    expect(r.finalValue).toBe(10 * 150 * 5);
  });

  it('dividendele se reinvestesc la data ex-dividend', () => {
    const p = flat(['2024-01-02', '2024-03-01', '2024-12-31'], 100);
    const r = simulateInvestment([{ date: '2024-01-02', amount: 1000 }], { prices: p, fxOn: () => 1, dividends: [{ exDate: '2024-03-01', amount: 5 }], feePct: 0, dates: ['2024-12-31'] });
    expect(r.units).toBeCloseTo(10.5, 10);
    expect(r.reinvested).toBe(50);
    expect(r.finalValue).toBeCloseTo(1050, 10);
  });

  it('investiție lunară și retrageri', () => {
    expect(monthlyFlows(100, '2024-01-31', '2024-04-15').map((f) => f.date)).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
    const p = flat(['2024-01-01'], 50);
    const r = simulateInvestment(
      [
        { date: '2024-01-01', amount: 1000 },
        { date: '2024-02-01', amount: -500 }
      ],
      { prices: p, fxOn: () => 1, dividends: null, feePct: 0, dates: ['2024-03-01'] }
    );
    expect(r.units).toBe(10);
    expect(r.invested).toBe(500);
    expect(r.finalValue).toBe(500);
  });
});

describe('datele proiecției', () => {
  it('contribuția lunară medie din ultimele 12 luni', () => {
    const today = '2025-12-15';
    const flows = Array.from({ length: 18 }, (_, k) => ({ date: addMonths('2024-07-01', k), amount: 1000 }));
    flows.push({ date: '2025-06-10', amount: -2400 });
    // Ultimele 12 luni: 12 depuneri de 1.000 și o retragere de 2.400 → 9.600 / 12.
    expect(averageMonthlyContribution(flows, today, 12)).toBe(800);
    // Istoric scurt: împărțit la lunile calendaristice de la prima depunere (septembrie–decembrie).
    expect(averageMonthlyContribution([{ date: '2025-09-15', amount: 3000 }], today, 12)).toBe(750);
    expect(averageMonthlyContribution([], today)).toBe(0);
  });

  it('anualizarea randamentului și randamentul compus din prețuri', () => {
    expect(annualize(0.21, 730)).toBeCloseTo(0.1, 3);
    expect(cagr([{ date: '2020-01-01', close: 100 }, { date: '2022-01-01', close: 121 }])).toBeCloseTo(0.1, 3);
    expect(cagr([{ date: '2025-01-01', close: 100 }, { date: '2025-06-01', close: 121 }])).toBeNull();
    const steady = Array.from({ length: 25 }, (_, k) => ({ date: addMonths('2020-01-15', k), close: 100 * 1.01 ** k }));
    expect(monthlyVolatility(steady)).toBeCloseTo(0, 10);
  });

  it('fără volatilitate, rezultatul este cel exact', () => {
    expect(futureValue(1000, 0, 0.1, 24)).toBeCloseTo(1210, 9);
    expect(futureValue(5000, 500, 0, 12)).toBe(11000);
    // Cu contribuții: formula valorii viitoare a unei anuități la sfârșit de lună.
    const i = 1.12 ** (1 / 12) - 1;
    expect(futureValue(10000, 500, 0.12, 12)).toBeCloseTo(10000 * 1.12 + (500 * (1.12 - 1)) / i, 8);
    const mc = monteCarlo({ start: 10000, monthly: 500, annualReturn: 0.12, annualVolatility: 0, months: 24, scenarios: 50, target: 25000, targetMonth: 24, inflation: 0, real: false });
    expect(mc.p50[12]).toBeCloseTo(futureValue(10000, 500, 0.12, 12), 8);
    expect(mc.p10[24]).toBeCloseTo(mc.p90[24], 8);
    expect(mc.medianMonth).toBe(monthsToTarget(10000, 500, 0.12, 25000));
    expect(mc.probabilityByTarget).toBe(1);
  });

  it('contribuția lunară necesară pentru o țintă la o dată', () => {
    expect(requiredMonthlyContribution(0, 12000, 0, 24)).toBe(500);
    const needed = requiredMonthlyContribution(20000, 100000, 0.07, 60);
    expect(futureValue(20000, needed, 0.07, 60)).toBeCloseTo(100000, 6);
    expect(requiredMonthlyContribution(200000, 100000, 0.07, 60)).toBe(0);
  });

  it('Monte Carlo: scenarii reproductibile, interval pesimist–optimist, valori în bani de azi', () => {
    const base = { start: 20000, monthly: 800, annualReturn: 0.07, annualVolatility: 0.16, months: 240, scenarios: 2000, seed: 7, target: 150000, targetMonth: 120, inflation: 0.04 };
    const a = monteCarlo({ ...base, real: false });
    const b = monteCarlo({ ...base, real: false });
    expect(a.p50[120]).toBe(b.p50[120]);
    expect(a.p10[120]).toBeLessThan(a.p50[120]);
    expect(a.p50[120]).toBeLessThan(a.p90[120]);
    expect(a.fastMonth!).toBeLessThanOrEqual(a.medianMonth!);
    expect(a.medianMonth!).toBeLessThanOrEqual(a.slowMonth ?? Infinity);
    // Mediana se apropie de calculul determinist cu același randament.
    expect(Math.abs(a.p50[120] / futureValue(20000, 800, 0.07, 120) - 1)).toBeLessThan(0.08);
    // Textul și graficul spun același lucru: mediana trece de țintă exact în luna afișată,
    // iar la luna aceea cel puțin jumătate din scenarii au suma-țintă.
    const m = a.medianMonth!;
    expect(a.p50[m]).toBeGreaterThanOrEqual(base.target);
    expect(a.p50[m - 1]).toBeLessThan(base.target);
    expect(monteCarlo({ ...base, targetMonth: m, real: false }).probabilityByTarget!).toBeGreaterThanOrEqual(0.5);
    expect(monteCarlo({ ...base, targetMonth: 300, real: false }).probabilityByTarget).toBeNull();
    const real = monteCarlo({ ...base, real: true });
    expect(real.p50[120]).toBeLessThan(a.p50[120]);
    expect(real.probabilityByTarget!).toBeLessThan(a.probabilityByTarget!);
  });
});

let db: Db;
let user: User;
const TODAY = '2026-01-15';

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'planificator', password: 'parola-plan-1' });
  updateSettings(db, user.id, { baseCurrency: 'RON', benchmark: '^GSPC' });
});
afterAll(() => db.close());
beforeEach(() => {
  for (const table of ['goals', 'transactions', 'assets', 'brokers', 'prices', 'price_history', 'dividend_events']) db.prepare(`DELETE FROM ${table}`).run();
});

describe('serviciile simulatorului și ale obiectivelor', () => {
  const market = () => {
    // SPY: 400 $ în 2024, 500 $ azi; cursul USD/RON constant 4,5.
    saveHistory(db, user.id, 'SPY', [{ date: '2024-01-02', close: 400 }, { date: '2025-01-02', close: 450 }, { date: addDays(TODAY, -1), close: 500 }], true, 'yahoo');
    saveQuote(db, user.id, { symbol: 'SPY', price: 500, currency: 'USD', asOf: `${TODAY}T12:00:00Z`, provider: 'yahoo' });
    saveHistory(db, user.id, 'USDRON=X', [{ date: '2024-01-02', close: 4.5 }], true, 'yahoo');
    saveQuote(db, user.id, { symbol: 'USDRON=X', price: 4.5, currency: 'RON', asOf: `${TODAY}T12:00:00Z`, provider: 'yahoo' });
  };

  it('investiția unică și cea lunară, în lei, într-un ETF în dolari', () => {
    market();
    const lump = runSimulation(db, user.id, { mode: 'lump', symbol: 'spy', amount: 9000, startDate: '2024-01-02', includeDividends: false, feePct: 0 }, TODAY);
    expect(lump).toMatchObject({ symbol: 'SPY', currency: 'USD', baseCurrency: 'RON', invested: 9000 });
    expect(lump.finalValue).toBeCloseTo(9000 * 1.25, 8);
    expect(lump.gainPct).toBeCloseTo(0.25, 8);
    expect(lump.annualized).toBeGreaterThan(0.1);
    expect(lump.notes.some((n) => n.includes('convertite din RON în USD'))).toBe(true);

    const dca = runSimulation(db, user.id, { mode: 'dca', symbol: 'SPY', amount: 450, startDate: '2025-07-15', includeDividends: true, feePct: 0 }, TODAY);
    expect(dca.invested).toBe(450 * 7);
    expect(dca.notes.some((n) => n.includes('Nu s-au găsit dividende pentru SPY'))).toBe(true);
    saveDividendEvents(db, user.id, 'SPY', [{ exDate: '2025-09-19', payDate: null, amount: 1.8, currency: 'USD' }], 'yahoo');
    const withDiv = runSimulation(db, user.id, { mode: 'dca', symbol: 'SPY', amount: 450, startDate: '2025-07-15', includeDividends: true, feePct: 0 }, TODAY);
    expect(withDiv.finalValue).toBeGreaterThan(dca.finalValue);
    expect(withDiv.reinvested).toBeGreaterThan(0);
  });

  it('comparația cu piața: depunerile mele investite în SPY vs. portofoliul real', () => {
    market();
    const broker = createBroker(db, user.id, { name: 'XTB' });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: broker.id, date: '2024-01-02', currency: 'RON', amount: 10000 });
    addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'TLV.RO', currency: 'RON' }, brokerId: broker.id, date: '2024-01-02', quantity: 300, price: 30, fee: 0 });
    saveHistory(db, user.id, 'TLV.RO', [{ date: '2024-01-02', close: 30 }], true, 'yahoo');
    saveQuote(db, user.id, { symbol: 'TLV.RO', price: 33, currency: 'RON', asOf: `${TODAY}T12:00:00Z`, provider: 'yahoo' });
    const r = runSimulation(db, user.id, { mode: 'market', symbol: 'SPY', includeDividends: false, feePct: 0 }, TODAY);
    expect(r.invested).toBe(10000);
    expect(r.finalValue).toBeCloseTo(12500, 6);
    // Real: 300 × 33 = 9.900 lei în acțiuni + 1.000 lei cash neinvestit (face parte din portofoliu).
    expect(r.actualValue).toBeCloseTo(10900, 6);
    expect(r.points[r.points.length - 1].actual).toBeCloseTo(10900, 6);
    expect(() => runSimulation(db, user.id, { mode: 'lump', symbol: 'NIMIC', amount: 100, startDate: '2024-01-02', includeDividends: false, feePct: 0 }, TODAY)).toThrow(/Nu există istoric/);
    expect(() => runSimulation(db, user.id, { mode: 'lump', symbol: 'SPY', amount: 100, startDate: '2024-01-02', includeDividends: false, feePct: 0.2 }, TODAY)).toThrow(/Comisionul/);
  });

  it('obiectivele: date din aplicație, sursa automată și editare', () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    for (let k = 0; k < 8; k++) createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: broker.id, date: addMonths('2025-06-10', k), currency: 'RON', amount: 1500 });
    // S&P 500 din 2000: de la 1.000 la 4.000 în 24 de ani ≈ 5,9% pe an.
    saveHistory(db, user.id, '^GSPC', [{ date: '2000-01-03', close: 1000 }, { date: '2012-01-03', close: 1800 }, { date: '2024-01-03', close: 4000 }], true, 'yahoo');
    const goal = createGoal(db, user.id, { name: 'Fond de siguranță', targetAmount: 100000, targetDate: '2032-01-01' }, TODAY);
    const [view] = listGoals(db, user.id, TODAY);
    expect(view).toMatchObject({ id: goal.id, scopeLabel: 'Toate portofoliile', shortHistory: true, targetAmount: 100000 });
    expect(view.inputs.currentValue).toBe(12000);
    // Istoricul din grafic are aceeași bază ca valoarea actuală (cash-ul inclus).
    expect(view.inputs.history[view.inputs.history.length - 1].value).toBeCloseTo(12000, 6);
    expect(view.inputs.averageContribution).toBeCloseTo(12000 / 8, 6);
    expect(view.inputs.benchmark.annualReturn).toBeCloseTo(4 ** (1 / 24) - 1, 2);
    // Istoric personal sub 2 ani: randamentul vine de la indice.
    expect(view.effective).toMatchObject({ returnFrom: 'benchmark', monthly: 1500 });
    expect(view.progress).toBeCloseTo(0.12, 6);

    updateGoal(db, user.id, goal.id, { name: 'Fond', targetAmount: 50000, returnSource: 'manual', manualReturn: 0.05, monthlyContribution: 2000, inflation: 0.03 }, TODAY);
    const [edited] = listGoals(db, user.id, TODAY);
    expect(edited.effective).toMatchObject({ returnFrom: 'manual', annualReturn: 0.05, monthly: 2000 });
    expect(edited.targetDate).toBeNull();
    expect(() => createGoal(db, user.id, { name: 'X', targetAmount: 100, targetDate: '2020-01-01' }, TODAY)).toThrow(/în viitor/);
    deleteGoal(db, user.id, goal.id);
    expect(listGoals(db, user.id, TODAY)).toEqual([]);
  });
});
