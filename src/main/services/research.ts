/** Simbolurile pentru care se caută știri și raportări: activele deținute și cele din watchlist. */
import type { AssetType, ResearchSymbol } from '@shared/types';
import type { Db } from '../db/database';
import { assert } from './common';
import { normalizeSymbol } from './assets';
import { heldSymbols } from './watchlist';

/** Obligațiunile nu au știri și nici raportări de companie, deci nu se includ. */
const RESEARCH_TYPES: AssetType[] = ['stock', 'etf', 'crypto'];

/** Activele deținute întâi, apoi cele din watchlist (fără dubluri), fiecare cu tipul și numele lui. */
export function researchSymbols(db: Db, userId: number): ResearchSymbol[] {
  const held = heldSymbols(db, userId);
  const assets = db.prepare('SELECT symbol, name, type FROM assets WHERE user_id = ? ORDER BY symbol').all(userId) as { symbol: string; name: string | null; type: AssetType }[];
  const watch = db
    .prepare('SELECT symbol, MAX(name) AS name, MAX(type) AS type FROM watchlist_items WHERE user_id = ? GROUP BY symbol ORDER BY MIN(created_at), symbol')
    .all(userId) as { symbol: string; name: string | null; type: AssetType }[];
  const out = new Map<string, ResearchSymbol>();
  for (const a of assets) if (held.has(a.symbol) && RESEARCH_TYPES.includes(a.type)) out.set(a.symbol, { symbol: a.symbol, name: a.name ?? '', type: a.type, held: true });
  for (const w of watch) if (!out.has(w.symbol) && RESEARCH_TYPES.includes(w.type)) out.set(w.symbol, { symbol: w.symbol, name: w.name ?? '', type: w.type, held: false });
  return [...out.values()];
}

/** Simbolurile alese de filtru: unul anume, doar cele deținute sau toate. */
export function pickSymbols(db: Db, userId: number, filter: { symbol?: string | null; portfolioOnly?: boolean }): ResearchSymbol[] {
  const all = researchSymbols(db, userId);
  if (filter.symbol) {
    const symbol = normalizeSymbol(filter.symbol);
    const found = all.find((s) => s.symbol === symbol);
    assert(found, 'Simbolul nu este în portofoliu sau în watchlist.');
    return [found];
  }
  return filter.portfolioOnly ? all.filter((s) => s.held) : all;
}

/** Rulează `fn` pe toate elementele, cel mult `limit` deodată; păstrează ordinea rezultatelor. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
