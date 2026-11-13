/** Cache-ul de știri și raportări (tabela `research_cache`): o înregistrare JSON pe utilizator, fel de date și simbol. */
import type { Db } from '../db/database';

export type CacheKind = 'news' | 'fin' | 'cal' | 'thumb';

export interface CacheEntry<T> {
  data: T;
  /** Momentul descărcării (ISO). */
  fetchedAt: string;
}

export function cacheGet<T>(db: Db, userId: number, kind: CacheKind, key: string): CacheEntry<T> | null {
  const row = db.prepare('SELECT payload, fetched_at FROM research_cache WHERE user_id = ? AND kind = ? AND symbol = ?').get(userId, kind, key) as
    | { payload: string; fetched_at: string }
    | undefined;
  if (!row) return null;
  try {
    return { data: JSON.parse(row.payload) as T, fetchedAt: row.fetched_at };
  } catch {
    return null; // înregistrare stricată: se descarcă din nou
  }
}

export function cachePut(db: Db, userId: number, kind: CacheKind, key: string, data: unknown, now: Date = new Date()): void {
  db.prepare('INSERT OR REPLACE INTO research_cache (user_id, kind, symbol, payload, fetched_at) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    kind,
    key,
    JSON.stringify(data),
    now.toISOString()
  );
}

/** Cache-ul este încă valabil dacă are mai puțin de `ttlMs` milisecunde. */
export function isFresh(entry: CacheEntry<unknown> | null, ttlMs: number, now: number = Date.now()): boolean {
  return !!entry && now - Date.parse(entry.fetchedAt) < ttlMs;
}

/** Imaginile mici rămân în cache câteva săptămâni, apoi se șterg. */
export function pruneThumbs(db: Db, userId: number, olderThanMs: number, now: number = Date.now()): void {
  db.prepare("DELETE FROM research_cache WHERE user_id = ? AND kind = 'thumb' AND fetched_at < ?").run(userId, new Date(now - olderThanMs).toISOString());
}
