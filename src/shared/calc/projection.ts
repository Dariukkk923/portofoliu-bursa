/**
 * Obiectivele financiare: contribuția lunară medie, randamentul și volatilitatea pe termen lung
 * dintr-o serie de prețuri, proiecția Monte Carlo (scenarii lunare), calculul determinist (fără
 * volatilitate) și contribuția lunară necesară pentru a atinge un obiectiv la o dată.
 *
 * Sunt estimări: se lucrează cu numere JavaScript, iar rezultatele se rotunjesc la afișare.
 */
import { addMonths, daysBetween } from '../dates';
import type { Flow } from './returns';

/**
 * Contribuția lunară medie: suma fluxurilor externe nete (depuneri − retrageri) din ultimele
 * `months` luni, împărțită la numărul de luni. Dacă istoricul e mai scurt, se împarte la lunile
 * calendaristice de la primul flux până azi, inclusiv (8 depuneri lunare = 8 luni).
 */
export function averageMonthlyContribution(flows: Flow[], today: string, months = 12): number {
  const from = addMonths(today, -months);
  const inWindow = flows.filter((f) => f.date > from && f.date <= today);
  const total = inWindow.reduce((s, f) => s + f.amount, 0);
  const first = flows.reduce<string | null>((min, f) => (min === null || f.date < min ? f.date : min), null);
  if (first === null) return 0;
  const calendarMonths = (Number(today.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
  const span = first > from ? Math.max(1, calendarMonths) : months;
  return total / Math.min(months, span);
}

/** Randamentul anual compus (CAGR) între primul și ultimul preț; null cu mai puțin de un an de date. */
export function cagr(prices: { date: string; close: number }[]): number | null {
  if (prices.length < 2) return null;
  const first = prices[0];
  const last = prices[prices.length - 1];
  const years = daysBetween(first.date, last.date) / 365.25;
  if (years < 1 || !(first.close > 0) || !(last.close > 0)) return null;
  return (last.close / first.close) ** (1 / years) - 1;
}

/** Prețurile de la sfârșitul fiecărei luni (ultima zi cu preț din lună). */
export function monthEnds(prices: { date: string; close: number }[]): { date: string; close: number }[] {
  const out: { date: string; close: number }[] = [];
  for (const p of prices) {
    if (out.length > 0 && out[out.length - 1].date.slice(0, 7) === p.date.slice(0, 7)) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Volatilitatea anualizată din randamentele lunare (abaterea standard × √12); null sub 12 luni. */
export function monthlyVolatility(prices: { date: string; close: number }[]): number | null {
  const m = monthEnds(prices);
  const r: number[] = [];
  for (let i = 1; i < m.length; i++) if (m[i - 1].close > 0) r.push(m[i].close / m[i - 1].close - 1);
  if (r.length < 12) return null;
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(12);
}

/** Rata lunară echivalentă unui randament anual: (1 + r)^(1/12) − 1. */
export const monthlyRate = (annual: number): number => (1 + annual) ** (1 / 12) - 1;

/** Valoarea viitoare fără volatilitate: capitalul crește lunar, iar contribuția se adaugă la sfârșitul fiecărei luni. */
export function futureValue(start: number, monthly: number, annualReturn: number, months: number): number {
  const i = monthlyRate(annualReturn);
  if (Math.abs(i) < 1e-12) return start + monthly * months;
  const g = (1 + i) ** months;
  return start * g + (monthly * (g - 1)) / i;
}

/** Contribuția lunară necesară ca să ajungi la `target` în `months` luni (fără volatilitate); 0 dacă ajungi oricum. */
export function requiredMonthlyContribution(start: number, target: number, annualReturn: number, months: number): number {
  if (months <= 0) return Math.max(0, target - start);
  const i = monthlyRate(annualReturn);
  const g = (1 + i) ** months;
  const missing = target - start * g;
  if (missing <= 0) return 0;
  return Math.abs(i) < 1e-12 ? missing / months : (missing * i) / (g - 1);
}

/** Luna (de la azi) în care se atinge ținta fără volatilitate; null dacă nu se atinge în `maxMonths`. */
export function monthsToTarget(start: number, monthly: number, annualReturn: number, target: number, maxMonths = 600): number | null {
  if (start >= target) return 0;
  const i = monthlyRate(annualReturn);
  let v = start;
  for (let m = 1; m <= maxMonths; m++) {
    v = v * (1 + i) + monthly;
    if (v >= target) return m;
  }
  return null;
}

/** Generator de numere aleatoare cu sămânță (mulberry32): aceeași sămânță dă aceleași scenarii. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MonteCarloInput {
  start: number;
  monthly: number;
  annualReturn: number;
  annualVolatility: number;
  /** Câte luni se simulează. */
  months: number;
  scenarios?: number;
  seed?: number;
  target: number;
  /** Luna-țintă (de la azi), pentru probabilitatea de atingere; null = fără dată-țintă. */
  targetMonth: number | null;
  /** Inflația anuală: cu `real = true` valorile se exprimă în bani de azi. */
  inflation: number;
  real: boolean;
}

export interface MonteCarloResult {
  /** Percentilele 10 / 50 / 90 la fiecare lună (indicele 0 = azi). */
  p10: number[];
  p50: number[];
  p90: number[];
  /**
   * Prima lună în care mediana (curba din grafic) atinge ținta; null dacă nu o atinge în orizont.
   * Așa textul și graficul spun același lucru: linia realistă trece de obiectiv în luna afișată.
   */
  medianMonth: number | null;
  /** La fel, pentru curba pesimistă (percentila 10) și cea optimistă (percentila 90). */
  slowMonth: number | null;
  fastMonth: number | null;
  /** Ce parte din scenarii au cel puțin suma-țintă la luna-țintă (null fără dată sau dincolo de orizont). */
  probabilityByTarget: number | null;
}

const percentile = (sorted: Float64Array, q: number): number => {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
};

/**
 * Simularea Monte Carlo: fiecare scenariu are randamente lunare lognormale cu media anuală și
 * volatilitatea date (mediana creșterii lunare este exp(μ)), plus contribuția lunară la sfârșitul lunii.
 */
export function monteCarlo(input: MonteCarloInput): MonteCarloResult {
  const n = Math.max(1, Math.floor(input.scenarios ?? 5000));
  const months = Math.max(1, Math.floor(input.months));
  const rnd = seededRandom(input.seed ?? 12345);
  const sigma = Math.max(0, input.annualVolatility) / Math.sqrt(12);
  const mu = Math.log(1 + input.annualReturn) / 12 - (sigma * sigma) / 2;
  const deflate = (m: number): number => (input.real ? (1 + input.inflation) ** (m / 12) : 1);
  const values = new Float64Array(n).fill(input.start);
  const tm = input.targetMonth;
  let probability: number | null = tm === null || tm > months ? null : tm <= 0 ? (input.start >= input.target ? 1 : 0) : null;
  const p10: number[] = [input.start];
  const p50: number[] = [input.start];
  const p90: number[] = [input.start];
  const sorted = new Float64Array(n);
  let spare: number | null = null;
  const normal = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = rnd();
    const v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  for (let m = 1; m <= months; m++) {
    const d = deflate(m);
    for (let s = 0; s < n; s++) {
      const growth = sigma > 0 ? Math.exp(mu + sigma * normal()) : Math.exp(mu);
      values[s] = values[s] * growth + input.monthly;
    }
    for (let s = 0; s < n; s++) sorted[s] = values[s] / d;
    sorted.sort();
    if (m === tm) {
      let ok = 0;
      for (let s = 0; s < n; s++) if (sorted[s] >= input.target) ok++;
      probability = ok / n;
    }
    p10.push(percentile(sorted, 0.1));
    p50.push(percentile(sorted, 0.5));
    p90.push(percentile(sorted, 0.9));
  }
  const firstAtTarget = (curve: number[]): number | null => {
    const m = curve.findIndex((v) => v >= input.target);
    return m < 0 ? null : m;
  };
  return { p10, p50, p90, medianMonth: firstAtTarget(p50), fastMonth: firstAtTarget(p90), slowMonth: firstAtTarget(p10), probabilityByTarget: probability };
}
