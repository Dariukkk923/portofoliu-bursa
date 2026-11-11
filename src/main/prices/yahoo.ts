/**
 * Provider Yahoo Finance (pachetul yahoo-finance2). Nu cere cheie API și este
 * providerul implicit: acoperă acțiuni, ETF-uri (inclusiv BVB, sufix .RO),
 * crypto (BTC-USD) și cursuri valutare (EURRON=X).
 */
import YahooFinance from 'yahoo-finance2';
import type { AssetType, SymbolSearchResult } from '@shared/types';
import { addDays } from '@shared/dates';
import { isNetworkError, ProviderError, type HistoryResult, type PriceProvider, type Quote, type SymbolRef } from './provider';

/** Tipul Yahoo -> tipul de activ al aplicației (indicii, opțiunile etc. sunt ignorate). */
const QUOTE_TYPES: Record<string, AssetType> = {
  EQUITY: 'stock',
  ETF: 'etf',
  MUTUALFUND: 'etf',
  CRYPTOCURRENCY: 'crypto',
  BOND: 'bond'
};

type Any = any;

/**
 * Unele burse cotează în subunități: Londra în pence („GBp”/„GBX”). Aplicația
 * lucrează doar cu unitatea principală, deci prețul se împarte la 100.
 */
function toMajorUnits(price: number, currency: unknown): { price: number; currency: string | null } {
  if (currency === 'GBp' || currency === 'GBX') return { price: price / 100, currency: 'GBP' };
  return { price, currency: currency ? String(currency).toUpperCase() : null };
}

export class YahooProvider implements PriceProvider {
  readonly id = 'yahoo' as const;
  private client: Any = null;

  /** Clientul se creează la prima folosire. */
  private yf(): Any {
    if (!this.client) {
      const Ctor: Any = (YahooFinance as Any).default ?? YahooFinance;
      this.client = new Ctor({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
    }
    return this.client;
  }

  private wrap(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const message = (err as Error)?.message ?? String(err);
    if (isNetworkError(err)) return new ProviderError('network', `Yahoo Finance nu poate fi contactat: ${message}`);
    if (/429|too many requests/i.test(message)) return new ProviderError('ratelimit', 'Yahoo Finance: prea multe cereri.');
    if (/not found|no data|delisted/i.test(message)) return new ProviderError('notfound', message);
    return new ProviderError('other', `Yahoo Finance: ${message}`);
  }

  private toQuote(q: Any): Quote | null {
    const price = q?.regularMarketPrice;
    if (!q?.symbol || typeof price !== 'number' || !(price > 0)) return null;
    const time = q.regularMarketTime instanceof Date ? q.regularMarketTime : new Date();
    return {
      symbol: String(q.symbol).toUpperCase(),
      ...toMajorUnits(price, q.currency),
      asOf: time.toISOString(),
      name: q.longName ?? q.shortName ?? null,
      assetType: QUOTE_TYPES[String(q.quoteType ?? '')] ?? null
    };
  }

  async getQuotes(refs: SymbolRef[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    if (refs.length === 0) return out;
    try {
      const list: Any[] = await this.yf().quote(refs.map((r) => r.symbol));
      for (const item of list ?? []) {
        const q = this.toQuote(item);
        if (q) out.set(q.symbol, q);
      }
      return out;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async getQuote(ref: SymbolRef): Promise<Quote> {
    const q = (await this.getQuotes([ref])).get(ref.symbol.toUpperCase());
    if (!q) throw new ProviderError('notfound', `Yahoo Finance nu are preț pentru ${ref.symbol}.`);
    return q;
  }

  async getHistory(ref: SymbolRef, from: string, to: string): Promise<HistoryResult> {
    try {
      // period2 este exclusiv, deci cerem o zi în plus.
      const chart: Any = await this.yf().chart(ref.symbol, { period1: from, period2: addDays(to, 1), interval: '1d' });
      const points = ((chart?.quotes ?? []) as Any[])
        .filter((r) => r?.date instanceof Date && typeof r.close === 'number' && r.close > 0)
        .map((r) => ({ date: (r.date as Date).toISOString().slice(0, 10), close: toMajorUnits(r.close as number, chart?.meta?.currency).price }));
      // „close” de la Yahoo este ajustat la split-uri (nu și la dividende).
      return { points, splitAdjusted: true };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async search(query: string): Promise<SymbolSearchResult[]> {
    try {
      const res: Any = await this.yf().search(query, { quotesCount: 10, newsCount: 0 });
      const results: SymbolSearchResult[] = [];
      for (const q of (res?.quotes ?? []) as Any[]) {
        const type = QUOTE_TYPES[String(q?.quoteType ?? '')];
        if (!q?.symbol || !type) continue;
        results.push({
          symbol: String(q.symbol).toUpperCase(),
          name: q.longname ?? q.shortname ?? '',
          exchange: q.exchDisp ?? q.exchange ?? null,
          type,
          currency: null
        });
      }
      return results;
    } catch (err) {
      throw this.wrap(err);
    }
  }
}
