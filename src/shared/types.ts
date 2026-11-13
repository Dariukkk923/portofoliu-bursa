/**
 * Tipuri comune procesului principal (Electron/Node) și interfeței (React).
 * Tot ce traversează IPC este descris aici.
 */

import type { StatementKind } from './import/statement';
import type { ColumnMapping } from './import/mapping';

export type AssetType = 'stock' | 'etf' | 'bond' | 'crypto';
/**
 * Tipurile de tranzacții. Primele cinci privesc un activ; celelalte mută doar bani
 * la un broker: depunere, retragere, comision general, dobândă la cash, ajustare de sold.
 */
export type TransactionType = 'buy' | 'sell' | 'dividend' | 'coupon' | 'split' | 'deposit' | 'withdrawal' | 'fee' | 'interest' | 'adjustment';
export type CostMethod = 'AVG' | 'FIFO';
export type ProviderId = 'yahoo' | 'alphavantage' | 'twelvedata' | 'polygon';
export type Theme = 'light' | 'dark' | 'system';
export type PriceMode = 'auto' | 'manual';
export type HistoryRange = '1M' | '3M' | '6M' | '1Y' | 'ALL';

export const ASSET_TYPES: AssetType[] = ['stock', 'etf', 'bond', 'crypto'];
export const TRANSACTION_TYPES: TransactionType[] = ['buy', 'sell', 'dividend', 'coupon', 'split', 'deposit', 'withdrawal', 'fee', 'interest', 'adjustment'];
/** Tranzacțiile care privesc un activ. */
export const ASSET_TRANSACTION_TYPES: TransactionType[] = ['buy', 'sell', 'dividend', 'coupon', 'split'];
/** Tranzacțiile de cash (fără activ, cu excepția comisioanelor, care pot privi un activ). */
export const CASH_TRANSACTION_TYPES: TransactionType[] = ['deposit', 'withdrawal', 'fee', 'interest', 'adjustment'];
export const PROVIDER_IDS: ProviderId[] = ['yahoo', 'alphavantage', 'twelvedata', 'polygon'];
/** Lista unică a monedelor acceptate; pentru una nouă se adaugă și un curs aproximativ în prices/store.ts. */
export const CURRENCIES = ['RON', 'EUR', 'USD', 'GBP', 'CHF', 'PLN', 'SEK', 'DKK', 'NOK'] as const;
/** Monede în care poate fi exprimat totalul portofoliului. */
export const BASE_CURRENCIES = ['RON', 'EUR', 'USD', 'GBP'] as const;
/** Monede acceptate pentru un activ (prețul lui de tranzacționare). */
export const ASSET_CURRENCIES = CURRENCIES;
export const REFRESH_INTERVALS = [0, 1, 5, 15, 30, 60] as const;

/** Culorile și iconițele din care se alege aspectul unui portofoliu. */
export const PORTFOLIO_COLORS = ['blue', 'green', 'violet', 'amber', 'rose', 'teal', 'orange', 'slate'] as const;
export type PortfolioColor = (typeof PORTFOLIO_COLORS)[number];
export const PORTFOLIO_ICONS = ['wallet', 'piggy-bank', 'trending-up', 'bitcoin', 'landmark', 'briefcase', 'rocket', 'shield', 'graduation-cap', 'house'] as const;
export type PortfolioIcon = (typeof PORTFOLIO_ICONS)[number];

/** Un portofoliu: un grup de tranzacții cu evidență separată (cost, cash, randament). */
export interface Portfolio {
  id: number;
  name: string;
  color: PortfolioColor;
  icon: PortfolioIcon;
  /** Moneda în care se afișează totalurile portofoliului. */
  baseCurrency: string;
  /** Indicele de referință (ex.: ^GSPC); null = cel implicit. */
  benchmark: string | null;
  /** Arhivat: nu mai apare în selector și nici în vederea „Toate portofoliile”, dar datele rămân. */
  archived: boolean;
  sortOrder: number;
  createdAt: string;
  transactionCount?: number;
}

export interface PortfolioInput {
  name: string;
  color?: PortfolioColor;
  icon?: PortfolioIcon;
  baseCurrency?: string;
  benchmark?: string | null;
}

/** Portofoliul selectat: unul anume sau toate, combinate. */
export type PortfolioScope = number | 'all';

export interface User {
  id: number;
  username: string;
  email: string | null;
  isDemo: boolean;
  createdAt: string;
}

/** Unde își are sediul brokerul, pentru raportul fiscal: în România (impozitul se reține la sursă) sau în străinătate. */
export type BrokerResidence = 'ro' | 'foreign';

export interface Broker {
  id: number;
  name: string;
  notes: string | null;
  residence: BrokerResidence;
  createdAt: string;
  /** Numărul de tranzacții legate de broker (un broker folosit nu poate fi șters). */
  transactionCount?: number;
}

export interface Asset {
  id: number;
  type: AssetType;
  symbol: string;
  name: string;
  currency: string;
  /** Doar pentru obligațiuni. */
  faceValue: number | null;
  /** Rata anuală a cuponului, în procente (ex.: 7.2). */
  couponRate: number | null;
  /** Numărul de cupoane pe an (1, 2, 4 sau 12). */
  couponFrequency: number | null;
  maturityDate: string | null;
  /** „auto” = preț din API (cu rezervă pe prețul manual); „manual” = doar preț introdus de utilizator. */
  priceMode: PriceMode;
  manualPrice: number | null;
  manualPriceDate: string | null;
  /** Codul ISIN, dacă a venit dintr-un extras (ajută la recunoașterea instrumentului la alt broker). */
  isin: string | null;
  /** Sectorul (sau categoria, la ETF-uri) și țara: de la provider sau completate manual. */
  sector: string | null;
  country: string | null;
  /** „api” = de la provider, „manual” = completate de utilizator (nu se mai suprascriu). */
  profileSource: 'api' | 'manual' | 'none' | null;
  createdAt: string;
}

