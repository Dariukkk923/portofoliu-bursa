/**
 * Citirea valorilor din extrase: numere exacte (cu punct sau virgulă zecimală,
 * cu simbol de monedă), date în formatele obișnuite, tipul operațiunii în mai
 * multe limbi, coduri ISIN și simbolurile brokerilor traduse în formatul
 * aplicației (Yahoo Finance).
 */
import { isIsoDate } from '../dates';
import { normalizeKey } from '../csv';
import { dec } from '../calc/decimal';
import type { AssetType } from '../types';
import type { Cell, StatementKind, SymbolGuess } from './statement';

export const cellText = (cell: Cell | undefined): string => (cell === null || cell === undefined ? '' : String(cell).trim());

/* ------------------------------------------------------------------ numere */

/**
 * Normalizează cifrele unui număr fără semn: „1.234,56” -> „1234.56”.
 * Cu `decimalComma`, punctele sunt separatori de mii (fișier în format european).
 */
function normalizeDigits(text: string, decimalComma: boolean): string | null {
  let s = text;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (decimalComma) {
    s = s.replaceAll('.', '');
    if (s.indexOf(',') !== s.lastIndexOf(',')) return null;
    s = s.replace(',', '.');
  } else if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replaceAll('.', '').replace(',', '.') : s.replaceAll(',', '');
  } else if (lastComma >= 0) {
    // Mai multe virgule = separatori de mii („1,234,567”); una singură = zecimală.
    s = s.indexOf(',') !== lastComma ? s.replaceAll(',', '') : s.replace(',', '.');
  } else if (lastDot >= 0 && s.indexOf('.') !== lastDot) {
    s = s.replaceAll('.', ''); // „1.234.567”
  }
  return /^(\d+(\.\d*)?|\.\d+)$/.test(s) ? s : null;
}

/**
 * Numărul dintr-o celulă, ca text zecimal exact („-1234.5”), sau null.
 * Acceptă simboluri și coduri de monedă („USD 12.50”, „$1,234.50”, „12,5 €”),
 * semn la început sau la sfârșit și paranteze pentru negative („(3.20)”).
 */
export function parseDecimal(cell: Cell | undefined, decimalComma = false): string | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? dec(cell).toString() : null;
  let s = cellText(cell);
  if (!s) return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Eliminăm literele (coduri de monedă), simbolurile monetare și spațiile (inclusiv cele nedespărțitoare).
  s = s.replace(/[\p{L}\p{Sc}\s'’]/gu, '');
  if (s.endsWith('%')) s = s.slice(0, -1);
  for (;;) {
    if (s.startsWith('+')) s = s.slice(1);
    else if (s.startsWith('-') || s.startsWith('−')) {
      negative = !negative;
      s = s.slice(1);
    } else if (s.endsWith('-')) {
      negative = !negative;
      s = s.slice(0, -1);
    } else break;
  }
  if (!s) return null;
  const digits = normalizeDigits(s, decimalComma);
  if (digits === null) return null;
  const value = dec(digits);
  return (negative && !value.isZero() ? value.neg() : value).toString();
}

/** Valoarea absolută a unui număr ca text exact. */
export const absText = (value: string | null): string | null => (value === null ? null : dec(value).abs().toString());

/**
 * Formatul european al unor celule: separatorul zecimal este virgula („0,621”, „1.234,5”).
 * Se numără indiciile clare: ultimul separator când apar amândouă, sau un separator
 * singur urmat de alt număr de cifre decât trei („1,234” rămâne ambiguu și nu contează).
 */
export function detectDecimalComma(cells: Cell[]): boolean {
  let comma = 0;
  let dot = 0;
  for (const cell of cells) {
    if (typeof cell !== 'string') continue;
    const c = cell.replace(/[\p{L}\p{Sc}\s()+\-−]/gu, '');
    const lastComma = c.lastIndexOf(',');
    const lastDot = c.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) comma++;
      else dot++;
    } else if (lastComma >= 0 && lastComma === c.indexOf(',') && c.length - lastComma - 1 !== 3) {
      comma++;
    } else if (lastDot >= 0 && lastDot === c.indexOf('.') && c.length - lastDot - 1 !== 3) {
      dot++;
    }
  }
  return comma > dot;
}

