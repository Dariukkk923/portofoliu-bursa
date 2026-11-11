/**
 * Portofoliul evaluat: poziții pe broker și agregate, cash, totaluri, alocări,
 * clasamente și seria istorică pentru grafic.
 *
 * Aici se leagă datele din bază (tranzacții, active, prețuri și cursuri salvate)
 * de modulul de calcul din `shared/calc`, care face toată aritmetica (zecimal exact).
 */
import type {
  Asset,
  CashBalanceView,
  HistoryPoint,
  HistoryRange,
  PerformanceData,
  PortfolioComparison,
  PortfolioFilter,
  PortfolioOverview,
  PositionView
} from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { BENCHMARKS, DEFAULT_BENCHMARK, benchmarkName } from '@shared/benchmarks';
import { addMonths, daysBetween, todayIso } from '@shared/dates';
import {
  accountKey,
  annualize,
  annualizedVolatility,
  maxDrawdown,
  buildAllocation,
  buildDateRange,
  buildPerformanceSeries,
  buildValueSeries,
  externalFlow,
  twrSeries,
  xirr,
  xirrFlows,
  combineValuations,
  Ledger,
  priceMultiplier,
  sortTransactions,
  summarize,
  topMovers,
  valuePosition,
  type HistoricalPrice,
  type LedgerTx,
  type Valuation
} from '@shared/calc';
import { dec, sum, toNum, ZERO, type DecValue } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { rowToLedgerTx } from './common';
import { listAssets } from './assets';
import { listBrokers } from './brokers';
import { getSettings } from './settings';
import { listPortfolios, resolveScope } from './portfolios';
import { fxSymbol, getCachedPrices, lastOnOrBefore, loadHistory, resolveFx, resolvePrice, type CachedPrice, type HistoryRow } from '../prices/store';

export function allLedgerTxs(db: Db, userId: number): LedgerTx[] {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ?').all(userId) as Record<string, unknown>[];
  return sortTransactions(rows.map(rowToLedgerTx));
}

/** Monedele folosite de active și de tranzacțiile de cash. */
function currenciesOf(txs: LedgerTx[], assets: Map<number, Asset>): Set<string> {
  const out = new Set<string>();
  for (const t of txs) {
    const asset = t.assetId != null ? assets.get(t.assetId) : undefined;
    if (asset) out.add(asset.currency);
    if (t.currency) out.add(t.currency);
    if (t.cashCurrency) out.add(t.cashCurrency);
  }
  return out;
}

/**
 * Cursul unei monede față de moneda de bază la o dată: cursul de închidere din
 * istoricul salvat (ultimul cunoscut până atunci, sau primul disponibil pentru
 * datele mai vechi), iar pentru azi și când nu există istoric, cursul curent.
 */
export function makeFxOn(
  base: string,
  history: Map<string, HistoryRow[]>,
  cache: Map<string, CachedPrice>,
  today: string
): (currency: string, date: string) => DecValue {
  return (currency, date) => {
    if (currency === base) return 1;
    if (date < today) {
      const rows = history.get(fxSymbol(currency, base));
      const row = lastOnOrBefore(rows, date) ?? rows?.[0];
      if (row) return row.close;
    }
    return resolveFx(cache, currency, base).rate;
  };
}

/**
 * Indicele de referință al unui portofoliu (al lui, altfel cel din setări) ca serie de randamente,
 * convertit în moneda de bază la cursul fiecărei zile, ca să fie comparabil cu randamentul portofoliului.
 * `levelOn` = valoarea indicelui în moneda de bază la o dată (null înainte de prima zi cu date).
 */
export function benchmarkSeries(
  db: Db,
  userId: number,
  symbol: string,
  base: string,
  cache: Map<string, CachedPrice>,
  today: string
): { symbol: string; name: string; currency: string; levelOn: (date: string) => number | null } {
  const info = BENCHMARKS.find((b) => b.symbol === symbol) ?? { symbol, name: benchmarkName(symbol), currency: base };
  const history = loadHistory(db, userId, [info.symbol, ...(info.currency !== base ? [fxSymbol(info.currency, base)] : [])]);
  const rows = history.get(info.symbol) ?? [];
  const fxOn = makeFxOn(base, history, cache, today);
  return {
    symbol: info.symbol,
    name: info.name,
    currency: info.currency,
    levelOn: (date) => {
      const row = lastOnOrBefore(rows, date);
      return row ? row.close * Number(fxOn(info.currency, date)) : null;
    }
  };
}