export interface Transaction {
  id: number;
  /** Portofoliul tranzacției; null doar la split-uri (se aplică în toate portofoliile). */
  portfolioId: number | null;
  /** Null la tranzacțiile de cash fără activ (depuneri, retrageri, dobânzi, ajustări). */
  assetId: number | null;
  /** Null doar la split-urile care se aplică la toți brokerii. */
  brokerId: number | null;
  type: TransactionType;
  /** Data în format AAAA-LL-ZZ. */
  date: string;
  quantity: number;
  /** Preț pe unitate; la obligațiuni este procent din valoarea nominală. */
  price: number;
  fee: number;
  currency: string;
  /**
   * Dividende/cupoane/dobânzi: suma brută, impozitul reținut și suma netă.
   * Depuneri, retrageri, comisioane, ajustări: suma este în `netAmount` (la ajustări poate fi negativă).
   */
  grossAmount: number;
  taxWithheld: number;
  netAmount: number;
  /** Split „4:1” => splitNumerator = 4, splitDenominator = 1. */
  splitNumerator: number | null;
  splitDenominator: number | null;
  notes: string | null;
  /** Suma debitată/creditată efectiv de broker (cu semn), dacă apare în extras, și moneda ei. */
  cashAmount: number | null;
  cashCurrency: string | null;
  /** Identificatorul operațiunii în extrasul brokerului (tranzacțiile importate). */
  externalId: string | null;
  /** Lotul de import din care provine tranzacția (null = introdusă manual). */
  batchId: number | null;
  createdAt: string;
}

/** Tranzacție îmbogățită cu datele activului și ale brokerului, pentru tabel. */
export interface TransactionView extends Transaction {
  /** Null la tranzacțiile de cash fără activ. */
  symbol: string | null;
  assetName: string | null;
  assetType: AssetType | null;
  brokerName: string | null;
  portfolioName: string | null;
}

