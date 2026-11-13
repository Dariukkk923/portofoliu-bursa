/**
 * Reconstrucția evoluției valorii portofoliului din tranzacții și prețuri istorice.
 *
 * Pentru fiecare dată din interval se aplică tranzacțiile făcute până atunci și
 * se evaluează pozițiile rămase la prețul de închidere din acea zi (ultimul
 * cunoscut), convertit în moneda de bază la cursul din acea zi.
 */
import type { CostMethod, HistoryPoint } from '../types';
import { addDays, daysBetween } from '../dates';
import { dec, Decimal, toNum, ZERO, type DecValue } from './decimal';
import { accountKey, Ledger, sortTransactions, splitFactorExact, type LedgerTx } from './engine';
import type { Flow, PerformancePoint } from './returns';

export interface HistoryAsset {
  currency: string;
  multiplier: DecValue;
}

export interface HistoricalPrice {
  price: DecValue;
  /**
   * True dacă prețul este ajustat la split-urile ulterioare (cum întoarce Yahoo).
   * În acest caz cantitatea de la acea dată trebuie ajustată la fel, altfel
   * valoarea dinaintea unui split ar ieși de câteva ori mai mică.
   */
  splitAdjusted: boolean;
}

export interface SeriesInput {
  transactions: LedgerTx[];
  assets: Map<number, HistoryAsset>;
  method: CostMethod;
  /** Datele pentru care se calculează valoarea, în ordine crescătoare. */
  dates: string[];
  /** Ultimul preț de închidere cunoscut la data dată sau înainte; null dacă nu există. */
  priceOn: (assetId: number, date: string) => HistoricalPrice | null;
  /** Cursul monedei față de moneda de bază la data dată. */
  fxOn: (currency: string, date: string) => DecValue;
}

/** Motorul și funcția de evaluare a activelor deținute la o dată, comune graficelor de valoare și de randament. */
function createValuer(input: SeriesInput) {
  const txs = sortTransactions(input.transactions);
  const splits = txs.filter((t) => t.type === 'split');
  const ledger = new Ledger({
    method: input.method,
    multiplierOf: (id) => input.assets.get(id)?.multiplier ?? 1,
    currencyOf: (id) => input.assets.get(id)?.currency,
    fxAt: (currency, date) => input.fxOn(currency, date),
    strict: false
  });

  /** Produsul split-urilor ulterioare datei, care afectează poziția dată. */
  const futureSplitFactor = (assetId: number, brokerId: number, portfolioId: number | null, date: string): Decimal => {
    let factor = dec(1);
    for (const s of splits) {
      if (s.assetId !== assetId || s.date <= date) continue;
      if (s.brokerId != null && s.brokerId !== brokerId) continue;
      if (s.portfolioId != null && s.portfolioId !== portfolioId) continue;
      factor = factor.times(splitFactorExact(s));
    }
    return factor;
  };

  /** Valoarea activelor deținute la data dată și suma investită în ele (costul la cursurile istorice). */
  const holdingsAt = (date: string): { value: Decimal; invested: Decimal } => {
    let value = ZERO;
    let invested = ZERO;
    for (const p of ledger.list()) {
      if (!p.exact.quantity.gt(0)) continue;
      const asset = input.assets.get(p.assetId);
      if (!asset) continue;
      const fx = dec(input.fxOn(asset.currency, date));
      // Suma investită: costul la cursurile din zilele cumpărărilor.
      const cost = p.exact.costBasisBase ?? p.exact.costBasis.times(fx);
      invested = invested.plus(cost);

      const hp = input.priceOn(p.assetId, date);
      if (!hp) {
        // Fără preț istoric (ex.: obligațiune cu preț manual): poziția se ia la cost.
        value = value.plus(cost);
        continue;
      }
      const qty = hp.splitAdjusted ? p.exact.quantity.times(futureSplitFactor(p.assetId, p.brokerId, p.portfolioId, date)) : p.exact.quantity;
      value = value.plus(qty.times(dec(hp.price)).times(dec(asset.multiplier)).times(fx));
    }
    return { value, invested };
  };
  return { txs, ledger, holdingsAt };
}

export function buildValueSeries(input: SeriesInput): HistoryPoint[] {
  const { txs, ledger, holdingsAt } = createValuer(input);
  const points: HistoryPoint[] = [];
  let next = 0;
  for (const date of input.dates) {
    while (next < txs.length && txs[next].date <= date) ledger.apply(txs[next++]);
    const { value, invested } = holdingsAt(date);
    points.push({ date, value: toNum(value), invested: toNum(invested) });
  }
  return points;
}

export interface PerformanceInput extends SeriesInput {
  /**
   * Conturile (portofoliu + broker, vezi `accountKey`) la care se urmărește cash-ul (au
   * depuneri/retrageri): valoarea include cash-ul lor, iar fluxurile sunt depunerile și
   * retragerile. La celelalte, fluxurile sunt chiar cumpărările (bani intrați) și vânzările,
   * dividendele, dobânzile (bani ieșiți).
   */
  trackedAccounts: Set<string>;
}

