/**
 * Interpretarea raportului de cont exportat din xStation (XTB).
 *
 * XTB nu mai oferă un API public (a fost închis în martie 2025), deci singura
 * cale de a prelua automat pozițiile este fișierul exportat de utilizator:
 *  - Excel (.xlsx). Exportul actual are foile „Closed Positions”, „Cash
 *    Operations” și „Open Positions”, iar tabelul operațiunilor are coloanele
 *    `Type | Instrument | Ticker | Category | Time | Amount | ID | Comment | …`
 *    sub câteva rânduri cu datele contului. Exporturile mai vechi au foaia
 *    „CASH OPERATION HISTORY” cu `ID | Type | Time | Comment | Symbol | Amount`;
 *  - CSV (formatul vechi), doar cu operațiunile de numerar:
 *    `ID;Type;Time;Symbol;Comment;Amount`.
 * Tabelul este căutat după antet, nu după poziție, deci toate variantele merg.
 *
 * Sursa folosită este lista operațiunilor de numerar. Fiecare rând este
 * clasificat după COMENTARIU, care are aceeași formă în toate limbile, nu după
 * coloana „Type”, care este tradusă:
 *   „OPEN BUY 34/42.5658 @ 11.7480”  -> cumpărare a 34 de unități la 11,748
 *   „OPEN BUY NVDA.US 2 @ 181.25”    -> la fel, în exportul actual (cu simbol)
 *   „CLOSE BUY 1 @ 26.280”           -> vânzare
 *   „SPYL.DE USD 0.6600/ SHR”        -> dividend (0,66 USD pe acțiune)
 *   „FB.US USD WHT 15%”              -> impozit reținut la sursă pentru dividend
 * Depunerile, retragerile, transferurile, dobânzile la cash (și impozitul lor) și
 * comisioanele se recunosc după coloana „Type” (în mai multe limbi) și semnul sumei.
 * CFD-urile și restul operațiunilor sunt numărate și ignorate.
 *
 * Modulul este pur (fără acces la fișiere sau la baza de date): primește
 * tabelele deja citite și întoarce operațiunile. Sumele din coloana „Amount”
 * sunt în moneda contului, iar prețurile din comentariu în moneda instrumentului.
 */
import { normalizeKey, parseNumberLoose, usesDecimalComma } from '../csv';
import { isIsoDate } from '../dates';

export type XtbCell = string | number | null;

/** O foaie din fișierul Excel sau conținutul unui CSV (atunci `name` este gol). */
export interface XtbTable {
  name: string;
  rows: XtbCell[][];
}

interface XtbOperationBase {
  /** Rândul din foaie (primul rând = 1), pentru mesaje. */
  row: number;
  /** Identificatorul operațiunii în XTB; pe el se bazează evitarea dublurilor la reimport. */
  id: string;
  /** AAAA-LL-ZZ */
  date: string;
  /** HH:MM:SS */
  time: string;
  /** Simbolul în formatul XTB, ex.: „AAPL.US”. */
  symbol: string;
  /** Denumirea instrumentului din raport (coloana „Instrument”), dacă există. */
  name: string;
  /** Categoria din raport (coloana „Category”: STOCK sau ETF), dacă există. */
  category: 'stock' | 'etf' | null;
}

export interface XtbTrade extends XtbOperationBase {
  kind: 'buy' | 'sell';
  quantity: number;
  /** Prețul pe unitate, în moneda instrumentului. */
  price: number;
  /** Suma plătită sau încasată, în moneda contului (fără semn); null dacă lipsește. */
  amount: number | null;
}

export interface XtbDividend extends XtbOperationBase {
  kind: 'dividend';
  /** Dividendul brut, în moneda contului. */
  amount: number;
  /** Impozitul reținut la sursă, în moneda contului (valoare pozitivă). */
  tax: number;
  /** Dividendul pe acțiune din comentariu și moneda lui, dacă apar. */
  perShare: number | null;
  perShareCurrency: string | null;
}

export type XtbOperation = XtbTrade | XtbDividend;