export interface TransactionFilters {
  /** null sau lipsă = toate portofoliile active. */
  portfolioId?: number | null;
  type?: TransactionType | null;
  assetType?: AssetType | null;
  symbol?: string | null;
  brokerId?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

/** Datele activului trimise la crearea lui (împreună cu prima achiziție sau la import). */
export interface AssetInput {
  type: AssetType;
  symbol: string;
  name?: string;
  currency: string;
  faceValue?: number | null;
  couponRate?: number | null;
  couponFrequency?: number | null;
  maturityDate?: string | null;
  priceMode?: PriceMode;
  manualPrice?: number | null;
  /** Sectorul / categoria și țara, completate manual (gol = înapoi la datele de la provider). */
  sector?: string | null;
  country?: string | null;
}

/** Câmpurile unui activ care pot fi modificate după creare. */
export interface AssetUpdate {
  name?: string;
  faceValue?: number | null;
  couponRate?: number | null;
  couponFrequency?: number | null;
  maturityDate?: string | null;
  priceMode?: PriceMode;
  manualPrice?: number | null;
  /** Sectorul / categoria și țara, completate manual (gol = înapoi la datele de la provider). */
  sector?: string | null;
  country?: string | null;
}

/** Formularul „Adaugă activ”: activul + achiziția care devine tranzacție de tip Cumpărare. */
export interface PurchaseInput {
  /** Portofoliul în care intră; lipsă = portofoliul activ. */
  portfolioId?: number | null;
  asset: AssetInput;
  brokerId: number;
  date: string;
  quantity: number;
  price: number;
  fee: number;
  notes?: string | null;
}

export interface TransactionInput {
  /** Portofoliul tranzacției (lipsă = portofoliul activ); ignorat la split-uri. */
  portfolioId?: number | null;
  /** Null la depuneri, retrageri, dobânzi, ajustări și comisioanele generale. */
  assetId: number | null;
  brokerId: number | null;
  type: TransactionType;
  date: string;
  /** Moneda sumei, la tranzacțiile de cash (la cele cu activ se folosește moneda activului). */
  currency?: string | null;
  /** Suma unei depuneri, retrageri, a unui comision sau a unei ajustări (ajustarea poate fi negativă). */
  amount?: number;
  quantity?: number;
  price?: number;
  fee?: number;
  grossAmount?: number;
  taxWithheld?: number;
  netAmount?: number;
  splitNumerator?: number | null;
  splitDenominator?: number | null;
  notes?: string | null;
}

export interface Settings {
  baseCurrency: string;
  costMethod: CostMethod;
  theme: Theme;
  primaryProvider: ProviderId;
  /** Minute între actualizări automate; 0 = doar manual. */
  refreshIntervalMin: number;
  lastPriceUpdate: string | null;
  /** Ultimul portofoliu selectat (sau „all”), ca aplicația să pornească tot pe el. */
  activePortfolio: PortfolioScope;
  /** Indicele de referință implicit (ex.: ^GSPC); fiecare portofoliu îl poate schimba pe al lui. */
  benchmark: string;
  /** Pragul de concentrare pe o singură poziție, pentru ecranul Risc (0,2 = 20%). */
  concentrationLimit: number;
  /** Pentru fiecare provider: dacă există o cheie salvată și ultimele ei caractere (cheia nu părăsește procesul principal). */
  apiKeys: Record<ProviderId, { configured: boolean; hint: string | null }>;
}

export interface SettingsUpdate {
  baseCurrency?: string;
  costMethod?: CostMethod;
  theme?: Theme;
  primaryProvider?: ProviderId;
  refreshIntervalMin?: number;
  activePortfolio?: PortfolioScope;
  benchmark?: string;
  concentrationLimit?: number;
}

/** De unde provine prețul folosit la evaluare. */
export type PriceSource = 'api' | 'manual' | 'cost';

/** O poziție evaluată: fie pe (activ, broker), fie agregată pe activ (brokerId = null). */
export interface PositionView {
  key: string;
  /** Portofoliul poziției; null la liniile agregate din mai multe portofolii. */
  portfolioId: number | null;
  portfolioName: string | null;
  assetId: number;
  brokerId: number | null;
  brokerName: string | null;
  symbol: string;
  name: string;
  assetType: AssetType;
  currency: string;
  quantity: number;
  /** Preț mediu de achiziție (procent din nominal la obligațiuni). */
  avgPrice: number;
  price: number | null;
  priceSource: PriceSource;
  priceAsOf: string | null;
  costBasis: number;
  marketValue: number;
  /** Profitul nerealizat în moneda activului (doar din preț). */
  unrealizedPnl: number;
  unrealizedPct: number | null;
  /** Profit realizat din vânzări (fără dividende/cupoane). */
  realizedPnl: number;
  /** Dividende și cupoane nete încasate. */
  income: number;
  /** Total cumpărat vreodată (inclusiv comisioane). */
  totalBought: number;
  /** Cursul monedei activului față de moneda de bază. */
  fxRate: number;
  marketValueBase: number;
  /** Costul în moneda de bază, la cursul din ziua fiecărei cumpărări. */
  costBasisBase: number;
  /** Profitul nerealizat în moneda de bază (preț + curs valutar) și procentul lui. */
  unrealizedBase: number;
  unrealizedBasePct: number | null;
  /** Partea din profitul nerealizat datorată prețului, respectiv cursului valutar. */
  pricePnlBase: number;
  fxPnlBase: number;
  realizedBase: number;
  incomeBase: number;
  totalBoughtBase: number;
  /** Prețul la care poziția iese pe zero (cu tot cu comisioanele), în moneda activului, la cursul de azi. */
  breakEvenPrice: number | null;
  /** Pozițiile pe minus: creșterea de preț necesară ca să recuperezi (ex.: 0,25 = +25%). */
  recoveryPct: number | null;
}

export interface PortfolioTotals {
  baseCurrency: string;
  /** Valoarea totală: active + cash neinvestit. */
  totalValue: number;
  /** Valoarea activelor deținute. */
  holdingsValue: number;
  /** Cash neinvestit la brokerii la care se urmărește cash-ul. */
  cash: number;
  totalCost: number;
  unrealized: number;
  unrealizedPct: number | null;
  /** Profitul nerealizat împărțit în: din preț și din curs valutar. */
  pricePnl: number;
  fxPnl: number;
  /** Doar pozițiile pe plus: totalul câștigurilor nerealizate, procentul și numărul lor. */
  unrealizedGains: number;
  unrealizedGainsPct: number | null;
  gainingPositions: number;
  /** Doar pozițiile pe minus: totalul pierderilor nerealizate (negativ), procentul și numărul lor. */
  unrealizedLosses: number;
  unrealizedLossesPct: number | null;
  losingPositions: number;
  /** Profit realizat din vânzări. */
  realizedSales: number;
  /** Dividende + cupoane nete (+ dobânzi la cash − comisioane generale). */
  income: number;
  /** realizedSales + income. */
  realized: number;
  /** realized + unrealized. */
  totalPnl: number;
  /** Suma tuturor cumpărărilor (inclusiv comisioane). */
  totalInvested: number;
  /** totalPnl / totalInvested. */
  returnPct: number | null;
}

export interface AllocationSlice {
  key: string;
  label: string;
  value: number;
  pct: number;
}

/** Soldul de cash al unui broker într-o monedă. */
export interface CashBalanceView {
  portfolioId: number | null;
  portfolioName: string | null;
  brokerId: number;
  brokerName: string;
  currency: string;
  amount: number;
  /** În moneda de bază, la cursul de azi. */
  amountBase: number;
}

export interface PortfolioOverview {
  totals: PortfolioTotals;
  /** Cash-ul neinvestit, pe broker și monedă (doar la brokerii cu depuneri/retrageri înregistrate). */
  cashBalances: CashBalanceView[];
  /** Brokerii cu tranzacții, dar fără depuneri înregistrate (cash-ul lor nu se urmărește). */
  untrackedCashBrokers: string[];
  /** Poziții deschise pe (activ, broker). */
  positions: PositionView[];
  /** Poziții deschise agregate pe activ. */
  aggregated: PositionView[];
  /** Poziții închise (cantitate 0) care au profit realizat sau venituri, agregate pe activ. */
  closed: PositionView[];
  allocationByType: AllocationSlice[];
  allocationByBroker: AllocationSlice[];
  allocationByAsset: AllocationSlice[];
  topGainers: PositionView[];
  topLosers: PositionView[];
  lastPriceUpdate: string | null;
  /** Simboluri fără niciun preț disponibil, evaluate la cost. */
  missingPrices: string[];
  /** True dacă pentru cel puțin o monedă s-a folosit un curs aproximativ (niciun curs salvat). */
  approximateFx: boolean;
}

/** Un punct din graficul de randament: valoarea (active + cash) și randamentul TWR cumulat de la începutul intervalului. */
export interface PerformancePointView {
  date: string;
  value: number;
  twr: number;
  /** Randamentul indicelui de referință de la începutul intervalului (null fără date). */
  benchmark: number | null;
}

export interface PerformanceData {
  range: HistoryRange;
  baseCurrency: string;
  points: PerformancePointView[];
  /** Randamentul ponderat în timp (TWR) pe interval și anualizat (doar pentru intervale de cel puțin un an). */
  twr: number | null;
  twrAnnualized: number | null;
  /** Randamentul ponderat cu banii (XIRR), anual. */
  xirr: number | null;
  startValue: number;
  endValue: number;
  /** Bani intrați net în interval (depuneri − retrageri, sau cumpărări − încasări unde cash-ul nu se urmărește). */
  netFlows: number;
  /** De la prima tranzacție: total depus net, valoarea actuală și diferența (cât au adus investițiile). */
  allTime: { netContributions: number; currentValue: number; gain: number };
  /** True dacă cel puțin un broker are depuneri/retrageri înregistrate. */
  cashTracked: boolean;
  /**
   * Indicele de referință folosit (ex.: ^GSPC), convertit în moneda portofoliului la cursul fiecărei zile:
   * randamentul lui de la `from` (prima zi cu date în interval) și randamentul portofoliului pe aceeași perioadă.
   */
  benchmark: { symbol: string; name: string; currency: string; from: string | null; return: number | null; portfolioReturn: number | null } | null;
}

export interface PortfolioFilter {
  /** Un portofoliu anume; null sau lipsă = toate portofoliile active, combinate (în moneda de bază din setări). */
  portfolioId?: number | null;
  brokerId?: number | null;
  assetType?: AssetType | null;
}

export interface HistoryPoint {
  date: string;
  value: number;
  invested: number;
}

export interface RefreshResult {
  ok: boolean;
  /** True când niciun provider nu a putut fi contactat (fără internet). */
  offline: boolean;
  updated: number;
  failed: string[];
  lastPriceUpdate: string | null;
  message?: string;
}

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  exchange: string | null;
  type: AssetType | null;
  currency: string | null;
}

