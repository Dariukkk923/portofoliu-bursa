/**
 * Simulatorul „ce-ar fi fost dacă”: aceleași sume investite (sau retrase) la aceleași date
 * într-un alt instrument, cu dividendele reinvestite opțional, conversie valutară și comision.
 *
 * Cumpărarea se face la prețul de închidere al zilei (sau al ultimei zile de tranzacționare
 * de dinainte); dividendele se reinvestesc la prețul din ziua ex-dividend. Rezultatele sunt
 * estimări afișate rotunjit, deci se lucrează cu numere JavaScript.
 */
import { addMonths } from '../dates';

export interface SimPrice {
  date: string;
  close: number;
}

/** O sumă investită (plus) sau retrasă (minus), în moneda de bază. */
export interface SimFlow {
  date: string;
  amount: number;
}

export interface SimOptions {
  /** Prețurile de închidere ale instrumentului, în moneda lui (ordonate după dată). */
  prices: SimPrice[];
  /** Cursul monedei instrumentului față de moneda de bază la o dată (1 dacă sunt aceeași monedă). */
  fxOn: (date: string) => number;
  /** Dividendele pe unitate (în moneda instrumentului), de reinvestit; null = fără dividende. */
  dividends: { exDate: string; amount: number }[] | null;
  /** Comisionul la fiecare cumpărare/vânzare, ca fracție (0,002 = 0,2%). */
  feePct: number;
  /** Datele pentru grafic (ordonate). */
  dates: string[];
}

export interface SimPoint {
  date: string;
  /** Valoarea simulată și totalul investit net până la acea dată, în moneda de bază. */
  value: number;
  invested: number;
}

export interface SimResult {
  points: SimPoint[];
  units: number;
  invested: number;
  finalValue: number;
  fees: number;
  /** Dividendele reinvestite, în moneda de bază (la cursul zilei). */
  reinvested: number;
  /** Prima zi cu preț: sumele de dinainte se investesc atunci. */
  firstPriceDate: string | null;
}

/** Ultimul preț de până la data dată (sau primul, pentru datele dinaintea istoricului). */
export function priceOnOrBefore(prices: SimPrice[], date: string): SimPrice | null {
  if (prices.length === 0) return null;
  let lo = 0;
  let hi = prices.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? prices[found] : prices[0];
}

export function simulateInvestment(flows: SimFlow[], o: SimOptions): SimResult {
  const prices = o.prices;
  type Ev = { date: string; kind: 0 | 1 | 2; amount: number };
  // În aceeași zi: întâi dividendul (pentru unitățile deja deținute), apoi fluxul, apoi punctul din grafic.
  const events: Ev[] = [
    ...(o.dividends ?? []).map((d) => ({ date: d.exDate, kind: 0 as const, amount: d.amount })),
    ...flows.map((f) => ({ date: f.date, kind: 1 as const, amount: f.amount })),
    ...o.dates.map((d) => ({ date: d, kind: 2 as const, amount: 0 }))
  ].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.kind - b.kind));

  let units = 0;
  let invested = 0;
  let fees = 0;
  let reinvested = 0;
  const points: SimPoint[] = [];
  for (const e of events) {
    const p = priceOnOrBefore(prices, e.date);
    if (!p || !(p.close > 0)) {
      if (e.kind === 1) invested += e.amount;
      if (e.kind === 2) points.push({ date: e.date, value: 0, invested });
      continue;
    }
    const fx = o.fxOn(e.date);
    if (e.kind === 0) {
      if (units <= 0) continue;
      const cash = units * e.amount; // în moneda instrumentului
      reinvested += cash * fx;
      units += cash / p.close;
    } else if (e.kind === 1) {
      invested += e.amount;
      if (e.amount > 0) {
        const fee = e.amount * o.feePct;
        fees += fee;
        units += (e.amount - fee) / fx / p.close;
      } else if (e.amount < 0 && units > 0) {
        // Retragere: se vând unitățile care, după comision, dau suma cerută (cel mult tot ce există).
        const gross = -e.amount / (1 - o.feePct);
        const sellUnits = Math.min(units, gross / fx / p.close);
        fees += sellUnits * p.close * fx * o.feePct;
        units -= sellUnits;
      }
    } else {
      points.push({ date: e.date, value: units * p.close * fx, invested });
    }
  }
  const last = o.dates[o.dates.length - 1];
  const lastPrice = last ? priceOnOrBefore(prices, last) : null;
  return {
    points,
    units,
    invested,
    finalValue: lastPrice ? units * lastPrice.close * o.fxOn(last) : 0,
    fees,
    reinvested,
    firstPriceDate: prices[0]?.date ?? null
  };
}

/** Investiția lunară: aceeași sumă în aceeași zi a fiecărei luni, de la `start` până la `end` (inclusiv). */
export function monthlyFlows(amount: number, start: string, end: string): SimFlow[] {
  const out: SimFlow[] = [];
  for (let k = 0; k < 1200; k++) {
    const date = addMonths(start, k);
    if (date > end) break;
    out.push({ date, amount });
  }
  return out;
}