/** O operațiune de numerar fără activ: depunere, retragere, dobândă, impozitul dobânzii, comision. */
export interface XtbCashOperation {
  kind: 'deposit' | 'withdrawal' | 'interest' | 'tax' | 'fee';
  id: string;
  date: string;
  time: string;
  /** Suma, pozitivă, în moneda contului. */
  amount: number;
  row: number;
  /** Tipul din raport (ex.: „Deposit”), păstrat în notă. */
  label: string;
  /** Instrumentul la care se referă (ex.: comisionul SEC al unei vânzări), dacă apare. */
  symbol: string;
}

export interface XtbIgnored {
  /** Tipul operațiunii așa cum apare în raport (ex.: „Deposit”). */
  label: string;
  count: number;
  /** Instrumentele la care se referă rândurile ignorate (cel mult câteva, pentru afișare). */
  symbols: string[];
}

export interface XtbReport {
  /** Moneda contului, dacă apare în fișier sau în numele lui. */
  accountCurrency: string | null;
  /** Operațiunile recunoscute, în ordine cronologică. */
  operations: XtbOperation[];
  /** Depunerile, retragerile, dobânzile și comisioanele, în ordine cronologică. */
  cash: XtbCashOperation[];
  /** Rândurile care nu se importă (CFD-uri, operațiuni necunoscute). */
  ignored: XtbIgnored[];
  /** Cantitățile din foaia „OPEN POSITION” (doar la Excel), pentru verificare. */
  openPositions: Record<string, number> | null;
}

/** Fișierul nu a putut fi interpretat; mesajul este în română, gata de afișat. */
export class XtbParseError extends Error {}

/* ------------------------------------------------------------- recunoaștere */

type ColumnKind = 'id' | 'type' | 'time' | 'symbol' | 'name' | 'category' | 'comment' | 'amount';
type Columns = Partial<Record<ColumnKind, number>>;

/** Denumirile coloanelor în limbile în care exportă xStation (comparate fără diacritice și spații). */
const HEADERS: Record<ColumnKind, string[]> = {
  id: ['id'],
  type: ['type', 'tip', 'typ', 'tipo', 'art', 'tipoperatiune'],
  time: ['time', 'date', 'datetime', 'time(utc)', 'ora', 'timp', 'data', 'dataora', 'datasiora', 'czas', 'zeit', 'datum', 'hora', 'fecha', 'heure'],
  symbol: ['ticker', 'symbol', 'simbol', 'simbolo', 'symbole'],
  // În exportul actual „Instrument” este denumirea (ex.: „Nvidia”), iar simbolul stă în „Ticker”.
  name: ['instrument', 'instrument/position', 'instrumente', 'instrumento'],
  category: ['category', 'categorie', 'kategoria', 'kategorie', 'categoria'],
  comment: ['comment', 'comentariu', 'komentarz', 'kommentar', 'comentario', 'commentaire', 'commento', 'descriere', 'description'],
  amount: ['amount', 'suma', 'valoare', 'kwota', 'betrag', 'importe', 'montant', 'importo', 'montante', 'quantia']
};
const VOLUME_HEADERS = ['volume', 'volum', 'wolumen', 'volumen'];
const CURRENCY_LABELS = ['currency', 'moneda', 'valuta', 'waluta', 'wahrung', 'devise', 'moeda', 'divisa'];
/** Monedele în care XTB deschide conturi (folosite la recunoașterea monedei din numele fișierului). */
const ACCOUNT_CURRENCIES = ['EUR', 'USD', 'RON', 'PLN', 'GBP', 'CZK', 'HUF', 'CHF'];