/** Indicele de referință folosit pentru un filtru: al portofoliului ales, altfel cel din setări. */
export function benchmarkFor(db: Db, userId: number, filter: PortfolioFilter): string {
  const scope = resolveScope(db, userId, filter.portfolioId);
  return scope.single?.benchmark ?? getSettings(db, userId).benchmark ?? DEFAULT_BENCHMARK;
}

/** Opțiuni interne: moneda în care se exprimă rezultatul (comparația portofoliilor folosește moneda din setări). */
export interface ScopeOptions {
  baseCurrency?: string;
}

/**
 * Portofoliul evaluat. `filter.portfolioId` alege un portofoliu (în moneda lui de bază);
 * fără el, toate portofoliile active, combinate, în moneda de bază din setări.
 */
export function getOverview(
  db: Db,
  userId: number,
  filter: PortfolioFilter = {},
  today: string = todayIso(),
  options: ScopeOptions = {}
): PortfolioOverview {
  const settings = getSettings(db, userId);
  const scope = resolveScope(db, userId, filter.portfolioId, options.baseCurrency);
  const base = scope.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const brokers = new Map(listBrokers(db, userId).map((b) => [b.id, b]));
  const cache = getCachedPrices(db, userId);
  const txs = allLedgerTxs(db, userId).filter(scope.includes);
  /** În vederea combinată cu mai multe portofolii, liniile poartă numele portofoliului. */
  const multi = !scope.single && scope.ids.size > 1;
  const portfolioName = (id: number | null): string | null => (id == null ? null : (scope.byId.get(id)?.name ?? null));
  const currencies = [...currenciesOf(txs, assets)].filter((c) => c !== base);
  const fxHistory = loadHistory(db, userId, currencies.map((c) => fxSymbol(c, base)));
  const fxOn = makeFxOn(base, fxHistory, cache, today);

  // Datele din bază sunt deja validate; modul tolerant evită ca o eventuală inconsecvență să blocheze ecranul.
  const ledger = new Ledger({
    method: settings.costMethod,
    multiplierOf: (id) => {
      const a = assets.get(id);
      return a ? priceMultiplier(a) : 1;
    },
    currencyOf: (id) => assets.get(id)?.currency,
    fxAt: fxOn,
    strict: false
  }).applyAll(txs);

  let approximateFx = false;
  const fxNow = (currency: string): number => {
    const fx = resolveFx(cache, currency, base);
    if (fx.approximate) approximateFx = true;
    return fx.rate;
  };
  const missing = new Set<string>();
  const valuedOf = new Map<PositionView, Valuation>();
  const views: PositionView[] = [];

  const describe = (asset: Asset, brokerId: number | null, portfolioId: number | null, v: Valuation): PositionView => {
    const resolved = resolvePrice(asset, cache);
    return {
      key: `${portfolioId ?? 'all'}:${asset.id}:${brokerId ?? 'all'}`,
      portfolioId,
      portfolioName: portfolioName(portfolioId),
      assetId: asset.id,
      brokerId,
      brokerName: brokerId != null ? (brokers.get(brokerId)?.name ?? null) : null,
      symbol: asset.symbol,
      name: asset.name,
      assetType: asset.type,
      currency: asset.currency,
      price: resolved?.price ?? null,
      priceSource: resolved?.source ?? 'cost',
      priceAsOf: resolved?.asOf ?? null,
      ...v
    };
  };

  for (const state of ledger.list()) {
    const asset = assets.get(state.assetId);
    if (!asset) continue;
    if (filter.assetType && asset.type !== filter.assetType) continue;
    if (filter.brokerId && state.brokerId !== filter.brokerId) continue;

    const resolved = resolvePrice(asset, cache);
    if (!resolved && state.quantity > 0) missing.add(asset.symbol);
    const v = valuePosition(state, priceMultiplier(asset), resolved?.price ?? null, fxNow(asset.currency));
    const view = describe(asset, state.brokerId, state.portfolioId, v);
    valuedOf.set(view, v);
    views.push(view);
  }

  // Agregare pe activ: același simbol de la brokeri (și portofolii) diferiți devine o singură linie.
  const byAsset = new Map<number, PositionView[]>();
  for (const view of views) byAsset.set(view.assetId, [...(byAsset.get(view.assetId) ?? []), view]);
  const aggregated: PositionView[] = [];
  const closed: PositionView[] = [];
  for (const [assetId, parts] of byAsset) {
    const asset = assets.get(assetId) as Asset;
    const combined = combineValuations(
      parts.map((p) => valuedOf.get(p) as Valuation),
      priceMultiplier(asset)
    );
    const portfolios = new Set(parts.map((p) => p.portfolioId));
    const view = describe(asset, null, portfolios.size === 1 ? (parts[0].portfolioId ?? null) : null, combined);
    if (combined.quantity > 0) aggregated.push(view);
    else if (combined.realizedPnl !== 0 || combined.income !== 0) closed.push(view);
  }

  // Cash-ul neinvestit (doar la brokerii cu depuneri/retrageri) și veniturile fără activ (dobânzi − comisioane).
  // Filtrul pe tip de activ exclude cash-ul: nu este un activ.
  const showCash = !filter.assetType;
  const tracked = ledger.cashTrackedAccounts();
  const cashBalances: CashBalanceView[] = [];
  if (showCash) {
    for (const c of ledger.cashBalances()) {
      if (!c.tracked || (filter.brokerId && c.brokerId !== filter.brokerId) || c.exact.isZero()) continue;
      cashBalances.push({
        portfolioId: c.portfolioId,
        portfolioName: portfolioName(c.portfolioId),
        brokerId: c.brokerId,
        brokerName: brokers.get(c.brokerId)?.name ?? '—',
        currency: c.currency,
        amount: c.amount,
        amountBase: toNum(c.exact.times(dec(fxNow(c.currency))))
      });
    }
  }
  cashBalances.sort(
    (a, b) => (a.portfolioName ?? '').localeCompare(b.portfolioName ?? '') || a.brokerName.localeCompare(b.brokerName) || a.currency.localeCompare(b.currency)
  );
  let otherIncome = ZERO;
  if (showCash) {
    for (const t of ledger.otherIncome()) {
      if (filter.brokerId && t.brokerId !== filter.brokerId) continue;
      otherIncome = otherIncome.plus(
        t.otherIncomeBase ?? sum([...t.otherIncome].map(([currency, amount]) => amount.times(dec(fxNow(currency)))))
      );
    }
  }
  // Conturile (broker într-un portofoliu) cu tranzacții, dar fără depuneri: cash-ul lor nu se urmărește.
  const usedAccounts = new Map<string, { portfolioId: number | null; brokerId: number }>();
  for (const t of txs) if (t.brokerId != null && t.portfolioId != null) usedAccounts.set(accountKey(t.portfolioId, t.brokerId), { portfolioId: t.portfolioId, brokerId: t.brokerId });
  const untrackedCashBrokers = [...usedAccounts]
    .filter(([key, a]) => !tracked.has(key) && (!filter.brokerId || a.brokerId === filter.brokerId))
    .map(([, a]) => {
      const broker = brokers.get(a.brokerId)?.name ?? '—';
      return multi ? `${broker} (${portfolioName(a.portfolioId) ?? '—'})` : broker;
    })
    .sort();

  const open = views.filter((v) => v.quantity > 0).sort((a, b) => b.marketValueBase - a.marketValueBase);
  aggregated.sort((a, b) => b.marketValueBase - a.marketValueBase);
  closed.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const movers = topMovers(aggregated, 5);

  return {
    // Totalurile includ și pozițiile închise: ele mai contribuie doar cu profit realizat și venituri.
    totals: summarize(
      [...valuedOf.values()],
      base,
      { cash: sum(cashBalances.map((c) => c.amountBase)), otherIncome },
      aggregated.map((p) => p)
    ),
    cashBalances,
    untrackedCashBrokers: showCash ? untrackedCashBrokers : [],
    positions: open,
    aggregated,
    closed,
    allocationByType: buildAllocation(
      aggregated.map((p) => ({ key: p.assetType, label: ASSET_TYPE_LABEL_PLURAL[p.assetType], value: p.marketValueBase }))
    ),
    allocationByBroker: buildAllocation(open.map((p) => ({ key: String(p.brokerId), label: p.brokerName ?? '—', value: p.marketValueBase }))),
    allocationByAsset: buildAllocation(
      aggregated.map((p) => ({ key: String(p.assetId), label: p.symbol, value: p.marketValueBase })),
      8
    ),
    topGainers: movers.gainers,
    topLosers: movers.losers,
    lastPriceUpdate: settings.lastPriceUpdate,
    missingPrices: [...missing].sort(),
    approximateFx
  };
}

