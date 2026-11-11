/**
 * Evaluarea pozițiilor la prețul curent și totalurile portofoliului.
 *
 * Fiecare poziție este evaluată în moneda activului și în moneda de bază:
 *  - valoarea de piață se convertește la cursul de AZI (`fxRate` = câte unități
 *    din moneda de bază valorează o unitate din moneda activului);
 *  - costul se ia la cursul din ZIUA fiecărei cumpărări, dacă motorul l-a primit
 *    (`costBasisBase`), altfel la cursul de azi.
 * Diferența dintre cele două se împarte în profit din preț și profit din curs valutar.
 *
 * Calculele sunt zecimale exacte; rezultatul este în numere JavaScript, gata de afișat.
 */
import type { AllocationSlice, AssetType, PortfolioTotals } from '../types';
import type { ExactPosition, PositionState } from './engine';
import { dec, decOrNull, Decimal, ONE, sum, toNum, ZERO, type DecValue } from './decimal';

/** Multiplicatorul de preț: la obligațiuni prețul este procent din valoarea nominală. */
export function priceMultiplier(asset: { type: AssetType; faceValue?: number | null }): number {
  if (asset.type !== 'bond') return 1;
  const face = asset.faceValue && asset.faceValue > 0 ? asset.faceValue : 100;
  return toNum(dec(face).div(100));
}

/** Cifrele unei poziții evaluate (fără datele descriptive ale activului). */
export interface Valuation {
  quantity: number;
  avgPrice: number;
  costBasis: number;
  marketValue: number;
  /** Profitul nerealizat în moneda activului (doar din preț). */
  unrealizedPnl: number;
  unrealizedPct: number | null;
  realizedPnl: number;
  income: number;
  totalBought: number;
  fxRate: number;
  marketValueBase: number;
  /** Costul în moneda de bază, la cursurile din zilele cumpărărilor. */
  costBasisBase: number;
  /** Profitul nerealizat în moneda de bază = profit din preț + profit din curs valutar. */
  unrealizedBase: number;
  unrealizedBasePct: number | null;
  /** Partea din profitul nerealizat care vine din evoluția prețului (convertită la cursul de azi). */
  pricePnlBase: number;
  /** Partea care vine din schimbarea cursului valutar de la cumpărare până azi. */
  fxPnlBase: number;
  realizedBase: number;
  incomeBase: number;
  totalBoughtBase: number;
  /**
   * Prețul (în moneda activului, la cursul de azi) la care poziția nu mai este pe minus:
   * costul total, cu tot cu comisioanele, împărțit la cantitate. Null fără unități deținute.
   */
  breakEvenPrice: number | null;
  /** Doar pentru pozițiile pe minus: cât trebuie să crească prețul ca să recuperezi (−20% => +25%). */
  recoveryPct: number | null;
}

/** Ce primește evaluarea: starea din motor (cu valorile exacte) sau doar sumele, ca numere sau text. */
export interface ValuationInput {
  quantity: DecValue;
  costBasis: DecValue;
  realizedPnl: DecValue;
  income: DecValue;
  totalBought: DecValue;
  costBasisBase?: DecValue | null;
  realizedPnlBase?: DecValue | null;
  incomeBase?: DecValue | null;
  totalBoughtBase?: DecValue | null;
  exact?: ExactPosition;
}

const ratio = (a: Decimal, b: Decimal): number | null => (b.gt(0) ? toNum(a.div(b)) : null);

/** Valorile exacte ale intrării: din `exact`, dacă există, altfel din câmpurile numerice. */
function exactOf(state: ValuationInput | PositionState): ExactPosition {
  if ('exact' in state && state.exact) return state.exact;
  return {
    quantity: dec(state.quantity),
    costBasis: dec(state.costBasis),
    realizedPnl: dec(state.realizedPnl),
    income: dec(state.income),
    totalBought: dec(state.totalBought),
    costBasisBase: decOrNull(state.costBasisBase),
    realizedPnlBase: decOrNull(state.realizedPnlBase),
    incomeBase: decOrNull(state.incomeBase),
    totalBoughtBase: decOrNull(state.totalBoughtBase)
  };
}

/** Rezultatele unei evaluări, calculate exact, înainte de conversia în numere. */
interface ExactValuation {
  quantity: Decimal;
  multiplier: Decimal;
  costBasis: Decimal;
  marketValue: Decimal;
  realizedPnl: Decimal;
  income: Decimal;
  totalBought: Decimal;
  fxRate: Decimal;
  marketValueBase: Decimal;
  costBasisBase: Decimal;
  realizedBase: Decimal;
  incomeBase: Decimal;
  totalBoughtBase: Decimal;
}

