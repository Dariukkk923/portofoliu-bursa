/**
 * Stratul IPC: leagă apelurile din interfață de servicii.
 *
 * Aici se ține sesiunea curentă. Fiecare handler (în afară de cele de
 * autentificare) trece prin `uid()`, care aruncă eroare dacă nu există un
 * utilizator autentificat, și transmite serviciilor id-ul din sesiune — nu
 * unul primit de la interfață. Așa se garantează izolarea datelor pe utilizator.
 */
import type { EarningsSnap } from '@shared/alerts';
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { IPC_CALL, IPC_EVENT, type Api, type AppEvent, type IpcResult } from '@shared/api';
import type { AlertEventView, RefreshResult, User } from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import type { Db } from './db/database';
import type { SecretBox } from './secrets';
import { AppError } from './services/common';
import * as auth from './services/auth';
import * as brokers from './services/brokers';
import * as assets from './services/assets';
import * as transactions from './services/transactions';
import * as portfolio from './services/portfolio';
import * as portfolios from './services/portfolios';
import { moveTransactions, positionTransactionIds, previewMove } from './services/portfolioMove';
import * as settings from './services/settings';
import { exportTransactionsCsv, importTransactionsCsv, looksLikeTransactionsCsv } from './services/csvio';
import { createBackup, restoreBackup } from './services/backup';
import type { AppInfo } from '@shared/api';
import * as imports from './services/statementImport';
import * as watchlist from './services/watchlist';
import { getRiskReport } from './services/risk';
import * as dividends from './services/dividends';
import * as journal from './services/journal';
import * as goals from './services/goals';
import * as alerts from './services/alerts';
import { runSimulation, simulationStart } from './services/simulator';
import { simInstrumentType } from '@shared/simulator';
import { prepareTaxReport, taxReportCsv, taxReportHtml } from './services/taxReport';
import { ensureDemoAccount } from './services/demo';
import { PriceService } from './prices/service';
import { getLogos } from './prices/store';
import type { SymbolRef } from './prices/provider';
import { looksLikeZip } from './xlsx';
import { getNews } from './services/news';
import { earningsSnapshots, getEarningsCalendar, getFinancials, latestReportDates, upcomingReports } from './services/financials';
import { researchSymbols } from './services/research';
import { createResearchSources } from './research/sources';

