/**
 * Provider Alpha Vantage (https://www.alphavantage.co) — cere cheie API.
 * Planul gratuit permite puține cereri pe zi, deci cache-ul contează mult aici.
 * Prețurile istorice zilnice NU sunt ajustate la split-uri pe planul gratuit.
 */
import type { SymbolSearchResult } from '@shared/types';
import {
  fetchJson,
  parseCryptoSymbol,
  parseFxSymbol,
  ProviderError,
  RateLimiter,
  splitExchangeSuffix,
  toNumber,
  type HistoryResult,
  type PriceProvider,
  type Quote,
  type SymbolRef
} from './provider';

const BASE = 'https://www.alphavantage.co/query';
/** Sufix Yahoo -> sufix Alpha Vantage (bursele acoperite). */
const SUFFIX_MAP: Record<string, string> = { L: 'LON', DE: 'DEX', F: 'FRK', PA: 'PAR', AS: 'AMS', TO: 'TRT' };

type Json = Record<string, any>;

export class AlphaVantageProvider implements PriceProvider {
  readonly id = 'alphavantage' as const;
  private readonly limiter = new RateLimiter(1_500);

  constructor(private readonly apiKey: string) {}

  private async call(params: Record<string, string>): Promise<Json> {
    const qs = new URLSearchParams({ ...params, apikey: this.apiKey });
    const data = (await this.limiter.schedule(() => fetchJson(`${BASE}?${qs}`))) as Json;
    // Alpha Vantage răspunde cu 200 și la erori; mesajul stă într-unul din aceste câmpuri.
    if (data['Error Message']) throw new ProviderError('notfound', String(data['Error Message']));
    const note = data.Note ?? data.Information;
    if (note) {
      const text = String(note);
      throw new ProviderError(/premium/i.test(text) && !/rate limit|per day|per minute/i.test(text) ? 'other' : 'ratelimit', text);
    }
    return data;
  }

  private stockSymbol(symbol: string): string {
    const { ticker, suffix } = splitExchangeSuffix(symbol);
    if (!suffix) return symbol;
    const mapped = SUFFIX_MAP[suffix];
    if (!mapped) throw new ProviderError('notfound', `Alpha Vantage nu acoperă bursa „.${suffix}”.`);
    return `${ticker}.${mapped}`;
  }

  /** Perechea de monede pentru crypto și curs valutar. */
  private pair(ref: SymbolRef): { from: string; to: string } | null {
    if (ref.type === 'fx') return parseFxSymbol(ref.symbol);
    if (ref.type === 'crypto') {
      const c = parseCryptoSymbol(ref.symbol);
      return c ? { from: c.base, to: c.quote } : null;
    }
    return null;
  }

  async getQuote(ref: SymbolRef): Promise<Quote> {
    const pair = this.pair(ref);
    if (pair) {
      const data = await this.call({ function: 'CURRENCY_EXCHANGE_RATE', from_currency: pair.from, to_currency: pair.to });
      const r = data['Realtime Currency Exchange Rate'] as Json | undefined;
      const price = toNumber(r?.['5. Exchange Rate']);
      if (!(price > 0)) throw new ProviderError('notfound', `Alpha Vantage nu are curs pentru ${ref.symbol}.`);
      return { symbol: ref.symbol, price, currency: pair.to, asOf: new Date().toISOString() };
    }
    const data = await this.call({ function: 'GLOBAL_QUOTE', symbol: this.stockSymbol(ref.symbol) });
    const q = data['Global Quote'] as Json | undefined;
    const price = toNumber(q?.['05. price']);
    if (!(price > 0)) throw new ProviderError('notfound', `Alpha Vantage nu are preț pentru ${ref.symbol}.`);
    const day = String(q?.['07. latest trading day'] ?? '');
    return {
      symbol: ref.symbol,
      price,
      currency: null, // GLOBAL_QUOTE nu întoarce moneda; se păstrează cea a activului
      asOf: /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : new Date().toISOString()
    };
  }

  async getHistory(ref: SymbolRef, from: string, to: string): Promise<HistoryResult> {
    const pair = this.pair(ref);
    let series: Json | undefined;
    if (pair && ref.type === 'fx') {
      const data = await this.call({ function: 'FX_DAILY', from_symbol: pair.from, to_symbol: pair.to, outputsize: 'full' });
      series = data['Time Series FX (Daily)'];
    } else if (pair) {
      const data = await this.call({ function: 'DIGITAL_CURRENCY_DAILY', symbol: pair.from, market: pair.to });
      series = data['Time Series (Digital Currency Daily)'];
    } else {
      const symbol = this.stockSymbol(ref.symbol);
      try {
        series = (await this.call({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'full' }))['Time Series (Daily)'];
      } catch (err) {
        // Istoricul complet poate fi rezervat planurilor plătite; încercăm ultimele 100 de zile.
        if (!(err instanceof ProviderError) || err.kind !== 'other') throw err;
        series = (await this.call({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'compact' }))['Time Series (Daily)'];
      }
    }
    if (!series) throw new ProviderError('notfound', `Alpha Vantage nu are istoric pentru ${ref.symbol}.`);
    const points = Object.entries(series)
      .map(([date, v]) => ({ date: date.slice(0, 10), close: toNumber((v as Json)['4. close'] ?? (v as Json)['4a. close (USD)']) }))
      .filter((p) => p.date >= from && p.date <= to && p.close > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    return { points, splitAdjusted: false };
  }

  async search(query: string): Promise<SymbolSearchResult[]> {
    const data = await this.call({ function: 'SYMBOL_SEARCH', keywords: query });
    return ((data.bestMatches ?? []) as Json[]).slice(0, 10).map((m) => ({
      symbol: String(m['1. symbol']),
      name: String(m['2. name'] ?? ''),
      exchange: m['4. region'] ? String(m['4. region']) : null,
      type: /etf/i.test(String(m['3. type'])) ? 'etf' : 'stock',
      currency: m['8. currency'] ? String(m['8. currency']) : null
    }));
  }
}
