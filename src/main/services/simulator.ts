/**
 * Simulatorul „ce-ar fi fost dacă”:
 *  - comparația cu piața: depunerile tale (aceleași date și sume) investite într-un ETF sau indice;
 *  - investiția lunară (DCA): aceeași sumă în fiecare lună, de la o dată;
 *  - investiția unică: o sumă la o dată.
 * Cu dividendele reinvestite (opțional), conversie valutară la cursul fiecărei zile și comision.
 * Datele (istoric, curs, dividende) trebuie să fie deja în cache (vezi `PriceService.prepareInstrument`).
 */
import type { SimulationPoint, SimulationRequest, SimulationResult } from '@shared/types';
import { BENCHMARKS } from '@shared/benchmarks';
import { simPresetName } from '@shared/simulator';
import { isIsoDate, todayIso } from '@shared/dates';
import { buildDateRange, monthlyFlows, simulateInvestment, xirr, type SimFlow } from '@shared/calc';
import type { Db } from '../db/database';
import { assert } from './common';
import { listAssets } from './assets';
import { resolveScope } from './portfolios';
import { externalFlows, getPerformance, makeFxOn } from './portfolio';
import { fxSymbol, getCachedPrices, loadHistory } from '../prices/store';

const fmtDay = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Verifică cererea și întoarce data de început a simulării. */
export function simulationStart(db: Db, userId: number, req: SimulationRequest, today: string = todayIso()): string {
  const symbol = String(req.symbol ?? '').trim();
  assert(/^[\^A-Za-z0-9.=-]{1,20}$/.test(symbol), 'Scrie simbolul instrumentului (ex.: SPY, VWCE.DE).');
  const fee = Number(req.feePct ?? 0);
  assert(Number.isFinite(fee) && fee >= 0 && fee < 0.1, 'Comisionul trebuie să fie între 0% și 10%.');
  if (req.mode === 'market') {
    const { flows } = externalFlows(db, userId, req.filter ?? {}, today);
    assert(flows.length > 0, 'Nu există depuneri sau cumpărări în portofoliu de comparat.');
    return flows.reduce((min, f) => (f.date < min ? f.date : min), flows[0].date);
  }
  assert(req.startDate && isIsoDate(req.startDate), 'Alege data de început.');
  assert(req.startDate < today, 'Data de început trebuie să fie în trecut.');
  assert(req.startDate >= '1990-01-01', 'Data de început este prea veche.');
  const amount = Number(req.amount);
  assert(Number.isFinite(amount) && amount > 0, 'Scrie suma investită.');
  return req.startDate;
}

export function runSimulation(db: Db, userId: number, req: SimulationRequest, today: string = todayIso()): SimulationResult {
  const start = simulationStart(db, userId, req, today);
  const scope = resolveScope(db, userId, req.filter?.portfolioId);
  const base = scope.baseCurrency;
  const symbol = req.symbol.trim().toUpperCase();
  const cache = getCachedPrices(db, userId);
  const asset = listAssets(db, userId).find((a) => a.symbol === symbol);
  const currency = cache.get(symbol)?.currency ?? BENCHMARKS.find((b) => b.symbol === symbol)?.currency ?? asset?.currency ?? base;
  const history = loadHistory(db, userId, [symbol, fxSymbol(currency, base)]);
  const prices = (history.get(symbol) ?? []).map((r) => ({ date: r.date, close: r.close }));
  assert(prices.length > 0, `Nu există istoric de prețuri pentru ${symbol}. Verifică simbolul (ex.: SPY, VWCE.DE) și conexiunea la internet.`);
  const fx = makeFxOn(base, history, cache, today);
  const fxOn = (date: string): number => Number(fx(currency, date));

  // Fluxurile: depunerile tale, investiția lunară sau cea unică.
  let flows: SimFlow[];
  let actual: Map<string, number> | null = null;
  let dates: string[];
  if (req.mode === 'market') {
    flows = externalFlows(db, userId, req.filter ?? {}, today).flows;
    // Valoarea reală include cash-ul urmărit: depunerile neinvestite fac parte din portofoliu.
    const real = getPerformance(db, userId, 'ALL', req.filter ?? {}, today).points;
    actual = new Map(real.map((p) => [p.date, p.value]));
    dates = real.length > 0 ? real.map((p) => p.date) : buildDateRange(start, today, 300);
  } else {
    const amount = Number(req.amount);
    flows = req.mode === 'dca' ? monthlyFlows(amount, start, today) : [{ date: start, amount }];
    dates = buildDateRange(start, today, 300);
  }

  const dividends = req.includeDividends
    ? (db.prepare('SELECT ex_date, amount FROM dividend_events WHERE user_id = ? AND symbol = ? ORDER BY ex_date').all(userId, symbol) as { ex_date: string; amount: string }[]).map((d) => ({
        exDate: d.ex_date,
        amount: Number(d.amount)
      }))
    : null;
  const sim = simulateInvestment(flows, { prices, fxOn, dividends, feePct: Number(req.feePct ?? 0), dates });

  const points: SimulationPoint[] = sim.points.map((p) => ({ ...p, actual: actual ? (actual.get(p.date) ?? null) : null }));
  const actualValue = actual ? (points[points.length - 1]?.actual ?? null) : null;
  const gain = sim.finalValue - sim.invested;
  const annualized = xirr([...flows.map((f) => ({ date: f.date, amount: -f.amount })), { date: today, amount: sim.finalValue }]);

  const notes: string[] = [];
  if (prices[0].date > start) notes.push(`Istoricul pentru ${symbol} începe pe ${fmtDay(prices[0].date)}: sumele de dinainte sunt investite la primul preț disponibil.`);
  if (req.includeDividends) {
    if (symbol.startsWith('^')) notes.push('Un indice nu plătește dividende: pentru dividende reinvestite alege un ETF (ex.: SPY pentru S&P 500).');
    else if (!dividends || dividends.length === 0) notes.push(`Nu s-au găsit dividende pentru ${symbol} (poate nu plătește sau datele nu sunt disponibile).`);
  }
  if (currency !== base) notes.push(`Sumele sunt convertite din ${base} în ${currency} la cursul fiecărei zile, iar valoarea finală înapoi în ${base} la cursul de azi.`);
  if (req.mode === 'market') notes.push('Valoarea reală a portofoliului include cash-ul neinvestit de la brokerii cu depuneri înregistrate.');

  return {
    mode: req.mode,
    symbol,
    name: simPresetName(symbol) ?? BENCHMARKS.find((b) => b.symbol === symbol)?.name ?? asset?.name ?? symbol,
    currency,
    baseCurrency: base,
    points,
    invested: sim.invested,
    finalValue: sim.finalValue,
    gain,
    gainPct: sim.invested > 0 ? gain / sim.invested : null,
    annualized,
    fees: sim.fees,
    reinvested: sim.reinvested,
    actualValue,
    startDate: start,
    endDate: today,
    notes
  };
}
