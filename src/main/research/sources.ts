/**
 * Sursele de știri și de date financiare. Yahoo nu cere cheie; Polygon și Alpha Vantage
 * se folosesc doar când utilizatorul are cheia lor salvată (cheile nu ajung niciodată în interfață).
 *
 * Serviciile (`news.ts`, `financials.ts`) lucrează cu interfața `ResearchSources`, ca testele să
 * poată înlocui rețeaua cu date fixe.
 */
import YahooFinance from 'yahoo-finance2';
import type { AssetType, ProviderId, StatementSet } from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import type { Db } from '../db/database';
import type { SecretBox } from '../secrets';
import { getApiKey } from '../services/settings';
import { fetchImage, fetchJson, isNetworkError, parseCryptoSymbol, ProviderError, RateLimiter, splitExchangeSuffix, type LogoImage } from '../prices/provider';
import {
  emptySet,
  parseAlphaCalendar,
  parseAlphaEarnings,
  parseAlphaNews,
  parseAlphaStatements,
  parsePolygonFinancials,
  parsePolygonNews,
  parseYahooNews,
  parseYahooStatements,
  parseYahooSummary,
  type CalendarData,
  type FinancialsData,
  type RawNews
} from './parsers';

type Any = any;

export interface NewsOptions {
  /** Cere și Polygon / Alpha Vantage (au limite mici de cereri: doar la un simbol ales). */
  extra: boolean;
}

export interface ResearchSources {
  /** Știrile unui simbol, de la toți providerii disponibili. Aruncă eroarea doar dacă toți au eșuat. */
  news(symbol: string, type: AssetType, opts: NewsOptions): Promise<RawNews[]>;
  /** Imaginea unei știri (mică, doar formate obișnuite); null dacă nu se poate descărca. */
  thumbnail(url: string): Promise<LogoImage | null>;
  /** Raportările unei companii; null = simbolul nu are raportări (ETF, crypto etc.). Aruncă la erori de rețea. */
  financials(symbol: string, type: AssetType): Promise<FinancialsData | null>;
  /** Doar data următoarei raportări și a ultimei publicate (cerere ușoară). */
  calendar(symbol: string, type: AssetType): Promise<CalendarData | null>;
}

const POLYGON = 'https://api.polygon.io';
const ALPHA = 'https://www.alphavantage.co/query';
/** Limitele planurilor gratuite: 5 cereri/minut la Polygon, 1 cerere la 1,5 secunde la Alpha Vantage. */
const polygonLimiter = new RateLimiter(13_000);
const alphaLimiter = new RateLimiter(1_500);
const ALPHA_SUFFIX: Record<string, string> = { L: 'LON', DE: 'DEX', F: 'FRK', PA: 'PAR', AS: 'AMS', TO: 'TRT' };