/** „OPEN BUY [simbol] cantitate[/total] @ preț”; grupurile: 1 = OPEN/CLOSE, 2 = cantitatea, 3 = prețul. */
const TRADE = /^\s*(OPEN|CLOSE)\s+BUY\s+(?:\S+\s+)?([0-9][0-9.,]*)(?:\s*\/\s*[0-9][0-9.,]*)?\s*@\s*([0-9][0-9.,]*)/i;
const DIVIDEND = /^\s*\S+\s+([A-Z]{3})\s+([0-9][0-9.,]*)\s*\/\s*SHR/i;
const WHT = /\bWHT\b/i;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,23}$/;
/** Acțiunile și ETF-urile au sufix de bursă („AAPL.US”); CFD-urile („EURUSD”, „US500”) nu au. */
const STOCK_SYMBOL = /^[A-Z0-9][A-Z0-9-]*\.[A-Z]{2,3}(_[0-9]+)?$/;
const DATE_DMY = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const DATE_YMD = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

const TAX_WORDS = ['withholding', 'wht', 'impozit', 'podatek', 'retencion', 'retencao', 'quellensteuer', 'ritenuta', 'retenue'];
const isTaxType = (key: string): boolean => TAX_WORDS.some((w) => key.includes(w));
const isDividendType = (key: string): boolean => key.includes('divid') || key.includes('dywid');

const has = (key: string, words: string[]): boolean => words.some((w) => key.includes(w));
/** Operațiunile CFD (profitul închiderii, swap-uri) nu sunt mișcări de bani ale investitorului în acțiuni. */
const CFD_WORDS = ['closetrade', 'swap', 'rollover', 'profit', 'cfd'];

/** Felul unei operațiuni de numerar după tipul din raport (în mai multe limbi) și semnul sumei. */
function classifyCash(typeKey: string, amount: number): XtbCashOperation['kind'] | null {
  if (amount === 0 || has(typeKey, CFD_WORDS)) return null;
  if (has(typeKey, ['interest', 'dobanda', 'odsetki', 'zinsen', 'interes'])) {
    if (has(typeKey, ['tax', 'impozit', 'podatek', 'steuer', 'impuesto', 'imposto'])) return amount < 0 ? 'tax' : null;
    return amount > 0 ? 'interest' : null;
  }
  if (has(typeKey, ['withdraw', 'retragere', 'wyplata', 'auszahlung', 'retiro', 'retrait', 'prelievo', 'levantamento'])) return amount < 0 ? 'withdrawal' : null;
  if (has(typeKey, ['deposit', 'depunere', 'wplata', 'einzahlung', 'deposito', 'depot', 'versamento'])) return amount > 0 ? 'deposit' : null;
  if (has(typeKey, ['transfer', 'przelew', 'ubertrag', 'transferencia', 'virement', 'trasferimento'])) return amount > 0 ? 'deposit' : 'withdrawal';
  if (has(typeKey, ['fee', 'commission', 'comision', 'prowizja', 'gebuhr', 'oplata', 'comissao'])) return amount < 0 ? 'fee' : null;
  return null;
}

const text = (cell: XtbCell | undefined): string => (cell === null || cell === undefined ? '' : String(cell).trim());
const pad = (n: number | string): string => String(n).padStart(2, '0');
const roundQty = (n: number): number => Math.round(n * 1e8) / 1e8;

/** Datele din Excel pot fi numere de serie (zile de la 30.12.1899). */
const isSerialDate = (n: number): boolean => n >= 36526 && n < 73051; // anii 2000–2099

function parseWhen(cell: XtbCell | undefined): { date: string; time: string } | null {
  if (typeof cell === 'number') {
    if (!isSerialDate(cell)) return null;
    const d = new Date(Math.round((cell - 25569) * 86_400_000));
    return {
      date: d.toISOString().slice(0, 10),
      time: d.toISOString().slice(11, 19)
    };
  }
  const s = text(cell);
  let m = s.match(DATE_DMY);
  let date: string;
  if (m) {
    date = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  } else {
    m = s.match(DATE_YMD);
    if (!m) return null;
    date = `${m[1]}-${m[2]}-${m[3]}`;
  }
  if (!isIsoDate(date)) return null;
  return { date, time: `${pad(m[4] ?? 0)}:${pad(m[5] ?? 0)}:${pad(m[6] ?? 0)}` };
}

