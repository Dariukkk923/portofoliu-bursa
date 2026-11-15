/**
 * Știrile pentru activele din portofoliu și din watchlist.
 *
 * Fiecare simbol are cache-ul lui (30 de minute); dacă reîmprospătarea eșuează, se arată ce există
 * în cache. Știrile de la mai mulți provideri se combină, iar dublurile (același articol sau
 * același titlu) se elimină. Imaginile se descarcă aici, în procesul principal, și se trimit
 * interfeței ca data URI, ca să nu fie nevoie să deschidem politica de securitate a paginii.
 */
import { createHash } from 'node:crypto';
import { ASSET_TYPES, type AssetType, type NewsFeed, type NewsFilter, type NewsItem, type ResearchSource } from '@shared/types';
import type { Db } from '../db/database';
import { isNetworkError } from '../prices/provider';
import { MemoCache } from '../prices/symbolHistory';
import { normalizeSymbol } from './assets';
import { assert } from './common';
import { newsId, titleKey, urlKey, type RawNews } from '../research/parsers';
import type { ResearchSources } from '../research/sources';
import { cacheGet, cachePut, isFresh, pruneThumbs } from './researchCache';
import { mapLimit, pickSymbols, researchSymbols } from './research';

export const NEWS_TTL_MS = 30 * 60_000;
const THUMB_KEEP_MS = 21 * 86_400_000;
const THUMB_RETRY_MS = 24 * 3_600_000;
/** Câte simboluri se interoghează la o încărcare, câte știri se păstrează per simbol și în total. */
const MAX_SYMBOLS = 12;
const PER_SYMBOL = 15;
const MAX_ITEMS = 60;
const THUMBS_PER_RUN = 24;

interface ThumbEntry {
  dataUri: string | null;
}

const thumbKey = (url: string): string => createHash('sha1').update(url).digest('hex').slice(0, 24);

export async function getNews(db: Db, userId: number, filter: NewsFilter, sources: ResearchSources, now: number = Date.now()): Promise<NewsFeed> {
  // Un simbol oarecare (cu tipul dat), din afara portofoliului și a watchlist-ului: doar în memorie.
  if (filter?.symbol && filter.type && ASSET_TYPES.includes(filter.type)) {
    const symbol = normalizeSymbol(filter.symbol);
    if (!researchSymbols(db, userId).some((s) => s.symbol === symbol)) return transientNews(userId, symbol, filter.type, sources, !!filter.force, now);
  }
  const picked = pickSymbols(db, userId, filter ?? {});
  const chosen = [...picked].sort((a, b) => Number(b.held) - Number(a.held)).slice(0, MAX_SYMBOLS);
  const single = !!filter?.symbol;
  const empty: NewsFeed = { items: [], fetchedAt: null, stale: false, offline: false, error: null, symbolCount: chosen.length };
  if (chosen.length === 0) return empty;

  // Polygon și Alpha Vantage au limite mici: se folosesc doar când se cere un singur simbol.
  const cacheName = (symbol: string): string => (single ? `${symbol}+` : symbol);
  let failures = 0;
  let networkFailures = 0;
  let oldest: string | null = null;
  const merged = new Map<string, { raw: RawNews; symbols: Set<string>; providers: Set<ResearchSource> }>();
  const titleIndex = new Map<string, string>();
  // Etichetele de simbol: orice simbol al utilizatorului pomenit în știre, nu doar cele interogate.
  const known = new Set(researchSymbols(db, userId).map((s) => s.symbol.toUpperCase()));

  const results = await mapLimit(chosen, 4, async (s) => {
    const cached = cacheGet<RawNews[]>(db, userId, 'news', cacheName(s.symbol));
    if (isFresh(cached, NEWS_TTL_MS, now) && !filter?.force) return { s, raws: cached!.data, fetchedAt: cached!.fetchedAt };
    try {
      const raws = (await sources.news(s.symbol, s.type, { extra: single })).slice(0, PER_SYMBOL * 3);
      cachePut(db, userId, 'news', cacheName(s.symbol), raws, new Date(now));
      return { s, raws, fetchedAt: new Date(now).toISOString() };
    } catch (err) {
      failures++;
      if (isNetworkError(err)) networkFailures++;
      // La eroare se păstrează ce există în cache (poate fi mai vechi de 30 de minute).
      return { s, raws: cached?.data ?? [], fetchedAt: cached?.fetchedAt ?? null };
    }
  });

  for (const { s, raws, fetchedAt } of results) {
    if (fetchedAt && (!oldest || fetchedAt < oldest)) oldest = fetchedAt;
    for (const raw of raws.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, PER_SYMBOL)) {
      const key = urlKey(raw.url);
      const tk = titleKey(raw.title);
      const existing = merged.get(key) ?? (titleIndex.has(tk) ? merged.get(titleIndex.get(tk)!) : undefined);
      const mine = [s.symbol, ...raw.symbols.map((t) => t.toUpperCase()).filter((t) => known.has(t))];
      if (existing) {
        mine.forEach((m) => existing.symbols.add(m));
        existing.providers.add(raw.provider);
        // Se păstrează varianta cu imagine sau cu rezumat.
        if (!existing.raw.thumbUrl && raw.thumbUrl) existing.raw = { ...existing.raw, thumbUrl: raw.thumbUrl };
        if (!existing.raw.summary && raw.summary) existing.raw = { ...existing.raw, summary: raw.summary };
        continue;
      }
      merged.set(key, { raw, symbols: new Set(mine), providers: new Set([raw.provider]) });
      if (tk) titleIndex.set(tk, key);
    }
  }

  const list = [...merged.values()].sort((a, b) => b.raw.publishedAt.localeCompare(a.raw.publishedAt)).slice(0, MAX_ITEMS);
  const offline = failures > 0 && networkFailures === failures;
  const thumbs = await loadThumbnails(db, userId, list.map((m) => m.raw.thumbUrl), sources, offline, now);

  const items: NewsItem[] = list.map((m) => ({
    id: newsId(m.raw.url),
    title: m.raw.title,
    source: m.raw.source,
    url: m.raw.url,
    publishedAt: m.raw.publishedAt,
    summary: m.raw.summary,
    thumbnail: m.raw.thumbUrl ? (thumbs.get(m.raw.thumbUrl) ?? null) : null,
    symbols: [...m.symbols],
    providers: [...m.providers]
  }));

  return {
    items,
    fetchedAt: oldest,
    stale: failures > 0 && items.length > 0,
    offline,
    error: items.length === 0 && failures > 0 ? (offline ? 'Fără conexiune la internet.' : 'Nu am putut încărca știrile. Încearcă din nou.') : null,
    symbolCount: chosen.length
  };
}