const RANGE_MONTHS: Record<Exclude<HistoryRange, 'ALL'>, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };

/** Prima zi a intervalului ales, dar nu înainte de prima tranzacție. */
export function rangeStart(range: HistoryRange, firstDate: string, today: string): string {
  const start = range === 'ALL' ? firstDate : addMonths(today, -RANGE_MONTHS[range]);
  const s = start > firstDate ? start : firstDate;
  return s > today ? today : s;
}

/** Prețul unui activ la o dată: istoricul salvat, prețul curent pentru azi sau prețul manual. */
function makePriceOn(
  assets: Map<number, Asset>,
  history: Map<string, HistoryRow[]>,
  cache: Map<string, CachedPrice>,
  today: string
): (assetId: number, date: string) => HistoricalPrice | null {
  return (assetId, date) => {
    const asset = assets.get(assetId) as Asset;
    // Ultimul punct folosește prețul curent, ca graficul să se încheie exact la valoarea din dashboard.
    if (date >= today) {
      const current = resolvePrice(asset, cache);
      if (current) return { price: current.price, splitAdjusted: false };
    }
    const rows = history.get(asset.symbol);
    const row = asset.priceMode === 'manual' ? null : lastOnOrBefore(rows, date);
    if (row) return { price: row.close, splitAdjusted: row.splitAdjusted };
    // Fără istoric din API: prețul manual se aplică de la data la care a fost introdus.
    if (asset.manualPrice != null && asset.manualPriceDate && date >= asset.manualPriceDate) {
      return { price: asset.manualPrice, splitAdjusted: false };
    }
    return null;
  };
}

