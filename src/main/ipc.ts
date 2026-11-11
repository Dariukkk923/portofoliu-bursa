/**
 * Stratul IPC: leagă apelurile din interfață de servicii.
 *
 * Aici se ține sesiunea curentă. Fiecare handler (în afară de cele de
 * autentificare) trece prin `uid()`, care aruncă eroare dacă nu există un
 * utilizator autentificat, și transmite serviciilor id-ul din sesiune — nu
 * unul primit de la interfață. Așa se garantează izolarea datelor pe utilizator.
 */
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CALL, IPC_EVENT, type Api, type AppEvent, type IpcResult } from '@shared/api';
import type { RefreshResult, User } from '@shared/types';
import { todayIso } from '@shared/dates';
import type { Db } from './db/database';
import type { SecretBox } from './secrets';
import { AppError } from './services/common';
import * as auth from './services/auth';
import * as brokers from './services/brokers';
import * as assets from './services/assets';
import * as transactions from './services/transactions';
import * as portfolio from './services/portfolio';
import * as settings from './services/settings';
import { exportTransactionsCsv, importTransactionsCsv } from './services/csvio';
import { createBackup, restoreBackup } from './services/backup';
import { ensureDemoAccount } from './services/demo';
import { PriceService } from './prices/service';

export interface IpcContext {
  db: Db;
  secrets: SecretBox;
  dataDir: string;
  getWindow: () => BrowserWindow | null;
}

export function registerIpc(ctx: IpcContext): { dispose: () => void } {
  const { db, secrets } = ctx;
  /** Fișierul în care stă (criptat) tokenul „ține-mă minte”. */
  const tokenFile = join(ctx.dataDir, 'session.bin');

  let currentUserId: number | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;

  const send = (event: AppEvent): void => {
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT, event);
  };

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

  const refreshPrices = async (force: boolean): Promise<RefreshResult> => {
    const userId = uid();
    const result = await prices.refresh(userId, { force });
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

  const readToken = (): string | null => {
    try {
      return existsSync(tokenFile) ? secrets.decrypt(readFileSync(tokenFile, 'utf8')) : null;
    } catch {
      return null;
    }
  };

  const clearToken = (): void => {
    const token = readToken();
    if (token) auth.revokeToken(db, token);
    rmSync(tokenFile, { force: true });
  };

  const openSession = (user: User, remember: boolean): User => {
    clearToken();
    currentUserId = user.id;
    if (remember) {
      writeFileSync(tokenFile, secrets.encrypt(auth.createRememberToken(db, user.id)), { mode: 0o600 });
    }
    startAutoRefresh();
    return user;
  };

  const closeSession = (): void => {
    stopAutoRefresh();
    clearToken();
    currentUserId = null;
  };

  // --- dialoguri de fișier ------------------------------------------------

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

  // --- handlere -----------------------------------------------------------

  const api: Api = {
    auth: {
      async current() {
        if (currentUserId !== null) return auth.getUser(db, currentUserId);
        // Nicio sesiune în memorie: încercăm tokenul „ține-mă minte” salvat pe disc.
        const token = readToken();
        const user = token ? auth.userFromToken(db, token) : null;
        if (!user) return null;
        currentUserId = user.id;
        startAutoRefresh();
        return user;
      },
      async register(input) {
        const user = await auth.register(db, input);
        return openSession(user, false);
      },
      async login(input) {
        const user = await auth.verifyLogin(db, input.username, input.password);
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
        // Toate sesiunile salvate au fost invalidate; cea curentă rămâne deschisă până la ieșire.
        rmSync(tokenFile, { force: true });
      }
    },
    brokers: {
      list: async () => brokers.listBrokers(db, uid()),
      create: async (input) => brokers.createBroker(db, uid(), input),
      update: async (id, input) => brokers.updateBroker(db, uid(), id, input),
      remove: async (id) => brokers.deleteBroker(db, uid(), id)
    },
    assets: {
      list: async () => assets.listAssets(db, uid()),
      update: async (id, patch) => assets.updateAsset(db, uid(), id, patch),
      remove: async (id) => assets.deleteAsset(db, uid(), id)
    },
    portfolio: {
      overview: async (filter) => portfolio.getOverview(db, uid(), filter ?? {}),
      history: async (range, filter) => portfolio.getHistory(db, uid(), range, filter ?? {}),
      async addPurchase(input) {
        const { transaction } = transactions.addPurchase(db, uid(), input);
        // Un activ nou are nevoie de preț și de istoric: le aducem în fundal.
        void refreshPrices(false).catch(() => undefined);
        return transaction;
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
      async exportCsv(filters) {
        const userId = uid();
        const path = await saveDialog('Exportă tranzacțiile', `tranzactii-${todayIso()}.csv`, [{ name: 'CSV', extensions: ['csv'] }]);
        if (!path) return { canceled: true };
        const { csv, count } = exportTransactionsCsv(db, userId, filters ?? {});
        writeFileSync(path, csv, 'utf8');
        return { canceled: false, path, count };
      },
      async importCsv() {
        const userId = uid();
        const path = await openDialog('Importă tranzacții din CSV', [{ name: 'CSV', extensions: ['csv', 'txt'] }]);
        if (!path) return { canceled: true };
        const result = importTransactionsCsv(db, userId, readFileSync(path, 'utf8'));
        if (result.imported > 0) void refreshPrices(false).catch(() => undefined);
        return { canceled: false, result };
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
    backup: {
      async create() {
        const userId = uid();
        const path = await saveDialog('Salvează backup-ul', `portofoliu-backup-${todayIso()}.db`, [
          { name: 'Backup Portofoliu Bursa', extensions: ['db'] }
        ]);
        if (!path) return { canceled: true };
        const { transactions: count } = createBackup(db, userId, path);
        return { canceled: false, path, count };
      },
      async restore() {
        const userId = uid();
        const path = await openDialog('Restaurează din backup', [{ name: 'Backup Portofoliu Bursa', extensions: ['db'] }]);
        if (!path) return { canceled: true };
        const counts = restoreBackup(db, userId, path);
        startAutoRefresh();
        send({ type: 'data:changed' });
        return { canceled: false, path, count: counts.transactions };
      }
    },
    app: {
      info: async () => ({ version: app.getVersion(), platform: process.platform, dataPath: ctx.dataDir })
    }
  };

  // Un singur canal IPC: „grup.metodă” + argumente. Căile necunoscute sunt respinse.
  ipcMain.handle(IPC_CALL, async (_event, path: unknown, args: unknown): Promise<IpcResult<unknown>> => {
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
  });

  return {
    dispose: () => {
      stopAutoRefresh();
      ipcMain.removeHandler(IPC_CALL);
    }
  };
}
