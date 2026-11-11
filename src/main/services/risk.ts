/**
 * Analiza de risc a portofoliului selectat (sau a tuturor, combinate):
 *  - concentrarea: ponderea fiecărei poziții și cele peste pragul ales;
 *  - expunerea pe sector, țară, monedă și tip de activ;
 *  - volatilitatea anualizată, cea mai mare scădere (cu perioada) și beta față de indicele de
 *    referință, toate din seria randamentului ponderat în timp (TWR), deci fără efectul depunerilor;
 *  - scorul de diversificare (1–10) și sugestii concrete.
 */
import type { AllocationSlice, AssetType, HistoryRange, PortfolioFilter, RiskPosition, RiskReport } from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { todayIso } from '@shared/dates';
import { annualizedVolatility, assessDiversification, beta, buildAllocation, maxDrawdown, type ExposureShare } from '@shared/calc';
import { DIVERSIFIED_ETF, NO_COUNTRY, UNKNOWN_COUNTRY, UNKNOWN_SECTOR, assetCountry, assetSector } from '@shared/riskLabels';
import { benchmarkName } from '@shared/benchmarks';
import type { Db } from '../db/database';
import { listAssets } from './assets';
import { getSettings } from './settings';
import { benchmarkFor, getOverview, getPerformance } from './portfolio';

/** Cel mult atâtea felii pe grafic; restul intră la „Altele”. */
const MAX_SLICES = 8;

const shares = (slices: AllocationSlice[], skip: string[] = []): ExposureShare[] =>
  slices.filter((s) => s.key !== '__other__' && !skip.includes(s.label)).map((s) => ({ label: s.label, pct: s.pct }));

export function getRiskReport(db: Db, userId: number, range: HistoryRange = '1Y', filter: PortfolioFilter = {}, today: string = todayIso()): RiskReport {
  const settings = getSettings(db, userId);
  const overview = getOverview(db, userId, filter, today);
  const base = overview.totals.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));

  // Pozițiile deschise, pe activ (toți brokerii din filtru), cu ponderea în valoarea investită.
  const open = overview.aggregated.filter((p) => p.quantity > 0 && p.marketValueBase > 0);
  const holdingsValue = open.reduce((s, p) => s + p.marketValueBase, 0);
  const positions: RiskPosition[] = open
    .map((p) => {
      const a = assets.get(p.assetId);
      const info = { type: p.assetType, symbol: p.symbol, currency: p.currency, sector: a?.sector ?? null, country: a?.country ?? null };
      return {
        assetId: p.assetId,
        symbol: p.symbol,
        name: p.name,
        type: p.assetType,
        value: p.marketValueBase,
        weight: holdingsValue > 0 ? p.marketValueBase / holdingsValue : 0,
        sector: assetSector(info),
        country: assetCountry(info),
        currency: p.currency
      };
    })
    .sort((a, b) => b.value - a.value);

  const group = (key: (p: RiskPosition) => string, label: (p: RiskPosition) => string = key): AllocationSlice[] =>
    buildAllocation(
      positions.map((p) => ({ key: key(p), label: label(p), value: p.value })),
      MAX_SLICES
    );
  const bySector = group((p) => p.sector);
  const byCountry = group((p) => p.country);
  const byType = group(
    (p) => p.type,
    (p) => ASSET_TYPE_LABEL_PLURAL[p.type as AssetType]
  );
  // Expunerea pe monedă include și cash-ul (banii neinvestiți într-o monedă sunt tot expunere la ea).
  const byCurrency = buildAllocation(
    [
      ...positions.map((p) => ({ key: p.currency, label: p.currency, value: p.value })),
      ...overview.cashBalances.map((c) => ({ key: c.currency, label: c.currency, value: c.amountBase }))
    ],
    MAX_SLICES
  );

  // Riscul din istoric: seria TWR pe intervalul ales și indicele de referință pe aceeași perioadă.
  const perf = getPerformance(db, userId, range, filter, today);
  const series = perf.points.map((p) => ({ date: p.date, twr: p.twr }));
  const benchPoints = perf.points.filter((p) => p.benchmark !== null).map((p) => ({ date: p.date, twr: p.benchmark as number }));
  const drawdown = maxDrawdown(series);

  const unknown = positions.filter((p) => p.sector === UNKNOWN_SECTOR);
  const diversification = assessDiversification({
    positions: positions.map((p) => ({ symbol: p.symbol, weight: p.weight })),
    sectors: shares(bySector, [DIVERSIFIED_ETF, UNKNOWN_SECTOR]),
    countries: shares(byCountry, [DIVERSIFIED_ETF, NO_COUNTRY, UNKNOWN_COUNTRY]),
    currencies: shares(group((p) => p.currency)),
    types: shares(byType),
    unknownSector: { pct: unknown.reduce((s, p) => s + p.weight, 0), symbols: unknown.map((p) => p.symbol) },
    limit: settings.concentrationLimit
  });
  const benchmarkSymbol = perf.benchmark?.symbol ?? benchmarkFor(db, userId, filter);

  return {
    baseCurrency: base,
    range,
    holdingsValue,
    cash: overview.totals.cash,
    concentrationLimit: settings.concentrationLimit,
    positions,
    bySector,
    byCountry,
    byCurrency,
    byType,
    unknownSector: unknown.map((p) => p.symbol),
    volatility: annualizedVolatility(series),
    maxDrawdown: drawdown ? { value: drawdown.value, peakDate: drawdown.peakDate, troughDate: drawdown.troughDate, recoveryDate: drawdown.recoveryDate } : null,
    beta: beta(series, benchPoints),
    benchmark: { symbol: benchmarkSymbol, name: perf.benchmark?.name ?? benchmarkName(benchmarkSymbol) },
    score: diversification.score,
    effectivePositions: diversification.effectivePositions,
    suggestions: diversification.suggestions
  };
}