export interface SymbolQuote {
  symbol: string;
  name: string | null;
  price: number;
  currency: string | null;
  asOf: string;
  provider: ProviderId;
}

export interface CsvImportResult {
  imported: number;
  errors: { line: number; message: string }[];
  createdAssets: number;
  createdBrokers: number;
}

/* ------------------------------------------------ import din extrasele brokerilor */

/** Opțiunile importului, alese pe ecranul de previzualizare. */
export interface ImportOptions {
  /** Portofoliul în care intră tranzacțiile (lipsă = cel selectat). */
  portfolioId?: number | null;
  /** Un broker existent sau, dacă lipsește, numele unuia nou. */
  brokerId?: number | null;
  brokerName?: string | null;
  /**
   * Răspunsurile pentru instrumente: cheia instrumentului din fișier -> simbolul din aplicație
   * (ex.: „VWCE.DE”); textul gol înseamnă „nu importa acest instrument”. Se țin minte.
   */
  symbols?: Record<string, string>;
  /** Înlocuiește tranzacțiile introduse manual la broker pentru instrumentele din fișier. */
  replaceManual?: boolean;
  /** Doar la importul universal: maparea coloanelor și numele șablonului sub care se salvează. */
  mapping?: ColumnMapping | null;
  templateName?: string | null;
}

export type ImportRowStatus = 'new' | 'duplicate' | 'error' | 'warning' | 'skipped';

export interface ImportPreviewRow {
  line: number;
  kind: StatementKind;
  date: string;
  /** Simbolul din aplicație și cel din fișier. */
  symbol: string | null;
  brokerSymbol: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fee: number | null;
  tax: number | null;
  currency: string | null;
  status: ImportRowStatus;
  message: string | null;
}

export interface ImportInstrument {
  /** Cheia instrumentului în fișier (simbolul brokerului sau ISIN-ul). */
  key: string;
  brokerSymbol: string | null;
  isin: string | null;
  name: string | null;
  /** Activul din aplicație (existent sau propus). */
  symbol: string;
  currency: string;
  assetType: AssetType;
  /**
   * existing = există deja în aplicație; confirmed = găsit la furnizorul de prețuri; unconfirmed = nu a
   * fost găsit (utilizatorul e întrebat); skipped = ignorat la cerere; incomplete = istoric fără cumpărările de la început.
   */
  status: 'existing' | 'confirmed' | 'unconfirmed' | 'skipped' | 'incomplete';
  rows: number;
}

export interface ImportPreview {
  fileName: string;
  format: string;
  formatLabel: string;
  brokerId: number | null;
  brokerName: string;
  portfolioId: number;
  accountCurrency: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  counts: Record<ImportRowStatus, number>;
  /** Tranzacțiile noi, pe tip. */
  byKind: Partial<Record<StatementKind, number>>;
  rows: ImportPreviewRow[];
  instruments: ImportInstrument[];
  /** Tranzacții introduse manual la broker, în portofoliu, pentru instrumentele din fișier. */
  manualCount: number;
  ignored: { label: string; count: number }[];
  warnings: string[];
  /** Simbolurile nu au putut fi verificate (fără internet). */
  offline: boolean;
}

