/**
 * Serviciul de actualizare a prețurilor.
 *
 * - alege lanțul de provideri al utilizatorului (cel principal, apoi rezervele);
 * - cere cotațiile doar pentru simbolurile al căror cache a expirat;
 * - dacă un provider dă eroare, încearcă simbolurile rămase la următorul;
 * - salvează cotațiile și istoricul zilnic în baza de date;
 * - raportează când nu există internet (aplicația merge mai departe cu cache-ul).
 */
import {
  PROVIDER_IDS,
  type AssetType,
  type PriceStatus,
  type ProviderId,
  type RefreshResult,
  type SymbolQuote,
  type SymbolSearchResult
} from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import { Ledger, sortTransactions } from '@shared/calc';
import type { Db } from '../db/database';
import type { SecretBox } from '../secrets';
import { rowToLedgerTx } from '../services/common';
import { listAssets } from '../services/assets';
import { getApiKey, getSettings, setLastPriceUpdate } from '../services/settings';
import { AlphaVantageProvider } from './alphavantage';
import { PolygonProvider } from './polygon';
import { TwelveDataProvider } from './twelvedata';
import { YahooProvider } from './yahoo';
import { isNetworkError, type PriceProvider, type Quote, type SymbolRef } from './provider';
import { fxSymbol, getCachedPrices, getHistorySync, saveHistory, saveQuote, setHistorySync } from './store';

/** Istoricul unui simbol se reîmprospătează cel mult o dată la atâtea ore (sau la 15 minute, la cerere). */
const HISTORY_TTL_MS = 12 * 3_600_000;
const HISTORY_TTL_FORCED_MS = 15 * 60_000;

export interface PriceServiceOptions {
  db: Db;
  secrets: SecretBox;
  /** Înlocuiește construcția providerilor (folosit în teste). */
  providerFactory?: (id: ProviderId, apiKey: string | null) => PriceProvider | null;
  /** Anunțat la fiecare schimbare de stare (început/sfârșit de actualizare). */
  onStatus?: (userId: number, status: PriceStatus) => void;
}

interface UserState {
  refreshing: Promise<RefreshResult> | null;
  offline: boolean;
  lastError: string | null;
}

export class PriceService {
  private readonly db: Db;
  private readonly secrets: SecretBox;
  private readonly onStatus?: PriceServiceOptions['onStatus'];
  private readonly factory: NonNullable<PriceServiceOptions['providerFactory']>;
  /** Instanțele se păstrează (pe cheie), ca limitatorul de cereri să-și țină starea. */
  private readonly instances = new Map<string, PriceProvider>();
  private readonly states = new Map<number, UserState>();

  constructor(options: PriceServiceOptions) {
    this.db = options.db;
    this.secrets = options.secrets;
    this.onStatus = options.onStatus;
    this.factory =
      options.providerFactory ??
      ((id, apiKey) => {
        if (id === 'yahoo') return new YahooProvider();
        if (!apiKey) return null;
        if (id === 'alphavantage') return new AlphaVantageProvider(apiKey);
        if (id === 'twelvedata') return new TwelveDataProvider(apiKey);
        return new PolygonProvider(apiKey);
      });
  }

  private state(userId: number): UserState {
    let s = this.states.get(userId);
    if (!s) {
      s = { refreshing: null, offline: false, lastError: null };
      this.states.set(userId, s);
    }
    return s;
  }

  status(userId: number): PriceStatus {
    const s = this.state(userId);
    return {
      refreshing: s.refreshing !== null,
      offline: s.offline,
      lastPriceUpdate: getSettings(this.db, userId).lastPriceUpdate,
      lastError: s.lastError
    };
  }

  private emit(userId: number): void {
    this.onStatus?.(userId, this.status(userId));
  }

  /**
   * Lanțul de provideri al utilizatorului: providerul principal, apoi Yahoo
   * (nu cere cheie), apoi ceilalți provideri pentru care există o cheie salvată.
   */
  providerChain(userId: number): PriceProvider[] {
    const primary = getSettings(this.db, userId).primaryProvider;
    const candidates: ProviderId[] = [primary, 'yahoo', ...PROVIDER_IDS];
    const order = candidates.filter((id, i, all) => all.indexOf(id) === i);
    const chain: PriceProvider[] = [];
    for (const id of order) {
      const key = id === 'yahoo' ? null : getApiKey(this.db, this.secrets, userId, id);
      if (id !== 'yahoo' && !key) continue;
      const cacheKey = `${id}:${key ?? ''}`;
      let provider = this.instances.get(cacheKey);
      if (!provider) {
        const created = this.factory(id, key);
        if (!created) continue;
        provider = created;
        this.instances.set(cacheKey, provider);
      }
      chain.push(provider);
    }
    return chain;
  }

