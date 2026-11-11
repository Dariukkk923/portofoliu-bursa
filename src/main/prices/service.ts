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
import { BENCHMARKS } from '@shared/benchmarks';
import type { Db } from '../db/database';
import type { SecretBox } from '../secrets';
import { rowToLedgerTx } from '../services/common';
import { listAssets } from '../services/assets';
import { saveDividendEvents } from '../services/dividends';
import { getApiKey, getSettings, setLastPriceUpdate } from '../services/settings';
import { AlphaVantageProvider } from './alphavantage';
import { PolygonProvider } from './polygon';
import { TwelveDataProvider } from './twelvedata';
import { YahooProvider } from './yahoo';
import { isNetworkError, type PriceProvider, type Quote, type SymbolRef } from './provider';
import { fxSymbol, getCachedPrices, getHistorySync, getLogos, saveHistory, saveLogo, saveQuote, setHistorySync } from './store';

/** Istoricul unui simbol se reîmprospătează cel mult o dată la atâtea ore (sau la 15 minute, la cerere). */
const HISTORY_TTL_MS = 12 * 3_600_000;
const HISTORY_TTL_FORCED_MS = 15 * 60_000;
/** Câte zile de istoric se păstrează pentru graficul mic din watchlist. */
const WATCHLIST_HISTORY_DAYS = 100;
/** Logo-urile: câte se descarcă la o rulare (limitele planurilor gratuite) și când se reîncearcă. */
const LOGOS_PER_RUN = 25;
const LOGO_TTL_MS = 180 * 86_400_000;
const NO_LOGO_RETRY_MS = 30 * 86_400_000;
/** Profilul (sector, țară) se reîmprospătează rar: o dată la 90 de zile, câte cel mult 20 de active pe rulare. */
const PROFILE_TTL_MS = 90 * 86_400_000;
const PROFILES_PER_RUN = 20;
/** Dividendele se verifică o dată la 3 zile pe simbol, câte cel mult 15 simboluri pe rulare. */
const DIVIDEND_TTL_MS = 3 * 86_400_000;
const DIVIDENDS_PER_RUN = 15;

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
    for (const t of txs) if (t.assetId != null && !firstTxDate.has(t.assetId)) firstTxDate.set(t.assetId, t.date);
    // Monedele sumelor de cash (depuneri, sume raportate de broker) au nevoie și ele de curs, de la prima apariție.
    const firstCashDate = new Map<string, string>();
    for (const t of txs) {
      for (const c of [t.assetId == null ? t.currency : null, t.cashCurrency]) {
        if (c && !firstCashDate.has(c)) firstCashDate.set(c, t.date);
      }
    }
    // Cursurile se cer față de moneda de bază din setări, față de moneda fiecărui portofoliu activ și
    // față de leu (raportul fiscal convertește în lei când cursul BNR nu poate fi descărcat).
    const bases = new Set([settings.baseCurrency, 'RON']);
    for (const r of this.db.prepare('SELECT DISTINCT base_currency FROM portfolios WHERE user_id = ? AND archived = 0').all(userId) as {
      base_currency: string;
    }[]) {
      bases.add(r.base_currency);
    }
    const fxRefs = (currency: string): SymbolRef[] =>
      [...bases].filter((b) => b !== currency).map((b) => ({ symbol: fxSymbol(currency, b), type: 'fx' as const }));

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
      for (const ref of fxRefs(asset.currency)) {
        if (!quoteRefs.some((r) => r.symbol === ref.symbol)) quoteRefs.push(ref);
        needHistory(ref, first);
      }
    }

    // Instrumentele din watchlist: cotația și istoricul recent (pentru variația de azi și graficul mic).
    const watchFrom = addDays(todayIso(), -WATCHLIST_HISTORY_DAYS);
    for (const w of this.db.prepare("SELECT DISTINCT symbol, type FROM watchlist_items WHERE user_id = ? AND type <> 'bond'").all(userId) as {
      symbol: string;
      type: AssetType;
    }[]) {
      const asset = assets.find((a) => a.symbol === w.symbol);
      if (asset?.priceMode === 'manual') continue;
      const ref: SymbolRef = { symbol: w.symbol, type: w.type };
      if (!quoteRefs.some((r) => r.symbol === ref.symbol)) quoteRefs.push(ref);
      needHistory(ref, watchFrom);
    }

    // Indicii de referință (din setări și ai portofoliilor): doar istoricul zilnic, de la prima tranzacție, și cursul
    // monedei lor. Nu sunt active, deci nu primesc cotație și nu apar niciodată la „preț negăsit”.
    const firstAny = txs[0]?.date;
    if (firstAny) {
      const symbols = new Set([settings.benchmark]);
      for (const r of this.db.prepare('SELECT DISTINCT benchmark FROM portfolios WHERE user_id = ? AND archived = 0 AND benchmark IS NOT NULL').all(userId) as {
        benchmark: string;
      }[]) {
        symbols.add(r.benchmark);
      }
      for (const symbol of symbols) {
        needHistory({ symbol, type: 'etf' }, firstAny);
        const currency = BENCHMARKS.find((b) => b.symbol === symbol)?.currency;
        for (const fx of currency ? fxRefs(currency) : []) needHistory(fx, firstAny);
      }
    }

    for (const [currency, first] of firstCashDate) {
      for (const ref of fxRefs(currency)) {
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
      await this.fetchProfiles(userId, chain, assets.filter((a) => held.has(a.id)));
      await this.fetchDividends(userId, chain, assets.filter((a) => held.has(a.id)), firstTxDate);
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

  /** Sectorul și țara activelor deținute (acțiuni și ETF-uri), de la providerii care le știu; cele completate manual rămân. */
  private async fetchProfiles(userId: number, chain: PriceProvider[], held: { id: number; symbol: string; type: AssetType }[]): Promise<void> {
    const providers = chain.filter((p) => p.getProfile);
    if (providers.length === 0) return;
    const rows = new Map(
      (this.db.prepare('SELECT id, profile_source, profile_fetched_at FROM assets WHERE user_id = ?').all(userId) as {
        id: number;
        profile_source: string | null;
        profile_fetched_at: string | null;
      }[]).map((r) => [r.id, r])
    );
    const now = Date.now();
    const due = held
      .filter((a) => a.type === 'stock' || a.type === 'etf')
      .filter((a) => {
        const r = rows.get(a.id);
        if (!r || r.profile_source === 'manual') return false;
        return !r.profile_fetched_at || now - Date.parse(r.profile_fetched_at) >= PROFILE_TTL_MS;
      })
      .slice(0, PROFILES_PER_RUN);
    const save = this.db.prepare(
      "UPDATE assets SET sector = ?, country = ?, profile_source = ?, profile_fetched_at = ? WHERE id = ? AND user_id = ? AND (profile_source IS NULL OR profile_source <> 'manual')"
    );
    for (const asset of due) {
      let profile = null;
      let answered = false;
      for (const provider of providers) {
        try {
          profile = await provider.getProfile!({ symbol: asset.symbol, type: asset.type });
          answered = true;
          if (profile) break;
        } catch (err) {
          if (isNetworkError(err)) return;
        }
      }
      if (profile) save.run(profile.sector, profile.country, 'api', new Date().toISOString(), asset.id, userId);
      else if (answered) save.run(null, null, 'none', new Date().toISOString(), asset.id, userId);
    }
  }

  /**
   * Pregătește un instrument (care poate să nu fie deținut) pentru simulator și obiective: cotația
   * (pentru monedă), istoricul zilnic de la data dată, cursul monedei lui față de monedele date și,
   * la cerere, dividendele. Totul se salvează în cache. Fără internet se folosește ce există.
   */
  async prepareInstrument(
    userId: number,
    ref: SymbolRef,
    from: string,
    bases: string[],
    withDividends: boolean
  ): Promise<{ currency: string | null; offline: boolean }> {
    const chain = this.providerChain(userId);
    const symbol = ref.symbol.toUpperCase();
    const cached = getCachedPrices(this.db, userId).get(symbol);
    let currency = cached?.currency ?? null;
    let offline = false;
    if (!cached || Date.now() - Date.parse(cached.fetchedAt) > HISTORY_TTL_MS) {
      for (const provider of chain) {
        try {
          const q = await provider.getQuote({ ...ref, symbol });
          saveQuote(this.db, userId, { symbol, price: q.price, currency: q.currency, asOf: q.asOf, provider: provider.id });
          currency = q.currency ?? currency;
          break;
        } catch (err) {
          if (isNetworkError(err)) {
            offline = true;
            break;
          }
        }
      }
    }
    if (offline) return { currency, offline };
    const needs: { ref: SymbolRef; from: string }[] = [{ ref: { ...ref, symbol }, from }];
    for (const b of bases) if (currency && b !== currency) needs.push({ ref: { symbol: fxSymbol(currency, b), type: 'fx' }, from });
    await this.syncHistory(userId, chain, needs, false);
    // Cursul de azi, pentru conversie (dacă nu există deja în cache).
    const prices = getCachedPrices(this.db, userId);
    for (const n of needs.slice(1)) {
      if (prices.has(n.ref.symbol)) continue;
      for (const provider of chain) {
        try {
          const q = await provider.getQuote(n.ref);
          saveQuote(this.db, userId, { symbol: n.ref.symbol, price: q.price, currency: q.currency, asOf: q.asOf, provider: provider.id });
          break;
        } catch (err) {
          if (isNetworkError(err)) break;
        }
      }
    }
    if (withDividends && (ref.type === 'stock' || ref.type === 'etf')) {
      const sync = this.db.prepare('SELECT fetched_at FROM dividend_sync WHERE user_id = ? AND symbol = ?').get(userId, symbol) as { fetched_at: string } | undefined;
      if (!sync || Date.now() - Date.parse(sync.fetched_at) >= DIVIDEND_TTL_MS) {
        for (const provider of chain.filter((p) => p.getDividends)) {
          try {
            const list = await provider.getDividends!({ ...ref, symbol }, from);
            if (list === null) continue;
            if (list.length === 0) continue;
            saveDividendEvents(this.db, userId, symbol, list, provider.id);
            break;
          } catch (err) {
            if (isNetworkError(err)) break;
          }
        }
      }
    }
    return { currency, offline };
  }

  /**
   * Dividendele activelor deținute (acțiuni și ETF-uri), de la providerii care le oferă: primul
   * provider din lanț care are date pentru simbol. Cele introduse manual rămân neatinse.
   */
  private async fetchDividends(
    userId: number,
    chain: PriceProvider[],
    held: { id: number; symbol: string; type: AssetType }[],
    firstTxDate: Map<number, string>
  ): Promise<void> {
    const providers = chain.filter((p) => p.getDividends);
    if (providers.length === 0) return;
    const synced = new Map(
      (this.db.prepare('SELECT symbol, fetched_at FROM dividend_sync WHERE user_id = ?').all(userId) as { symbol: string; fetched_at: string }[]).map((r) => [
        r.symbol,
        r.fetched_at
      ])
    );
    const now = Date.now();
    const today = todayIso();
    const due = held
      .filter((a) => a.type === 'stock' || a.type === 'etf')
      .filter((a) => {
        const at = synced.get(a.symbol);
        return !at || now - Date.parse(at) >= DIVIDEND_TTL_MS;
      })
      .slice(0, DIVIDENDS_PER_RUN);
    for (const asset of due) {
      // Istoricul: de la prima tranzacție (cel puțin 2 ani, pentru frecvență), dar nu mai vechi de 5 ani.
      const first = firstTxDate.get(asset.id) ?? today;
      const twoYears = addDays(today, -730);
      const from = [first < twoYears ? first : twoYears, addDays(today, -1826)].sort()[1];
      let saved = false;
      let answered = false;
      for (const provider of providers) {
        try {
          const list = await provider.getDividends!({ symbol: asset.symbol, type: asset.type }, from);
          if (list === null) continue;
          answered = true;
          if (list.length === 0) continue;
          saveDividendEvents(this.db, userId, asset.symbol, list, provider.id);
          saved = true;
          break;
        } catch (err) {
          if (isNetworkError(err)) return;
        }
      }
      // Niciun provider nu are dividende pentru simbol: se notează, ca să nu se întrebe la fiecare actualizare.
      if (!saved && answered) saveDividendEvents(this.db, userId, asset.symbol, [], null);
    }
  }

  /**
   * Simbolurile al căror logo lipsește din cache sau trebuie reîmprospătat. Crypto și obligațiunile
   * nu se cer (crypto are iconițe incluse în aplicație), iar fără un provider care dă logo-uri nu se cere nimic.
   */
  logosToFetch(userId: number, refs: SymbolRef[]): SymbolRef[] {
    if (!this.providerChain(userId).some((p) => p.getLogo)) return [];
    const cached = getLogos(this.db, userId, refs.map((r) => r.symbol));
    const now = Date.now();
    return refs.filter((r) => {
      if (r.type === 'crypto' || r.type === 'bond' || r.type === 'fx') return false;
      const c = cached.get(r.symbol);
      return !c || now - Date.parse(c.fetchedAt) >= (c.dataUrl ? LOGO_TTL_MS : NO_LOGO_RETRY_MS);
    });
  }

  /**
   * Descarcă logo-urile cerute de la providerii configurați care le oferă (Twelve Data, Polygon) și le
   * salvează local. Întoarce simbolurile pentru care s-a găsit un logo nou. Fără internet se oprește și
   * reîncearcă la următoarea cerere.
   */
  async fetchLogos(userId: number, refs: SymbolRef[]): Promise<string[]> {
    const chain = this.providerChain(userId).filter((p) => p.getLogo);
    const found: string[] = [];
    if (chain.length === 0) return found;
    for (const ref of refs.slice(0, LOGOS_PER_RUN)) {
      let answered = false;
      let saved = false;
      for (const provider of chain) {
        try {
          const image = await provider.getLogo!(ref);
          answered = true;
          if (image) {
            saveLogo(this.db, userId, ref.symbol, image, provider.id);
            found.push(ref.symbol);
            saved = true;
            break;
          }
        } catch (err) {
          if (isNetworkError(err)) return found;
          // cheie respinsă sau limită depășită: încercăm următorul provider
        }
      }
      if (!saved && answered) saveLogo(this.db, userId, ref.symbol, null, 'none');
    }
    return found;
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

  /**
   * Cotațiile mai multor simboluri dintr-o singură cerere (importul din raportul
   * unui broker: confirmă simbolul, moneda și tipul fiecărui instrument nou).
   * Se folosesc doar providerii care pot răspunde în bloc, ca să nu consumăm
   * limita de cereri a planurilor gratuite. `offline` = niciun provider nu a răspuns.
   */
  async lookupMany(userId: number, symbols: string[]): Promise<{ quotes: Map<string, Quote>; offline: boolean }> {
    const quotes = new Map<string, Quote>();
    const refs: SymbolRef[] = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean).map((symbol) => ({ symbol, type: 'stock' }));
    if (refs.length === 0) return { quotes, offline: false };
    let answered = false;
    for (const provider of this.providerChain(userId)) {
      if (!provider.getQuotes) continue;
      const missing = refs.filter((r) => !quotes.has(r.symbol));
      if (missing.length === 0) break;
      try {
        for (const [symbol, quote] of await provider.getQuotes(missing)) quotes.set(symbol.toUpperCase(), quote);
        answered = true;
      } catch {
        // încercăm următorul provider
      }
    }
    return { quotes, offline: !answered };
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
