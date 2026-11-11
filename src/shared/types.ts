/**
 * Tipuri comune procesului principal (Electron/Node) și interfeței (React).
 * Tot ce traversează IPC este descris aici.
 */

export type AssetType = 'stock' | 'etf' | 'bond' | 'crypto';
export type TransactionType = 'buy' | 'sell' | 'dividend' | 'coupon' | 'split';
export type CostMethod = 'AVG' | 'FIFO';
export type ProviderId = 'yahoo' | 'alphavantage' | 'twelvedata' | 'polygon';
export type Theme = 'light' | 'dark' | 'system';
export type PriceMode = 'auto' | 'manual';
export type HistoryRange = '1M' | '3M' | '6M' | '1Y' | 'ALL';

export const ASSET_TYPES: AssetType[] = ['stock', 'etf', 'bond', 'crypto'];
export const TRANSACTION_TYPES: TransactionType[] = ['buy', 'sell', 'dividend', 'coupon', 'split'];
export const PROVIDER_IDS: ProviderId[] = ['yahoo', 'alphavantage', 'twelvedata', 'polygon'];
/** Monede în care poate fi exprimat totalul portofoliului. */
export const BASE_CURRENCIES = ['RON', 'EUR', 'USD'] as const;
/** Monede acceptate pentru un activ (prețul lui de tranzacționare). */
export const ASSET_CURRENCIES = ['RON', 'EUR', 'USD', 'GBP', 'CHF'] as const;
export const REFRESH_INTERVALS = [0, 1, 5, 15, 30, 60] as const;

export interface User {
  id: number;
  username: string;
  email: string | null;
  isDemo: boolean;
  createdAt: string;
}

export interface Broker {
  id: number;
  name: string;
  notes: string | null;
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
  createdAt: string;
}

export interface Transaction {
  id: number;
  assetId: number;
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
  /** Dividende/cupoane: suma brută, impozitul reținut și suma netă. */
  grossAmount: number;
  taxWithheld: number;
  netAmount: number;
  /** Split „4:1” => splitNumerator = 4, splitDenominator = 1. */
  splitNumerator: number | null;
  splitDenominator: number | null;
  notes: string | null;
  createdAt: string;
}

/** Tranzacție îmbogățită cu datele activului și ale brokerului, pentru tabel. */
export interface TransactionView extends Transaction {
  symbol: string;
  assetName: string;
  assetType: AssetType;
  brokerName: string | null;
}

export interface TransactionFilters {
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
}

/** Formularul „Adaugă activ”: activul + achiziția care devine tranzacție de tip Cumpărare. */
export interface PurchaseInput {
  asset: AssetInput;
  brokerId: number;
  date: string;
  quantity: number;
  price: number;
  fee: number;
  notes?: string | null;
}

export interface TransactionInput {
  assetId: number;
  brokerId: number | null;
  type: TransactionType;
  date: string;
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
  /** Pentru fiecare provider: dacă există o cheie salvată și ultimele ei caractere (cheia nu părăsește procesul principal). */
  apiKeys: Record<ProviderId, { configured: boolean; hint: string | null }>;
}

export interface SettingsUpdate {
  baseCurrency?: string;
  costMethod?: CostMethod;
  theme?: Theme;
  primaryProvider?: ProviderId;
  refreshIntervalMin?: number;
}

/** De unde provine prețul folosit la evaluare. */
export type PriceSource = 'api' | 'manual' | 'cost';

/** O poziție evaluată: fie pe (activ, broker), fie agregată pe activ (brokerId = null). */
export interface PositionView {
  key: string;
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
  costBasisBase: number;
  unrealizedBase: number;
  realizedBase: number;
  incomeBase: number;
  totalBoughtBase: number;
}

export interface PortfolioTotals {
  baseCurrency: string;
  totalValue: number;
  totalCost: number;
  unrealized: number;
  unrealizedPct: number | null;
  /** Profit realizat din vânzări. */
  realizedSales: number;
  /** Dividende + cupoane nete. */
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

export interface PortfolioOverview {
  totals: PortfolioTotals;
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

export interface PortfolioFilter {
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

/* ------------------------------------------------ import din raportul brokerului */

/** Ce s-a găsit în raportul ales, înainte de a salva ceva. */
export interface BrokerImportPreview {
  /** Identifică raportul citit, pentru pasul de import (fișierul nu se mai alege o dată). */
  token: string;
  fileName: string;
  /** Brokerul la care se înregistrează tranzacțiile („XTB”, creat dacă lipsește). */
  brokerName: string;
  dateFrom: string;
  dateTo: string;
  /** Operațiunile recunoscute în raport și câte dintre ele au fost deja importate. */
  totals: { buys: number; sells: number; dividends: number; alreadyImported: number };
  /** Numărul de instrumente (acțiuni, ETF-uri) din raport. */
  instruments: number;
  /**
   * Tranzacții introduse manual la acest broker pentru instrumentele din raport.
   * Dacă există, utilizatorul alege dacă sunt înlocuite de cele din raport (altfel ar apărea de două ori).
   */
  manualCount: number;
}

export interface BrokerImportOptions {
  /** Înlocuiește tranzacțiile introduse manual la broker cu cele din raport. */
  replaceManual: boolean;
}

export interface BrokerImportResult {
  brokerName: string;
  imported: number;
  buys: number;
  sells: number;
  dividends: number;
  /** Operațiuni din raport care erau deja în aplicație (importate anterior). */
  alreadyImported: number;
  createdAssets: number;
  /** Tranzacții introduse manual care au fost înlocuite. */
  replaced: number;
  /** Dividende a căror sumă a fost convertită aproximativ din moneda contului. */
  approximated: number;
  /** Pozițiile deținute la broker după import; `reportedQuantity` este cantitatea din raport, dacă apare. */
  positions: { symbol: string; brokerSymbol: string; name: string; quantity: number; reportedQuantity: number | null }[];
  /** Instrumente sărite: raportul nu conține toate cumpărările lor (perioadă incompletă sau split). */
  incomplete: string[];
  /** Active noi al căror simbol nu a fost găsit la furnizorul de prețuri (rămân evaluate la cost). */
  unconfirmed: string[];
  /** Operațiunile din raport care nu se importă (depuneri, dobânzi etc.). */
  ignored: { label: string; count: number; symbols: string[] }[];
  /** Simbolurile noi nu au putut fi verificate (fără internet). */
  offline: boolean;
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