export interface IpcContext {
  db: Db;
  secrets: SecretBox;
  dataDir: string;
  getWindow: () => BrowserWindow | null;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * Ce diferă între desktop (Electron) și web (PWA): fișiere, notificări, tokenul de sesiune, backup.
 * Restul backendului (serviciile, prețurile, sesiunea) este același cod pe ambele.
 */
export interface Platform {
  /** Salvează un fișier (dialog pe desktop, descărcare/partajare pe web). Întoarce calea sau numele, sau null dacă s-a renunțat. */
  saveFile(title: string, defaultName: string, filters: FileFilter[], data: string | Uint8Array): Promise<string | null>;
  /** Salvează un document HTML ca PDF (desktop) sau îl deschide la tipărire (web). */
  savePdf(title: string, defaultName: string, html: string): Promise<string | null>;
  openFile(title: string, filters: FileFilter[]): Promise<{ name: string; data: Uint8Array } | null>;
  notify(event: AlertEventView, sound: boolean): void;
  readToken(): string | null;
  writeToken(token: string | null): void;
  createBackup(db: Db, userId: number): { data: Uint8Array; transactions: number };
  restoreBackup(db: Db, userId: number, data: Uint8Array): { brokers: number; assets: number; transactions: number };
  info(): AppInfo;
  /** Deschide o adresă https în browserul sistemului (pe web, pagina o deschide deja în gestul utilizatorului). */
  openExternal(url: string): Promise<void>;
  /** Web: deblochează cheia pentru secretele utilizatorului (parola, sau null la reluarea sesiunii salvate). */
  unlockSecrets?(userId: number, password: string | null, remember: boolean): Promise<void>;
  /** Web: șterge cheia din memorie și din dispozitiv la ieșirea din cont. */
  lockSecrets?(): void;
  /** Web: pregătește criptarea unei chei API (criptarea din Web Crypto este asincronă). */
  sealSecret?(plain: string): Promise<void>;
  /** Web: recriptează secretele după schimbarea parolei. */
  changeSecretsPassword?(userId: number, oldPassword: string, newPassword: string): Promise<void>;
  /** Web: ține minte data ultimului backup salvat. */
  onBackupSaved?(): void;
}

export interface BackendContext {
  db: Db;
  secrets: SecretBox;
  platform: Platform;
  send: (event: AppEvent) => void;
}

export interface Backend {
  dispatch(path: unknown, args: unknown): Promise<IpcResult<unknown>>;
  dispose(): void;
}

export function createBackend(ctx: BackendContext): Backend {
  const { db, secrets, platform, send } = ctx;

  let currentUserId: number | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  /** Extrasul citit la previzualizare, păstrat până la import (unul singur, al utilizatorului curent). */
  let pendingImport: imports.ImportSession | null = null;

  const prices = new PriceService({
    db,
    secrets,
    onStatus: (userId, status) => {
      if (userId === currentUserId) send({ type: 'prices:status', payload: status });
    }
  });

  /** Id-ul utilizatorului autentificat; fără sesiune, apelul este respins. */
  const uid = (): number => {
    if (currentUserId === null) throw new AppError('Sesiunea a expirat. Autentifică-te din nou.');
    return currentUserId;
  };

  // --- actualizarea automată a prețurilor ---------------------------------

  /** Evaluează alertele utilizatorului și anunță declanșările (notificare nativă + eveniment către interfață). */
  /** Ultimele date despre raportări, per utilizator; se reîncarcă după fiecare actualizare de prețuri. */
  const earningsCache = new Map<number, Map<string, EarningsSnap>>();
  const warmEarnings = async (userId: number): Promise<void> => {
    const sources = createResearchSources(db, secrets, userId);
    const [next, last] = await Promise.all([upcomingReports(db, userId, sources, { withinDays: 60 }), latestReportDates(db, userId, sources)]);
    earningsCache.set(userId, earningsSnapshots(next, last));
  };

  const runAlerts = (userId: number): void => {
    try {
      const snaps = earningsCache.get(userId);
      alerts.registerEarningsSource(snaps ? (symbol) => snaps.get(symbol) ?? null : null);
      const fired = alerts.evaluateAlerts(db, userId);
      if (fired.length === 0 || userId !== currentUserId) return;
      for (const { event, sound } of fired) platform.notify(event, sound);
      send({ type: 'alerts:triggered', payload: fired.map((f) => f.event) });
    } catch (err) {
      // Alertele nu au voie să strice actualizarea prețurilor.
      console.error('[ipc] evaluarea alertelor a eșuat:', err);
    }
  };

  const refreshPrices = async (force: boolean): Promise<RefreshResult> => {
    const userId = uid();
    const result = await prices.refresh(userId, { force });
    // Alertele se evaluează după fiecare actualizare de prețuri, cât timp aplicația rulează.
    runAlerts(userId);
    // Calendarul de raportări vine din rețea (cu cache); alertele de rezultate se reevaluează după.
    void warmEarnings(userId)
      .then(() => runAlerts(userId))
      .catch((err) => console.warn('[ipc] calendarul de raportări nu s-a încărcat:', err instanceof Error ? err.message : err));
    if (userId === currentUserId) send({ type: 'data:changed' });
    return result;
  };

  const stopAutoRefresh = (): void => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  };

  /** (Re)pornește temporizatorul conform intervalului din setări și face o primă actualizare. */
  const startAutoRefresh = (): void => {
    stopAutoRefresh();
    if (currentUserId === null) return;
    const minutes = settings.getSettings(db, currentUserId).refreshIntervalMin;
    void refreshPrices(false).catch(() => undefined);
    if (minutes > 0) {
      refreshTimer = setInterval(() => void refreshPrices(false).catch(() => undefined), minutes * 60_000);
    }
  };

  // --- sesiune ------------------------------------------------------------

  const readToken = (): string | null => platform.readToken();

  const clearToken = (): void => {
    const token = readToken();
    if (token) auth.revokeToken(db, token);
    platform.writeToken(null);
  };

  const openSession = (user: User, remember: boolean): User => {
    clearToken();
    currentUserId = user.id;
    if (remember) platform.writeToken(auth.createRememberToken(db, user.id));
    startAutoRefresh();
    return user;
  };

