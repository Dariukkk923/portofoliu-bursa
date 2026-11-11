/**
 * Forma comună în care ajunge orice extras de la broker, indiferent de format.
 *
 * Fiecare cititor (XTB, Trading 212, Revolut, Interactive Brokers sau maparea
 * universală a unui CSV) transformă fișierul într-un `Statement`: o listă de
 * operațiuni (cumpărări, vânzări, dividende, impozite, comisioane, split-uri,
 * depuneri, retrageri) cu sumele ca text zecimal exact. Restul importului —
 * legarea de active, dublurile, previzualizarea, salvarea ca lot — este comun
 * și nu depinde de broker.
 *
 * Modulul este pur: fără acces la fișiere sau la baza de date.
 */
import type { AssetType } from '../types';

/** Felurile de operațiuni recunoscute într-un extras. `tax` = impozit reținut la sursă (se atașează dividendului). */
export type StatementKind = 'buy' | 'sell' | 'dividend' | 'coupon' | 'interest' | 'fee' | 'tax' | 'split' | 'deposit' | 'withdrawal';

export const STATEMENT_KINDS: StatementKind[] = ['buy', 'sell', 'dividend', 'coupon', 'interest', 'fee', 'tax', 'split', 'deposit', 'withdrawal'];

export const STATEMENT_KIND_LABEL: Record<StatementKind, string> = {
  buy: 'Cumpărare',
  sell: 'Vânzare',
  dividend: 'Dividend',
  coupon: 'Cupon',
  interest: 'Dobândă',
  fee: 'Comision',
  tax: 'Impozit reținut',
  split: 'Split',
  deposit: 'Depunere',
  withdrawal: 'Retragere'
};

/** O celulă din Excel (text sau număr) sau din CSV (text). */
export type Cell = string | number | null;

/** O foaie Excel sau conținutul unui CSV (atunci `name` este gol). */
export interface Table {
  name: string;
  rows: Cell[][];
}

/** Propunerea cititorului pentru simbolul din aplicație (format Yahoo Finance). */
export interface SymbolGuess {
  symbol: string;
  currency: string | null;
  type: AssetType | null;
}

export interface StatementRow {
  /** Rândul din fișier (primul rând = 1), pentru mesaje. */
  line: number;
  kind: StatementKind;
  /** AAAA-LL-ZZ */
  date: string;
  /** HH:MM:SS sau gol. */
  time: string;
  /** Simbolul instrumentului exact ca în fișier (ex.: „NVDA.US”); null la operațiunile de cash. */
  symbol: string | null;
  isin: string | null;
  name: string | null;
  guess: SymbolGuess | null;
  /** Text zecimal exact, pozitiv. La split fără raport: acțiunile primite (cu minus, cele cedate). */
  quantity: string | null;
  /** Prețul pe unitate. */
  price: string | null;
  /**
   * Moneda prețului și a comisionului (cumpărări, vânzări) sau a sumei (venituri, cash).
   * null = moneda activului la tranzacții și moneda contului la sume.
   */
  currency: string | null;
  /** Suma brută (dividende, dobânzi) sau suma operațiunii de cash, pozitivă. */
  amount: string | null;
  /** Impozitul reținut la sursă, pozitiv. */
  tax: string | null;
  /** Comisionul tranzacției, pozitiv. */
  fee: string | null;
  /** Suma mișcată efectiv în cont, cu semn (minus = bani ieșiți), în `cashCurrency`. */
  cashAmount: string | null;
  /** null = moneda contului. */
  cashCurrency: string | null;
  /** Dividendul pe acțiune, dacă extrasul îl dă (ajută la conversia din moneda contului). */
  perShare: string | null;
  perShareCurrency: string | null;
  /** Raportul unui split, „10:1” = zece acțiuni noi pentru una veche. */
  ratio: string | null;
  /** Identificatorul operațiunii la broker; pe el se bazează evitarea dublurilor la reimport. */
  externalId: string | null;
  note: string | null;
}

/** Un rând care nu a putut fi citit; apare în previzualizare ca eroare. */
export interface StatementProblem {
  line: number;
  message: string;
}

export interface Statement {
  /** Identificatorul formatului: „xtb”, „trading212”, „revolut”, „ibkr” sau „csv” (mapare universală). */
  format: string;
  /** Denumirea afișată a formatului („XTB (xStation)”). */
  formatLabel: string;
  /** Numele propus pentru brokerul la care se înregistrează tranzacțiile. */
  brokerName: string;
  /** Moneda contului, dacă fișierul o spune. */
  accountCurrency: string | null;
  rows: StatementRow[];
  problems: StatementProblem[];
  /** Operațiunile care nu se importă (conversii valutare, CFD-uri etc.), numărate. */
  ignored: { label: string; count: number }[];
  /** Observații despre tot fișierul. */
  warnings: string[];
  /** Cantitățile deținute raportate de broker (simbolul din fișier -> cantitate), pentru verificare. */
  openPositions: Record<string, number> | null;
}

/** Fișierul nu a putut fi interpretat; mesajul este în română, gata de afișat. */
export class StatementError extends Error {}

type Required = Pick<StatementRow, 'line' | 'kind' | 'date'>;

/** Un rând complet, cu câmpurile nespecificate goale. */
export function statementRow(fields: Required & Partial<StatementRow>): StatementRow {
  return {
    time: '',
    symbol: null,
    isin: null,
    name: null,
    guess: null,
    quantity: null,
    price: null,
    currency: null,
    amount: null,
    tax: null,
    fee: null,
    cashAmount: null,
    cashCurrency: null,
    perShare: null,
    perShareCurrency: null,
    ratio: null,
    externalId: null,
    note: null,
    ...fields
  };
}

/** Numără rândurile ignorate după etichetă. */
export class IgnoredCounter {
  private readonly counts = new Map<string, number>();
  add(label: string): void {
    const key = label.trim() || '(fără tip)';
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  list(): { label: string; count: number }[] {
    return [...this.counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
}

/** Ordonează rândurile cronologic (la aceeași dată, în ordinea din fișier). */
export function sortRows(rows: StatementRow[]): StatementRow[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.line - b.line);
}

/** Cititorul unui format de extras. */
export interface StatementReader {
  id: string;
  label: string;
  /** True dacă fișierul are structura acestui format (după antet și foi, nu după nume). */
  detect(tables: Table[], fileName: string): boolean;
  read(tables: Table[], fileName: string): Statement;
}