/**
 * Randamentul pe intervalul ales: TWR (cât de bine au mers investițiile, fără
 * efectul depunerilor) și XIRR (randamentul anual al banilor tăi), plus totalul
 * depus net de la început față de valoarea actuală.
 */
export function getPerformance(
  db: Db,
  userId: number,
  range: HistoryRange,
  filter: PortfolioFilter = {},
  today: string = todayIso(),
  options: ScopeOptions = {}
): PerformanceData {
  const settings = getSettings(db, userId);
  const scope = resolveScope(db, userId, filter.portfolioId, options.baseCurrency);
  const base = scope.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const cache = getCachedPrices(db, userId);
  const empty: PerformanceData = {
    range,
    baseCurrency: base,
    points: [],
    twr: null,
    twrAnnualized: null,
    xirr: null,
    startValue: 0,
    endValue: 0,
    netFlows: 0,
    allTime: { netContributions: 0, currentValue: 0, gain: 0 },
    cashTracked: false,
    benchmark: null
  };

  const txs = allLedgerTxs(db, userId).filter((t) => {
    if (!scope.includes(t)) return false;
    const asset = t.assetId != null ? assets.get(t.assetId) : undefined;
    if (t.assetId != null && !asset) return false;
    // Filtrul pe tip de activ lasă doar tranzacțiile activelor de acel tip (fără cash).
    if (filter.assetType && asset?.type !== filter.assetType) return false;
    if (filter.brokerId && t.brokerId !== filter.brokerId && !(t.type === 'split' && t.brokerId == null)) return false;
    return true;
  });
  if (txs.length === 0) return empty;

  const tracked = new Set<string>();
  if (!filter.assetType) {
    for (const t of txs) {
      if (t.brokerId != null && (t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'adjustment')) tracked.add(accountKey(t.portfolioId, t.brokerId));
    }
  }
  const usedAssets = [...new Set(txs.map((t) => t.assetId).filter((id): id is number => id != null))].map((id) => assets.get(id) as Asset);
  const currencies = [...currenciesOf(txs, assets)].filter((c) => c !== base);
  const history = loadHistory(db, userId, [...usedAssets.map((a) => a.symbol), ...currencies.map((c) => fxSymbol(c, base))]);
  const fxOn = makeFxOn(base, history, cache, today);
  const dates = buildDateRange(rangeStart(range, txs[0].date, today), today, 366);
  const input = {
    transactions: txs,
    dates,
    assets: new Map(usedAssets.map((a) => [a.id, { currency: a.currency, multiplier: priceMultiplier(a) }])),
    method: settings.costMethod,
    priceOn: makePriceOn(assets, history, cache, today),
    fxOn,
    trackedAccounts: tracked
  };
  const points = buildPerformanceSeries(input);
  const twr = twrSeries(points);
  const first = points[0];
  const last = points[points.length - 1];
  const totalTwr = twr[twr.length - 1]?.twr ?? null;
  const netContributions = sum(txs.map((t) => (t.brokerId == null ? ZERO : externalFlow(t, tracked.has(accountKey(t.portfolioId, t.brokerId)), input))));

  // Indicele de referință pe aceeași perioadă, pornind de la 0% în prima zi în care are date.
  const bench = benchmarkSeries(db, userId, scope.single?.benchmark ?? settings.benchmark, base, cache, today);
  const levels = points.map((p) => bench.levelOn(p.date));
  const startAt = levels.findIndex((l) => l !== null && l > 0);
  const startLevel = startAt >= 0 ? (levels[startAt] as number) : null;
  const benchReturns = levels.map((l, i) => (startLevel !== null && i >= startAt && l !== null ? l / startLevel - 1 : null));
  const lastBench = benchReturns[benchReturns.length - 1] ?? null;
  const portfolioFrom = startAt >= 0 && totalTwr !== null ? (1 + totalTwr) / (1 + twr[startAt].twr) - 1 : null;

  return {
    ...empty,
    points: points.map((p, i) => ({ date: p.date, value: p.value, twr: twr[i].twr, benchmark: benchReturns[i] })),
    benchmark: {
      symbol: bench.symbol,
      name: bench.name,
      currency: bench.currency,
      from: startAt >= 0 ? points[startAt].date : null,
      return: lastBench,
      portfolioReturn: portfolioFrom
    },
    twr: totalTwr,
    twrAnnualized: totalTwr === null ? null : annualize(totalTwr, daysBetween(first.date, last.date)),
    xirr: xirr(xirrFlows(points)),
    startValue: first.value,
    endValue: last.value,
    netFlows: toNum(sum(points.slice(1).flatMap((p) => p.flows.map((f) => f.amount)))),
    allTime: { netContributions: toNum(netContributions), currentValue: last.value, gain: toNum(dec(last.value).minus(netContributions)) },
    cashTracked: tracked.size > 0
  };
}