/** La importul universal: coloanele fișierului și maparea propusă (sau din șablon). */
export interface ImportMappingInfo {
  headers: string[];
  keys: string[];
  /** Primele rânduri, ca text, pentru a recunoaște coloanele. */
  sample: string[][];
  mapping: ColumnMapping;
  typeValues: { value: string; key: string; count: number; kind: StatementKind | 'ignore' | null }[];
  templateId: number | null;
  templateName: string | null;
}

export interface ImportSessionView {
  token: string;
  fileName: string;
  mapping: ImportMappingInfo | null;
  /** Lipsește la importul universal până la alegerea mapării. */
  preview: ImportPreview | null;
}

export interface ImportResult {
  batchId: number | null;
  brokerName: string;
  portfolioName: string;
  imported: number;
  byKind: Partial<Record<StatementKind, number>>;
  duplicates: number;
  errors: number;
  createdAssets: number;
  replaced: number;
  approximated: number;
  /** Pozițiile deținute la broker după import, cu cantitatea raportată de broker, dacă apare în fișier. */
  positions: { symbol: string; brokerSymbol: string; name: string; quantity: number; reportedQuantity: number | null }[];
  unconfirmed: string[];
  offline: boolean;
  templateSaved: string | null;
}

/** Un import făcut, care poate fi anulat complet. */
export interface ImportBatchView {
  id: number;
  createdAt: string;
  fileName: string | null;
  formatLabel: string;
  brokerName: string | null;
  portfolioName: string | null;
  txCount: number;
  /** Câte tranzacții din import mai există (unele pot fi șterse între timp). */
  remaining: number;
  dateFrom: string | null;
  dateTo: string | null;
  summary: Partial<Record<StatementKind, number>>;
}

