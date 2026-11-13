/**
 * Știrile pentru activele din portofoliu și din watchlist.
 *
 * Fiecare simbol are cache-ul lui (30 de minute); dacă reîmprospătarea eșuează, se arată ce există
 * în cache. Știrile de la mai mulți provideri se combină, iar dublurile (același articol sau
 * același titlu) se elimină. Imaginile se descarcă aici, în procesul principal, și se trimit
 * interfeței ca data URI, ca să nu fie nevoie să deschidem politica de securitate a paginii.
 */
import { createHash } from 'node:crypto';
import type { NewsFeed, NewsFilter, NewsItem, ResearchSource } from '@shared/types';
import type { Db } from '../db/database';
import { isNetworkError } from '../prices/provider';
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
