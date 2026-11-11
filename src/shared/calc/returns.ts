/**
 * Randamentul portofoliului, în două variante:
 *
 *  - TWR (time-weighted return, randament ponderat în timp): măsoară cât de
 *    bine au mers investițiile, indiferent de când și cât ai depus. Banii noi
 *    nu „umflă” și nu „strică” randamentul. Este măsura potrivită pentru
 *    comparația cu un indice (ex.: S&P 500).
 *  - XIRR (randament ponderat cu banii): randamentul anual efectiv al banilor
 *    tăi, ținând cont de momentul fiecărei depuneri și retrageri. Dacă ai depus
 *    mult chiar înaintea unei creșteri, XIRR iese mai mare decât TWR.
 *
 * Valorile sunt în moneda de bază. Aici se pot folosi numere JavaScript:
 * rezultatele sunt procente afișate rotunjit, nu sume de bani.
 */
import { daysBetween } from '../dates';

/** Un flux de bani extern: plus = bani intrați în portofoliu (depunere), minus = bani ieșiți (retragere). */
export interface Flow {
  date: string;
  amount: number;
}

/** Valoarea portofoliului la sfârșitul unei zile și fluxurile din perioada de la punctul anterior până atunci. */
export interface PerformancePoint {
  date: string;
  value: number;
  /** Fluxurile din (data anterioară, data curentă]; la primul punct sunt ignorate (punctul de pornire). */
  flows: Flow[];
}

/**
 * Randamentul unei perioade prin metoda Modified Dietz: fiecare flux contează
 * proporțional cu timpul cât a stat investit în perioadă. Fluxurile se consideră
 * făcute la începutul zilei lor (o cumpărare de azi participă la evoluția de azi).
 */
export function periodReturn(startValue: number, endValue: number, flows: Flow[], startDate: string, endDate: string): number {
  const length = Math.max(1, daysBetween(startDate, endDate));
  let net = 0;
  let weighted = 0;
  for (const f of flows) {
    const remaining = Math.min(length, Math.max(0, daysBetween(f.date, endDate) + 1));
    net += f.amount;
    weighted += f.amount * (remaining / length);
  }
  const capital = startValue + weighted;
  if (!(capital > 1e-9)) return 0;
  return (endValue - startValue - net) / capital;
}

/** TWR cumulat pentru fiecare punct (primul punct are 0%). */
export function twrSeries(points: PerformancePoint[]): { date: string; twr: number }[] {
  const out: { date: string; twr: number }[] = [];
  let growth = 1;
  points.forEach((p, i) => {
    if (i > 0) {
      const prev = points[i - 1];
      const r = periodReturn(prev.value, p.value, p.flows, prev.date, p.date);
      // O perioadă fără capital investit (ex.: înainte de prima depunere) nu schimbă randamentul.
      if (Number.isFinite(r) && r > -1) growth *= 1 + r;
    }
    out.push({ date: p.date, twr: growth - 1 });
  });
  return out;
}

/** Randamentul anualizat: (1 + R)^(365 / zile) − 1. Null pentru perioade mai scurte de un an. */
export function annualize(totalReturn: number, days: number): number | null {
  if (!(days >= 365) || !(totalReturn > -1)) return null;
  return (1 + totalReturn) ** (365 / days) - 1;
}

/**
 * XIRR: rata anuală r pentru care valoarea actualizată a fluxurilor este zero.
 * Fluxurile sunt din perspectiva investitorului: minus = bani puși, plus = bani primiți
 * (inclusiv valoarea finală a portofoliului). Null dacă nu există o soluție.
 */
export function xirr(flows: Flow[]): number | null {
  const list = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0);
  if (list.length < 2 || !list.some((f) => f.amount > 0) || !list.some((f) => f.amount < 0)) return null;
  const t0 = list.reduce((min, f) => (f.date < min ? f.date : min), list[0].date);
  const years = list.map((f) => daysBetween(t0, f.date) / 365);
  const npv = (r: number): number => list.reduce((s, f, i) => s + f.amount / (1 + r) ** years[i], 0);
  const dnpv = (r: number): number => list.reduce((s, f, i) => s - (years[i] * f.amount) / (1 + r) ** (years[i] + 1), 0);

  // Newton, pornind de la 10%; dacă nu converge, căutare prin înjumătățire.
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const value = npv(r);
    const slope = dnpv(r);
    if (Math.abs(value) < 1e-9) return r;
    if (!Number.isFinite(slope) || slope === 0) break;
    const next = r - value / slope;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }
  let lo = -0.999999;
  let hi = 100;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-9 || hi - lo < 1e-12) return mid;
    if (fLo * fMid < 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Fluxurile pentru XIRR pe un interval: valoarea de pornire ca bani „puși” la
 * început, fluxurile externe (cu semn inversat: o depunere înseamnă bani puși),
 * iar valoarea finală ca bani „primiți” la sfârșit.
 */
export function xirrFlows(points: PerformancePoint[]): Flow[] {
  if (points.length === 0) return [];
  const first = points[0];
  const last = points[points.length - 1];
  const flows: Flow[] = [];
  if (first.value > 0) flows.push({ date: first.date, amount: -first.value });
  for (const p of points.slice(1)) for (const f of p.flows) flows.push({ date: f.date, amount: -f.amount });
  flows.push({ date: last.date, amount: last.value });
  return flows;
}