/** Suma unei tranzacții care intră sau iese din portofoliu, în moneda de bază la cursul zilei (plus = intrare). */
export function externalFlow(t: LedgerTx, tracked: boolean, input: SeriesInput): Decimal {
  const currencyOf = (): string => t.currency || (t.assetId != null ? (input.assets.get(t.assetId)?.currency ?? '') : '');
  const reported = t.cashAmount !== null && t.cashAmount !== undefined && t.cashCurrency ? dec(t.cashAmount) : null;
  const inBase = (amount: Decimal, currency: string): Decimal => (currency ? amount.times(dec(input.fxOn(currency, t.date))) : ZERO);
  const net = dec(t.netAmount);
  if (tracked) {
    if (t.type === 'deposit') return inBase(net.abs(), currencyOf());
    if (t.type === 'withdrawal') return inBase(net.abs().neg(), currencyOf());
    if (t.type === 'adjustment') return inBase(net, currencyOf());
    return ZERO;
  }
  // Fără cash urmărit: banii cumpărărilor vin din afară, iar încasările pleacă din portofoliu.
  const mult = t.assetId != null ? dec(input.assets.get(t.assetId)?.multiplier ?? 1) : dec(1);
  const trade = dec(t.quantity).times(dec(t.price)).times(mult);
  switch (t.type) {
    case 'buy':
      return reported ? inBase(reported.abs(), t.cashCurrency as string) : inBase(trade.plus(dec(t.fee)), currencyOf());
    case 'sell':
      return (reported ? inBase(reported.abs(), t.cashCurrency as string) : inBase(trade.minus(dec(t.fee)), currencyOf())).neg();
    case 'dividend':
    case 'coupon':
    case 'interest':
      return (reported ? inBase(reported.abs(), t.cashCurrency as string) : inBase(net, currencyOf())).neg();
    case 'fee':
      return inBase(net.abs(), currencyOf());
    default:
      return ZERO;
  }
}

/**
 * Seria pentru randament (TWR/XIRR): la fiecare dată, valoarea portofoliului
 * (active + cash-ul urmărit) și fluxurile externe din perioada care se încheie atunci.
 */
export function buildPerformanceSeries(input: PerformanceInput): PerformancePoint[] {
  const { txs, ledger, holdingsAt } = createValuer(input);
  const points: PerformancePoint[] = [];
  /**
   * Banii presupuși depuși din afară, pe cont (în moneda de bază): când cumpărările dintr-un cont cu
   * cash urmărit depășesc depunerile înregistrate, soldul ar ieși negativ și valoarea ar porni de
   * aproape zero (randamente de sute de procente). Lipsa se tratează ca depunere la data cumpărării,
   * iar o depunere/ajustare pozitivă ulterioară o acoperă întâi pe aceasta (nu e bani noi de două ori).
   */
  const funded = new Map<string, Decimal>();
  const accountCash = (key: string, date: string): Decimal =>
    sum0(ledger.cashBalances().filter((c) => accountKey(c.portfolioId, c.brokerId) === key).map((c) => c.exact.times(dec(input.fxOn(c.currency, date)))));
  let next = 0;
  for (const date of input.dates) {
    const flows: Flow[] = [];
    while (next < txs.length && txs[next].date <= date) {
      const t = txs[next++];
      ledger.apply(t);
      if (t.brokerId == null) continue;
      const key = accountKey(t.portfolioId, t.brokerId);
      const tracked = input.trackedAccounts.has(key);
      let amount = externalFlow(t, tracked, input);
      if (tracked) {
        let f = funded.get(key) ?? ZERO;
        if (amount.gt(0) && f.gt(0)) {
          const repaid = Decimal.min(f, amount);
          f = f.minus(repaid);
          amount = amount.minus(repaid);
        }
        const shortfall = accountCash(key, t.date).plus(f).neg();
        if (shortfall.gt(0)) {
          f = f.plus(shortfall);
          amount = amount.plus(shortfall);
        }
        funded.set(key, f);
      }
      if (!amount.isZero()) flows.push({ date: t.date, amount: toNum(amount) });
    }
    let value = holdingsAt(date).value;
    for (const c of ledger.cashBalances()) {
      if (input.trackedAccounts.has(accountKey(c.portfolioId, c.brokerId))) value = value.plus(c.exact.times(dec(input.fxOn(c.currency, date))));
    }
    for (const f of funded.values()) value = value.plus(f);
    points.push({ date, value: toNum(value), flows });
  }
  return points;
}

const sum0 = (xs: Decimal[]): Decimal => xs.reduce((s, x) => s.plus(x), ZERO);

/**
 * Lista de date dintre `start` și `end` (inclusiv), rărită astfel încât să nu
 * depășească `maxPoints`. Ultima dată este întotdeauna `end`.
 */
export function buildDateRange(start: string, end: string, maxPoints = 400): string[] {
  if (start > end) return [end];
  const total = daysBetween(start, end);
  const step = Math.max(1, Math.ceil((total + 1) / maxPoints));
  const dates: string[] = [];
  // Pornim de la capăt, ca ultima valoare să fie mereu cea de azi.
  for (let d = end; d >= start; d = addDays(d, -step)) dates.push(d);
  return dates.reverse();
}
