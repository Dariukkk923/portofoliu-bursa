/**
 * Provider Polygon (https://polygon.io, redenumit Massive) — cere cheie API.
 * Planul gratuit: 5 cereri/minut, prețul de închidere al zilei precedente și
 * circa 2 ani de istoric. Acoperă acțiuni/ETF-uri din SUA, crypto și valute.
 */
import type { AssetType, SymbolSearchResult } from '@shared/types';
import {
  fetchImage,
  fetchJson,
  parseCryptoSymbol,
  parseFxSymbol,
  ProviderError,
  RateLimiter,
  splitExchangeSuffix,
  toNumber,
  type HistoryResult,
  type LogoImage,
  type PriceProvider,
  type ProviderDividend,
  type Quote,
  type SymbolRef
} from './provider';

/** Adresa API-ului. Polygon s-a redenumit în Massive; dacă adresa veche nu mai răspunde, schimb-o aici. */
const BASE = 'https://api.polygon.io';

type Json = Record<string, any>;

export class PolygonProvider implements PriceProvider {
  readonly id = 'polygon' as const;
  private readonly limiter = new RateLimiter(13_000);

  constructor(private readonly apiKey: string) {}

  private async call(path: string, params: Record<string, string> = {}): Promise<Json> {
    const qs = new URLSearchParams({ ...params, apiKey: this.apiKey });
    const data = (await this.limiter.schedule(() => fetchJson(`${BASE}${path}?${qs}`))) as Json;
    if (data.status === 'ERROR' || data.status === 'NOT_AUTHORIZED') {
      throw new ProviderError(data.status === 'NOT_AUTHORIZED' ? 'auth' : 'other', `Polygon: ${data.error ?? data.message ?? 'eroare'}`);
    }
    return data;
  }

  /** Tickerul Polygon și moneda prețului. */
  private ticker(ref: SymbolRef): { ticker: string; currency: string } {
    if (ref.type === 'fx') {
      const fx = parseFxSymbol(ref.symbol);
      if (fx) return { ticker: `C:${fx.from}${fx.to}`, currency: fx.to };
    }
    if (ref.type === 'crypto') {
      const c = parseCryptoSymbol(ref.symbol);
      if (c) return { ticker: `X:${c.base}${c.quote}`, currency: c.quote };
    }
    if (splitExchangeSuffix(ref.symbol).suffix) {
      throw new ProviderError('notfound', 'Polygon acoperă doar acțiuni și ETF-uri listate în SUA.');
    }
    // Clasele de acțiuni: Yahoo scrie BRK-B, Polygon scrie BRK.B.
    return { ticker: ref.symbol.replace('-', '.'), currency: 'USD' };
  }

  async getQuote(ref: SymbolRef): Promise<Quote> {
    const { ticker, currency } = this.ticker(ref);
    const data = await this.call(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`, { adjusted: 'true' });
    const bar = (data.results as Json[] | undefined)?.[0];
    const price = toNumber(bar?.c);
    if (!(price > 0)) throw new ProviderError('notfound', `Polygon nu are preț pentru ${ref.symbol}.`);
    return {
      symbol: ref.symbol,
      price,
      currency,
      asOf: bar?.t ? new Date(Number(bar.t)).toISOString() : new Date().toISOString()
    };
  }

  /** Iconița companiei din detaliile tickerului (doar acțiuni și ETF-uri din SUA). Imaginea cere și ea cheia. */
  async getLogo(ref: SymbolRef): Promise<LogoImage | null> {
    if (ref.type !== 'stock' && ref.type !== 'etf') return null;
    let data: Json;
    try {
      data = await this.call(`/v3/reference/tickers/${encodeURIComponent(this.ticker(ref).ticker)}`);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'notfound') return null;
      throw err;
    }
    const branding = (data.results as Json | undefined)?.branding as Json | undefined;
    const url = String(branding?.icon_url ?? branding?.logo_url ?? '');
    if (!/^https:\/\//.test(url)) return null;
    return this.limiter.schedule(() => fetchImage(`${url}${url.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(this.apiKey)}`));
  }

  /** Dividendele declarate (inclusiv cele viitoare), cu data plății. Doar acțiuni și ETF-uri din SUA. */
  async getDividends(ref: SymbolRef, from: string): Promise<ProviderDividend[] | null> {
    if (ref.type !== 'stock' && ref.type !== 'etf') return null;
    let ticker: string;
    try {
      ticker = this.ticker(ref).ticker;
    } catch {
      return null;
    }
    const data = await this.call('/v3/reference/dividends', { ticker, 'ex_dividend_date.gte': from, order: 'asc', sort: 'ex_dividend_date', limit: '1000' });
    return ((data.results ?? []) as Json[])
      .map((r) => ({
        exDate: String(r.ex_dividend_date ?? ''),
        payDate: r.pay_date ? String(r.pay_date) : null,
        amount: toNumber(r.cash_amount),
        currency: r.currency ? String(r.currency).toUpperCase() : 'USD'
      }))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.exDate) && d.amount > 0);
  }

  async getHistory(ref: SymbolRef, from: string, to: string): Promise<HistoryResult> {
    const { ticker } = this.ticker(ref);
    const data = await this.call(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`, {
      adjusted: 'true',
      sort: 'asc',
      limit: '50000'
    });
    const points = ((data.results ?? []) as Json[])
      .map((b) => ({ date: new Date(Number(b.t)).toISOString().slice(0, 10), close: toNumber(b.c) }))
      .filter((p) => p.close > 0);
    return { points, splitAdjusted: true };
  }

  async search(query: string): Promise<SymbolSearchResult[]> {
    const data = await this.call('/v3/reference/tickers', { search: query, active: 'true', limit: '10' });
    const results: SymbolSearchResult[] = [];
    for (const t of (data.results ?? []) as Json[]) {
      const market = String(t.market ?? '');
      let type: AssetType | null = null;
      let symbol = String(t.ticker ?? '');
      if (market === 'stocks' || market === 'otc') {
        type = /ETF|ETN|ETV/.test(String(t.type ?? '')) ? 'etf' : 'stock';
        symbol = symbol.replace('.', '-');
      } else if (market === 'crypto') {
        // X:BTCUSD -> BTC-USD
        const m = symbol.match(/^X:([A-Z0-9]+)([A-Z]{3})$/);
        if (!m) continue;
        type = 'crypto';
        symbol = `${m[1]}-${m[2]}`;
      } else continue;
      results.push({
        symbol,
        name: String(t.name ?? ''),
        exchange: t.primary_exchange ? String(t.primary_exchange) : null,
        type,
        currency: t.currency_name ? String(t.currency_name).toUpperCase() : null
      });
    }
    return results;
  }
}