/** Numărul dintr-o celulă; din text se elimină simbolurile monetare („1.21 EUR”). */
function parseAmount(cell: XtbCell | undefined, decimalComma: boolean): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  const s = text(cell).replace(/[^0-9.,\-\s]/g, '');
  return parseNumberLoose(s, decimalComma);
}

const num = (s: string): number => parseNumberLoose(s) ?? Number.NaN;

/* ----------------------------------------------------------------- coloane */

/** Caută rândul de antet: primul rând în care apar cel puțin trei dintre denumirile cunoscute. */
function findHeader(rows: XtbCell[][]): { index: number; columns: Columns } | null {
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const columns: Columns = {};
    rows[i].forEach((cell, col) => {
      if (typeof cell !== 'string') return;
      const key = normalizeKey(cell);
      for (const kind of Object.keys(HEADERS) as ColumnKind[]) {
        if (columns[kind] === undefined && HEADERS[kind].includes(key)) columns[kind] = col;
      }
    });
    if (Object.keys(columns).length >= 3) return { index: i, columns };
  }
  return null;
}

/**
 * Completează coloanele lipsă după conținut (pentru antete într-o limbă
 * necunoscută): comentariul conține „OPEN BUY … @ …”, data arată a dată etc.
 */
function detectByContent(rows: XtbCell[][], known: Columns): Columns {
  const columns: Columns = { ...known };
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const taken = (): Set<number> => new Set(Object.values(columns));
  const best = (score: (cell: XtbCell) => number): number | undefined => {
    let winner: number | undefined;
    let top = 0;
    for (let col = 0; col < width; col++) {
      if (taken().has(col)) continue;
      let total = 0;
      for (const r of rows) total += score(r[col] ?? null);
      if (total >= top && total > 0) {
        top = total; // la egalitate câștigă coloana din dreapta (suma stă de regulă ultima)
        winner = col;
      }
    }
    return winner;
  };
  const asNumber = (cell: XtbCell): number | null => (typeof cell === 'number' ? cell : parseNumberLoose(text(cell)));

  columns.comment ??= best((c) => (typeof c === 'string' && (TRADE.test(c) || DIVIDEND.test(c) || WHT.test(c)) ? 1 : 0));
  columns.time ??= best((c) => (parseWhen(c) ? 1 : 0));
  columns.symbol ??= best((c) => (typeof c === 'string' && STOCK_SYMBOL.test(c.trim()) ? 1 : 0));
  columns.amount ??= best((c) => {
    const n = asNumber(c);
    return n !== null && (n < 0 || !Number.isInteger(n)) ? 1 : 0;
  });
  columns.id ??= best((c) => {
    const n = asNumber(c);
    return n !== null && Number.isInteger(n) && n >= 1_000_000 ? 1 : 0;
  });
  columns.type ??= best((c) => (typeof c === 'string' && c.trim() !== '' && asNumber(c) === null ? 1 : 0));
  return columns;
}

/* ----------------------------------------------------------- operațiuni */

interface ParsedCash {
  operations: XtbOperation[];
  cash: XtbCashOperation[];
  ignored: XtbIgnored[];
}