  /** Actualizează prețurile. Apelurile simultane pentru același utilizator împart aceeași rulare. */
  refresh(userId: number, options: { force?: boolean } = {}): Promise<RefreshResult> {
    const s = this.state(userId);
    if (s.refreshing) return s.refreshing;
    s.refreshing = this.doRefresh(userId, options.force ?? false)
      .catch((err): RefreshResult => {
        s.lastError = (err as Error).message;
        return {
          ok: false,
          offline: s.offline,
          updated: 0,
          failed: [],
          lastPriceUpdate: getSettings(this.db, userId).lastPriceUpdate,
          message: 'Actualizarea prețurilor a eșuat.'
        };
      })
      .finally(() => {
        s.refreshing = null;
        this.emit(userId);
      });
    this.emit(userId);
    return s.refreshing;
  }

  private async doRefresh(userId: number, force: boolean): Promise<RefreshResult> {
    const s = this.state(userId);
    const settings = getSettings(this.db, userId);
    const assets = listAssets(this.db, userId);
    const txRows = this.db.prepare('SELECT * FROM transactions WHERE user_id = ?').all(userId) as Record<string, unknown>[];
    const txs = sortTransactions(txRows.map(rowToLedgerTx));

    // Ce active sunt deținute acum (au nevoie de cotație) și de când este nevoie de istoric pentru fiecare.
    const held = new Set<number>();
    for (const p of new Ledger({ method: 'AVG', strict: false }).applyAll(txs).list()) {
      if (p.quantity > 0) held.add(p.assetId);
    }
    const firstTxDate = new Map<number, string>();
    for (const t of txs) if (!firstTxDate.has(t.assetId)) firstTxDate.set(t.assetId, t.date);

    const quoteRefs: SymbolRef[] = [];
    const historyNeeds = new Map<string, { ref: SymbolRef; from: string }>();
    const needHistory = (ref: SymbolRef, from: string): void => {
      const existing = historyNeeds.get(ref.symbol);
      if (!existing || from < existing.from) historyNeeds.set(ref.symbol, { ref, from });
    };
    for (const asset of assets) {
      const first = firstTxDate.get(asset.id);
      if (!first) continue;
      if (asset.priceMode === 'auto') {
        const ref: SymbolRef = { symbol: asset.symbol, type: asset.type };
        if (held.has(asset.id)) quoteRefs.push(ref);
        needHistory(ref, first);
      }
      if (asset.currency !== settings.baseCurrency) {
        const ref: SymbolRef = { symbol: fxSymbol(asset.currency, settings.baseCurrency), type: 'fx' };
        if (!quoteRefs.some((r) => r.symbol === ref.symbol)) quoteRefs.push(ref);
        needHistory(ref, first);
      }
    }

    if (quoteRefs.length === 0 && historyNeeds.size === 0) {
      s.offline = false;
      s.lastError = null;
      return { ok: true, offline: false, updated: 0, failed: [], lastPriceUpdate: settings.lastPriceUpdate };
    }

    // Cache: nu cerem din nou prețurile mai noi decât intervalul de actualizare.
    const ttlMs = force ? 0 : Math.max(1, settings.refreshIntervalMin || 5) * 60_000 * 0.9;
    const cache = getCachedPrices(this.db, userId);
    const now = Date.now();
    let pending = quoteRefs.filter((r) => {
      const c = cache.get(r.symbol);
      return !c || c.provider === 'demo' || now - Date.parse(c.fetchedAt) >= ttlMs;
    });

    const chain = this.providerChain(userId);
    let networkFailures = 0;
    let otherResponses = 0;
    let updated = 0;
    const today = todayIso();

    const store = (ref: SymbolRef, q: Quote, provider: PriceProvider): void => {
      const asset = assets.find((a) => a.symbol === ref.symbol);
      saveQuote(this.db, userId, {
        symbol: ref.symbol,
        price: q.price,
        currency: q.currency ?? asset?.currency ?? null,
        asOf: q.asOf,
        provider: provider.id
      });
      // Cotația de azi intră și în istoric, ca graficul să aibă mereu ultimul punct.
      saveHistory(this.db, userId, ref.symbol, [{ date: q.asOf.slice(0, 10) > today ? today : q.asOf.slice(0, 10), close: q.price }], true, provider.id);
      updated++;
    };

    for (const provider of chain) {
      if (pending.length === 0) break;
      const done = new Set<string>();
      try {
        if (provider.getQuotes) {
          const quotes = await provider.getQuotes(pending);
          otherResponses++;
          for (const ref of pending) {
            const q = quotes.get(ref.symbol.toUpperCase());
            if (q) {
              store(ref, q, provider);
              done.add(ref.symbol);
            }
          }
        } else {
          for (const ref of pending) {
            try {
              store(ref, await provider.getQuote(ref), provider);
              done.add(ref.symbol);
              otherResponses++;
            } catch (err) {
              // Fără rețea sau cheie respinsă: nu are rost să continuăm cu acest provider.
              if (isNetworkError(err)) throw err;
              otherResponses++;
              s.lastError = (err as Error).message;
              if ((err as { kind?: string }).kind === 'auth' || (err as { kind?: string }).kind === 'ratelimit') break;
            }
          }
        }
      } catch (err) {
        if (isNetworkError(err)) networkFailures++;
        else otherResponses++;
        s.lastError = (err as Error).message;
      }
      pending = pending.filter((r) => !done.has(r.symbol));
    }

    // „Offline” = am încercat și absolut toate răspunsurile au fost erori de rețea.
    const offline = networkFailures > 0 && otherResponses === 0;
    s.offline = offline;
    if (!offline) {
      await this.syncHistory(userId, chain, [...historyNeeds.values()], force);
      if (pending.length === 0) s.lastError = null;
    }

    let lastPriceUpdate = settings.lastPriceUpdate;
    if (updated > 0) {
      lastPriceUpdate = new Date().toISOString();
      setLastPriceUpdate(this.db, userId, lastPriceUpdate);
    }

    return {
      ok: !offline && pending.length === 0,
      offline,
      updated,
      failed: pending.filter((r) => r.type !== 'fx').map((r) => r.symbol),
      lastPriceUpdate,
      message: offline
        ? 'Fără conexiune la internet. Se folosesc ultimele prețuri salvate.'
        : pending.length > 0
          ? `Nu s-a găsit preț pentru: ${pending.map((r) => r.symbol).join(', ')}.`
          : undefined
    };
  }