/* -------------------------------------------------------------------- date */

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const pad = (n: number | string): string => String(n).padStart(2, '0');
/** Datele din Excel pot fi numere de serie (zile de la 30.12.1899). */
const isSerialDate = (n: number): boolean => n >= 36526 && n < 73051; // anii 2000–2099

const YMD = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const XYZ = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4}|\d{2})(?:[T,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})(?:[;T\s]+(\d{2}):?(\d{2}):?(\d{2})?)?$/;

/**
 * Data (și ora) dintr-o celulă: număr de serie Excel, „2024-03-01”, „2024-03-01T14:32:11Z”,
 * „2024-03-01, 10:15:32”, „01.03.2024 10:15”, „03/01/2024” (după `order`), „20240301”.
 */
export function parseWhen(cell: Cell | undefined, order: DateOrder = 'dmy'): { date: string; time: string } | null {
  if (typeof cell === 'number') {
    if (isSerialDate(cell)) {
      const d = new Date(Math.round((cell - 25569) * 86_400_000));
      return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19) };
    }
    return parseWhen(String(cell), order);
  }
  const s = cellText(cell);
  if (!s) return null;
  let y: string;
  let mo: string;
  let d: string;
  let m = s.match(YMD) ?? s.match(COMPACT);
  if (m) {
    [y, mo, d] = [m[1], m[2], m[3]];
  } else {
    m = s.match(XYZ);
    if (!m) return null;
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (order === 'mdy') [y, mo, d] = [year, m[1], m[2]];
    else [y, mo, d] = [year, m[2], m[1]];
  }
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  if (!isIsoDate(date)) return null;
  const time = m[4] !== undefined ? `${pad(m[4])}:${pad(m[5] ?? 0)}:${pad(m[6] ?? 0)}` : '';
  return { date, time };
}

/**
 * Ordinea zilei și a lunii într-o coloană de date („03/04/2024” poate fi 3 aprilie sau 4 martie):
 * dacă vreo primă parte trece de 12 este ziua, dacă vreo a doua trece de 12 este luna întâi.
 * Fără indicii: ziua întâi (formatul românesc), cu excepția separatorului „/” fără punct, unde rămâne ambiguu.
 */
