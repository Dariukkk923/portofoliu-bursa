/**
 * Cache-ul de prețuri din baza de date (fără acces la rețea).
 *
 * - `prices`: ultimul preț cunoscut pe simbol, inclusiv perechile valutare (ex.: EURRON=X);
 * - `price_history`: închideri zilnice pentru graficul de evoluție;
 * - `history_sync`: până la ce dată a fost descărcat istoricul fiecărui simbol.
 *
 * Aplicația citește întotdeauna de aici; providerii doar alimentează aceste
 * tabele. Așa funcționează și fără internet, cu ultimele prețuri salvate.
 */
import type { Asset, PriceSource } from '@shared/types';
import type { Db } from '../db/database';

export interface CachedPrice {
  symbol: string;
  price: number;
  currency: string | null;
  asOf: string;
  provider: string;
  fetchedAt: string;
}

export interface HistoryRow {
  date: string;
  close: number;
  splitAdjusted: boolean;
}

/** Simbolul intern al unei perechi valutare (formatul Yahoo): fxSymbol('EUR', 'RON') = 'EURRON=X'. */
export const fxSymbol = (from: string, to: string): string => `${from}${to}=X`;
export const isFxSymbol = (symbol: string): boolean => /^[A-Z]{6}=X$/.test(symbol);

export function getCachedPrices(db: Db, userId: number): Map<string, CachedPrice> {
  const rows = db.prepare('SELECT * FROM prices WHERE user_id = ?').all(userId) as Record<string, unknown>[];
  return new Map(
    rows.map((r) => [
      r.symbol as string,
      {
        symbol: r.symbol as string,
        price: r.price as number,
        currency: (r.currency as string | null) ?? null,
        asOf: r.as_of as string,
        provider: r.provider as string,
        fetchedAt: r.fetched_at as string
      }
    ])
  );
}

export function saveQuote(
  db: Db,
  userId: number,
  q: { symbol: string; price: number; currency: string | null; asOf: string; provider: string }
): void {
  db.prepare(
    `INSERT INTO prices (user_id, symbol, price, currency, as_of, provider, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, symbol) DO UPDATE SET price = excluded.price, currency = excluded.currency,
       as_of = excluded.as_of, provider = excluded.provider, fetched_at = excluded.fetched_at`
  ).run(userId, q.symbol, q.price, q.currency, q.asOf, q.provider, new Date().toISOString());
}

export function saveHistory(
  db: Db,
  userId: number,
  symbol: string,
  points: { date: string; close: number }[],
  splitAdjusted: boolean,
  provider: string
): void {
  const stmt = db.prepare(
    `INSERT INTO price_history (user_id, symbol, date, close, split_adjusted, provider) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, symbol, date) DO UPDATE SET close = excluded.close,
       split_adjusted = excluded.split_adjusted, provider = excluded.provider`
  );
  db.transaction(() => {
    for (const p of points) {
      if (Number.isFinite(p.close) && p.close > 0) stmt.run(userId, symbol, p.date, p.close, splitAdjusted ? 1 : 0, provider);
    }
  })();
}

/** Istoricul salvat al simbolurilor cerute, sortat crescător după dată. */
export function loadHistory(db: Db, userId: number, symbols: string[]): Map<string, HistoryRow[]> {
  const result = new Map<string, HistoryRow[]>();
  const stmt = db.prepare(
    'SELECT date, close, split_adjusted FROM price_history WHERE user_id = ? AND symbol = ? ORDER BY date'
  );
  for (const symbol of new Set(symbols)) {
    const rows = stmt.all(userId, symbol) as { date: string; close: number; split_adjusted: number }[];
    result.set(
      symbol,
      rows.map((r) => ({ date: r.date, close: r.close, splitAdjusted: !!r.split_adjusted }))
    );
  }
  return result;
}

/** Ultimul rând cu data <= `date` (căutare binară într-o listă sortată). */
export function lastOnOrBefore(rows: HistoryRow[] | undefined, date: string): HistoryRow | null {
  if (!rows || rows.length === 0) return null;
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? rows[found] : null;
}

export function getHistorySync(db: Db, userId: number, symbol: string): { fromDate: string; fetchedAt: string } | null {
  const r = db.prepare('SELECT from_date, fetched_at FROM history_sync WHERE user_id = ? AND symbol = ?').get(userId, symbol) as
    | { from_date: string; fetched_at: string }
    | undefined;
  return r ? { fromDate: r.from_date, fetchedAt: r.fetched_at } : null;
}

export function setHistorySync(db: Db, userId: number, symbol: string, fromDate: string, provider: string): void {
  db.prepare(
    `INSERT INTO history_sync (user_id, symbol, from_date, fetched_at, provider) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, symbol) DO UPDATE SET from_date = excluded.from_date, fetched_at = excluded.fetched_at,
       provider = excluded.provider`
  ).run(userId, symbol, fromDate, new Date().toISOString(), provider);
}

/**
 * Cursuri aproximative față de RON, folosite doar dacă nu există niciun curs
 * salvat (prima pornire fără internet). Interfața afișează atunci un avertisment.
 */
const APPROX_RON: Record<string, number> = { RON: 1, EUR: 5.3, USD: 4.8, GBP: 6.1, CHF: 5.7 };

export interface FxResult {
  rate: number;
  approximate: boolean;
}

/** Cursul `from` -> `base`: direct din cache, inversul perechii opuse sau, în lipsă, o aproximare. */
export function resolveFx(cache: Map<string, CachedPrice>, from: string, base: string): FxResult {
  if (from === base) return { rate: 1, approximate: false };
  const direct = cache.get(fxSymbol(from, base));
  if (direct && direct.price > 0) return { rate: direct.price, approximate: false };
  const inverse = cache.get(fxSymbol(base, from));
  if (inverse && inverse.price > 0) return { rate: 1 / inverse.price, approximate: false };
  const a = APPROX_RON[from];
  const b = APPROX_RON[base];
  return { rate: a && b ? a / b : 1, approximate: true };
}

export interface ResolvedPrice {
  price: number;
  source: PriceSource;
  asOf: string | null;
}

/**
 * Prețul folosit la evaluarea unui activ:
 *  - mod „manual”: prețul introdus de utilizator;
 *  - mod „auto”: ultimul preț din API; dacă nu există, ultimul preț introdus manual.
 * Întoarce null când nu există niciun preț (poziția se evaluează atunci la cost).
 */
export function resolvePrice(asset: Asset, cache: Map<string, CachedPrice>): ResolvedPrice | null {
  const manual: ResolvedPrice | null =
    asset.manualPrice != null ? { price: asset.manualPrice, source: 'manual', asOf: asset.manualPriceDate } : null;
  if (asset.priceMode === 'manual') return manual;
  const cached = cache.get(asset.symbol);
  if (cached && cached.price > 0) return { price: cached.price, source: 'api', asOf: cached.asOf };
  return manual;
}
