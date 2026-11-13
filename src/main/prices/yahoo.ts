/**
 * Provider Yahoo Finance (pachetul yahoo-finance2). Nu cere cheie API și este
 * providerul implicit: acoperă acțiuni, ETF-uri (inclusiv BVB, sufix .RO),
 * crypto (BTC-USD) și cursuri valutare (EURRON=X).
 */
import type { AssetType, SymbolSearchResult } from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import {
  crossSeries,
  isNetworkError,
  parseFxSymbol,
  ProviderError,
  toMajorUnits,
  type AssetProfile,
  type HistoryResult,
  type PriceProvider,
  type ProviderDividend,
  type Quote,
  type SymbolRef
} from './provider';

/** O dată de la Yahoo (Date sau secunde Unix) ca AAAA-LL-ZZ. */
function isoDay(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

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
 * Clientul Yahoo (metodele quote, chart, quoteSummary, search). Pe desktop este yahoo-finance2
 * (yahooNode.ts), pe web un client mic prin proxy (src/web/yahooWeb.ts); îl alege punctul de pornire.
 */
let clientFactory: () => Any = () => {
  throw new Error('Clientul Yahoo nu este configurat.');
};
export const setYahooClientFactory = (factory: () => Any): void => {
  clientFactory = factory;
};

export class YahooProvider implements PriceProvider {
  readonly id = 'yahoo' as const;
  private client: Any = null;

  /** Clientul se creează la prima folosire. */
  private yf(): Any {
    if (!this.client) this.client = clientFactory();
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
      for (const r of refs) {
        const sym = r.symbol.toUpperCase();
        if (r.type === 'fx' && !out.has(sym)) {
          const c = await this.crossQuote(sym);
          if (c) out.set(sym, c);
        }
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

  /**
   * Yahoo nu are toate perechile directe (ex.: PLNRON=X, NOKRON=X): le calculăm prin dolar, din cele două
   * perechi cu USD, care există pentru toate monedele aplicației.
   */
  private async crossQuote(symbol: string): Promise<Quote | null> {
    const fx = parseFxSymbol(symbol);
    if (!fx || fx.from === 'USD' || fx.to === 'USD') return null;
    const legs = await this.yf().quote([`${fx.from}USD=X`, `USD${fx.to}=X`]);
    const price = (name: string): number => (legs as Any[]).find((l) => l?.symbol === name)?.regularMarketPrice;
    const rate = price(`${fx.from}USD=X`) * price(`USD${fx.to}=X`);
    return rate > 0 ? { symbol, price: rate, currency: fx.to, asOf: new Date().toISOString() } : null;
  }

  private async crossHistory(symbol: string, from: string, to: string): Promise<HistoryResult | null> {
    const fx = parseFxSymbol(symbol);
    if (!fx || fx.from === 'USD' || fx.to === 'USD') return null;
    const a = await this.getHistory({ symbol: `${fx.from}USD=X`, type: 'fx' }, from, to);
    const b = await this.getHistory({ symbol: `USD${fx.to}=X`, type: 'fx' }, addDays(from, -7), to);
    const points = crossSeries(a.points, b.points);
    return points.length > 0 ? { points, splitAdjusted: true } : null;
  }

  async getHistory(ref: SymbolRef, from: string, to: string): Promise<HistoryResult> {
    const direct = await this.directHistory(ref, from, to).catch((err: unknown) => {
      if (ref.type === 'fx' && err instanceof ProviderError && err.kind === 'notfound') return null;
      throw err;
    });
    if (ref.type !== 'fx') return direct as HistoryResult;
    // Un interval scurt poate fi gol legitim (weekend); doar unul lung înseamnă că perechea directă lipsește.
    if (direct && (direct.points.length > 0 || to < addDays(from, 7))) return direct;
    try {
      const cross = await this.crossHistory(ref.symbol.toUpperCase(), from, to);
      if (cross || direct) return cross ?? direct!;
      throw new ProviderError('notfound', `Yahoo Finance nu are istoric pentru ${ref.symbol}.`);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private async directHistory(ref: SymbolRef, from: string, to: string): Promise<HistoryResult> {
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

  /**
   * Dividendele din istoricul Yahoo (data ex-dividend și suma), plus următorul dividend anunțat
   * (din calendarul companiei: data ex-dividend și data plății; suma este a dividendului anterior).
   */
  async getDividends(ref: SymbolRef, from: string): Promise<ProviderDividend[] | null> {
    if (ref.type !== 'stock' && ref.type !== 'etf') return null;
    let out: ProviderDividend[];
    try {
      const chart: Any = await this.yf().chart(ref.symbol, { period1: from, period2: addDays(todayIso(), 1), interval: '1d', events: 'div' });
      const raw = chart?.events?.dividends ?? [];
      const list: Any[] = Array.isArray(raw) ? raw : Object.values(raw);
      const unit = toMajorUnits(1, chart?.meta?.currency);
      out = list
        .map((d) => ({ exDate: isoDay(d?.date), amount: typeof d?.amount === 'number' ? d.amount * unit.price : NaN }))
        .filter((d): d is { exDate: string; amount: number } => !!d.exDate && d.amount > 0)
        .map((d) => ({ exDate: d.exDate, payDate: null, amount: d.amount, currency: unit.currency }))
        .sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
    } catch (err) {
      const e = this.wrap(err);
      if (e.kind === 'notfound') return [];
      throw e;
    }
    try {
      const res: Any = await this.yf().quoteSummary(ref.symbol, { modules: ['calendarEvents'] }, { validateResult: false });
      const ex = isoDay(res?.calendarEvents?.exDividendDate);
      const pay = isoDay(res?.calendarEvents?.dividendDate);
      if (ex) {
        const known = out.find((d) => d.exDate === ex);
        const last = out[out.length - 1];
        if (known) {
          if (pay && pay >= ex) known.payDate = pay;
        } else if (last && ex > last.exDate) {
          out.push({ exDate: ex, payDate: pay && pay >= ex ? pay : null, amount: last.amount, currency: last.currency, amountEstimated: true });
        }
      }
    } catch (err) {
      if (isNetworkError(err)) throw this.wrap(err);
      // Fără calendar: rămâne istoricul.
    }
    return out;
  }

  /** Sectorul și țara (acțiuni) sau categoria fondului (ETF-uri), din profilul Yahoo. */
  async getProfile(ref: SymbolRef): Promise<AssetProfile | null> {
    if (ref.type !== 'stock' && ref.type !== 'etf') return null;
    try {
      const res: Any = await this.yf().quoteSummary(ref.symbol, { modules: ref.type === 'etf' ? ['fundProfile', 'assetProfile'] : ['assetProfile'] }, { validateResult: false });
      const sector = (ref.type === 'etf' ? res?.fundProfile?.categoryName : res?.assetProfile?.sector) ?? null;
      const country = res?.assetProfile?.country ?? null;
      if (!sector && !country) return null;
      return { sector: sector ? String(sector).slice(0, 60) : null, country: country ? String(country).slice(0, 60) : null };
    } catch (err) {
      const e = this.wrap(err);
      if (e.kind === 'notfound') return null;
      throw e;
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
      // Căutarea nu întoarce moneda; o aflăm dintr-o singură cerere de cotații (cu pence deja convertiți în lire).
      if (results.length > 0) {
        try {
          const quotes = await this.getQuotes(results.map((r) => ({ symbol: r.symbol, type: r.type ?? 'stock' })));
          for (const r of results) r.currency = quotes.get(r.symbol)?.currency ?? null;
        } catch {
          // Fără monedă: interfața folosește moneda uzuală a bursei.
        }
      }
      return results;
    } catch (err) {
      throw this.wrap(err);
    }
  }
}