let yahooClient: Any = null;
function yf(): Any {
  if (!yahooClient) {
    const Ctor: Any = (YahooFinance as Any).default ?? YahooFinance;
    yahooClient = new Ctor({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
  }
  return yahooClient;
}

/** Rezultatul unei cereri sau null la erori „normale” (simbol fără date); erorile de rețea se propagă. */
async function soft<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (err) {
    if (isNetworkError(err)) throw err;
    return null;
  }
}

/** Imaginile se descarcă doar de la adrese publice https (nu de la adrese locale sau numerice). */
export function isPublicHttps(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':') || /^\d+(\.\d+){3}$/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ProviderError('network', `Conexiune eșuată: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ProviderError('other', `Răspuns HTTP ${res.status}.`);
  return res.text();
}

export function createResearchSources(db: Db, secrets: SecretBox, userId: number): ResearchSources {
  const polygonKey = getApiKey(db, secrets, userId, 'polygon' satisfies ProviderId);
  const alphaKey = getApiKey(db, secrets, userId, 'alphavantage' satisfies ProviderId);

  const polygon = async (path: string, params: Record<string, string>): Promise<Any> => {
    const qs = new URLSearchParams({ ...params, apiKey: polygonKey ?? '' });
    const data = (await polygonLimiter.schedule(() => fetchJson(`${POLYGON}${path}?${qs}`))) as Any;
    if (data?.status === 'ERROR' || data?.status === 'NOT_AUTHORIZED') throw new ProviderError('other', `Polygon: ${data.error ?? data.message ?? 'eroare'}`);
    return data;
  };
  const alpha = async (params: Record<string, string>): Promise<Any> => {
    const qs = new URLSearchParams({ ...params, apikey: alphaKey ?? '' });
    const data = (await alphaLimiter.schedule(() => fetchJson(`${ALPHA}?${qs}`))) as Any;
    if (data?.['Error Message'] || data?.Note || data?.Information) throw new ProviderError('other', String(data['Error Message'] ?? data.Note ?? data.Information));
    return data;
  };
  const alphaTicker = (symbol: string): string | null => {
    const { ticker, suffix } = splitExchangeSuffix(symbol);
    if (!suffix) return symbol;
    return ALPHA_SUFFIX[suffix] ? `${ticker}.${ALPHA_SUFFIX[suffix]}` : null;
  };
  const isUs = (symbol: string): boolean => !splitExchangeSuffix(symbol).suffix;

  return {
    async news(symbol, type, opts) {
      const jobs: Promise<RawNews[]>[] = [yf().search(symbol, { newsCount: 12, quotesCount: 0 }, { validateResult: false }).then(parseYahooNews)];
      if (opts.extra && polygonKey && isUs(symbol)) {
        const crypto = type === 'crypto' ? parseCryptoSymbol(symbol) : null;
        const ticker = crypto ? `X:${crypto.base}${crypto.quote}` : symbol.replace('-', '.');
        if (type !== 'bond') jobs.push(polygon('/v2/reference/news', { ticker, limit: '12', order: 'desc', sort: 'published_utc' }).then(parsePolygonNews));
      }
      if (opts.extra && alphaKey && type !== 'bond') {
        const crypto = type === 'crypto' ? parseCryptoSymbol(symbol) : null;
        const ticker = crypto ? `CRYPTO:${crypto.base}` : alphaTicker(symbol);
        if (ticker) jobs.push(alpha({ function: 'NEWS_SENTIMENT', tickers: ticker, limit: '12', sort: 'LATEST' }).then(parseAlphaNews));
      }
      const results = await Promise.allSettled(jobs);
      const ok = results.filter((r): r is PromiseFulfilledResult<RawNews[]> => r.status === 'fulfilled');
      if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
      return ok.flatMap((r) => r.value);
    },

    thumbnail: async (url) => (isPublicHttps(url) ? fetchImage(url, 6_000) : null),

    async calendar(symbol, type) {
      if (type !== 'stock') return null;
      const qs = await soft<Any>(yf().quoteSummary(symbol, { modules: ['calendarEvents', 'earnings'] }, { validateResult: false }));
      const parsed = qs ? parseYahooSummary(qs) : null;
      let next = parsed?.next ?? null;
      if (!next && alphaKey && alphaTicker(symbol)) {
        const csv = await soft(fetchText(`${ALPHA}?${new URLSearchParams({ function: 'EARNINGS_CALENDAR', symbol: alphaTicker(symbol)!, horizon: '6month', apikey: alphaKey })}`));
        next = csv ? parseAlphaCalendar(csv, symbol, todayIso()) : null;
      }
      if (!parsed && !next) return null;
      return { next, lastReportedDate: parsed?.lastReportedDate ?? null, lastPeriodEnd: parsed?.lastPeriodEnd ?? null };
    },

    async financials(symbol, type) {
      if (type !== 'stock') return null;
      const today = todayIso();
      const [qs, quarterlyRows, annualRows] = await Promise.all([
        soft<Any>(yf().quoteSummary(symbol, { modules: ['calendarEvents', 'earnings', 'earningsHistory', 'financialData', 'assetProfile'] }, { validateResult: false })),
        soft<Any[]>(yf().fundamentalsTimeSeries(symbol, { period1: addDays(today, -365 * 3), type: 'quarterly', module: 'all' }, { validateResult: false })),
        soft<Any[]>(yf().fundamentalsTimeSeries(symbol, { period1: addDays(today, -365 * 6), type: 'annual', module: 'all' }, { validateResult: false }))
      ]);
      const summary = qs ? parseYahooSummary(qs) : null;
      const statements = { quarterly: parseYahooStatements(quarterlyRows ?? []), annual: parseYahooStatements(annualRows ?? []) };
      const sources: FinancialsData['sources'] = [];
      if (summary || statements.quarterly.income.length || statements.annual.income.length) sources.push('yahoo');
      let { eps = [], next = null } = summary ?? {};

      // Rezerve: Polygon (doar SUA), apoi Alpha Vantage, când Yahoo nu are situațiile financiare.
      const lacksStatements = statements.quarterly.income.length === 0 && statements.annual.income.length === 0;
      if (lacksStatements && polygonKey && isUs(symbol)) {
        const [q, a] = await Promise.all(
          (['quarterly', 'annual'] as const).map((timeframe) =>
            soft(polygon('/vX/reference/financials', { ticker: symbol.replace('-', '.'), timeframe, limit: timeframe === 'quarterly' ? '12' : '6', order: 'desc', sort: 'period_of_report_date' }).then(parsePolygonFinancials))
          )
        );
        if (q || a) {
          statements.quarterly = q ?? emptySet();
          statements.annual = a ?? emptySet();
          if (statements.quarterly.income.length || statements.annual.income.length) sources.push('polygon');
        }
      }
      const aTicker = alphaKey ? alphaTicker(symbol) : null;
      if (aTicker && statements.quarterly.income.length === 0 && statements.annual.income.length === 0) {
        const [i, b, c] = await Promise.all(['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW'].map((fn) => soft(alpha({ function: fn, symbol: aTicker }))));
        if (i || b || c) {
          const set = parseAlphaStatements(i, b, c);
          statements.quarterly = set.quarterly;
          statements.annual = set.annual;
          if (set.quarterly.income.length || set.annual.income.length) sources.push('alphavantage');
        }
      }
      if (aTicker && eps.length === 0) {
        const e = await soft(alpha({ function: 'EARNINGS', symbol: aTicker }));
        eps = e ? parseAlphaEarnings(e) : [];
        if (eps.length && !sources.includes('alphavantage')) sources.push('alphavantage');
      }
      if (aTicker && !next) {
        const csv = await soft(fetchText(`${ALPHA}?${new URLSearchParams({ function: 'EARNINGS_CALENDAR', symbol: aTicker, horizon: '6month', apikey: alphaKey! })}`));
        next = csv ? parseAlphaCalendar(csv, symbol, today) : null;
      }

      const empty = (s: StatementSet): boolean => s.income.length + s.balance.length + s.cashflow.length === 0;
      if (!summary && empty(statements.quarterly) && empty(statements.annual) && eps.length === 0 && !next) return null;
      return {
        name: null,
        currency: summary?.currency ?? null,
        next,
        eps,
        statements,
        website: summary?.website ?? null,
        investors: summary?.investors ?? null,
        sources
      };
    }
  };
}