export function detectDateOrder(cells: Cell[]): { order: DateOrder; ambiguous: boolean } {
  let dayFirst = false;
  let monthFirst = false;
  let sample = false;
  for (const cell of cells) {
    if (typeof cell !== 'string') continue;
    const s = cell.trim();
    if (YMD.test(s)) return { order: 'ymd', ambiguous: false };
    const m = s.match(XYZ);
    if (!m) continue;
    sample = true;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return { order: 'dmy', ambiguous: false };
  if (monthFirst && !dayFirst) return { order: 'mdy', ambiguous: false };
  return { order: 'dmy', ambiguous: sample && !dayFirst };
}

/* ---------------------------------------------------- tipul operațiunii */

const KIND_WORDS: [StatementKind, string[]][] = [
  ['tax', ['withholding', 'wht', 'impozit', 'retinere', 'quellensteuer', 'podatek', 'dividendtax', 'taxwithheld', 'retenue', 'ritenuta', 'retencion']],
  ['split', ['split']],
  ['deposit', ['deposit', 'depunere', 'depus', 'alimentare', 'topup', 'wplata', 'einzahlung', 'deposito', 'versement', 'cashin', 'transferin', 'incoming']],
  ['withdrawal', ['withdraw', 'retragere', 'retras', 'extragere', 'wyplata', 'auszahlung', 'retiro', 'retrait', 'cashout', 'transferout', 'outgoing']],
  ['dividend', ['divid', 'dywid', 'distribution', 'distributie', 'paymentinlieu']],
  ['coupon', ['cupon', 'coupon', 'kupon']],
  ['interest', ['interest', 'dobanda', 'dobanzi', 'odsetki', 'zinsen', 'interes']],
  ['fee', ['fee', 'comision', 'commission', 'prowizja', 'gebuhr', 'custody', 'custodie', 'taxa', 'charge', 'stampduty']],
  ['sell', ['sell', 'vanz', 'vand', 'sale', 'sold', 'verkauf', 'venta', 'vente', 'sprzedaz']],
  ['buy', ['buy', 'cumpar', 'purchase', 'bought', 'kauf', 'compra', 'achat', 'kupno', 'achizit']]
];

/**
 * Tipul operațiunii dintr-un text („Market buy”, „Vânzare”, „CASH TOP-UP”,
 * „Withholding tax”, „Dividend (Ordinary)”…), sau null dacă nu este recunoscut.
 */
export function classifyKind(text: string): StatementKind | null {
  const key = normalizeKey(text);
  if (!key) return null;
  if (['b', 'c', 'buy', 'cump'].includes(key)) return 'buy';
  if (['s', 'v', 'sell'].includes(key)) return 'sell';
  if (key === 'tax' || key === 'taxes' || (key.startsWith('tax') && !key.startsWith('taxa'))) return 'tax';
  for (const [kind, words] of KIND_WORDS) {
    if (words.some((w) => key.includes(w))) return kind;
  }
  return null;
}

/* ------------------------------------------------------------- identificare */

/** Codul unei monede („usd” -> „USD”), sau null. „GBX”/„GBp” (pence) rămân distincte. */
export function cleanCurrency(text: Cell | undefined): string | null {
  const s = cellText(text);
  if (s === 'GBp' || s.toUpperCase() === 'GBX') return 'GBX';
  const upper = s.toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

/** Codul ISIN (12 caractere, cu cifră de control). */
export function isIsin(text: string | null | undefined): boolean {
  const s = (text ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  const digits = [...s.slice(0, 11)].map((ch) => (ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch)).join('');
  let sum = 0;
  let double = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return (10 - (sum % 10)) % 10 === Number(s[11]);
}

/** Primul ISIN dintr-un text („AAPL(US0378331005) Cash Dividend…”). */
export function findIsin(text: string): string | null {
  for (const m of text.toUpperCase().matchAll(/\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/g)) if (isIsin(m[0])) return m[0];
  return null;
}

/** Sufixul de bursă folosit de brokeri („.US”, „.UK”, „.DE”) -> sufixul Yahoo Finance și moneda obișnuită. */
const EXCHANGE_SUFFIXES: Record<string, { suffix: string; currency: string }> = {
  US: { suffix: '', currency: 'USD' },
  UK: { suffix: '.L', currency: 'GBP' },
  L: { suffix: '.L', currency: 'GBP' },
  LN: { suffix: '.L', currency: 'GBP' },
  DE: { suffix: '.DE', currency: 'EUR' },
  GY: { suffix: '.DE', currency: 'EUR' },
  FR: { suffix: '.PA', currency: 'EUR' },
  PA: { suffix: '.PA', currency: 'EUR' },
  NL: { suffix: '.AS', currency: 'EUR' },
  AS: { suffix: '.AS', currency: 'EUR' },
  ES: { suffix: '.MC', currency: 'EUR' },
  MC: { suffix: '.MC', currency: 'EUR' },
  IT: { suffix: '.MI', currency: 'EUR' },
  MI: { suffix: '.MI', currency: 'EUR' },
  BE: { suffix: '.BR', currency: 'EUR' },
  PT: { suffix: '.LS', currency: 'EUR' },
  FI: { suffix: '.HE', currency: 'EUR' },
  AT: { suffix: '.VI', currency: 'EUR' },
  IE: { suffix: '.IR', currency: 'EUR' },
  CH: { suffix: '.SW', currency: 'CHF' },
  SW: { suffix: '.SW', currency: 'CHF' },
  PL: { suffix: '.WA', currency: 'PLN' },
  WA: { suffix: '.WA', currency: 'PLN' },
  CZ: { suffix: '.PR', currency: 'CZK' },
  SE: { suffix: '.ST', currency: 'SEK' },
  ST: { suffix: '.ST', currency: 'SEK' },
  DK: { suffix: '.CO', currency: 'DKK' },
  CO: { suffix: '.CO', currency: 'DKK' },
  NO: { suffix: '.OL', currency: 'NOK' },
  OL: { suffix: '.OL', currency: 'NOK' },
  RO: { suffix: '.RO', currency: 'RON' },
  BVB: { suffix: '.RO', currency: 'RON' },
  CA: { suffix: '.TO', currency: 'CAD' },
  TO: { suffix: '.TO', currency: 'CAD' }
};

/** Bursa obișnuită după moneda de tranzacționare (pentru tickerele fără sufix). */
const SUFFIX_BY_CURRENCY: Record<string, string> = {
  GBP: '.L',
  GBX: '.L',
  CHF: '.SW',
  SEK: '.ST',
  DKK: '.CO',
  NOK: '.OL',
  PLN: '.WA',
  CZK: '.PR',
  CAD: '.TO',
  RON: '.RO'
};

/** Pentru acțiunile în euro: bursa după țara din ISIN; ETF-urile irlandeze și luxemburgheze, la Xetra. */
const EUR_SUFFIX_BY_COUNTRY: Record<string, string> = {
  DE: '.DE',
  FR: '.PA',
  NL: '.AS',
  ES: '.MC',
  IT: '.MI',
  BE: '.BR',
  PT: '.LS',
  FI: '.HE',
  AT: '.VI',
  IE: '.DE',
  LU: '.DE'
};

const KNOWN_YAHOO_SUFFIXES = new Set(Object.values(EXCHANGE_SUFFIXES).map((e) => e.suffix.slice(1)).filter(Boolean).concat(['F', 'SG', 'MU', 'BE', 'DU', 'HM', 'IR']));

/**
 * Simbolul din aplicație pentru simbolul unui broker: „NVDA.US” -> NVDA (USD),
 * „CSPX.UK” -> CSPX.L, „VWCE.DE” -> VWCE.DE (EUR), „BRK B” -> BRK-B.
 * Fără sufix, bursa se deduce din monedă și din țara ISIN-ului. Este doar o propunere:
 * se confirmă la furnizorul de prețuri, iar utilizatorul o poate corecta.
 */
export function guessSymbol(brokerSymbol: string, hints: { currency?: string | null; isin?: string | null; type?: AssetType | null } = {}): SymbolGuess {
  const clean = brokerSymbol.trim().toUpperCase().replace(/_\d+$/, '').replace(/\s+/g, '-');
  const currency = hints.currency === 'GBX' ? 'GBP' : (hints.currency ?? null);
  const type = hints.type ?? null;
  const dot = clean.lastIndexOf('.');
  if (dot > 0) {
    const suffix = clean.slice(dot + 1);
    const exchange = EXCHANGE_SUFFIXES[suffix];
    if (exchange) return { symbol: clean.slice(0, dot) + exchange.suffix, currency: currency ?? exchange.currency, type };
    if (KNOWN_YAHOO_SUFFIXES.has(suffix)) return { symbol: clean, currency, type };
    // „BRK.B”: clasă de acțiuni americană.
    if (suffix.length === 1 && (!currency || currency === 'USD')) return { symbol: `${clean.slice(0, dot)}-${suffix}`, currency: currency ?? 'USD', type };
    return { symbol: clean, currency, type };
  }
  const isin = (hints.isin ?? '').toUpperCase();
  if (!currency || currency === 'USD' || isin.startsWith('US')) return { symbol: clean, currency: currency ?? (isin.startsWith('US') ? 'USD' : null), type };
  if (currency === 'EUR') {
    const suffix = EUR_SUFFIX_BY_COUNTRY[isin.slice(0, 2)];
    return { symbol: suffix ? clean + suffix : clean, currency, type };
  }
  const suffix = SUFFIX_BY_CURRENCY[currency];
  return { symbol: suffix ? clean + suffix : clean, currency, type };
}

/** Suffixul Yahoo după bursa raportată de Interactive Brokers (coloana „Listing Exch”). */
const IBKR_EXCHANGES: Record<string, string> = {
  NASDAQ: '',
  NYSE: '',
  ARCA: '',
  AMEX: '',
  BATS: '',
  NMS: '',
  LSE: '.L',
  LSEETF: '.L',
  IBIS: '.DE',
  IBIS2: '.DE',
  FWB: '.F',
  FWB2: '.F',
  GETTEX: '.MU',
  AEB: '.AS',
  SBF: '.PA',
  BVME: '.MI',
  'BVME.ETF': '.MI',
  BM: '.MC',
  EBS: '.SW',
  SFB: '.ST',
  CPH: '.CO',
  OSE: '.OL',
  WSE: '.WA',
  TSE: '.TO',
  VSE: '.VI',
  ENEXT_BE: '.BR'
};

export function ibkrSymbol(symbol: string, exchange: string | null, currency: string | null): SymbolGuess {
  const suffix = exchange ? IBKR_EXCHANGES[exchange.toUpperCase()] : undefined;
  const clean = symbol.trim().toUpperCase().replace(/\s+/g, '-');
  if (suffix !== undefined) return { symbol: clean + suffix, currency, type: null };
  return guessSymbol(clean, { currency });
}