/** Imaginile din cache, plus cele lipsă (până la o limită), descărcate acum; cele eșuate se reîncearcă după o zi. */
async function loadThumbnails(db: Db, userId: number, urls: (string | null)[], sources: ResearchSources, offline: boolean, now: number): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const todo: string[] = [];
  for (const url of new Set(urls.filter((u): u is string => !!u))) {
    const cached = cacheGet<ThumbEntry>(db, userId, 'thumb', thumbKey(url));
    if (cached && (cached.data.dataUri || isFresh(cached, THUMB_RETRY_MS, now))) out.set(url, cached.data.dataUri);
    else todo.push(url);
  }
  if (!offline && todo.length > 0) {
    await mapLimit(todo.slice(0, THUMBS_PER_RUN), 4, async (url) => {
      let dataUri: string | null = null;
      try {
        const img = await sources.thumbnail(url);
        if (img) dataUri = `data:${img.mime};base64,${Buffer.from(img.data).toString('base64')}`;
      } catch {
        dataUri = null; // imaginea este opțională
      }
      cachePut(db, userId, 'thumb', thumbKey(url), { dataUri } satisfies ThumbEntry, new Date(now));
      out.set(url, dataUri);
    });
  }
  pruneThumbs(db, userId, THUMB_KEEP_MS, now);
  return out;
}

/* ------------------------------------------------- simbol oarecare (doar în memorie) */

/** Știrile și imaginile simbolurilor din afara portofoliului și a watchlist-ului: în memorie, nu în baza de date. */
const transientFeeds = new MemoCache<{ raws: RawNews[]; fetchedAt: string }>(NEWS_TTL_MS, 30);
const transientThumbs = new MemoCache<string>(THUMB_RETRY_MS, 300, true);
const TRANSIENT_ITEMS = 20;

async function transientNews(userId: number, symbol: string, type: AssetType, sources: ResearchSources, force: boolean, now: number): Promise<NewsFeed> {
  assert(/^[A-Z0-9.\-=^_/]{1,24}$/.test(symbol), 'Simbolul nu este valid.');
  const base: NewsFeed = { items: [], fetchedAt: null, stale: false, offline: false, error: null, symbolCount: 1 };
  if (type === 'bond') return base;
  const key = `${userId}:${symbol}`;
  if (force) transientFeeds.delete(key);
  let failure: unknown = null;
  const feed = await transientFeeds.get(key, async () => {
    try {
      return { raws: await sources.news(symbol, type, { extra: true }), fetchedAt: new Date(now).toISOString() };
    } catch (err) {
      failure = err;
      return null;
    }
  });
  if (!feed) {
    const offline = failure !== null && isNetworkError(failure);
    return { ...base, offline, error: offline ? 'Fără conexiune la internet.' : 'Nu am putut încărca știrile. Încearcă din nou.' };
  }

  // Dublurile (aceeași adresă sau același titlu) se elimină, ca la știrile din portofoliu.
  const seen = new Set<string>();
  const list: RawNews[] = [];
  for (const raw of feed.raws.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    const keys = [urlKey(raw.url), titleKey(raw.title)].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    list.push(raw);
    if (list.length >= TRANSIENT_ITEMS) break;
  }
  const thumbs = await mapLimit(list, 4, (raw) =>
    raw.thumbUrl
      ? transientThumbs.get(raw.thumbUrl, async () => {
          const img = await sources.thumbnail(raw.thumbUrl!).catch(() => null);
          return img ? `data:${img.mime};base64,${Buffer.from(img.data).toString('base64')}` : null;
        })
      : Promise.resolve(null)
  );
  const items: NewsItem[] = list.map((raw, i) => ({
    id: newsId(raw.url),
    title: raw.title,
    source: raw.source,
    url: raw.url,
    publishedAt: raw.publishedAt,
    summary: raw.summary,
    thumbnail: thumbs[i],
    symbols: [symbol],
    providers: [raw.provider]
  }));
  return { ...base, items, fetchedAt: feed.fetchedAt };
}
