/**
 * Contractul dintre interfață și procesul principal.
 *
 * Interfața apelează `api.<grup>.<metodă>(...)`; apelul trece prin scriptul
 * preload ca mesaj IPC și este rezolvat de handlerul cu același nume din
 * `main/ipc.ts`. Utilizatorul curent NU este un parametru: procesul principal
 * îl ia din sesiunea proprie, deci interfața nu poate cere datele altui cont.
 */
import type {
  AlertCenter,
  AlertEventView,
  AlertInput,
  AlertSymbol,
  AlertView,
  Asset,
  AssetType,
  AssetUpdate,
  Broker,
  BrokerInput,
  CsvImportResult,
  DividendCalendar,
  FileResult,
  Goal,
  GoalInput,
  GoalView,
  HistoryPoint,
  HistoryRange,
  ImportBatchView,
  ImportOptions,
  ImportResult,
  ImportSessionView,
  ImportTemplate,
  JournalEntry,
  JournalEntryInput,
  JournalFilters,
  JournalList,
  LogoRequest,
  ManualDividendInput,
  MoveOptions,
  MovePreview,
  MoveResult,
  PerformanceData,
  PeriodProfit,
  Portfolio,
  PortfolioComparison,
  PortfolioInput,
  PortfolioFilter,
  PortfolioOverview,
  PriceStatus,
  ProviderId,
  PurchaseInput,
  RiskReport,
  SimulationRequest,
  SimulationResult,
  RefreshResult,
  Settings,
  SettingsUpdate,
  SymbolQuote,
  SymbolSearchResult,
  TaxReport,
  Transaction,
  TransactionFilters,
  TransactionInput,
  TransactionView,
  User,
  Watchlist,
  WatchlistItemInput,
  WatchlistItemUpdate,
  WatchlistItemView,
  CompanyFinancials,
  EarningsCalendar,
  NewsFeed,
  NewsFilter,
  ResearchSymbol
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
    create(input: BrokerInput): Promise<Broker>;
    update(id: number, input: BrokerInput): Promise<Broker>;
    remove(id: number): Promise<void>;
  };
  portfolios: {
    /** Toate portofoliile, inclusiv cele arhivate (la final). */
    list(): Promise<Portfolio[]>;
    create(input: PortfolioInput): Promise<Portfolio>;
    update(id: number, input: PortfolioInput): Promise<Portfolio>;
    archive(id: number, archived: boolean): Promise<Portfolio>;
    /** Șterge portofoliul cu toate tranzacțiile lui. */
    remove(id: number): Promise<void>;
    duplicate(id: number, name?: string): Promise<Portfolio>;
    reorder(ids: number[]): Promise<void>;
    /** Portofoliile active unul lângă altul: valoare, profit, randament și risc. */
    compare(): Promise<PortfolioComparison[]>;
  };
  watchlists: {
    /** Listele utilizatorului (la prima folosire se creează lista „De urmărit”). */
    list(): Promise<Watchlist[]>;
    create(name: string): Promise<Watchlist>;
    rename(id: number, name: string): Promise<Watchlist>;
    /** Șterge lista cu tot ce conține (cel puțin o listă rămâne). */
    remove(id: number): Promise<void>;
    reorder(ids: number[]): Promise<void>;
    items(watchlistId: number): Promise<WatchlistItemView[]>;
    addItem(watchlistId: number, input: WatchlistItemInput): Promise<WatchlistItemView>;
    updateItem(id: number, patch: WatchlistItemUpdate): Promise<WatchlistItemView>;
    removeItem(id: number): Promise<void>;
    reorderItems(watchlistId: number, ids: number[]): Promise<void>;
  };
  logos: {
    /**
     * Logo-urile salvate local, ca „data URL” (null = încă nu există). Cele lipsă se descarcă în fundal
     * de la providerii configurați care oferă logo-uri, iar la final vine evenimentul `logos:changed`.
     */
    get(requests: LogoRequest[]): Promise<Record<string, string | null>>;
  };
  assets: {
    list(): Promise<Asset[]>;
    update(id: number, patch: AssetUpdate): Promise<Asset>;
    remove(id: number): Promise<void>;
  };
  portfolio: {
    overview(filter: PortfolioFilter): Promise<PortfolioOverview>;
    history(range: HistoryRange, filter: PortfolioFilter): Promise<HistoryPoint[]>;
    /** Randamentul TWR și XIRR pe interval, plus totalul depus net de la început. */
    performance(range: HistoryRange, filter: PortfolioFilter): Promise<PerformanceData>;
    /** Profitul realizat și variația celui nerealizat pe perioada aleasă. */
    periodProfit(range: HistoryRange, filter: PortfolioFilter): Promise<PeriodProfit>;
    /** Ecranul „Risc”: concentrare, expuneri, volatilitate, scădere maximă, beta, scor de diversificare. */
    risk(range: HistoryRange, filter: PortfolioFilter): Promise<RiskReport>;
    addPurchase(input: PurchaseInput): Promise<Transaction>;
  };
  dividends: {
    /** Calendarul anului ales: dividende încasate, anunțate, estimate și cupoane; venitul pe luni; propuneri; randamente. */
    calendar(year: number, filter: PortfolioFilter): Promise<DividendCalendar>;
    addManual(input: ManualDividendInput): Promise<void>;
    removeManual(id: number): Promise<void>;
    /** „Nu l-am primit”: dividendul propus nu se mai propune. */
    dismiss(assetId: number, exDate: string): Promise<void>;
  };
  simulator: {
    /** Descarcă (dacă lipsesc) istoricul, cursul și dividendele instrumentului, apoi face simularea. */
    run(request: SimulationRequest): Promise<SimulationResult>;
  };
  goals: {
    /** Obiectivele cu datele proiecției (valoarea actuală, contribuția medie, randamentul și volatilitatea). */
    list(): Promise<GoalView[]>;
    create(input: GoalInput): Promise<Goal>;
    update(id: number, input: GoalInput): Promise<Goal>;
    remove(id: number): Promise<void>;
  };
  journal: {
    /** Cronologia (cele mai noi întâi), cu filtre; include vânzările care au un plan anterior. */
    list(filters: JournalFilters): Promise<JournalList>;
    create(input: JournalEntryInput): Promise<JournalEntry>;
    update(id: number, input: JournalEntryInput): Promise<JournalEntry>;
    remove(id: number): Promise<void>;
    /** Teza a fost revizuită; opțional, următoarea revizuire peste câteva luni. */
    markReviewed(id: number, nextInMonths: number | null): Promise<JournalEntry>;
    /** Planul în vigoare pentru o poziție (afișat la vânzare). */
    planFor(portfolioId: number | null, assetId: number): Promise<JournalEntry | null>;
    /** Câte teze sunt de revizuit acum. */
    dueCount(): Promise<number>;
    exportCsv(filters: JournalFilters): Promise<FileResult>;
    exportPdf(filters: JournalFilters): Promise<FileResult>;
  };
  tax: {
    /** Raportul anual (descarcă întâi cursurile BNR lipsă). `portfolioId` null = toate portofoliile, inclusiv cele arhivate. */
    report(year: number, portfolioId: number | null): Promise<TaxReport>;
    /** Deschide dialogul de salvare și scrie detalierea ca CSV. */
    exportCsv(year: number, portfolioId: number | null): Promise<FileResult>;
    /** Deschide dialogul de salvare și scrie raportul ca PDF. */
    exportPdf(year: number, portfolioId: number | null): Promise<FileResult>;
  };
  transactions: {
    list(filters: TransactionFilters): Promise<TransactionView[]>;
    create(input: TransactionInput): Promise<Transaction>;
    update(id: number, input: TransactionInput): Promise<Transaction>;
    remove(id: number): Promise<void>;
    /** Ce s-ar întâmpla la mutarea tranzacțiilor în alt portofoliu (pentru confirmare). */
    previewMove(ids: number[], portfolioId: number): Promise<MovePreview>;
    move(ids: number[], portfolioId: number, options: MoveOptions): Promise<MoveResult>;
    /** Tranzacțiile unei poziții (activ + broker) dintr-un portofoliu, pentru mutarea ei întregi. */
    positionIds(portfolioId: number, assetId: number, brokerId: number): Promise<number[]>;
    /** Deschide dialogul de salvare și scrie fișierul CSV. */
    exportCsv(filters: TransactionFilters): Promise<FileResult>;
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
  imports: {
    /**
     * Deschide dialogul de alegere a fișierului (CSV sau Excel) și îi recunoaște formatul după structură:
     *  - extrasul unui broker cunoscut (XTB, Trading 212, Revolut, Interactive Brokers): întoarce
     *    `session` cu previzualizarea, fără să salveze nimic — urmează `apply`;
     *  - orice alt tabel: `session` cu coloanele și maparea propusă (sau din șablonul salvat);
     *  - un CSV exportat din această aplicație: îl importă direct și întoarce `csv`.
     * Aplicația nu se conectează la contul de la broker: lucrează doar cu fișierul ales, local.
     */
    open(options?: ImportOptions): Promise<{ canceled: boolean; session?: ImportSessionView; csv?: CsvImportResult }>;
    /** Recalculează previzualizarea cu opțiunile alese (portofoliu, broker, mapare, simboluri). */
    preview(token: string, options: ImportOptions): Promise<ImportSessionView>;
    /** Salvează tranzacțiile noi ca un lot (care poate fi anulat). */
    apply(token: string, options: ImportOptions): Promise<ImportResult>;
    /** Abandonează fișierul citit. */
    discard(token: string): Promise<void>;
    batches(): Promise<ImportBatchView[]>;
    /** Anulează complet un import. */
    undo(batchId: number): Promise<{ removed: number; restored: number }>;
    templates(): Promise<ImportTemplate[]>;
    deleteTemplate(id: number): Promise<void>;
  };
  alerts: {
    /** Alertele utilizatorului (ale portofoliului ales și cele fără portofoliu). */
    list(portfolioId: number | null): Promise<AlertView[]>;
    create(input: AlertInput): Promise<AlertView>;
    update(id: number, input: AlertInput): Promise<AlertView>;
    setEnabled(id: number, enabled: boolean): Promise<AlertView>;
    /** Amână alerta cu atâtea minute; null anulează amânarea. */
    snooze(id: number, minutes: number | null): Promise<AlertView>;
    remove(id: number): Promise<void>;
    /** Dintr-o intrare din jurnal: alertă pe ținta de profit și stop-loss ale planului. */
    fromJournal(entryId: number): Promise<AlertView>;
    /** Simbolurile din portofoliu și watchlist, pentru alegerea din formular. */
    symbols(): Promise<AlertSymbol[]>;
    /** Centrul de notificări: ultimele declanșări și numărul celor necitite. */
    center(): Promise<AlertCenter>;
    /** Marchează ca citite notificările date; null = toate. */
    markRead(ids: number[] | null): Promise<AlertCenter>;
    clearHistory(): Promise<AlertCenter>;
  };
  backup: {
    create(): Promise<FileResult>;
    restore(): Promise<FileResult>;
  };
  app: {
    info(): Promise<AppInfo>;
  };
  news: {
    /** Simbolurile pentru care există știri: activele deținute și cele din watchlist. */
    symbols(): Promise<ResearchSymbol[]>;
    /** Știrile (din cache dacă sunt proaspete; altfel descărcate; la eșec, din cache, cu `stale`). */
    list(filter: NewsFilter): Promise<NewsFeed>;
    /** Deschide un articol (doar https) în browserul sistemului. */
    open(url: string): Promise<void>;
  };
  financials: {
    /** Raportările unei companii; ETF-urile, obligațiunile și crypto întorc `supported: false`, nu eroare. */
    get(symbol: string, type: AssetType, force?: boolean): Promise<CompanyFinancials>;
    /** Când raportează fiecare companie din filtru. */
    calendar(filter: NewsFilter): Promise<EarningsCalendar>;
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
  | { type: 'data:changed' }
  /** Au sosit logo-uri noi pentru simbolurile date. */
  | { type: 'logos:changed'; payload: string[] }
  /** Au sunat alerte noi (centrul de notificări trebuie reîncărcat). */
  | { type: 'alerts:triggered'; payload: AlertEventView[] };

/** Plicul răspunsului IPC: erorile ajung în interfață ca text, nu ca excepții serializate. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const IPC_CALL = 'api:call';
export const IPC_EVENT = 'app:event';

/** Ce expune scriptul preload în `window.bridge`. */
export interface Bridge {
  call(path: string, args: unknown[]): Promise<IpcResult<unknown>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
