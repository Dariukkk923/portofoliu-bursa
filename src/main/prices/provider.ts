/**
 * Contractul comun al providerilor de prețuri și utilitarele lor.
 *
 * Simbolurile interne ale aplicației sunt în formatul Yahoo Finance:
 *   - acțiuni/ETF-uri: AAPL, TLV.RO, VWCE.DE
 *   - crypto: BTC-USD, ETH-EUR
 *   - curs valutar: EURRON=X
 * Fiecare provider traduce aceste simboluri în formatul propriului API. Pentru
 * a adăuga un provider nou: implementează `PriceProvider` și înregistrează-l
 * în `service.ts`.
 */
import type { AssetType, ProviderId, SymbolSearchResult } from '@shared/types';

export interface SymbolRef {
  symbol: string;
  /** „fx” pentru perechile valutare. */
  type: AssetType | 'fx';
}

export interface Quote {
  symbol: string;
  price: number;
  currency: string | null;
  /** Momentul prețului (ISO). */
  asOf: string;
  name?: string | null;
  /** Tipul instrumentului, dacă providerul îl cunoaște (folosit la importul din rapoartele brokerilor). */
  assetType?: AssetType | null;
}

export interface HistoryResult {
  points: { date: string; close: number }[];
  /** True dacă prețurile sunt ajustate la split-urile ulterioare. */
  splitAdjusted: boolean;
}

export interface PriceProvider {
  readonly id: ProviderId;
  getQuote(ref: SymbolRef): Promise<Quote>;
  /** Opțional: mai multe cotații într-o singură cerere. Simbolurile negăsite lipsesc din rezultat. */
  getQuotes?(refs: SymbolRef[]): Promise<Map<string, Quote>>;
  getHistory(ref: SymbolRef, from: string, to: string): Promise<HistoryResult>;
  search(query: string): Promise<SymbolSearchResult[]>;
}

export type ProviderErrorKind = 'network' | 'notfound' | 'ratelimit' | 'auth' | 'other';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Recunoaște erorile de rețea (fără internet, DNS, timeout) indiferent de biblioteca ce le-a aruncat. */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.kind === 'network';
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const any = e as { name?: string; message?: string; code?: string; cause?: unknown };
    parts.push(any.name ?? '', any.message ?? '', any.code ?? '');
    e = any.cause;
  }
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR|network|timeout|aborted|socket/i.test(
    parts.join(' ')
  );
}

/** Cerere GET care întoarce JSON, cu timeout și erori clasificate. */
export async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ProviderError('network', `Conexiune eșuată: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'Cheia API a fost respinsă.');
  if (res.status === 429) throw new ProviderError('ratelimit', 'Limita de cereri a fost depășită.');
  if (res.status === 404) throw new ProviderError('notfound', 'Simbol negăsit.');
  if (!res.ok) throw new ProviderError('other', `Răspuns HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new ProviderError('other', 'Răspuns invalid de la provider.');
  }
}

/**
 * Limitator simplu: garantează o pauză minimă între cereri, ca să nu depășim
 * limitele planurilor gratuite (ex.: 5 cereri/minut la Polygon).
 */
export class RateLimiter {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return task();
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/** „BTC-USD” -> { base: 'BTC', quote: 'USD' }. */
export function parseCryptoSymbol(symbol: string): { base: string; quote: string } | null {
  const m = symbol.toUpperCase().match(/^([A-Z0-9]{2,10})-([A-Z]{3,4})$/);
  return m ? { base: m[1], quote: m[2] } : null;
}

/** „EURRON=X” -> { from: 'EUR', to: 'RON' }. */
export function parseFxSymbol(symbol: string): { from: string; to: string } | null {
  const m = symbol.toUpperCase().match(/^([A-Z]{3})([A-Z]{3})=X$/);
  return m ? { from: m[1], to: m[2] } : null;
}

/** Desparte sufixul de bursă: „VWCE.DE” -> { ticker: 'VWCE', suffix: 'DE' }. */
export function splitExchangeSuffix(symbol: string): { ticker: string; suffix: string | null } {
  const i = symbol.lastIndexOf('.');
  if (i <= 0 || i === symbol.length - 1) return { ticker: symbol, suffix: null };
  return { ticker: symbol.slice(0, i), suffix: symbol.slice(i + 1).toUpperCase() };
}

export const toNumber = (v: unknown): number => (typeof v === 'number' ? v : Number.parseFloat(String(v)));