/** Interpretează o foaie ca listă de operațiuni de numerar; null dacă nu arată a așa ceva. */
function parseCash(rows: XtbCell[][]): ParsedCash | null {
  const header = findHeader(rows);
  const data = header ? rows.slice(header.index + 1) : rows;
  const columns = detectByContent(data, header?.columns ?? {});
  if (columns.symbol === undefined && columns.name !== undefined) {
    // Exporturi în care simbolul stă chiar în coloana „Instrument”.
    const nameCol = columns.name;
    const cells = data.map((r) => text(r[nameCol])).filter(Boolean);
    if (cells.length > 0 && cells.filter((c) => STOCK_SYMBOL.test(c.toUpperCase())).length * 2 >= cells.length) {
      columns.symbol = nameCol;
      columns.name = undefined;
    }
  }
  if (columns.comment === undefined || columns.time === undefined || columns.symbol === undefined) return null;
  const at = (row: XtbCell[], kind: ColumnKind): XtbCell | undefined => (columns[kind] === undefined ? undefined : row[columns[kind]]);

  // Format european (virgulă zecimală) în tot fișierul? Contează doar la CSV, unde sumele sunt text.
  const decimalComma = usesDecimalComma(data.map((r) => at(r, 'amount')).filter((c): c is string => typeof c === 'string'));

  const trades: XtbTrade[] = [];
  const cashOps: XtbCashOperation[] = [];
  /** Dividendele se adună pe (simbol, zi): rândul de dividend și cel de impozit sunt separate în raport. */
  const dividends = new Map<string, XtbDividend>();
  const taxes: { symbol: string; date: string; amount: number }[] = [];
  const ignored = new Map<string, XtbIgnored>();
  const ignore = (label: string, symbol: string): void => {
    const entry = ignored.get(label) ?? { label, count: 0, symbols: [] };
    entry.count++;
    if (symbol && entry.symbols.length < 6 && !entry.symbols.includes(symbol)) entry.symbols.push(symbol);
    ignored.set(label, entry);
  };

  data.forEach((row, index) => {
    const rowNumber = (header ? header.index + 1 : 0) + index + 1;
    const comment = text(at(row, 'comment'));
    const symbol = text(at(row, 'symbol')).toUpperCase();
    const type = text(at(row, 'type'));
    const when = parseWhen(at(row, 'time'));
    if (!when && !symbol) return; // rând de total sau gol: fără dată și fără instrument
    const label = type || '(fără tip)';
    if (!when) return ignore(label, '');
    const rawId = at(row, 'id');
    const id = typeof rawId === 'number' ? String(Math.trunc(rawId)) : text(rawId) || `r${when.date}${when.time}-${index}`;
    const amount = parseAmount(at(row, 'amount'), decimalComma);
    const typeKey = normalizeKey(type);
    const cashKind = amount === null ? null : classifyCash(typeKey, amount);
    const pushCash = (kind: XtbCashOperation['kind']): void =>
      void cashOps.push({ kind, row: rowNumber, id, ...when, amount: Math.abs(amount as number), label, symbol: SYMBOL.test(symbol) ? symbol : '' });
    if (!SYMBOL.test(symbol)) return cashKind ? pushCash(cashKind) : ignore(label, '');

    const name = text(at(row, 'name'));
    const categoryKey = normalizeKey(text(at(row, 'category')));
    if (categoryKey.includes('cfd')) return ignore(label, symbol); // CFD-urile nu sunt dețineri
    const category = categoryKey === 'etf' ? 'etf' : categoryKey === 'stock' ? 'stock' : null;

    const trade = comment.match(TRADE);
    if (trade) {
      const quantity = num(trade[2]);
      const price = num(trade[3]);
      if (!(quantity > 0) || !(price >= 0)) return ignore(label, symbol);
      trades.push({
        kind: trade[1].toUpperCase() === 'OPEN' ? 'buy' : 'sell',
        row: rowNumber,
        id,
        ...when,
        symbol,
        name,
        category,
        quantity,
        price,
        amount: amount === null ? null : Math.abs(amount)
      });
      return;
    }

    if (WHT.test(comment) || isTaxType(typeKey)) {
      if (amount === null) return ignore(label, symbol);
      taxes.push({ symbol, date: when.date, amount: -amount });
      return;
    }

    const dividend = comment.match(DIVIDEND);
    if (dividend || isDividendType(typeKey)) {
      if (amount === null) return ignore(label, symbol);
      const perShare = dividend ? num(dividend[2]) : Number.NaN;
      const perShareCurrency = dividend ? dividend[1].toUpperCase() : null;
      const key = `${symbol}|${when.date}`;
      const existing = dividends.get(key);
      if (!existing) {
        dividends.set(key, {
          kind: 'dividend',
          row: rowNumber,
          id,
          ...when,
          symbol,
          name,
          category,
          amount,
          tax: 0,
          perShare: Number.isFinite(perShare) ? perShare : null,
          perShareCurrency
        });
      } else {
        // Două dividende în aceeași zi (ex.: obișnuit + special) devin o singură încasare.
        existing.amount += amount;
        const sameCurrency = existing.perShareCurrency === perShareCurrency;
        existing.perShare = existing.perShare !== null && Number.isFinite(perShare) && sameCurrency ? existing.perShare + perShare : null;
      }
      return;
    }

    // Comisioane legate de un instrument (ex.: comisionul SEC la vânzare).
    if (cashKind === 'fee') return pushCash('fee');
    ignore(label, symbol);
  });

  // Impozitul se atașează dividendului aceluiași instrument din aceeași zi (sau celui mai apropiat, la câteva zile).
  for (const tax of taxes) {
    let target = dividends.get(`${tax.symbol}|${tax.date}`);
    if (!target) {
      const day = Date.parse(`${tax.date}T00:00:00Z`);
      let nearest = 6 * 86_400_000;
      for (const d of dividends.values()) {
        const distance = Math.abs(Date.parse(`${d.date}T00:00:00Z`) - day);
        if (d.symbol === tax.symbol && distance < nearest) {
          nearest = distance;
          target = d;
        }
      }
    }
    if (target) target.tax += tax.amount;
    else ignore('Impozit reținut fără dividend', tax.symbol);
  }

  const operations: XtbOperation[] = [...trades];
  for (const d of dividends.values()) {
    if (d.amount > 0) operations.push({ ...d, tax: Math.min(Math.max(d.tax, 0), d.amount) });
    else ignore('Dividend corectat (sumă negativă)', d.symbol);
  }
  operations.sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.length - b.id.length || a.id.localeCompare(b.id)
  );
  cashOps.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return { operations, cash: cashOps, ignored: [...ignored.values()].sort((a, b) => b.count - a.count) };
}

