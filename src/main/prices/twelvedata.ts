/**
 * Provider Twelve Data (https://twelvedata.com) — cere cheie API.
 * Planul gratuit: 8 cereri/minut. Seriile zilnice sunt ajustate la split-uri.
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
  toMajorUnits,
  toNumber,
  type HistoryResult,
  type LogoImage,
  type PriceProvider,
  type Quote,
  type SymbolRef
} from './provider';

const BASE = 'https://api.twelvedata.com';
/** Sufix Yahoo -> codul MIC al bursei, cum îl cere Twelve Data. */
const MIC_MAP: Record<string, string> = {
  RO: 'XBSE',
  DE: 'XETR',
  F: 'XFRA',
  L: 'XLON',
  PA: 'XPAR',
  AS: 'XAMS',
  MI: 'XMIL',
  SW: 'XSWX',
  TO: 'XTSE'
};

type Json = Record<string, any>;

export class TwelveDataProvider implements PriceProvider {
  readonly id = 'twelvedata' as const;
  private readonly limiter = new RateLimiter(8_000);

  constructor(private readonly apiKey: string) {}

  private async call(path: string, params: Record<string, string>): Promise<Json> {
    const qs = new URLSearchParams({ ...params, apikey: this.apiKey });
    const data = (await this.limiter.schedule(() => fetchJson(`${BASE}${path}?${qs}`))) as Json;
    if (data.status === 'error') {
      const code = Number(data.code);
      const kind = code === 401 || code === 403 ? 'auth' : code === 429 ? 'ratelimit' : code === 400 || code === 404 ? 'notfound' : 'other';
      throw new ProviderError(kind, `Twelve Data: ${data.message ?? 'eroare necunoscută'}`);
    }
    return data;
  }

  /** Parametrii de simbol pentru API: „BTC/USD”, „EUR/RON” sau ticker + cod de bursă. */
  private symbolParams(ref: SymbolRef): Record<string, string> {
    if (ref.type === 'fx') {
      const fx = parseFxSymbol(ref.symbol);
      if (fx) return { symbol: `${fx.from}/${fx.to}` };
    }
    if (ref.type === 'crypto') {
      const c = parseCryptoSymbol(ref.symbol);
      if (c) return { symbol: `${c.base}/${c.quote}` };
    }
    const { ticker, suffix } = splitExchangeSuffix(ref.symbol);
    if (!suffix) return { symbol: ref.symbol };
    const mic = MIC_MAP[suffix];
    if (!mic) throw new ProviderError('notfound', `Twelve Data: bursa „.${suffix}” nu este configurată.`);
    return { symbol: ticker, mic_code: mic };
  }

  async getQuote(ref: SymbolRef): Promise<Quote> {
    const data = await this.call('/quote', this.symbolParams(ref));
    const price = toNumber(data.close);
    if (!(price > 0)) throw new ProviderError('notfound', `Twelve Data nu are preț pentru ${ref.symbol}.`);
    const currency = data.currency ?? (typeof data.symbol === 'string' && data.symbol.includes('/') ? data.symbol.split('/')[1] : null);
    return {
      symbol: ref.symbol,
      ...toMajorUnits(price, currency),
      asOf: data.timestamp ? new Date(Number(data.timestamp) * 1000).toISOString() : new Date().toISOString(),
      name: data.name ?? null
    };
  }

  /** Logo-ul companiei: endpoint-ul „/logo” întoarce adresa imaginii. */
  async getLogo(ref: SymbolRef): Promise<LogoImage | null> {
    if (ref.type === 'fx' || ref.type === 'bond') return null;
    let data: Json;
    try {
      data = await this.call('/logo', this.symbolParams(ref));
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'notfound') return null;
      throw err;
    }
    const url = String(data.url ?? data.logo_base ?? '');
    return /^https:\/\//.test(url) ? fetchImage(url) : null;
  }

  async getHistory(ref: SymbolRef, from: string, to: string): Promise<HistoryResult> {
    const data = await this.call('/time_series', {
      ...this.symbolParams(ref),
      interval: '1day',
      start_date: from,
      end_date: to,
      outputsize: '5000',
      order: 'ASC'
    });
    const points = ((data.values ?? []) as Json[])
      // Londra: prețurile vin în pence, iar moneda din „meta” spune asta (GBp).
      .map((v) => ({ date: String(v.datetime).slice(0, 10), close: toMajorUnits(toNumber(v.close), data.meta?.currency).price }))
      .filter((p) => p.close > 0);
    return { points, splitAdjusted: true };
  }

  async search(query: string): Promise<SymbolSearchResult[]> {
    const data = await this.call('/symbol_search', { symbol: query, outputsize: '10' });
    const typeOf = (t: string): AssetType | null =>
      /etf/i.test(t) ? 'etf' : /stock|equity/i.test(t) ? 'stock' : /digital|crypto/i.test(t) ? 'crypto' : /bond/i.test(t) ? 'bond' : null;
    return ((data.data ?? []) as Json[]).map((d) => ({
      symbol: String(d.symbol).replace('/', '-'),
      name: String(d.instrument_name ?? ''),
      exchange: d.exchange ? String(d.exchange) : null,
      type: typeOf(String(d.instrument_type ?? '')),
      currency: toMajorUnits(1, d.currency).currency
    }));
  }
}