function finish(v: ExactValuation): Valuation {
  const unrealized = v.marketValue.minus(v.costBasis);
  const unrealizedBase = v.marketValueBase.minus(v.costBasisBase);
  const pricePnlBase = unrealized.times(v.fxRate);
  const held = v.quantity.gt(0);
  const units = v.quantity.times(v.multiplier);
  return {
    quantity: toNum(v.quantity),
    avgPrice: held && units.gt(0) ? toNum(v.costBasis.div(units)) : 0,
    costBasis: toNum(v.costBasis),
    marketValue: toNum(v.marketValue),
    unrealizedPnl: toNum(unrealized),
    unrealizedPct: ratio(unrealized, v.costBasis),
    realizedPnl: toNum(v.realizedPnl),
    income: toNum(v.income),
    totalBought: toNum(v.totalBought),
    fxRate: toNum(v.fxRate),
    marketValueBase: toNum(v.marketValueBase),
    costBasisBase: toNum(v.costBasisBase),
    unrealizedBase: toNum(unrealizedBase),
    unrealizedBasePct: ratio(unrealizedBase, v.costBasisBase),
    pricePnlBase: toNum(pricePnlBase),
    fxPnlBase: toNum(unrealizedBase.minus(pricePnlBase)),
    realizedBase: toNum(v.realizedBase),
    incomeBase: toNum(v.incomeBase),
    totalBoughtBase: toNum(v.totalBoughtBase),
    breakEvenPrice: held && units.gt(0) && v.fxRate.gt(0) ? toNum(v.costBasisBase.div(units.times(v.fxRate))) : null,
    recoveryPct: held && unrealizedBase.lt(0) && v.marketValueBase.gt(0) ? toNum(v.costBasisBase.div(v.marketValueBase).minus(ONE)) : null
  };
}

/**
 * Evaluează o poziție.
 * @param price prețul curent pe unitate (procent din nominal la obligațiuni) sau
 *              null dacă nu există niciun preț — atunci poziția se evaluează la cost.
 * @param fxRate cursul de azi al monedei activului față de moneda de bază.
 */
export function valuePosition(state: ValuationInput | PositionState, multiplier: DecValue, price: DecValue | null, fxRate: DecValue): Valuation {
  const e = exactOf(state);
  const fx = dec(fxRate);
  const mult = dec(multiplier);
  const held = e.quantity.gt(0);
  const costBasis = held ? e.costBasis : ZERO;
  // Costul în moneda de bază: istoric, dacă este cunoscut; altfel la cursul de azi.
  const costBasisBase = held ? (e.costBasisBase ?? costBasis.times(fx)) : ZERO;
  // Fără preț de piață, poziția se evaluează la cost (și în moneda de bază, deci fără profit din curs).
  const marketValue = price == null ? costBasis : e.quantity.times(dec(price)).times(mult);
  const marketValueBase = price == null ? costBasisBase : marketValue.times(fx);
  return finish({
    quantity: e.quantity,
    multiplier: mult,
    costBasis,
    marketValue,
    realizedPnl: e.realizedPnl,
    income: e.income,
    totalBought: e.totalBought,
    fxRate: fx,
    marketValueBase,
    costBasisBase,
    realizedBase: e.realizedPnlBase ?? e.realizedPnl.times(fx),
    incomeBase: e.incomeBase ?? e.income.times(fx),
    totalBoughtBase: e.totalBoughtBase ?? e.totalBought.times(fx)
  });
}

/**
 * Agregă mai multe evaluări ale aceluiași activ (de la brokeri diferiți) într-una
 * singură. Toate au aceeași monedă și același multiplicator.
 */
export function combineValuations(parts: Valuation[], multiplier: DecValue): Valuation {
  const total = (pick: (v: Valuation) => number): Decimal => sum(parts.map(pick));
  return finish({
    quantity: total((v) => v.quantity),
    multiplier: dec(multiplier),
    costBasis: total((v) => v.costBasis),
    marketValue: total((v) => v.marketValue),
    realizedPnl: total((v) => v.realizedPnl),
    income: total((v) => v.income),
    totalBought: total((v) => v.totalBought),
    fxRate: dec(parts[0]?.fxRate ?? 1),
    marketValueBase: total((v) => v.marketValueBase),
    costBasisBase: total((v) => v.costBasisBase),
    realizedBase: total((v) => v.realizedBase),
    incomeBase: total((v) => v.incomeBase),
    totalBoughtBase: total((v) => v.totalBoughtBase)
  });
}

/** Sume suplimentare pentru totaluri (cash, venituri fără activ), deja în moneda de bază. */
export interface TotalsExtras {
  /** Cash-ul neinvestit, la cursul de azi. */
  cash?: DecValue;
  /** Dobânzi la cash − comisioane fără activ. */
  otherIncome?: DecValue;
}

