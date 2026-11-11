/**
 * Măsuri de risc din seria randamentului (TWR cumulat la fiecare dată):
 * volatilitatea anualizată și cea mai mare scădere de la un vârf (max drawdown).
 *
 * Seria poate avea pași de mai multe zile (graficele „Tot” sunt rărite), deci
 * volatilitatea se anualizează după lungimea medie a pasului, în zile calendaristice.
 * Sunt procente afișate rotunjit, deci se lucrează cu numere JavaScript.
 */
import { daysBetween } from '../dates';

export interface ReturnPoint {
  date: string;
  /** Randamentul cumulat de la începutul seriei (0,1 = +10%). */
  twr: number;
}

/** Randamentele pe fiecare pas: (1 + R_i) / (1 + R_{i−1}) − 1. */
export function periodReturns(points: ReturnPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = 1 + points[i - 1].twr;
    if (prev > 0) out.push((1 + points[i].twr) / prev - 1);
  }
  return out;
}

/** Abaterea standard de selecție (n − 1). */
export function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Volatilitatea anualizată: abaterea standard a randamentelor pe pas × √(pași pe an).
 * Null dacă seria are mai puțin de 10 pași (prea puține date ca cifra să spună ceva).
 */
export function annualizedVolatility(points: ReturnPoint[], minSteps = 10): number | null {
  const returns = periodReturns(points);
  if (returns.length < minSteps) return null;
  const sd = standardDeviation(returns);
  if (sd === null) return null;
  const days = daysBetween(points[0].date, points[points.length - 1].date);
  const stepDays = days / returns.length;
  if (!(stepDays > 0)) return null;
  return sd * Math.sqrt(365 / stepDays);
}

export interface Drawdown {
  /** Scăderea, negativă (−0,2 = −20%). */
  value: number;
  peakDate: string;
  troughDate: string;
  /** Data la care valoarea a revenit la vârf, sau null dacă nu a revenit încă. */
  recoveryDate: string | null;
}

/** Cea mai mare scădere de la un vârf până la minimul următor; null dacă valoarea nu a scăzut niciodată. */
export function maxDrawdown(points: ReturnPoint[]): Drawdown | null {
  let peak = Number.NEGATIVE_INFINITY;
  let peakDate = '';
  let worst: Drawdown | null = null;
  let current: { peak: number; peakDate: string } | null = null;
  for (const p of points) {
    const wealth = 1 + p.twr;
    if (wealth >= peak) {
      if (current && worst && worst.peakDate === current.peakDate && worst.recoveryDate === null) worst.recoveryDate = p.date;
      peak = wealth;
      peakDate = p.date;
      current = { peak, peakDate };
      continue;
    }
    const dd = wealth / peak - 1;
    if (!worst || dd < worst.value) worst = { value: dd, peakDate, troughDate: p.date, recoveryDate: null };
  }
  return worst && worst.value < 0 ? worst : null;
}

/**
 * Beta față de indicele de referință: cât de mult se mișcă portofoliul când se mișcă piața
 * (cov(R_p, R_b) / var(R_b), pe pașii comuni ai celor două serii). 1 = la fel ca piața,
 * peste 1 = amplifică mișcările, sub 1 = mai liniștit. Null cu mai puțin de 10 pași comuni.
 */
export function beta(portfolio: ReturnPoint[], benchmark: ReturnPoint[], minSteps = 10): number | null {
  const bench = new Map(benchmark.map((p) => [p.date, p.twr]));
  const common = portfolio.filter((p) => bench.has(p.date));
  const rp: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < common.length; i++) {
    const p0 = 1 + common[i - 1].twr;
    const b0 = 1 + (bench.get(common[i - 1].date) as number);
    if (!(p0 > 0) || !(b0 > 0)) continue;
    rp.push((1 + common[i].twr) / p0 - 1);
    rb.push((1 + (bench.get(common[i].date) as number)) / b0 - 1);
  }
  if (rb.length < minSteps) return null;
  const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  const mp = mean(rp);
  const mb = mean(rb);
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < rb.length; i++) {
    cov += (rp[i] - mp) * (rb[i] - mb);
    varB += (rb[i] - mb) ** 2;
  }
  return varB > 0 ? cov / varB : null;
}

/* -------------------------------------------------------- diversificarea */

export interface ExposureShare {
  label: string;
  /** Ponderea în portofoliu (0,25 = 25%). */
  pct: number;
}

