/**
 * Previzualizarea unui simbol căutat (graficul cu 1L, 3L, 6L, YTD, 1A, Tot): perioadele, tăierea
 * istoricului pe perioada aleasă, rărirea seriilor lungi și un cache mic în memorie. Nimic de aici nu ajunge în baza de date.
 */
import type { SymbolHistoryRange } from '@shared/types';
import { addMonths } from '@shared/dates';

type Point = { date: string; close: number };

/** Ultima zi dinaintea perioadei: prețul ei este baza variației. */
export function symbolRangeStart(range: SymbolHistoryRange, today: string): string {
  switch (range) {
    case '1M':
      return addMonths(today, -1);
    case '3M':
      return addMonths(today, -3);
    case '6M':
      return addMonths(today, -6);
    case 'YTD':
      return `${Number(today.slice(0, 4)) - 1}-12-31`;
    case '1Y':
      return addMonths(today, -12);
    case 'ALL':
      return '0000-01-01';
  }
}

/** Cel mult `max` puncte, la intervale egale; primul și ultimul rămân exacte (variația nu se schimbă). */
export function thinPoints(points: Point[], max = 300): Point[] {
  if (points.length <= max) return points;
  const every = Math.ceil((points.length - 1) / (max - 1));
  return points.filter((_, i) => i % every === 0 || i === points.length - 1);
}

/**
 * Punctele perioadei (de la ultima închidere de până la începutul ei, inclusiv) și variația:
 * ultimul preț față de primul punct. Punctele trebuie să fie în ordinea datelor.
 */
export function sliceSymbolHistory(points: Point[], range: SymbolHistoryRange, today: string): { points: Point[]; change: number | null } {
  const start = symbolRangeStart(range, today);
  let from = 0;
  for (let i = 0; i < points.length && points[i].date <= start; i++) from = i;
  const out = points.slice(from);
  const first = out[0]?.close;
  const last = out[out.length - 1]?.close;
  const change = out.length >= 2 && first > 0 ? last / first - 1 : null;
  return { points: out, change };
}

/**
 * Cache în memorie cu durată de viață și număr maxim de intrări (cele mai vechi folosite pleacă primele).
 * Cererile simultane pentru aceeași cheie împart aceeași încărcare; un rezultat `null` (eșec) nu se păstrează, implicit.
 */
export class MemoCache<T> {
  private readonly map = new Map<string, { at: number; value: Promise<T | null> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    /** Și rezultatele `null` se păstrează (ex. un curs pe care providerul nu îl are). */
    private readonly keepNull = false
  ) {}

  get size(): number {
    return this.map.size;
  }

  /** Uită o intrare (reîmprospătare cerută de utilizator). */
  delete(key: string): void {
    this.map.delete(key);
  }

  get(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const hit = this.map.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit.value;
    }
    const value = load().catch(() => null);
    const entry = { at: Date.now(), value };
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    void value.then((v) => {
      if (v === null && !this.keepNull && this.map.get(key) === entry) this.map.delete(key);
    });
    return value;
  }
}