  const closeSession = (): void => {
    pendingImport = null;
    stopAutoRefresh();
    clearToken();
    platform.lockSecrets?.();
    currentUserId = null;
  };

  /**
   * Logo-urile lipsă se descarcă în fundal, câte un rând pe utilizator; la final interfața
   * primește simbolurile cu logo nou și le reafișează.
   */
  const logoQueue = new Map<number, { pending: Map<string, SymbolRef>; running: boolean }>();
  const queueLogos = (userId: number, refs: SymbolRef[]): void => {
    let q = logoQueue.get(userId);
    if (!q) {
      q = { pending: new Map(), running: false };
      logoQueue.set(userId, q);
    }
    for (const r of refs) q.pending.set(r.symbol, r);
    if (q.running) return;
    const queue = q;
    queue.running = true;
    void (async () => {
      try {
        while (queue.pending.size > 0) {
          const batch = [...queue.pending.values()];
          queue.pending.clear();
          const found = await prices.fetchLogos(userId, batch);
          if (found.length > 0 && userId === currentUserId) send({ type: 'logos:changed', payload: found });
          if (batch.length > 0 && found.length === 0) break; // fără rezultate (offline sau fără logo-uri): reîncercăm la următoarea cerere
        }
      } catch {
        // logo-urile sunt opționale: o eroare nu afectează restul aplicației
      } finally {
        queue.running = false;
      }
    })();
  };

  /** Extrasul citit, dacă este al utilizatorului curent și tokenul se potrivește. */
  const pendingSession = (token: string): imports.ImportSession => {
    if (!pendingImport || pendingImport.token !== token || pendingImport.userId !== uid()) {
      throw new AppError('Fișierul nu mai este disponibil. Alege-l din nou.');
    }
    return pendingImport;
  };

  /** Verificarea simbolurilor noi la furnizorul de prețuri (doar simbolurile, nimic din extras). */
  const lookup = (userId: number): imports.ImportLookup => ({
    quotes: (symbols) => prices.lookupMany(userId, symbols),
    search: (query) => prices.search(userId, query)
  });

  // --- handlere -----------------------------------------------------------

