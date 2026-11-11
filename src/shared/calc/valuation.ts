/**
 * Evaluarea pozițiilor la prețul curent și totalurile portofoliului.
 *
 * Fiecare poziție este evaluată în moneda activului, apoi convertită în moneda
 * de bază la cursul curent (`fxRate` = câte unități din moneda de bază valorează
 * o unitate din moneda activului).
 */
import type { AllocationSlice, AssetType, PortfolioTotals } from '../types';
import type { PositionState } from './engine';

/** Multiplicatorul de preț: la obligațiuni prețul este procent din valoarea nominală. */
export function priceMultiplier(asset: { type: AssetType; faceValue?: number | null }): number {
  if (asset.type !== 'bond') return 1;
  const face = asset.faceValue && asset.faceValue > 0 ? asset.faceValue : 100;
  return face / 100;
}

/** Cifrele unei poziții evaluate (fără datele descriptive ale activului). */
export interface Valuation {
  quantity: number;
  avgPrice: number;
  costBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPct: number | null;
  realizedPnl: number;
  income: number;
  totalBought: number;
  fxRate: number;
  marketValueBase: number;
  costBasisBase: number;
  unrealizedBase: number;
  realizedBase: number;
  incomeBase: number;
  totalBoughtBase: number;
}

/**
 * Evaluează o poziție.
 * @param price prețul curent pe unitate (procent din nominal la obligațiuni) sau
 *              null dacă nu există niciun preț — atunci poziția se evaluează la cost.
 */
export function valuePosition(
  state: Pick<PositionState, 'quantity' | 'costBasis' | 'realizedPnl' | 'income' | 'totalBought'>,
  multiplier: number,
  price: number | null,
  fxRate: number
): Valuation {
  const quantity = state.quantity;
  const costBasis = quantity > 0 ? state.costBasis : 0;
  const marketValue = price == null ? costBasis : quantity * price * multiplier;
  const unrealizedPnl = marketValue - costBasis;
  return {
    quantity,
    avgPrice: quantity > 0 ? costBasis / (quantity * multiplier) : 0,
    costBasis,
    marketValue,
    unrealizedPnl,
    unrealizedPct: costBasis > 0 ? unrealizedPnl / costBasis : null,
    realizedPnl: state.realizedPnl,
    income: state.income,
    totalBought: state.totalBought,
    fxRate,
    marketValueBase: marketValue * fxRate,
    costBasisBase: costBasis * fxRate,
    unrealizedBase: unrealizedPnl * fxRate,
    realizedBase: state.realizedPnl * fxRate,
    incomeBase: state.income * fxRate,
    totalBoughtBase: state.totalBought * fxRate
  };
}

/**
 * Agregă mai multe evaluări ale aceluiași activ (de la brokeri diferiți) într-una
 * singură. Toate au aceeași monedă și același multiplicator.
 */
export function combineValuations(parts: Valuation[], multiplier: number): Valuation {
  const sum = (pick: (v: Valuation) => number): number => parts.reduce((s, v) => s + pick(v), 0);
  const quantity = sum((v) => v.quantity);
  const costBasis = sum((v) => v.costBasis);
  const marketValue = sum((v) => v.marketValue);
  const unrealizedPnl = marketValue - costBasis;
  return {
    quantity,
    avgPrice: quantity > 0 ? costBasis / (quantity * multiplier) : 0,
    costBasis,
    marketValue,
    unrealizedPnl,
    unrealizedPct: costBasis > 0 ? unrealizedPnl / costBasis : null,
    realizedPnl: sum((v) => v.realizedPnl),
    income: sum((v) => v.income),
    totalBought: sum((v) => v.totalBought),
    fxRate: parts[0]?.fxRate ?? 1,
    marketValueBase: sum((v) => v.marketValueBase),
    costBasisBase: sum((v) => v.costBasisBase),
    unrealizedBase: sum((v) => v.unrealizedBase),
    realizedBase: sum((v) => v.realizedBase),
    incomeBase: sum((v) => v.incomeBase),
    totalBoughtBase: sum((v) => v.totalBoughtBase)
  };
}

/** Totalurile portofoliului, în moneda de bază. */
export function summarize(valuations: Valuation[], baseCurrency: string): PortfolioTotals {
  let totalValue = 0;
  let totalCost = 0;
  let realizedSales = 0;
  let income = 0;
  let totalInvested = 0;
  for (const v of valuations) {
    totalValue += v.marketValueBase;
    totalCost += v.costBasisBase;
    realizedSales += v.realizedBase;
    income += v.incomeBase;
    totalInvested += v.totalBoughtBase;
  }
  const unrealized = totalValue - totalCost;
  const realized = realizedSales + income;
  const totalPnl = realized + unrealized;
  return {
    baseCurrency,
    totalValue,
    totalCost,
    unrealized,
    unrealizedPct: totalCost > 0 ? unrealized / totalCost : null,
    realizedSales,
    income,
    realized,
    totalPnl,
    totalInvested,
    returnPct: totalInvested > 0 ? totalPnl / totalInvested : null
  };
}

/**
 * Transformă o listă de valori în felii de alocare (cu procente), sortate
 * descrescător. Dacă sunt mai multe decât `maxSlices`, restul se grupează în „Altele”.
 */
export function buildAllocation(
  items: { key: string; label: string; value: number }[],
  maxSlices = 8
): AllocationSlice[] {
  // Însumăm intrările cu aceeași cheie și ignorăm valorile nule sau negative.
  const byKey = new Map<string, { key: string; label: string; value: number }>();
  for (const it of items) {
    if (!(it.value > 0)) continue;
    const existing = byKey.get(it.key);
    if (existing) existing.value += it.value;
    else byKey.set(it.key, { ...it });
  }
  const sorted = [...byKey.values()].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, it) => s + it.value, 0);
  if (total <= 0) return [];

  let slices = sorted;
  if (sorted.length > maxSlices) {
    const head = sorted.slice(0, maxSlices - 1);
    const rest = sorted.slice(maxSlices - 1).reduce((s, it) => s + it.value, 0);
    slices = [...head, { key: '__other__', label: 'Altele', value: rest }];
  }
  return slices.map((s) => ({ ...s, pct: s.value / total }));
}

/** Primele `n` poziții cu câștig, respectiv cu pierdere, după randamentul nerealizat (%). */
export function topMovers<T extends { unrealizedPct: number | null; quantity: number }>(
  positions: T[],
  n = 5
): { gainers: T[]; losers: T[] } {
  const open = positions.filter((p) => p.quantity > 0 && p.unrealizedPct != null);
  const gainers = open
    .filter((p) => (p.unrealizedPct as number) > 0)
    .sort((a, b) => (b.unrealizedPct as number) - (a.unrealizedPct as number))
    .slice(0, n);
  const losers = open
    .filter((p) => (p.unrealizedPct as number) < 0)
    .sort((a, b) => (a.unrealizedPct as number) - (b.unrealizedPct as number))
    .slice(0, n);
  return { gainers, losers };
}