/** Evoluția valorii portofoliului, reconstruită din tranzacții și din prețurile istorice salvate. */
export function getHistory(db: Db, userId: number, range: HistoryRange, filter: PortfolioFilter = {}, today: string = todayIso()): HistoryPoint[] {
  const settings = getSettings(db, userId);
  const scope = resolveScope(db, userId, filter.portfolioId);
  const base = scope.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const cache = getCachedPrices(db, userId);

  const txs = allLedgerTxs(db, userId).filter((t) => {
    if (t.assetId == null || !scope.includes(t)) return false; // graficul de evoluție arată valoarea activelor
    const asset = assets.get(t.assetId);
    if (!asset) return false;
    if (filter.assetType && asset.type !== filter.assetType) return false;
    // Split-urile fără broker se aplică tuturor brokerilor, deci rămân și când se filtrează pe broker.
    if (filter.brokerId && t.brokerId !== filter.brokerId && !(t.type === 'split' && t.brokerId == null)) return false;
    return true;
  });
  if (txs.length === 0) return [];

  const dates = buildDateRange(rangeStart(range, txs[0].date, today), today, 366);
  const usedAssets = [...new Set(txs.map((t) => t.assetId as number))].map((id) => assets.get(id) as Asset);
  const currencies = [...currenciesOf(txs, assets)].filter((c) => c !== base);
  const history = loadHistory(db, userId, [...usedAssets.map((a) => a.symbol), ...currencies.map((c) => fxSymbol(c, base))]);

  const priceOn = makePriceOn(assets, history, cache, today);

  return buildValueSeries({
    transactions: txs,
    assets: new Map(usedAssets.map((a) => [a.id, { currency: a.currency, multiplier: priceMultiplier(a) }])),
    method: settings.costMethod,
    dates,
    priceOn,
    fxOn: makeFxOn(base, history, cache, today)
  });
}

