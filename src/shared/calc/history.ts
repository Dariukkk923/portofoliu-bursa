/**
 * Reconstrucția evoluției valorii portofoliului din tranzacții și prețuri istorice.
 *
 * Pentru fiecare dată din interval se aplică tranzacțiile făcute până atunci și
 * se evaluează pozițiile rămase la prețul de închidere din acea zi (ultimul
 * cunoscut), convertit în moneda de bază la cursul din acea zi.
 */
import type { CostMethod, HistoryPoint } from '../types';
import { addDays, daysBetween } from '../dates';
import { Ledger, sortTransactions, splitFactor, type LedgerTx } from './engine';

export interface HistoryAsset {
  currency: string;
  multiplier: number;
}

export interface HistoricalPrice {
  price: number;
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
  fxOn: (currency: string, date: string) => number;
}

export function buildValueSeries(input: SeriesInput): HistoryPoint[] {
  const txs = sortTransactions(input.transactions);
  const splits = txs.filter((t) => t.type === 'split');
  const ledger = new Ledger({
    method: input.method,
    multiplierOf: (id) => input.assets.get(id)?.multiplier ?? 1,
    strict: false
  });

  /** Produsul split-urilor ulterioare datei, care afectează poziția dată. */
  const futureSplitFactor = (assetId: number, brokerId: number, date: string): number => {
    let factor = 1;
    for (const s of splits) {
      if (s.assetId !== assetId || s.date <= date) continue;
      if (s.brokerId != null && s.brokerId !== brokerId) continue;
      factor *= splitFactor(s);
    }
    return factor;
  };

  const points: HistoryPoint[] = [];
  let next = 0;
  for (const date of input.dates) {
    while (next < txs.length && txs[next].date <= date) ledger.apply(txs[next++]);

    let value = 0;
    let invested = 0;
    for (const p of ledger.list()) {
      if (p.quantity <= 0) continue;
      const asset = input.assets.get(p.assetId);
      if (!asset) continue;
      const fx = input.fxOn(asset.currency, date);
      invested += p.costBasis * fx;

      const hp = input.priceOn(p.assetId, date);
      if (!hp) {
        // Fără preț istoric (ex.: obligațiune cu preț manual): poziția se ia la cost.
        value += p.costBasis * fx;
        continue;
      }
      const qty = hp.splitAdjusted ? p.quantity * futureSplitFactor(p.assetId, p.brokerId, date) : p.quantity;
      value += qty * hp.price * asset.multiplier * fx;
    }
    points.push({ date, value, invested });
  }
  return points;
}

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
