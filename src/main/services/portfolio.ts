/**
 * Portofoliul evaluat: poziții pe broker și agregate, totaluri, alocări,
 * clasamente și seria istorică pentru grafic.
 *
 * Aici se leagă datele din bază (tranzacții, active, prețuri salvate) de
 * modulul de calcul din `shared/calc`, care face toată aritmetica.
 */
import type {
  Asset,
  HistoryPoint,
  HistoryRange,
  PortfolioFilter,
  PortfolioOverview,
  PositionView
} from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { addMonths, todayIso } from '@shared/dates';
import {
  buildAllocation,
  buildDateRange,
  buildValueSeries,
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
import type { Db } from '../db/database';
import { rowToLedgerTx } from './common';
import { listAssets } from './assets';
import { listBrokers } from './brokers';
import { getSettings } from './settings';
import { fxSymbol, getCachedPrices, lastOnOrBefore, loadHistory, resolveFx, resolvePrice } from '../prices/store';

function allLedgerTxs(db: Db, userId: number): LedgerTx[] {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ?').all(userId) as Record<string, unknown>[];
  return sortTransactions(rows.map(rowToLedgerTx));
}

export function getOverview(db: Db, userId: number, filter: PortfolioFilter = {}): PortfolioOverview {
  const settings = getSettings(db, userId);
  const base = settings.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const brokers = new Map(listBrokers(db, userId).map((b) => [b.id, b]));
  const cache = getCachedPrices(db, userId);
  const multiplierOf = (assetId: number): number => {
    const a = assets.get(assetId);
    return a ? priceMultiplier(a) : 1;
  };

  // Datele din bază sunt deja validate; modul tolerant evită ca o eventuală inconsecvență să blocheze ecranul.
  const states = new Ledger({ method: settings.costMethod, multiplierOf, strict: false })
    .applyAll(allLedgerTxs(db, userId))
    .list();

  let approximateFx = false;
  const missing = new Set<string>();
  const valuedOf = new Map<PositionView, Valuation>();
  const views: PositionView[] = [];

  const describe = (asset: Asset, brokerId: number | null, v: Valuation): PositionView => {
    const resolved = resolvePrice(asset, cache);
    return {
      key: `${asset.id}:${brokerId ?? 'all'}`,
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

  for (const state of states) {
    const asset = assets.get(state.assetId);
    if (!asset) continue;
    if (filter.assetType && asset.type !== filter.assetType) continue;
    if (filter.brokerId && state.brokerId !== filter.brokerId) continue;

    const resolved = resolvePrice(asset, cache);
    const fx = resolveFx(cache, asset.currency, base);
    if (fx.approximate) approximateFx = true;
    if (!resolved && state.quantity > 0) missing.add(asset.symbol);

    const v = valuePosition(state, priceMultiplier(asset), resolved?.price ?? null, fx.rate);
    const view = describe(asset, state.brokerId, v);
    valuedOf.set(view, v);
    views.push(view);
  }

  // Agregare pe activ: același simbol de la brokeri diferiți devine o singură linie.
  const byAsset = new Map<number, PositionView[]>();
  for (const view of views) {
    const list = byAsset.get(view.assetId) ?? [];
    list.push(view);
    byAsset.set(view.assetId, list);
  }
  const aggregated: PositionView[] = [];
  const closed: PositionView[] = [];
  for (const [assetId, parts] of byAsset) {
    const asset = assets.get(assetId) as Asset;
    const combined = combineValuations(
      parts.map((p) => valuedOf.get(p) as Valuation),
      priceMultiplier(asset)
    );
    const view = describe(asset, null, combined);
    if (combined.quantity > 0) aggregated.push(view);
    else if (combined.realizedPnl !== 0 || combined.income !== 0) closed.push(view);
  }

  const open = views.filter((v) => v.quantity > 0).sort((a, b) => b.marketValueBase - a.marketValueBase);
  aggregated.sort((a, b) => b.marketValueBase - a.marketValueBase);
  closed.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const movers = topMovers(aggregated, 5);

  return {
    // Totalurile includ și pozițiile închise: ele mai contribuie doar cu profit realizat și venituri.
    totals: summarize([...valuedOf.values()], base),
    positions: open,
    aggregated,
    closed,
    allocationByType: buildAllocation(
      aggregated.map((p) => ({ key: p.assetType, label: ASSET_TYPE_LABEL_PLURAL[p.assetType], value: p.marketValueBase }))
    ),
    allocationByBroker: buildAllocation(
      open.map((p) => ({ key: String(p.brokerId), label: p.brokerName ?? '—', value: p.marketValueBase }))
    ),
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

/** Evoluția valorii portofoliului, reconstruită din tranzacții și din prețurile istorice salvate. */
export function getHistory(
  db: Db,
  userId: number,
  range: HistoryRange,
  filter: PortfolioFilter = {},
  today: string = todayIso()
): HistoryPoint[] {
  const settings = getSettings(db, userId);
  const base = settings.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const cache = getCachedPrices(db, userId);

  const txs = allLedgerTxs(db, userId).filter((t) => {
    const asset = assets.get(t.assetId);
    if (!asset) return false;
    if (filter.assetType && asset.type !== filter.assetType) return false;
    // Split-urile fără broker se aplică tuturor brokerilor, deci rămân și când se filtrează pe broker.
    if (filter.brokerId && t.brokerId !== filter.brokerId && !(t.type === 'split' && t.brokerId == null)) return false;
    return true;
  });
  if (txs.length === 0) return [];

  const firstDate = txs[0].date;
  const rangeStart = range === 'ALL' ? firstDate : addMonths(today, -RANGE_MONTHS[range]);
  const start = rangeStart > firstDate ? rangeStart : firstDate;
  const dates = buildDateRange(start > today ? today : start, today, 366);

  const usedAssets = [...new Set(txs.map((t) => t.assetId))].map((id) => assets.get(id) as Asset);
  const currencies = [...new Set(usedAssets.map((a) => a.currency))].filter((c) => c !== base);
  const history = loadHistory(db, userId, [
    ...usedAssets.map((a) => a.symbol),
    ...currencies.map((c) => fxSymbol(c, base))
  ]);

  const priceOn = (assetId: number, date: string): HistoricalPrice | null => {
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

  const fxOn = (currency: string, date: string): number => {
    if (currency === base) return 1;
    const rows = history.get(fxSymbol(currency, base));
    if (date < today) {
      const row = lastOnOrBefore(rows, date) ?? rows?.[0];
      if (row) return row.close;
    }
    return resolveFx(cache, currency, base).rate;
  };

  return buildValueSeries({
    transactions: txs,
    assets: new Map(usedAssets.map((a) => [a.id, { currency: a.currency, multiplier: priceMultiplier(a) }])),
    method: settings.costMethod,
    dates,
    priceOn,
    fxOn
  });
}