  const api: Api = {
    auth: {
      async current() {
        if (currentUserId !== null) return auth.getUser(db, currentUserId);
        // Nicio sesiune în memorie: încercăm tokenul „ține-mă minte” salvat pe disc.
        const token = readToken();
        const user = token ? auth.userFromToken(db, token) : null;
        if (!user) return null;
        await platform.unlockSecrets?.(user.id, null, true);
        currentUserId = user.id;
        startAutoRefresh();
        return user;
      },
      async register(input) {
        const user = await auth.register(db, input);
        await platform.unlockSecrets?.(user.id, input.password, false);
        return openSession(user, false);
      },
      async login(input) {
        const user = await auth.verifyLogin(db, input.username, input.password);
        await platform.unlockSecrets?.(user.id, input.password, !!input.remember);
        return openSession(user, !!input.remember);
      },
      async loginDemo() {
        return openSession(await ensureDemoAccount(db), false);
      },
      async logout() {
        closeSession();
      },
      async changePassword(oldPassword, newPassword) {
        await auth.changePassword(db, uid(), oldPassword, newPassword);
        await platform.changeSecretsPassword?.(uid(), oldPassword, newPassword);
        // Toate sesiunile salvate au fost invalidate; cea curentă rămâne deschisă până la ieșire.
        platform.writeToken(null);
      }
    },
    brokers: {
      list: async () => brokers.listBrokers(db, uid()),
      create: async (input) => brokers.createBroker(db, uid(), input),
      update: async (id, input) => brokers.updateBroker(db, uid(), id, input),
      remove: async (id) => brokers.deleteBroker(db, uid(), id)
    },
    portfolios: {
      list: async () => portfolios.listPortfolios(db, uid()),
      async create(input) {
        const p = portfolios.createPortfolio(db, uid(), input);
        void refreshPrices(false).catch(() => undefined); // o monedă de bază nouă are nevoie de cursuri
        return p;
      },
      async update(id, input) {
        const p = portfolios.updatePortfolio(db, uid(), id, input);
        void refreshPrices(false).catch(() => undefined);
        return p;
      },
      archive: async (id, archived) => portfolios.setPortfolioArchived(db, uid(), id, !!archived),
      remove: async (id) => portfolios.deletePortfolio(db, uid(), id),
      duplicate: async (id, name) => portfolios.duplicatePortfolio(db, uid(), id, name),
      reorder: async (ids) => portfolios.reorderPortfolios(db, uid(), Array.isArray(ids) ? ids.map(Number) : []),
      compare: async () => portfolio.comparePortfolios(db, uid())
    },
    watchlists: {
      list: async () => watchlist.listWatchlists(db, uid()),
      create: async (name) => watchlist.createWatchlist(db, uid(), name),
      rename: async (id, name) => watchlist.renameWatchlist(db, uid(), Number(id), name),
      remove: async (id) => watchlist.deleteWatchlist(db, uid(), Number(id)),
      reorder: async (ids) => watchlist.reorderWatchlists(db, uid(), Array.isArray(ids) ? ids.map(Number) : []),
      items: async (watchlistId) => watchlist.listWatchlistItems(db, uid(), Number(watchlistId)),
      async addItem(watchlistId, input) {
        const item = watchlist.addWatchlistItem(db, uid(), Number(watchlistId), input);
        // Simbolul nou are nevoie de cotație și de istoricul recent: le aducem în fundal.
        void refreshPrices(false).catch(() => undefined);
        return item;
      },
      updateItem: async (id, patch) => watchlist.updateWatchlistItem(db, uid(), Number(id), patch ?? {}),
      removeItem: async (id) => watchlist.removeWatchlistItem(db, uid(), Number(id)),
      reorderItems: async (watchlistId, ids) => watchlist.reorderWatchlistItems(db, uid(), Number(watchlistId), Array.isArray(ids) ? ids.map(Number) : [])
    },
    logos: {
      async get(requests) {
        const userId = uid();
        const refs = (Array.isArray(requests) ? requests : [])
          .slice(0, 300)
          .map((r) => ({ symbol: assets.normalizeSymbol(r?.symbol), type: r?.type }))
          .filter((r): r is { symbol: string; type: 'stock' | 'etf' | 'bond' | 'crypto' } => /^[A-Z0-9.\-=^_/]{1,24}$/.test(r.symbol) && ['stock', 'etf', 'bond', 'crypto'].includes(r.type as string));
        const cached = getLogos(db, userId, refs.map((r) => r.symbol));
        const out: Record<string, string | null> = {};
        for (const r of refs) out[r.symbol] = cached.get(r.symbol)?.dataUrl ?? null;
        const missing = prices.logosToFetch(userId, refs);
        if (missing.length > 0) queueLogos(userId, missing);
        return out;
      }
    },
    assets: {
      list: async () => assets.listAssets(db, uid()),
      update: async (id, patch) => assets.updateAsset(db, uid(), id, patch),
      remove: async (id) => assets.deleteAsset(db, uid(), id)
    },
    portfolio: {
      overview: async (filter) => portfolio.getOverview(db, uid(), filter ?? {}),
      history: async (range, filter) => portfolio.getHistory(db, uid(), range, filter ?? {}),
      performance: async (range, filter) => portfolio.getPerformance(db, uid(), range, filter ?? {}),
      periodProfit: async (range, filter) => portfolio.getPeriodProfit(db, uid(), range, filter ?? {}),
      risk: async (range, filter) => getRiskReport(db, uid(), range, filter ?? {}),
      async addPurchase(input) {
        const { transaction } = transactions.addPurchase(db, uid(), input);
        // Un activ nou are nevoie de preț și de istoric: le aducem în fundal.
        void refreshPrices(false).catch(() => undefined);
        return transaction;
      }
    },
    dividends: {
      calendar: async (year, filter) => dividends.getDividendCalendar(db, uid(), Number(year), filter ?? {}),
      addManual: async (input) => dividends.addManualDividend(db, uid(), input),
      removeManual: async (id) => dividends.deleteManualDividend(db, uid(), Number(id)),
      dismiss: async (assetId, exDate) => dividends.dismissDividend(db, uid(), Number(assetId), String(exDate))
    },
    simulator: {
      async run(request) {
        const userId = uid();
        const start = simulationStart(db, userId, request);
        const base = portfolios.resolveScope(db, userId, request.filter?.portfolioId).baseCurrency;
        const symbol = String(request.symbol).trim().toUpperCase();
        await prices.prepareInstrument(userId, { symbol, type: simInstrumentType(symbol) }, addDays(start, -10), [base], !!request.includeDividends);
        return runSimulation(db, userId, request);
      }
    },
    goals: {
      async list() {
        const userId = uid();
        // Istoricul lung al indicilor de referință (pentru randamentul pe termen lung), descărcat o singură dată.
        for (const symbol of goals.goalBenchmarks(db, userId)) {
          await prices.prepareInstrument(userId, { symbol, type: 'etf' }, goals.LONG_HISTORY_FROM, [], false).catch(() => undefined);
        }
        return goals.listGoals(db, userId);
      },
      create: async (input) => goals.createGoal(db, uid(), input),
      update: async (id, input) => goals.updateGoal(db, uid(), Number(id), input),
      remove: async (id) => goals.deleteGoal(db, uid(), Number(id))
    },
    journal: {
      list: async (filters) => journal.listJournal(db, uid(), filters ?? {}),
      create: async (input) => journal.createJournalEntry(db, uid(), input),
      update: async (id, input) => journal.updateJournalEntry(db, uid(), Number(id), input),
      remove: async (id) => journal.deleteJournalEntry(db, uid(), Number(id)),
      markReviewed: async (id, next) => journal.markJournalReviewed(db, uid(), Number(id), next == null ? null : Number(next)),
      planFor: async (portfolioId, assetId) => journal.journalPlanFor(db, uid(), portfolioId == null ? null : Number(portfolioId), Number(assetId)),
      dueCount: async () => journal.journalDueCount(db, uid()),
      async exportCsv(filters) {
        const userId = uid();
        const list = journal.listJournal(db, userId, filters ?? {});
        const path = await platform.saveFile('Exportă jurnalul (CSV)', `jurnal-${todayIso()}.csv`, [{ name: 'CSV', extensions: ['csv'] }], journal.journalCsv(list));
        if (!path) return { canceled: true };
        return { canceled: false, path, count: list.entries.length };
      },
      async exportPdf(filters) {
        const userId = uid();
        const list = journal.listJournal(db, userId, filters ?? {});
        const path = await platform.savePdf('Salvează jurnalul (PDF)', `jurnal-${todayIso()}.pdf`, journal.journalHtml(list, 'Jurnal de investiții'));
        if (!path) return { canceled: true };
        return { canceled: false, path, count: list.entries.length };
      }
    },
    tax: {
      report: async (year, portfolioId) => prepareTaxReport(db, uid(), Number(year), portfolioId == null ? null : Number(portfolioId)),
      async exportCsv(year, portfolioId) {
        const userId = uid();
        const report = await prepareTaxReport(db, userId, Number(year), portfolioId == null ? null : Number(portfolioId));
        const path = await platform.saveFile('Exportă raportul fiscal (CSV)', `raport-fiscal-${report.year}.csv`, [{ name: 'CSV', extensions: ['csv'] }], taxReportCsv(report));
        if (!path) return { canceled: true };
        return { canceled: false, path, count: report.details.length };
      },
      async exportPdf(year, portfolioId) {
        const userId = uid();
        const report = await prepareTaxReport(db, userId, Number(year), portfolioId == null ? null : Number(portfolioId));
        const path = await platform.savePdf('Salvează raportul fiscal (PDF)', `raport-fiscal-${report.year}.pdf`, taxReportHtml(report));
        if (!path) return { canceled: true };
        return { canceled: false, path, count: report.details.length };
      }
    },
    transactions: {
      list: async (filters) => transactions.listTransactions(db, uid(), filters ?? {}),
      async create(input) {
        const tx = transactions.createTransaction(db, uid(), input);
        if (tx.type === 'split') void refreshPrices(false).catch(() => undefined);
        return tx;
      },
      async update(id, input) {
        const tx = transactions.updateTransaction(db, uid(), id, input);
        void refreshPrices(false).catch(() => undefined);
        return tx;
      },
      remove: async (id) => transactions.deleteTransaction(db, uid(), id),
      previewMove: async (ids, portfolioId) => previewMove(db, uid(), Array.isArray(ids) ? ids.map(Number) : [], Number(portfolioId)),
      move: async (ids, portfolioId, options) =>
        moveTransactions(db, uid(), Array.isArray(ids) ? ids.map(Number) : [], Number(portfolioId), { moveCash: !!options?.moveCash }),
      positionIds: async (portfolioId, assetId, brokerId) => positionTransactionIds(db, uid(), Number(portfolioId), Number(assetId), Number(brokerId)),
      async exportCsv(filters) {
        const userId = uid();
        const { csv, count } = exportTransactionsCsv(db, userId, filters ?? {});
        const path = await platform.saveFile('Exportă tranzacțiile', `tranzactii-${todayIso()}.csv`, [{ name: 'CSV', extensions: ['csv'] }], csv);
        if (!path) return { canceled: true };
        return { canceled: false, path, count };
      }
    },
    settings: {
      get: async () => settings.getSettings(db, uid()),
      async update(patch) {
        const next = settings.updateSettings(db, uid(), patch);
        // Intervalul, providerul sau moneda de bază s-au putut schimba: repornim actualizarea.
        if (patch.refreshIntervalMin !== undefined || patch.primaryProvider !== undefined || patch.baseCurrency !== undefined) {
          startAutoRefresh();
        }
        return next;
      },
      async setApiKey(provider, key) {
        if (key && key.trim()) await platform.sealSecret?.(key.trim());
        settings.setApiKey(db, secrets, uid(), provider, key);
        return settings.getSettings(db, uid());
      }
    },
    prices: {
      refresh: async () => refreshPrices(true),
      status: async () => prices.status(uid()),
      search: async (query) => prices.search(uid(), String(query ?? '')),
      lookup: async (symbol, type) => prices.lookup(uid(), String(symbol ?? ''), type)
    },
    imports: {
      async open(options) {
        const userId = uid();
        const file = await platform.openFile('Alege extrasul de importat', [
          { name: 'Extras de la broker (Excel sau CSV)', extensions: ['xlsx', 'csv', 'txt', 'tsv'] }
        ]);
        if (!file) return { canceled: true };
        // Fișierul este citit local; nu este trimis nicăieri și nu este păstrat după import.
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
        const fileName = file.name;

        // Un CSV exportat din aplicație (pagina Tranzacții) se importă direct, ca lot.
        if (!looksLikeZip(data)) {
          const text = data.toString('utf8');
          if (looksLikeTransactionsCsv(text)) {
            const csv = importTransactionsCsv(db, userId, text, fileName);
            if (csv.imported > 0) void refreshPrices(false).catch(() => undefined);
            return { canceled: false, csv };
          }
        }

        const tables = imports.readImportFile(data);
        const session = imports.openImport(db, userId, tables, fileName, randomBytes(16).toString('hex'));
        pendingImport = session;
        return { canceled: false, session: await imports.previewImport(db, userId, session, options ?? {}, lookup(userId)) };
      },
      async preview(token, options) {
        return imports.previewImport(db, uid(), pendingSession(token), options ?? {}, lookup(uid()));
      },
      async apply(token, options) {
        const userId = uid();
        const result = imports.applyImport(db, userId, pendingSession(token), options ?? {});
        pendingImport = null;
        // Instrumentele noi au nevoie de prețuri și de istoric: le aducem în fundal.
        if (result.imported > 0) void refreshPrices(false).catch(() => undefined);
        return result;
      },
      async discard(token) {
        if (pendingImport?.token === token) pendingImport = null;
      },
      batches: async () => imports.listImportBatches(db, uid()),
      async undo(batchId) {
        const res = imports.undoImport(db, uid(), Number(batchId));
        void refreshPrices(false).catch(() => undefined);
        return res;
      },
      templates: async () => imports.listImportTemplates(db, uid()),
      deleteTemplate: async (id) => imports.deleteImportTemplate(db, uid(), Number(id))
    },
    alerts: {
      list: async (portfolioId) => alerts.listAlerts(db, uid(), portfolioId == null ? null : Number(portfolioId)),
      async create(input) {
        const userId = uid();
        const created = alerts.createAlert(db, userId, input);
        runAlerts(userId); // dacă condiția e deja îndeplinită, anunțul vine imediat
        return alerts.getAlert(db, userId, created.id);
      },
      async update(id, input) {
        const userId = uid();
        alerts.updateAlert(db, userId, Number(id), input);
        runAlerts(userId);
        return alerts.getAlert(db, userId, Number(id));
      },
      async setEnabled(id, enabled) {
        const userId = uid();
        alerts.setAlertEnabled(db, userId, Number(id), !!enabled);
        if (enabled) runAlerts(userId);
        return alerts.getAlert(db, userId, Number(id));
      },
      snooze: async (id, minutes) => alerts.snoozeAlert(db, uid(), Number(id), minutes == null ? null : Number(minutes)),
      remove: async (id) => alerts.deleteAlert(db, uid(), Number(id)),
      async fromJournal(entryId) {
        const userId = uid();
        const created = alerts.createAlertFromJournal(db, userId, Number(entryId));
        runAlerts(userId);
        return alerts.getAlert(db, userId, created.id);
      },
      symbols: async () => alerts.listAlertSymbols(db, uid()),
      center: async () => alerts.listAlertEvents(db, uid()),
      async markRead(ids) {
        const userId = uid();
        alerts.markAlertEventsRead(db, userId, ids == null ? null : ids.map(Number));
        return alerts.listAlertEvents(db, userId);
      },
      async clearHistory() {
        const userId = uid();
        alerts.clearAlertEvents(db, userId);
        return alerts.listAlertEvents(db, userId);
      }
    },
    backup: {
      async create() {
        const userId = uid();
        const { data, transactions: count } = platform.createBackup(db, userId);
        const path = await platform.saveFile('Salvează backup-ul', `portofoliu-backup-${todayIso()}.db`, [
          { name: 'Backup Portofoliu Bursa', extensions: ['db'] }
        ], data);
        if (!path) return { canceled: true };
        platform.onBackupSaved?.();
        return { canceled: false, path, count };
      },
      async restore() {
        const userId = uid();
        const file = await platform.openFile('Restaurează din backup', [{ name: 'Backup Portofoliu Bursa', extensions: ['db'] }]);
        if (!file) return { canceled: true };
        const counts = platform.restoreBackup(db, userId, file.data);
        startAutoRefresh();
        send({ type: 'data:changed' });
        return { canceled: false, path: file.name, count: counts.transactions };
      }
    },
    app: {
      info: async () => platform.info()
    },
    news: {
      symbols: async () => researchSymbols(db, uid()),
      async list(filter) {
        const userId = uid();
        return getNews(db, userId, filter ?? {}, createResearchSources(db, secrets, userId));
      },
      async open(url) {
        // Doar adrese https: alte scheme (file:, javascript:, http:) nu se deschid niciodată.
        let parsed: URL;
        try {
          parsed = new URL(String(url));
        } catch {
          throw new AppError('Adresa articolului nu este validă.');
        }
        if (parsed.protocol !== 'https:') throw new AppError('Se deschid doar adrese https.');
        await platform.openExternal(parsed.toString());
      }
    },
    financials: {
      async get(symbol, type, force) {
        const userId = uid();
        return getFinancials(db, userId, String(symbol ?? ''), type, createResearchSources(db, secrets, userId), { force: !!force });
      },
      async calendar(filter) {
        const userId = uid();
        return getEarningsCalendar(db, userId, filter ?? {}, createResearchSources(db, secrets, userId));
      }
    }
  };