/**
 * Totalurile portofoliului, în moneda de bază.
 * @param positions pozițiile pe care se numără câștigurile și pierderile nerealizate
 *                  (de regulă cele agregate pe activ); implicit `valuations`.
 */
export function summarize(valuations: Valuation[], baseCurrency: string, extras: TotalsExtras = {}, positions: Valuation[] = valuations): PortfolioTotals {
  const total = (pick: (v: Valuation) => number): Decimal => sum(valuations.map(pick));
  const holdings = total((v) => v.marketValueBase);
  const totalCost = total((v) => v.costBasisBase);
  const realizedSales = total((v) => v.realizedBase);
  const otherIncome = dec(extras.otherIncome);
  const income = total((v) => v.incomeBase).plus(otherIncome);
  const totalInvested = total((v) => v.totalBoughtBase);
  const cash = dec(extras.cash);
  const unrealized = holdings.minus(totalCost);
  const realized = realizedSales.plus(income);
  const totalPnl = realized.plus(unrealized);

  const open = positions.filter((v) => v.quantity > 0);
  const gains = open.filter((v) => v.unrealizedBase > 0);
  const losses = open.filter((v) => v.unrealizedBase < 0);
  const lossCost = sum(losses.map((v) => v.costBasisBase));
  const lossTotal = sum(losses.map((v) => v.unrealizedBase));
  const gainCost = sum(gains.map((v) => v.costBasisBase));
  const gainTotal = sum(gains.map((v) => v.unrealizedBase));

  return {
    baseCurrency,
    totalValue: toNum(holdings.plus(cash)),
    holdingsValue: toNum(holdings),
    cash: toNum(cash),
    totalCost: toNum(totalCost),
    unrealized: toNum(unrealized),
    unrealizedPct: ratio(unrealized, totalCost),
    pricePnl: toNum(total((v) => v.pricePnlBase)),
    fxPnl: toNum(total((v) => v.fxPnlBase)),
    unrealizedGains: toNum(gainTotal),
    unrealizedGainsPct: ratio(gainTotal, gainCost),
    gainingPositions: gains.length,
    unrealizedLosses: toNum(lossTotal),
    unrealizedLossesPct: ratio(lossTotal, lossCost),
    losingPositions: losses.length,
    realizedSales: toNum(realizedSales),
    income: toNum(income),
    realized: toNum(realized),
    totalPnl: toNum(totalPnl),
    totalInvested: toNum(totalInvested),
    returnPct: ratio(totalPnl, totalInvested)
  };
}

/**
 * Transformă o listă de valori în felii de alocare (cu procente), sortate
 * descrescător. Dacă sunt mai multe decât `maxSlices`, restul se grupează în „Altele”.
 */
export function buildAllocation(items: { key: string; label: string; value: number }[], maxSlices = 8): AllocationSlice[] {
  // Însumăm intrările cu aceeași cheie și ignorăm valorile nule sau negative.
  const byKey = new Map<string, { key: string; label: string; value: Decimal }>();
  for (const it of items) {
    if (!(it.value > 0)) continue;
    const existing = byKey.get(it.key);
    if (existing) existing.value = existing.value.plus(it.value);
    else byKey.set(it.key, { key: it.key, label: it.label, value: dec(it.value) });
  }
  const sorted = [...byKey.values()].sort((a, b) => b.value.comparedTo(a.value));
  const total = sum(sorted.map((s) => s.value));
  if (!total.gt(0)) return [];

  let slices = sorted;
  if (sorted.length > maxSlices) {
    const head = sorted.slice(0, maxSlices - 1);
    const rest = sum(sorted.slice(maxSlices - 1).map((s) => s.value));
    slices = [...head, { key: '__other__', label: 'Altele', value: rest }];
  }
  return slices.map((s) => ({ key: s.key, label: s.label, value: toNum(s.value), pct: toNum(s.value.div(total)) }));
}

/**
 * Primele `n` poziții cu câștig, respectiv cu pierdere, după randamentul nerealizat (%).
 * Implicit se folosește randamentul în moneda de bază (preț + curs), dacă există.
 */
export function topMovers<T extends { unrealizedPct: number | null; unrealizedBasePct?: number | null; quantity: number }>(
  positions: T[],
  n = 5
): { gainers: T[]; losers: T[] } {
  const pct = (p: T): number | null => (p.unrealizedBasePct !== undefined ? p.unrealizedBasePct : p.unrealizedPct);
  const open = positions.filter((p) => p.quantity > 0 && pct(p) != null);
  const gainers = open
    .filter((p) => (pct(p) as number) > 0)
    .sort((a, b) => (pct(b) as number) - (pct(a) as number))
    .slice(0, n);
  const losers = open
    .filter((p) => (pct(p) as number) < 0)
    .sort((a, b) => (pct(a) as number) - (pct(b) as number))
    .slice(0, n);
  return { gainers, losers };
}