  /** Descarcă istoricul zilnic lipsă, cu aceeași logică de rezervă între provideri. */
  private async syncHistory(
    userId: number,
    chain: PriceProvider[],
    needs: { ref: SymbolRef; from: string }[],
    force: boolean
  ): Promise<void> {
    const today = todayIso();
    const ttl = force ? HISTORY_TTL_FORCED_MS : HISTORY_TTL_MS;
    for (const { ref, from } of needs) {
      const sync = getHistorySync(this.db, userId, ref.symbol);
      let start: string;
      if (!sync || sync.fromDate > from) {
        start = from; // prima descărcare sau este nevoie de date mai vechi
      } else if (Date.now() - Date.parse(sync.fetchedAt) >= ttl) {
        start = addDays(sync.fetchedAt.slice(0, 10), -7); // doar zilele recente, cu o mică suprapunere
        if (start < from) start = from;
      } else {
        continue;
      }
      for (const provider of chain) {
        try {
          const result = await provider.getHistory(ref, start, today);
          if (result.points.length === 0 && provider !== chain[chain.length - 1]) continue;
          saveHistory(this.db, userId, ref.symbol, result.points, result.splitAdjusted, provider.id);
          setHistorySync(this.db, userId, ref.symbol, sync && sync.fromDate < from ? sync.fromDate : from, provider.id);
          break;
        } catch (err) {
          if (isNetworkError(err)) return; // conexiunea a căzut între timp; reluăm la următoarea actualizare
        }
      }
    }
  }

  /** Caută simboluri după nume sau ticker, la primul provider care răspunde. */
  async search(userId: number, query: string): Promise<SymbolSearchResult[]> {
    const q = query.trim();
    if (q.length < 1) return [];
    for (const provider of this.providerChain(userId)) {
      try {
        const results = await provider.search(q);
        if (results.length > 0) return results;
      } catch {
        // încercăm următorul provider
      }
    }
    return [];
  }

  /** Cotația unui simbol (pentru completarea automată a monedei și a prețului în formular). */
  async lookup(userId: number, symbol: string, type: AssetType): Promise<SymbolQuote | null> {
    const ref: SymbolRef = { symbol: symbol.trim().toUpperCase(), type };
    if (!ref.symbol) return null;
    for (const provider of this.providerChain(userId)) {
      try {
        const q = await provider.getQuote(ref);
        return { symbol: ref.symbol, name: q.name ?? null, price: q.price, currency: q.currency, asOf: q.asOf, provider: provider.id };
      } catch {
        // încercăm următorul provider
      }
    }
    return null;
  }
}
