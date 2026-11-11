/**
 * Contractul dintre interfață și procesul principal.
 *
 * Interfața apelează `api.<grup>.<metodă>(...)`; apelul trece prin scriptul
 * preload ca mesaj IPC și este rezolvat de handlerul cu același nume din
 * `main/ipc.ts`. Utilizatorul curent NU este un parametru: procesul principal
 * îl ia din sesiunea proprie, deci interfața nu poate cere datele altui cont.
 */
import type {
  Asset,
  AssetType,
  AssetUpdate,
  Broker,
  CsvImportResult,
  FileResult,
  HistoryPoint,
  HistoryRange,
  PortfolioFilter,
  PortfolioOverview,
  PriceStatus,
  ProviderId,
  PurchaseInput,
  RefreshResult,
  Settings,
  SettingsUpdate,
  SymbolQuote,
  SymbolSearchResult,
  Transaction,
  TransactionFilters,
  TransactionInput,
  TransactionView,
  User
} from './types';

export interface Api {
  auth: {
    /** Utilizatorul sesiunii active (inclusiv cea restaurată prin „ține-mă minte”) sau null. */
    current(): Promise<User | null>;
    register(input: { username: string; email?: string | null; password: string }): Promise<User>;
    login(input: { username: string; password: string; remember: boolean }): Promise<User>;
    loginDemo(): Promise<User>;
    logout(): Promise<void>;
    changePassword(oldPassword: string, newPassword: string): Promise<void>;
  };
  brokers: {
    list(): Promise<Broker[]>;
    create(input: { name: string; notes?: string | null }): Promise<Broker>;
    update(id: number, input: { name: string; notes?: string | null }): Promise<Broker>;
    remove(id: number): Promise<void>;
  };
  assets: {
    list(): Promise<Asset[]>;
    update(id: number, patch: AssetUpdate): Promise<Asset>;
    remove(id: number): Promise<void>;
  };
  portfolio: {
    overview(filter: PortfolioFilter): Promise<PortfolioOverview>;
    history(range: HistoryRange, filter: PortfolioFilter): Promise<HistoryPoint[]>;
    addPurchase(input: PurchaseInput): Promise<Transaction>;
  };
  transactions: {
    list(filters: TransactionFilters): Promise<TransactionView[]>;
    create(input: TransactionInput): Promise<Transaction>;
    update(id: number, input: TransactionInput): Promise<Transaction>;
    remove(id: number): Promise<void>;
    /** Deschide dialogul de salvare și scrie fișierul CSV. */
    exportCsv(filters: TransactionFilters): Promise<FileResult>;
    /** Deschide dialogul de alegere a fișierului și importă tranzacțiile. */
    importCsv(): Promise<{ canceled: boolean; result?: CsvImportResult }>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsUpdate): Promise<Settings>;
    /** `key` gol sau null șterge cheia salvată. */
    setApiKey(provider: ProviderId, key: string | null): Promise<Settings>;
  };
  prices: {
    refresh(): Promise<RefreshResult>;
    status(): Promise<PriceStatus>;
    search(query: string): Promise<SymbolSearchResult[]>;
    lookup(symbol: string, type: AssetType): Promise<SymbolQuote | null>;
  };
  backup: {
    create(): Promise<FileResult>;
    restore(): Promise<FileResult>;
  };
  app: {
    info(): Promise<AppInfo>;
  };
}

export interface AppInfo {
  version: string;
  platform: string;
  dataPath: string;
}

/** Evenimentele trimise de procesul principal către interfață. */
export type AppEvent =
  | { type: 'prices:status'; payload: PriceStatus }
  /** Datele s-au schimbat în fundal (prețuri noi, restaurare) și ecranele trebuie reîncărcate. */
  | { type: 'data:changed' };

/** Plicul răspunsului IPC: erorile ajung în interfață ca text, nu ca excepții serializate. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const IPC_CALL = 'api:call';
export const IPC_EVENT = 'app:event';

/** Ce expune scriptul preload în `window.bridge`. */
export interface Bridge {
  call(path: string, args: unknown[]): Promise<IpcResult<unknown>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