export interface DiversificationInput {
  /** Pozițiile (pe activ), cu ponderea în valoarea investită. */
  positions: { symbol: string; weight: number }[];
  /** Expunerile cunoscute; feliile „diversificate” (ETF-uri pe mai multe sectoare/țări, crypto) nu se socotesc concentrare. */
  sectors: ExposureShare[];
  countries: ExposureShare[];
  currencies: ExposureShare[];
  types: ExposureShare[];
  /** Ponderea pozițiilor fără sector cunoscut și simbolurile lor. */
  unknownSector: { pct: number; symbols: string[] };
  /** Pragul de concentrare pe o singură poziție (0,2 = 20%). */
  limit: number;
}

export interface Diversification {
  /** Scorul general, de la 1 (concentrat) la 10 (bine diversificat). */
  score: number;
  /** Numărul „efectiv” de poziții (1 / Σ ponderi²): 10 poziții egale = 10, una dominantă ≈ 1. */
  effectivePositions: number;
  suggestions: string[];
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const pctText = (x: number): string => `${Math.round(x * 100)}%`;
const top = (list: ExposureShare[]): ExposureShare | null => list.reduce<ExposureShare | null>((best, s) => (!best || s.pct > best.pct ? s : best), null);

/**
 * Scorul de diversificare și sugestiile concrete. Scorul combină: numărul efectiv de poziții,
 * ponderea celei mai mari poziții, cel mai mare sector, cea mai mare țară, cea mai mare monedă
 * și numărul de tipuri de active. Este o regulă simplă, explicabilă, nu o recomandare de investiții.
 */
export function assessDiversification(input: DiversificationInput): Diversification {
  const weights = input.positions.map((p) => p.weight).filter((w) => w > 0);
  if (weights.length === 0) return { score: 1, effectivePositions: 0, suggestions: [] };
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const effective = 1 / hhi;
  const largest = Math.max(...weights);
  const sector = top(input.sectors);
  const country = top(input.countries);
  const currency = top(input.currencies);
  const types = input.types.filter((t) => t.pct >= 0.05).length;

  const parts = [
    { weight: 0.35, value: clamp01((effective - 1) / 14) },
    { weight: 0.15, value: clamp01((0.5 - largest) / 0.4) },
    { weight: 0.2, value: sector ? clamp01((0.7 - sector.pct) / 0.45) : 1 },
    { weight: 0.15, value: country ? clamp01((0.9 - country.pct) / 0.5) : 1 },
    { weight: 0.1, value: currency ? clamp01((1 - currency.pct) / 0.4) : 1 },
    { weight: 0.05, value: types >= 3 ? 1 : types === 2 ? 0.6 : 0 }
  ];
  // O singură poziție nu este diversificată, oricum ar arăta celelalte criterii.
  const score = weights.length === 1 ? 1 : Math.min(10, Math.max(1, Math.round(1 + 9 * parts.reduce((s, p) => s + p.weight * p.value, 0))));

  const suggestions: string[] = [];
  for (const p of [...input.positions].sort((a, b) => b.weight - a.weight)) {
    if (p.weight > input.limit) suggestions.push(`${p.symbol} reprezintă ${pctText(p.weight)} din portofoliu, peste pragul tău de ${pctText(input.limit)}.`);
  }
  if (weights.length > 1 && effective < 5) {
    suggestions.push(`Practic doar ${Math.max(1, Math.round(effective))} ${Math.round(effective) === 1 ? 'poziție contează' : 'poziții contează'}: o problemă la una dintre ele afectează mult tot portofoliul.`);
  } else if (weights.length === 1) {
    suggestions.push('Tot portofoliul este într-o singură poziție.');
  }
  if (sector && sector.pct >= 0.4) {
    suggestions.push(`${pctText(sector.pct)} din portofoliu e în ${sector.label.toLowerCase()}. Un ETF pe toată piața sau poziții din alte sectoare reduc dependența de un singur domeniu.`);
  }
  if (country && country.pct >= 0.7) suggestions.push(`${pctText(country.pct)} din investiții sunt în companii din ${country.label}.`);
  if (currency && currency.pct >= 0.9 && input.currencies.length >= 1) {
    suggestions.push(`${pctText(currency.pct)} din portofoliu este în ${currency.label}: rezultatul depinde și de cursul acestei monede.`);
  }
  if (input.unknownSector.pct >= 0.1) {
    suggestions.push(
      `Pentru ${pctText(input.unknownSector.pct)} din portofoliu sectorul nu este cunoscut (${input.unknownSector.symbols.slice(0, 5).join(', ')}): completează-l din pagina Portofoliu, ca analiza să fie completă.`
    );
  }
  if (suggestions.length === 0) suggestions.push('Portofoliul este bine diversificat după toate criteriile de mai sus.');
  return { score, effectivePositions: effective, suggestions };
}