/* ------------------------------------------------- metadate și verificări */

function findAccountCurrency(tables: XtbTable[], fileName: string): string | null {
  // În Excel, moneda stă lângă sau sub eticheta „Currency”, deasupra tabelului.
  for (const table of tables) {
    const rows = table.rows.slice(0, 40);
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const cell = rows[r][c];
        if (typeof cell !== 'string' || !CURRENCY_LABELS.includes(normalizeKey(cell))) continue;
        for (const candidate of [rows[r][c + 1], rows[r + 1]?.[c]]) {
          const value = text(candidate).toUpperCase();
          if (/^[A-Z]{3}$/.test(value)) return value;
        }
      }
    }
  }
  // Numele fișierului: „USD_12345678_2026-01-01_2026-11-11.xlsx” (exportul actual)
  // sau „…_2024-12-30_EUR.csv” (CSV-ul vechi).
  const name = fileName.toUpperCase();
  const m = name.match(/^([A-Z]{3})[_-]/) ?? name.match(/[_-]([A-Z]{3})\.[A-Z]+$/);
  return m && ACCOUNT_CURRENCIES.includes(m[1]) ? m[1] : null;
}

/** Cantitățile din foaia cu pozițiile deschise (dacă există și poate fi citită). */
function findOpenPositions(tables: XtbTable[]): Record<string, number> | null {
  for (const table of tables) {
    const name = normalizeKey(table.name);
    if (!['open', 'deschis', 'otwart'].some((w) => name.includes(w))) continue;
    for (let i = 0; i < Math.min(table.rows.length, 40); i++) {
      const keys = table.rows[i].map((c) => (typeof c === 'string' ? normalizeKey(c) : ''));
      const symbolCol = keys.findIndex((k) => HEADERS.symbol.includes(k));
      const volumeCol = keys.findIndex((k) => VOLUME_HEADERS.includes(k));
      if (symbolCol < 0 || volumeCol < 0) continue;
      // Exportul actual are, pe lângă rândul fiecărei poziții (Type = BUY), un rând de total pe
      // instrument (fără Type): se numără doar pozițiile, altfel cantitatea ar ieși dublă.
      const typeCol = keys.findIndex((k) => HEADERS.type.includes(k));
      const data = table.rows.slice(i + 1);
      const typed = typeCol >= 0 && data.some((row) => text(row[typeCol]) !== '');
      const totals: Record<string, number> = {};
      for (const row of data) {
        if (typed && text(row[typeCol]) === '') continue;
        const symbol = text(row[symbolCol]).toUpperCase();
        const volume = parseAmount(row[volumeCol], false);
        if (STOCK_SYMBOL.test(symbol) && volume !== null && volume > 0) totals[symbol] = roundQty((totals[symbol] ?? 0) + volume);
      }
      return Object.keys(totals).length > 0 ? totals : null;
    }
  }
  return null;
}