/**
 * Comparația portofoliilor active, unul lângă altul: valoare, profit, randament (TWR) și risc.
 * Toate sumele sunt în moneda de bază din setări, ca să poată fi comparate.
 */
export function comparePortfolios(db: Db, userId: number, today: string = todayIso()): PortfolioComparison[] {
  const base = getSettings(db, userId).baseCurrency;
  return listPortfolios(db, userId)
    .filter((p) => !p.archived)
    .map((p): PortfolioComparison => {
      const o = getOverview(db, userId, { portfolioId: p.id }, today, { baseCurrency: base });
      const perf = getPerformance(db, userId, 'ALL', { portfolioId: p.id }, today, { baseCurrency: base });
      const series = perf.points.map((pt) => ({ date: pt.date, twr: pt.twr }));
      return {
        portfolioId: p.id,
        name: p.name,
        color: p.color,
        icon: p.icon,
        baseCurrency: p.baseCurrency,
        value: o.totals.totalValue,
        cash: o.totals.cash,
        totalPnl: o.totals.totalPnl,
        returnPct: o.totals.returnPct,
        twr: perf.twr,
        twrAnnualized: perf.twrAnnualized,
        volatility: annualizedVolatility(series),
        maxDrawdown: maxDrawdown(series)?.value ?? null,
        positions: o.aggregated.length
      };
    });
}

/**
 * Banii intrați și ieșiți din portofoliu (în moneda de bază, la cursul zilei), cu aceleași reguli ca la
 * randament: depunerile și retragerile la brokerii cu cash urmărit, cumpărările și încasările la ceilalți.
 */
export function externalFlows(db: Db, userId: number, filter: PortfolioFilter = {}, today: string = todayIso()): { baseCurrency: string; flows: { date: string; amount: number }[] } {
  const scope = resolveScope(db, userId, filter.portfolioId);
  const base = scope.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const txs = allLedgerTxs(db, userId).filter((t) => {
    if (!scope.includes(t)) return false;
    const asset = t.assetId != null ? assets.get(t.assetId) : undefined;
    if (t.assetId != null && !asset) return false;
    if (filter.assetType && asset?.type !== filter.assetType) return false;
    if (filter.brokerId && t.brokerId !== filter.brokerId) return false;
    return true;
  });
  const tracked = new Set<string>();
  if (!filter.assetType) {
    for (const t of txs) {
      if (t.brokerId != null && (t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'adjustment')) tracked.add(accountKey(t.portfolioId, t.brokerId));
    }
  }
  const currencies = [...currenciesOf(txs, assets)].filter((c) => c !== base);
  const fxOn = makeFxOn(base, loadHistory(db, userId, currencies.map((c) => fxSymbol(c, base))), getCachedPrices(db, userId), today);
  const input = {
    transactions: txs,
    dates: [today],
    assets: new Map([...assets.values()].map((a) => [a.id, { currency: a.currency, multiplier: priceMultiplier(a) }])),
    method: getSettings(db, userId).costMethod,
    priceOn: () => null,
    fxOn
  };
  const flows: { date: string; amount: number }[] = [];
  for (const t of txs) {
    if (t.brokerId == null) continue;
    const amount = externalFlow(t, tracked.has(accountKey(t.portfolioId, t.brokerId)), input as unknown as Parameters<typeof externalFlow>[2]);
    if (!amount.isZero()) flows.push({ date: t.date, amount: toNum(amount) });
  }
  return { baseCurrency: base, flows };
}