  // Un singur canal: „grup.metodă” + argumente. Căile necunoscute sunt respinse.
  const dispatch: Backend['dispatch'] = async (path, args) => {
    try {
      const [group, method] = String(path).split('.');
      const target = (api as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[group];
      const fn = target && Object.hasOwn(target, method) ? target[method] : undefined;
      if (typeof fn !== 'function') throw new AppError('Operațiune necunoscută.');
      return { ok: true, data: await fn(...(Array.isArray(args) ? args : [])) };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, error: err.message };
      console.error(`[ipc] ${String(path)} a eșuat:`, err);
      return { ok: false, error: 'A apărut o eroare neașteptată. Încearcă din nou.' };
    }
  };

  return { dispatch, dispose: stopAutoRefresh };
}

// --- partea de desktop (Electron) -----------------------------------------

function electronPlatform(ctx: IpcContext): Platform {
  const { secrets } = ctx;
  /** Fișierul în care stă (criptat) tokenul „ține-mă minte”. */
  const tokenFile = join(ctx.dataDir, 'session.bin');

  const saveDialog = async (title: string, defaultName: string, filters: Electron.FileFilter[]): Promise<string | null> => {
    const win = ctx.getWindow();
    const options = { title, defaultPath: join(app.getPath('documents'), defaultName), filters };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    return res.canceled || !res.filePath ? null : res.filePath;
  };

  const openDialog = async (title: string, filters: Electron.FileFilter[]): Promise<string | null> => {
    const win = ctx.getWindow();
    const options: Electron.OpenDialogOptions = { title, filters, properties: ['openFile'] };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  };

  /** Tipărește un document HTML ca PDF, într-o fereastră ascunsă, fără scripturi și fără acces la rețea. */
  const htmlToPdf = async (html: string): Promise<Buffer> => {
    const dir = mkdtempSync(join(tmpdir(), 'portofoliu-raport-'));
    const file = join(dir, 'raport.html');
    writeFileSync(file, html, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, partition: 'raport-pdf' } });
    try {
      // Sesiune separată (nu cea a aplicației): orice cerere în rețea a documentului este blocată.
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
      await win.loadFile(file);
      return await win.webContents.printToPDF({
        landscape: true,
        pageSize: 'A4',
        printBackground: true,
        margins: { top: 0.45, bottom: 0.5, left: 0.4, right: 0.4 },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          '<div style="font-size:8px;width:100%;text-align:center;color:#8a90a0;font-family:Segoe UI,Arial"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
      });
    } finally {
      win.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    openExternal: (url) => shell.openExternal(url),
    async saveFile(title, defaultName, filters, data) {
      const path = await saveDialog(title, defaultName, filters);
      if (!path) return null;
      if (typeof data === 'string') writeFileSync(path, data, 'utf8');
      else writeFileSync(path, data);
      return path;
    },
    async savePdf(title, defaultName, html) {
      const path = await saveDialog(title, defaultName, [{ name: 'PDF', extensions: ['pdf'] }]);
      if (!path) return null;
      writeFileSync(path, await htmlToPdf(html));
      return path;
    },
    async openFile(title, filters) {
      const path = await openDialog(title, filters);
      return path ? { name: basename(path), data: readFileSync(path) } : null;
    },
    notify(event, sound) {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: event.title, body: event.note ? event.body + '\n' + event.note : event.body, silent: !sound });
      n.on('click', () => {
        const win = ctx.getWindow();
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
    },
    readToken() {
      try {
        return existsSync(tokenFile) ? secrets.decrypt(readFileSync(tokenFile, 'utf8')) : null;
      } catch {
        return null;
      }
    },
    writeToken(token) {
      if (token === null) rmSync(tokenFile, { force: true });
      else writeFileSync(tokenFile, secrets.encrypt(token), { mode: 0o600 });
    },
    createBackup(db, userId) {
      const dir = mkdtempSync(join(tmpdir(), 'portofoliu-backup-'));
      try {
        const file = join(dir, 'backup.db');
        const { transactions } = createBackup(db, userId, file);
        return { data: readFileSync(file), transactions };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    restoreBackup(db, userId, data) {
      const dir = mkdtempSync(join(tmpdir(), 'portofoliu-restore-src-'));
      try {
        const file = join(dir, 'backup.db');
        writeFileSync(file, data);
        return restoreBackup(db, userId, file);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    info: () => ({ version: app.getVersion(), platform: process.platform, dataPath: ctx.dataDir })
  };
}

export function registerIpc(ctx: IpcContext): { dispose: () => void } {
  const backend = createBackend({
    db: ctx.db,
    secrets: ctx.secrets,
    platform: electronPlatform(ctx),
    send: (event) => {
      const win = ctx.getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT, event);
    }
  });
  ipcMain.handle(IPC_CALL, (_event, path: unknown, args: unknown) => backend.dispatch(path, args));
  return {
    dispose: () => {
      backend.dispose();
      ipcMain.removeHandler(IPC_CALL);
    }
  };
}