/**
 * Interpretează raportul. `tables` sunt foile fișierului Excel sau, pentru CSV,
 * un singur tabel; `fileName` ajută la aflarea monedei contului.
 */
export function parseXtbReport(tables: XtbTable[], fileName = ''): XtbReport {
  // Foaia cu operațiunile de numerar întâi, apoi celelalte (numele ei poate fi tradus).
  const ordered = [...tables].sort((a, b) => Number(normalizeKey(b.name).includes('cash')) - Number(normalizeKey(a.name).includes('cash')));
  let cash: ParsedCash | null = null;
  for (const table of ordered) {
    const parsed = parseCash(table.rows);
    if (parsed && parsed.operations.length + parsed.cash.length > 0) {
      cash = parsed;
      break;
    }
    cash ??= parsed;
  }
  if (!cash) {
    throw new XtbParseError(
      'Fișierul nu arată ca un raport XTB: nu am găsit lista operațiunilor (coloanele cu data, simbolul și comentariul). ' +
        'Exportă din xStation istoricul contului (operațiunile de numerar) în format Excel sau CSV.'
    );
  }
  if (cash.operations.length === 0 && cash.cash.length === 0) {
    throw new XtbParseError(
      'Raportul nu conține cumpărări, vânzări sau dividende de acțiuni și ETF-uri. ' +
        'Verifică perioada aleasă la export: trebuie să înceapă de la deschiderea contului.'
    );
  }
  return {
    accountCurrency: findAccountCurrency(tables, fileName),
    operations: cash.operations,
    cash: cash.cash,
    ignored: cash.ignored,
    openPositions: findOpenPositions(tables)
  };
}

/* ---------------------------------------------------------------- rezumat */

export interface XtbSymbolSummary {
  symbol: string;
  buys: number;
  sells: number;
  dividends: number;
  /** Cantitatea rămasă după toate operațiunile din raport. */
  quantity: number;
  /**
   * True dacă la un moment dat s-a vândut mai mult decât s-a cumpărat: raportul
   * nu acoperă toată perioada (lipsesc cumpărări) sau a existat un split.
   */
  incomplete: boolean;
  firstDate: string;
  lastDate: string;
}

/** Ce rezultă din raport pentru fiecare instrument (cantitatea deținută, numărul de operațiuni). */
export function summarizeXtbSymbols(operations: XtbOperation[]): XtbSymbolSummary[] {
  const bySymbol = new Map<string, XtbOperation[]>();
  for (const op of operations) bySymbol.set(op.symbol, [...(bySymbol.get(op.symbol) ?? []), op]);

  const out: XtbSymbolSummary[] = [];
  for (const [symbol, ops] of bySymbol) {
    // În aceeași zi, cumpărările se aplică înaintea vânzărilor (ca în motorul de calcul al aplicației).
    const order = { buy: 0, sell: 1, dividend: 2 };
    const sorted = [...ops].sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind]);
    const summary: XtbSymbolSummary = {
      symbol,
      buys: 0,
      sells: 0,
      dividends: 0,
      quantity: 0,
      incomplete: false,
      firstDate: sorted[0].date,
      lastDate: sorted[sorted.length - 1].date
    };
    for (const op of sorted) {
      if (op.kind === 'buy') {
        summary.buys++;
        summary.quantity += op.quantity;
      } else if (op.kind === 'sell') {
        summary.sells++;
        summary.quantity -= op.quantity;
        if (summary.quantity < -1e-7) summary.incomplete = true;
      } else {
        summary.dividends++;
      }
    }
    summary.quantity = roundQty(Math.max(summary.quantity, 0));
    out.push(summary);
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Cantitatea deținută dintr-un instrument la sfârșitul zilei `date`, conform raportului. */
export function xtbQuantityOn(operations: XtbOperation[], symbol: string, date: string): number {
  let quantity = 0;
  for (const op of operations) {
    if (op.symbol !== symbol || op.date > date || op.kind === 'dividend') continue;
    quantity += op.kind === 'buy' ? op.quantity : -op.quantity;
  }
  return roundQty(Math.max(quantity, 0));
}

