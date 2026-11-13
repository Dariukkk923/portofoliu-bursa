/**
 * Clientul Yahoo pentru browser. yahoo-finance2 nu poate rula în browser (cere cookie și crumb, iar Yahoo
 * nu trimite antete CORS), deci aici sunt doar cele patru metode folosite de aplicație (quote, chart,
 * quoteSummary, search), prin proxy. Forma rezultatelor este aceeași cu a pachetului, ca YahooProvider
 * să le citească neschimbat. Nu există: modulele „financialsTimeSeries”, știri, opțiuni, recomandări.
 */
import { PROXY_MISSING } from './net';

type Any = any;

const dayToUnix = (value: unknown): number => {
  if (typeof value === 'number') return Math.floor(value);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Math.floor(Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`) / 1000);
};

/** Yahoo întoarce valorile ca { raw, fmt }: păstrăm doar `raw`. */
function flatten(value: Any): Any {
  if (Array.isArray(value)) return value.map(flatten);
  if (value && typeof value === 'object') {
    if ('raw' in value) return value.raw;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flatten(v)]));
  }
  return value;
}

export function createWebYahooClient(getProxy: () => string | null, fetchImpl: typeof fetch = (i, o) => fetch(i, o)): Any {
  const get = async (path: string, params: Record<string, string>): Promise<Any> => {
    const proxy = getProxy();
    if (!proxy) throw new Error(`network: ${PROXY_MISSING}`);
    const qs = new URLSearchParams(params).toString();
    let res: Response;
    try {
      res = await fetchImpl(`${proxy}/yahoo/${path}${qs ? `?${qs}` : ''}`, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new Error(`network: ${(err as Error).message}`);
    }
    if (res.status === 429) throw new Error('429 too many requests');
    let body: Any = null;
    try {
      body = await res.json();
    } catch {
      /* răspuns fără JSON */
    }
    if (res.status === 404) throw new Error(body?.chart?.error?.description ?? 'Not Found');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return body;
  };

  const chartRaw = async (symbol: string, params: Record<string, string>): Promise<Any> => {
    const body = await get(`chart/${encodeURIComponent(symbol)}`, params);
    const result = body?.chart?.result?.[0];
    if (!result) throw new Error(body?.chart?.error?.description ?? 'No data found, symbol may be delisted');
    return result;
  };

  const toQuote = (m: Any): Any => ({
    symbol: m.symbol,
    regularMarketPrice: m.regularMarketPrice,
    regularMarketTime: new Date((m.regularMarketTime ?? Date.now() / 1000) * 1000),
    currency: m.currency,
    longName: m.longName,
    shortName: m.shortName,
    quoteType: m.instrumentType
  });

  return {
    /** Cotațiile: o cerere în grup (cu crumb, la proxy); dacă nu merge, câte una din „chart” (meta). */
    async quote(symbols: string[]): Promise<Any[]> {
      try {
        const body = await get('quote', { symbols: symbols.join(',') });
        const list: Any[] = body?.quoteResponse?.result ?? [];
        return list.map((q) => ({ ...q, regularMarketTime: new Date((q.regularMarketTime ?? Date.now() / 1000) * 1000) }));
      } catch (err) {
        if (/network/i.test((err as Error).message)) throw err;
        const out: Any[] = [];
        for (const symbol of symbols.slice(0, 40)) {
          try {
            out.push(toQuote((await chartRaw(symbol, { range: '1d', interval: '1d' })).meta));
          } catch {
            /* simbolul lipsește din rezultat */
          }
        }
        return out;
      }
    },

    async chart(symbol: string, opts: { period1: unknown; period2: unknown; interval?: string; events?: string }): Promise<Any> {
      const params: Record<string, string> = {
        period1: String(dayToUnix(opts.period1)),
        period2: String(dayToUnix(opts.period2)),
        interval: opts.interval ?? '1d'
      };
      if (opts.events) params.events = opts.events;
      const r = await chartRaw(symbol, params);
      const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
      const quotes = ((r.timestamp ?? []) as number[]).map((t, i) => ({ date: new Date(t * 1000), close: closes[i] ?? null }));
      const dividends = Object.values(r.events?.dividends ?? {}).map((d: Any) => ({ date: new Date(d.date * 1000), amount: d.amount }));
      return { meta: r.meta, quotes, events: { dividends } };
    },

    async quoteSummary(symbol: string, opts: { modules: string[] }): Promise<Any> {
      const body = await get(`quoteSummary/${encodeURIComponent(symbol)}`, { modules: opts.modules.join(',') });
      const result = body?.quoteSummary?.result?.[0];
      if (!result) throw new Error(body?.quoteSummary?.error?.description ?? 'Not Found');
      return flatten(result);
    },

    async search(query: string, opts?: { quotesCount?: number }): Promise<Any> {
      const body = await get('search', { q: query, quotesCount: String(opts?.quotesCount ?? 10), newsCount: '0' });
      return { quotes: body?.quotes ?? [] };
    }
  };
}