export interface ImportTemplate {
  id: number;
  name: string;
  signature: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PriceStatus {
  refreshing: boolean;
  offline: boolean;
  lastPriceUpdate: string | null;
  lastError: string | null;
}

/** Rezultat generic pentru operațiile care deschid dialoguri de fișier. */
export interface FileResult {
  canceled: boolean;
  path?: string;
  count?: number;
}

/* ------------------------------------------------------------- portofolii */

/** Ce se întâmplă dacă se mută tranzacțiile alese în alt portofoliu (pentru confirmare). */
export interface MovePreview {
  count: number;
  /** Portofoliile din care pleacă tranzacțiile. */
  from: string[];
  to: string;
  /**
   * Efectul asupra cash-ului urmărit în portofoliile de unde pleacă: banii plătiți pentru
   * cumpărările mutate (cu minus) sau încasați din vânzări rămân acum în portofoliul de destinație.
   */
  cash: { portfolioName: string; brokerName: string; currency: string; amount: number }[];
}

export interface MoveOptions {
  /**
   * Mută și banii: înregistrează o retragere în portofoliul de unde pleacă și o depunere
   * în cel de destinație, egale cu efectul tranzacțiilor mutate asupra cash-ului.
   */
  moveCash: boolean;
}

export interface MoveResult {
  moved: number;
  /** Perechile retragere + depunere create pentru mutarea banilor. */
  cashTransfers: number;
}

/** O linie din comparația portofoliilor (toate sumele în moneda de bază din setări). */
export interface PortfolioComparison {
  portfolioId: number;
  name: string;
  color: PortfolioColor;
  icon: PortfolioIcon;
  baseCurrency: string;
  value: number;
  cash: number;
  totalPnl: number;
  returnPct: number | null;
  twr: number | null;
  twrAnnualized: number | null;
  /** Volatilitatea anualizată a randamentelor (abaterea standard), din seria valorii. */
  volatility: number | null;
  /** Cea mai mare scădere de la un vârf (negativă), din seria valorii. */
  maxDrawdown: number | null;
  positions: number;
}

/* ------------------------------------------------------------- logo-uri */

/** Un simbol pentru care interfața cere logo-ul companiei. */
export interface LogoRequest {
  symbol: string;
  type: AssetType;
}

/* ------------------------------------------------------------- watchlist */

/** O listă de urmărire (ex.: „De cumpărat”, „Dividende”). */
export interface Watchlist {
  id: number;
  name: string;
  sortOrder: number;
  itemCount: number;
}

export interface WatchlistItemInput {
  symbol: string;
  type: AssetType;
  currency: string;
  name?: string | null;
  /** Prețul la care utilizatorul ar vrea să cumpere (opțional), în moneda instrumentului. */
  targetPrice?: number | string | null;
  note?: string | null;
}

export interface WatchlistItemUpdate {
  targetPrice?: number | string | null;
  note?: string | null;
  name?: string | null;
  /** Mută elementul în altă listă. */
  watchlistId?: number;
}

export interface WatchlistItemView {
  id: number;
  watchlistId: number;
  symbol: string;
  type: AssetType;
  currency: string;
  name: string;
  targetPrice: number | null;
  note: string | null;
  sortOrder: number;
  createdAt: string;
  /** Ultimul preț cunoscut (din cache) și momentul lui. */
  price: number | null;
  priceAsOf: string | null;
  /** Închiderea din ziua de tranzacționare anterioară și variația de azi (fracție: 0,012 = +1,2%). */
  previousClose: number | null;
  changePct: number | null;
  /** Închiderile zilnice din ultimele trei luni, pentru graficul mic. */
  sparkline: { date: string; close: number }[];
  /** Distanța până la prețul țintă: pozitivă = prețul este peste țintă; zero sau negativă = ținta a fost atinsă. */
  toTargetPct: number | null;
  /** Instrumentul este deținut acum (în oricare portofoliu). */
  held: boolean;
}

/* ---------------------------------------------------------------- risc */

export interface RiskPosition {
  assetId: number;
  symbol: string;
  name: string;
  type: AssetType;
  value: number;
  /** Ponderea în valoarea pozițiilor (fără cash). */
  weight: number;
  sector: string;
  country: string;
  currency: string;
}

/** Ecranul „Risc”: concentrare, expuneri, volatilitate, scădere maximă, beta și diversificare. */
export interface RiskReport {
  baseCurrency: string;
  range: HistoryRange;
  /** Valoarea pozițiilor (fără cash) și cash-ul urmărit, în moneda de bază. */
  holdingsValue: number;
  cash: number;
  concentrationLimit: number;
  positions: RiskPosition[];
  bySector: AllocationSlice[];
  byCountry: AllocationSlice[];
  byCurrency: AllocationSlice[];
  byType: AllocationSlice[];
  /** Pozițiile (acțiuni) fără sector cunoscut, de completat manual. */
  unknownSector: string[];
  volatility: number | null;
  maxDrawdown: { value: number; peakDate: string; troughDate: string; recoveryDate: string | null } | null;
  beta: number | null;
  benchmark: { symbol: string; name: string };
  score: number;
  effectivePositions: number;
  suggestions: string[];
}

export interface BrokerInput {
  name: string;
  notes?: string | null;
  /** Lipsă = se deduce din nume (brokerii cunoscuți din România), altfel „străin”. */
  residence?: BrokerResidence;
}

/* ---------------------------------------------------------- raport fiscal */

/** De unde vine cursul în lei al unei sume: BNR, cursul din aplicație (istoricul providerului) sau cel de azi. */
export type FxSource = 'ron' | 'bnr' | 'app' | 'current';

/** Totalurile unui broker într-o monedă, pentru anul ales. Fiecare sumă are și echivalentul în lei. */
export interface TaxGroupTotals {
  brokerId: number;
  brokerName: string;
  residence: BrokerResidence;
  currency: string;
  sales: number;
  /** Încasări din vânzări (după comisionul de vânzare), costul unităților vândute (cu comisioanele de cumpărare) și diferența. */
  proceeds: number;
  cost: number;
  gains: number;
  losses: number;
  net: number;
  proceedsRon: number;
  costRon: number;
  gainsRon: number;
  lossesRon: number;
  netRon: number;
  dividends: { gross: number; tax: number; net: number; grossRon: number; taxRon: number; netRon: number };
  coupons: { gross: number; tax: number; net: number; grossRon: number; taxRon: number; netRon: number };
  interest: { gross: number; tax: number; net: number; grossRon: number; taxRon: number; netRon: number };
  /** Comisioanele plătite: la cumpărări, la vânzări și cele separate (custodie etc.). */
  fees: number;
  feesRon: number;
}

/** O tranzacție din detalierea raportului. */
export interface TaxDetailRow {
  id: number;
  date: string;
  type: TransactionType;
  brokerName: string;
  residence: BrokerResidence;
  portfolioName: string | null;
  symbol: string | null;
  name: string | null;
  currency: string;
  quantity: number | null;
  price: number | null;
  /** Vânzări: încasarea, costul și profitul/pierderea; venituri: brut, impozit, net; comisioane: suma. */
  proceeds: number | null;
  cost: number | null;
  gain: number | null;
  gross: number | null;
  tax: number | null;
  net: number | null;
  fee: number;
  /** Cursul (lei pentru o unitate) din ziua tranzacției și sursa lui. */
  fxRate: number;
  fxSource: FxSource;
  /** Data cursului folosit (la BNR: ultima zi lucrătoare de dinainte, dacă tranzacția e în weekend). */
  fxDate: string | null;
  proceedsRon: number | null;
  costRon: number | null;
  gainRon: number | null;
  grossRon: number | null;
  taxRon: number | null;
  netRon: number | null;
  feeRon: number;
}

export interface TaxSection {
  residence: BrokerResidence;
  groups: TaxGroupTotals[];
  /** Totalul secțiunii, doar în lei (monedele diferite nu se adună direct). */
  totalRon: {
    gains: number;
    losses: number;
    net: number;
    dividendsGross: number;
    dividendsTax: number;
    dividendsNet: number;
    couponsGross: number;
    couponsTax: number;
    couponsNet: number;
    interestGross: number;
    interestTax: number;
    interestNet: number;
    fees: number;
  };
}

export interface TaxReport {
  year: number;
  /** null = toate portofoliile (inclusiv cele arhivate). */
  portfolioId: number | null;
  portfolioName: string | null;
  /** Anii cu tranzacții (pentru alegerea anului), descrescător. */
  years: number[];
  sections: TaxSection[];
  details: TaxDetailRow[];
  /** Câte sume s-au convertit cu fiecare sursă de curs. */
  fxSources: Record<FxSource, number>;
  /** Mesaj dacă cursurile BNR nu au putut fi descărcate (se folosește cursul din aplicație). */
  bnrNotice: string | null;
  costMethod: CostMethod;
}

/* --------------------------------------------------------------- dividende */

/** Starea unui dividend din calendar. */
export type DividendStatus = 'received' | 'announced' | 'estimated' | 'manual';

/** Un dividend (sau cupon) din calendar pentru o poziție deținută. */
export interface DividendCalendarEntry {
  key: string;
  assetId: number;
  symbol: string;
  name: string;
  assetType: AssetType;
  /** Data ex-dividend (null la dividendele înregistrate fără anunț cunoscut). */
  exDate: string | null;
  /** Data plății (estimată dacă nu e cunoscută). */
  payDate: string;
  payDateEstimated: boolean;
  /** Suma pe acțiune, în moneda activului (null la cele înregistrate fără anunț). */
  amountPerShare: number | null;
  currency: string;
  /** Cantitatea deținută în ziua dinaintea datei ex-dividend (sau cea curentă, pentru cele viitoare). */
  quantity: number;
  /** Suma brută: încasată (din tranzacții) sau estimată (cantitate × sumă pe acțiune). */
  gross: number;
  /** Suma netă încasată (doar la cele încasate). */
  net: number | null;
  grossBase: number;
  status: DividendStatus;
  /** Cuponul unei obligațiuni (calculat din termenii ei). */
  coupon: boolean;
  /** Id-ul evenimentului introdus manual (pentru ștergere). */
  manualId: number | null;
}

/** Un dividend plătit, dar încă neînregistrat: aplicația propune înregistrarea lui. */
export interface DividendProposal {
  key: string;
  assetId: number;
  symbol: string;
  name: string;
  portfolioId: number;
  portfolioName: string;
  brokerId: number;
  brokerName: string;
  exDate: string;
  payDate: string;
  quantity: number;
  amountPerShare: number;
  currency: string;
  gross: number;
  /** Impozitul propus: după ponderea reținută la dividendele anterioare ale activului (0 dacă nu există). */
  tax: number;
  status: DividendStatus;
  /** Cupon de obligațiune (se înregistrează ca „Cupon”), nu dividend. */
  coupon: boolean;
}

/** Randamentul din dividende al unei poziții. */
export interface DividendYieldRow {
  assetId: number;
  symbol: string;
  name: string;
  assetType: AssetType;
  currency: string;
  quantity: number;
  /** Dividendele pe acțiune din ultimele 12 luni (după data ex-dividend). */
  trailingPerShare: number;
  /** Plăți pe an (1, 2, 4 sau 12) deduse din istoric; null dacă nu se știe. */
  frequency: number | null;
  /** Dividend yield = dividende pe 12 luni / prețul curent. */
  yield: number | null;
  /** Yield on cost = dividende pe 12 luni / prețul mediu de cumpărare. */
  yieldOnCost: number | null;
  /** Venitul anual estimat pentru cantitatea deținută, în moneda de bază. */
  annualIncomeBase: number;
}

export interface DividendMonth {
  month: number;
  received: number;
  estimated: number;
}

export interface DividendCalendar {
  year: number;
  baseCurrency: string;
  /** Lunile anului: încasat (din tranzacții) și estimat (anunțat, estimat sau introdus manual, neîncasat). */
  months: DividendMonth[];
  receivedTotal: number;
  estimatedTotal: number;
  /** Venitul estimat în următoarele 12 luni. */
  next12Months: number;
  entries: DividendCalendarEntry[];
  proposals: DividendProposal[];
  yields: DividendYieldRow[];
  /** Pozițiile fără niciun istoric de dividende (de la provider sau introdus). */
  withoutData: string[];
  years: number[];
}

export interface ManualDividendInput {
  assetId: number;
  exDate: string;
  payDate?: string | null;
  /** Suma pe acțiune, în moneda activului. */
  amount: number;
}

/* ---------------------------------------------------------------- jurnal */

/** Intrarea din jurnal privește o cumpărare, o vânzare sau este o notă oarecare despre o poziție. */
export type JournalKind = 'buy' | 'sell' | 'note';

/** Orizonturile de timp din care se alege (în luni). */
export const JOURNAL_HORIZONS = [1, 3, 6, 12, 36, 60, 120] as const;
/** Mementourile de revizuire a tezei (în luni). */
export const JOURNAL_REVIEW_MONTHS = [1, 3, 6, 12] as const;

export interface JournalEntryInput {
  /** Portofoliul (lipsă = cel al tranzacției sau cel implicit). */
  portfolioId?: number | null;
  assetId?: number | null;
  /** Tranzacția de cumpărare/vânzare la care se referă intrarea (dă activul, portofoliul, tipul și data). */
  transactionId?: number | null;
  date?: string | null;
  reason?: string | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  horizonMonths?: number | null;
  /** Încrederea în decizie, 1–5. */
  confidence?: number | null;
  tags?: string[] | null;
  /** Data mementoului de revizuire (are prioritate față de `reviewInMonths`). */
  reviewDate?: string | null;
  reviewInMonths?: number | null;
}

export interface JournalPlanCheck {
  tone: 'ok' | 'warn' | 'info';
  text: string;
}

/** Planul inițial pus lângă rezultatul real al unei vânzări. */
export interface JournalOutcome {
  plan: {
    entryId: number;
    date: string;
    reason: string;
    targetPrice: number | null;
    stopLoss: number | null;
    horizonMonths: number | null;
    confidence: number | null;
  };
  saleDate: string;
  salePrice: number;
  quantity: number;
  /** Profitul realizat la vânzare (după metoda de cost din setări), în moneda activului. */
  gain: number | null;
  gainPct: number | null;
  heldDays: number;
  checks: JournalPlanCheck[];
  respected: boolean;
}

export interface JournalEntry {
  /** Cheia unică în cronologie („e:12” = intrare salvată, „s:34” = vânzare fără notă, dar cu plan). */
  key: string;
  /** Null la vânzările afișate doar pentru compararea cu planul (fără intrare salvată). */
  id: number | null;
  portfolioId: number;
  portfolioName: string;
  assetId: number;
  symbol: string;
  name: string;
  assetType: AssetType;
  currency: string;
  transactionId: number | null;
  kind: JournalKind;
  date: string;
  reason: string;
  targetPrice: number | null;
  stopLoss: number | null;
  horizonMonths: number | null;
  confidence: number | null;
  tags: string[];
  reviewDate: string | null;
  reviewedAt: string | null;
  /** Tranzacția legată (cantitate și preț), dacă există. */
  trade: { type: TransactionType; quantity: number; price: number } | null;
  outcome: JournalOutcome | null;
}

export interface JournalFilters {
  /** Portofoliul ales; lipsă = toate portofoliile active. */
  portfolioId?: number | null;
  symbol?: string | null;
  tag?: string | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
}

export interface JournalList {
  entries: JournalEntry[];
  /** Etichetele și simbolurile folosite (pentru filtre). */
  tags: string[];
  symbols: string[];
  /** Tezele de revizuit (memento ajuns la termen), indiferent de filtre. */
  dueReviews: JournalEntry[];
}

/* ------------------------------------------------------------ simulator */

/** „Ce-ar fi fost dacă”: depunerile mele în alt instrument, investiție lunară (DCA) sau investiție unică. */
export type SimulationMode = 'market' | 'dca' | 'lump';

export interface SimulationRequest {
  mode: SimulationMode;
  /** Simbolul în formatul Yahoo (ex.: SPY, VWCE.DE, ^GSPC). */
  symbol: string;
  /** Dividendele se reinvestesc la data ex-dividend (doar pentru acțiuni și ETF-uri). */
  includeDividends: boolean;
  /** Comisionul la fiecare cumpărare/vânzare, ca fracție (0,002 = 0,2%). */
  feePct: number;
  /** DCA: suma lunară; investiție unică: suma, în moneda de bază. */
  amount?: number;
  /** DCA: data primei investiții; investiție unică: data investiției. */
  startDate?: string;
  /** Portofoliul (pentru comparația cu piața și moneda de bază). */
  filter?: PortfolioFilter;
}

export interface SimulationPoint {
  date: string;
  /** Valoarea simulată și totalul investit net, în moneda de bază. */
  value: number;
  invested: number;
  /** Doar la comparația cu piața: valoarea reală a portofoliului. */
  actual: number | null;
}

export interface SimulationResult {
  mode: SimulationMode;
  symbol: string;
  name: string;
  currency: string;
  baseCurrency: string;
  points: SimulationPoint[];
  invested: number;
  finalValue: number;
  gain: number;
  gainPct: number | null;
  /** Randamentul anual al banilor investiți (XIRR). */
  annualized: number | null;
  fees: number;
  reinvested: number;
  /** Comparația cu piața: valoarea reală de azi a portofoliului. */
  actualValue: number | null;
  startDate: string;
  endDate: string;
  notes: string[];
}

/* ------------------------------------------------------------ obiective */

/** De unde vine randamentul (sau volatilitatea) folosit în proiecție. */
export type GoalSource = 'auto' | 'personal' | 'benchmark' | 'manual';

export interface GoalInput {
  name: string;
  /** Suma-țintă, în moneda de bază a portofoliului ales (sau din setări, pentru toate portofoliile). */
  targetAmount: number;
  targetDate?: string | null;
  /** Ce valoare se urmărește: un portofoliu (null = toate), un broker, un tip de activ. */
  portfolioId?: number | null;
  brokerId?: number | null;
  assetType?: AssetType | null;
  /** Contribuția lunară; null = media depunerilor nete din ultimele 12 luni. */
  monthlyContribution?: number | null;
  returnSource?: GoalSource;
  manualReturn?: number | null;
  volatilitySource?: GoalSource;
  manualVolatility?: number | null;
  /** Inflația anuală (0,04 = 4%). */
  inflation?: number;
}

export interface Goal {
  id: number;
  name: string;
  targetAmount: number;
  targetDate: string | null;
  portfolioId: number | null;
  brokerId: number | null;
  assetType: AssetType | null;
  monthlyContribution: number | null;
  returnSource: GoalSource;
  manualReturn: number | null;
  volatilitySource: GoalSource;
  manualVolatility: number | null;
  inflation: number;
}

/** Datele din aplicație pentru proiecția unui obiectiv (cele alese de utilizator au prioritate). */
export interface GoalInputs {
  currency: string;
  currentValue: number;
  /** Contribuția lunară medie (depuneri − retrageri) din ultimele 12 luni. */
  averageContribution: number;
  personal: { annualReturn: number | null; volatility: number | null; years: number };
  benchmark: { symbol: string; name: string; annualReturn: number | null; volatility: number | null; from: string | null };
  /** Istoricul real al valorii (lunar), pentru graficul tip evantai. */
  history: { date: string; value: number }[];
}

export interface GoalView extends Goal {
  scopeLabel: string;
  inputs: GoalInputs;
  /** Valorile efective folosite (după sursa aleasă). */
  effective: {
    monthly: number;
    annualReturn: number;
    volatility: number;
    returnFrom: 'personal' | 'benchmark' | 'manual';
    volatilityFrom: 'personal' | 'benchmark' | 'manual';
  };
  /** Istoricul personal e mai scurt de 2 ani: randamentul personal nu e încă reprezentativ. */
  shortHistory: boolean;
  /** Valoarea actuală / suma-țintă (0–1). */
  progress: number;
}