/* ----------------------------------------------------------------- simboluri */

/** Sufixul de bursă XTB -> sufixul Yahoo Finance (formatul intern al aplicației) și moneda obișnuită. */
const EXCHANGES: Record<string, { suffix: string; currency: string }> = {
  US: { suffix: '', currency: 'USD' },
  UK: { suffix: '.L', currency: 'GBP' },
  DE: { suffix: '.DE', currency: 'EUR' },
  FR: { suffix: '.PA', currency: 'EUR' },
  NL: { suffix: '.AS', currency: 'EUR' },
  ES: { suffix: '.MC', currency: 'EUR' },
  IT: { suffix: '.MI', currency: 'EUR' },
  BE: { suffix: '.BR', currency: 'EUR' },
  PT: { suffix: '.LS', currency: 'EUR' },
  FI: { suffix: '.HE', currency: 'EUR' },
  AT: { suffix: '.VI', currency: 'EUR' },
  IE: { suffix: '.IR', currency: 'EUR' },
  CH: { suffix: '.SW', currency: 'CHF' },
  PL: { suffix: '.WA', currency: 'PLN' },
  CZ: { suffix: '.PR', currency: 'CZK' },
  SE: { suffix: '.ST', currency: 'SEK' },
  DK: { suffix: '.CO', currency: 'DKK' },
  NO: { suffix: '.OL', currency: 'NOK' },
  RO: { suffix: '.RO', currency: 'RON' }
};

/** Instrumente pe care XTB le numește altfel decât bursa (clase de acțiuni, simboluri vechi). */
const ALIASES: Record<string, { symbol: string; currency: string }> = {
  'GOOGC.US': { symbol: 'GOOG', currency: 'USD' }, // Alphabet clasa C
  'BRKB.US': { symbol: 'BRK-B', currency: 'USD' },
  'BRKA.US': { symbol: 'BRK-A', currency: 'USD' },
  'FB.US': { symbol: 'META', currency: 'USD' } // simbolul Meta dinainte de 2022
};

/**
 * Propune simbolul din aplicație (format Yahoo Finance) și moneda pentru un
 * simbol XTB: „AAPL.US” -> AAPL (USD), „CSPX.UK” -> CSPX.L, „VWCE.DE” -> VWCE.DE (EUR).
 * Este doar o propunere: moneda reală se confirmă la furnizorul de prețuri,
 * iar utilizatorul poate corecta simbolul înainte de import.
 */
export function mapXtbSymbol(xtbSymbol: string): { symbol: string; currency: string } {
  // Unele exporturi adaugă un sufix intern: „AAPL.US_9”.
  const clean = xtbSymbol.trim().toUpperCase().replace(/_\d+$/, '');
  const alias = ALIASES[clean];
  if (alias) return alias;
  const dot = clean.lastIndexOf('.');
  if (dot <= 0) return { symbol: clean, currency: 'USD' };
  const exchange = EXCHANGES[clean.slice(dot + 1)];
  if (!exchange) return { symbol: clean, currency: 'EUR' };
  return { symbol: clean.slice(0, dot) + exchange.suffix, currency: exchange.currency };
}
