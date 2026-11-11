/**
 * Dividendele: frecvența plăților dedusă din istoric, estimarea dividendelor viitoare
 * (marcate „estimat”), randamentul pe ultimele 12 luni și datele de cupon ale obligațiunilor.
 *
 * Sumele sunt pe acțiune, în moneda activului; sunt estimări afișate rotunjit, deci se
 * lucrează cu numere JavaScript.
 */
import { addDays, addMonths, daysBetween } from '../dates';

export interface DividendPoint {
  exDate: string;
  /** Data plății, dacă este cunoscută. */
  payDate: string | null;
  /** Suma pe acțiune. */
  amount: number;
}

export interface DividendSchedule {
  /** Plăți pe an (1, 2, 4 sau 12); null dacă nu s-a plătit nimic în ultimele ~13 luni. */
  frequency: 1 | 2 | 4 | 12 | null;
  /** Câte zile trec de obicei între data ex-dividend și plată; null dacă nu se știe. */
  payLagDays: number | null;
  lastExDate: string | null;
  /** Suma „obișnuită” a unui dividend (ultima, fără dividendele speciale). */
  regularAmount: number | null;
}

/** Când nu se știe data plății, se presupune că vine la două săptămâni după data ex-dividend. */
export const DEFAULT_PAY_LAG_DAYS = 14;

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Frecvența, întârzierea plății și suma obișnuită, din dividendele cu data ex-dividend până azi. */
export function inferSchedule(events: DividendPoint[], today: string): DividendSchedule {
  const past = events.filter((e) => e.exDate <= today && e.amount > 0).sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  const lags = past.filter((e) => e.payDate && e.payDate >= e.exDate).map((e) => daysBetween(e.exDate, e.payDate as string));
  const payLagDays = lags.length > 0 ? Math.round(median(lags)) : null;
  if (past.length === 0) return { frequency: null, payLagDays, lastExDate: null, regularAmount: null };
  const last = past[past.length - 1];
  // Plățile din ultimele ~13 luni dau frecvența.
  const recent = past.filter((e) => e.exDate > addDays(today, -395));
  const n = recent.length;
  const frequency: DividendSchedule['frequency'] = n === 0 ? null : n >= 10 ? 12 : n >= 3 ? 4 : n === 2 ? 2 : 1;
  // Un dividend special (mult peste celelalte) nu se repetă: se ia mediana plăților recente.
  const amounts = (recent.length > 0 ? recent : [last]).map((e) => e.amount);
  const typical = median(amounts);
  const regularAmount = amounts.length >= 3 && last.amount > typical * 1.75 ? typical : last.amount;
  return { frequency, payLagDays, lastExDate: last.exDate, regularAmount };
}

export interface ProjectedDividend extends DividendPoint {
  payDate: string;
  payDateEstimated: boolean;
}

/**
 * Dividendele viitoare estimate după frecvența din istoric, de după ultimul dividend cunoscut
 * (inclusiv cele deja anunțate), până la data `until`. Nimic dacă plățile s-au oprit: ultima
 * a fost acum mai mult de 1,5 intervale.
 */
export function projectDividends(events: DividendPoint[], today: string, until: string): ProjectedDividend[] {
  const schedule = inferSchedule(events, today);
  if (!schedule.frequency || !schedule.lastExDate || schedule.regularAmount === null) return [];
  const step = 12 / schedule.frequency;
  if (schedule.lastExDate < addMonths(today, -Math.round(step * 1.5))) return [];
  const latestKnown = events.reduce((max, e) => (e.exDate > max ? e.exDate : max), schedule.lastExDate);
  const lag = schedule.payLagDays ?? DEFAULT_PAY_LAG_DAYS;
  const out: ProjectedDividend[] = [];
  for (let k = 1; k <= 60; k++) {
    const exDate = addMonths(latestKnown, k * step);
    if (exDate > until) break;
    if (exDate <= today) continue; // o plată „ratată” din trecut nu se mai estimează
    out.push({ exDate, payDate: addDays(exDate, lag), payDateEstimated: true, amount: schedule.regularAmount });
  }
  return out;
}

/** Dividendele pe acțiune cu data ex-dividend în ultimele 12 luni. */
export function trailingDividends(events: DividendPoint[], today: string): number {
  const from = addDays(today, -365);
  return events.filter((e) => e.exDate > from && e.exDate <= today).reduce((s, e) => s + e.amount, 0);
}

/** Dividendul anual estimat pe acțiune: suma obișnuită × frecvența, altfel cel din ultimele 12 luni. */
export function forwardAnnualDividend(events: DividendPoint[], today: string): number {
  const s = inferSchedule(events, today);
  if (s.frequency && s.regularAmount !== null && s.lastExDate && s.lastExDate >= addMonths(today, -Math.round((12 / s.frequency) * 1.5))) {
    return s.regularAmount * s.frequency;
  }
  return trailingDividends(events, today);
}

/** Datele de cupon ale unei obligațiuni dintr-un interval, numărate înapoi de la scadență. */
export function couponDates(maturityDate: string, frequency: number, from: string, to: string): string[] {
  const step = Math.max(1, Math.round(12 / (frequency > 0 ? frequency : 1)));
  const out: string[] = [];
  for (let k = 0; k < 1200; k++) {
    const d = addMonths(maturityDate, -k * step);
    if (d < from) break;
    if (d <= to) out.push(d);
  }
  return out.reverse();
}
