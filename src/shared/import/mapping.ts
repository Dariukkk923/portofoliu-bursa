/**
 * Importul universal: orice CSV (sau foaie Excel) cu o operațiune pe rând.
 *
 * Utilizatorul spune o singură dată ce coloană conține data, tipul, simbolul,
 * cantitatea, prețul, comisionul, moneda… (aplicația propune maparea după
 * denumirile coloanelor) și ce înseamnă valorile din coloana de tip, dacă nu
 * sunt recunoscute singure. Maparea se salvează ca șablon și se aplică automat
 * fișierelor cu același antet.
 */
import { normalizeKey } from '../csv';
import { dec } from '../calc/decimal';
import { IgnoredCounter, statementRow, type Cell, type Statement, type StatementKind, type StatementRow, type Table } from './statement';
import { cellText, classifyKind, cleanCurrency, detectDateOrder, detectDecimalComma, guessSymbol, isIsin, parseDecimal, parseWhen, type DateOrder } from './values';

export type MappedField = 'date' | 'type' | 'symbol' | 'isin' | 'name' | 'quantity' | 'price' | 'amount' | 'fee' | 'tax' | 'currency';

export const MAPPED_FIELDS: { field: MappedField; label: string; hint: string }[] = [
  { field: 'date', label: 'Data', hint: 'obligatoriu' },
  { field: 'type', label: 'Tipul operațiunii', hint: 'cumpărare, vânzare, dividend…' },
  { field: 'symbol', label: 'Simbol', hint: 'ex.: AAPL, SNP' },
  { field: 'isin', label: 'ISIN', hint: 'opțional' },
  { field: 'name', label: 'Denumire', hint: 'opțional' },
  { field: 'quantity', label: 'Cantitate', hint: 'număr de unități' },
  { field: 'price', label: 'Preț', hint: 'pe unitate' },
  { field: 'amount', label: 'Sumă totală', hint: 'la dividende, depuneri…' },
  { field: 'fee', label: 'Comision', hint: 'opțional' },
  { field: 'tax', label: 'Impozit reținut', hint: 'opțional' },
  { field: 'currency', label: 'Monedă', hint: 'ex.: RON, USD' }
];

/** Maparea coloanelor unui fișier; coloanele se rețin după denumirea normalizată din antet. */
export interface ColumnMapping {
  columns: Partial<Record<MappedField, string>>;
  dateOrder: DateOrder;
  decimalComma: boolean;
  /** Ce înseamnă valorile din coloana de tip (valoare normalizată -> tip sau „ignore”); restul se recunosc singure. */
  types: Record<string, StatementKind | 'ignore'>;
  /** Moneda folosită când fișierul nu are coloană de monedă. */
  defaultCurrency: string | null;
}

export interface GenericTable {
  sheet: string;
  /** Denumirile coloanelor, așa cum apar în fișier, și forma lor normalizată. */
  headers: string[];
  keys: string[];
  /** Rândul antetului în fișier (primul rând = 1). */
  headerLine: number;
  rows: Cell[][];
}

/** Antetul: primul rând (din primele 30) cu cel puțin trei celule de text, urmat de rânduri cu date. */
export function extractTable(tables: Table[]): GenericTable | null {
  let best: GenericTable | null = null;
  for (const table of tables) {
    for (let i = 0; i < Math.min(table.rows.length, 30); i++) {
      const row = table.rows[i];
      const texts = row.filter((c) => typeof c === 'string' && c.trim() !== '' && parseDecimal(c) === null);
      if (texts.length < 3 || i + 1 >= table.rows.length) continue;
      const headers = row.map((c) => cellText(c));
      const candidate: GenericTable = {
        sheet: table.name,
        headers,
        keys: headers.map((h) => normalizeKey(h)),
        headerLine: i + 1,
        rows: table.rows.slice(i + 1).filter((r) => r.some((c) => cellText(c) !== ''))
      };
      if (!best || candidate.rows.length > best.rows.length) best = candidate;
      break;
    }
  }
  return best;
}

/** Amprenta antetului: fișierele cu aceleași coloane primesc automat același șablon. */
export const headerSignature = (keys: string[]): string => keys.filter(Boolean).join('|');

const SYNONYMS: Record<MappedField, string[]> = {
  date: ['data', 'date', 'datetime', 'dataora', 'tradedate', 'datatranzactiei', 'datatranzactie', 'dataoperatiunii', 'dataexecutiei', 'datadecontarii', 'settledate', 'time', 'datum', 'fecha'],
  type: ['tip', 'type', 'tipoperatiune', 'tipoperatie', 'operatiune', 'operatie', 'tiptranzactie', 'tranzactie', 'transactiontype', 'action', 'side', 'sens', 'directie', 'buy/sell'],
  symbol: ['simbol', 'symbol', 'ticker', 'instrument', 'codinstrument', 'cod', 'titlu', 'emitent', 'security'],
  isin: ['isin', 'codisin'],
  name: ['nume', 'name', 'denumire', 'denumireinstrument', 'companie', 'securityname', 'descriere', 'description'],
  quantity: ['cantitate', 'quantity', 'qty', 'shares', 'nractiuni', 'numaractiuni', 'units', 'unitati', 'volum', 'volume', 'no.ofshares', 'bucati'],
  price: ['pret', 'price', 'pretunitar', 'pricepershare', 'price/share', 'unitprice', 'pretexecutie', 'pretpeactiune'],
  amount: ['suma', 'total', 'valoare', 'amount', 'valoaretotala', 'sumatotala', 'totalamount', 'netamount', 'valoareneta', 'sumaneta', 'valoarebruta'],
  fee: ['comision', 'comisioane', 'fee', 'fees', 'commission', 'comm', 'comm/fee'],
  tax: ['impozit', 'impozitretinut', 'tax', 'withholdingtax', 'wht'],
  currency: ['moneda', 'currency', 'valuta', 'ccy', 'devize']
};

/** Propune maparea după denumirile coloanelor și formatul valorilor (ordinea zilei și a lunii, virgula zecimală). */
export function guessMapping(t: GenericTable): ColumnMapping {
  const columns: ColumnMapping['columns'] = {};
  const taken = new Set<string>();
  const fields = Object.keys(SYNONYMS) as MappedField[];
  // Întâi potrivirile exacte, apoi cele parțiale („Preț unitar (RON)” -> preț).
  for (const exact of [true, false]) {
    for (const field of fields) {
      if (columns[field]) continue;
      const key = t.keys.find((k) => k && !taken.has(k) && SYNONYMS[field].some((s) => (exact ? k === s : k.startsWith(s) || (s.length >= 5 && k.includes(s)))));
      if (key) {
        columns[field] = key;
        taken.add(key);
      }
    }
  }
  const col = (field: MappedField): number => (columns[field] ? t.keys.indexOf(columns[field] as string) : -1);
  const values = (field: MappedField): Cell[] => (col(field) < 0 ? [] : t.rows.map((r) => r[col(field)] ?? null));
  return {
    columns,
    dateOrder: detectDateOrder(values('date')).order,
    decimalComma: detectDecimalComma([...values('quantity'), ...values('price'), ...values('amount'), ...values('fee'), ...values('tax')]),
    types: {},
    defaultCurrency: null
  };
}

/** Valorile distincte din coloana de tip, cu ce înseamnă (după mapare sau recunoscute singure). */
export function typeValues(t: GenericTable, mapping: ColumnMapping): { value: string; key: string; count: number; kind: StatementKind | 'ignore' | null }[] {
  const c = mapping.columns.type ? t.keys.indexOf(mapping.columns.type) : -1;
  if (c < 0) return [];
  const counts = new Map<string, { value: string; count: number }>();
  for (const row of t.rows) {
    const value = cellText(row[c]);
    if (!value) continue;
    const key = normalizeKey(value);
    const entry = counts.get(key) ?? { value, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts]
    .map(([key, { value, count }]) => ({ value, key, count, kind: mapping.types[key] ?? classifyKind(value) }))
    .sort((a, b) => b.count - a.count);
}

/** Citește tabelul cu maparea dată. Rândurile cu probleme apar în previzualizare ca erori. */
export function readWithMapping(t: GenericTable, mapping: ColumnMapping, label = 'Fișier cu mapare proprie'): Statement {
  const index = (field: MappedField): number => (mapping.columns[field] ? t.keys.indexOf(mapping.columns[field] as string) : -1);
  const col = Object.fromEntries((Object.keys(SYNONYMS) as MappedField[]).map((f) => [f, index(f)])) as Record<MappedField, number>;
  const at = (row: Cell[], field: MappedField): Cell => (col[field] < 0 ? null : (row[col[field]] ?? null));
  const num = (row: Cell[], field: MappedField): string | null => parseDecimal(at(row, field), mapping.decimalComma);
  const abs = (v: string | null): string | null => (v === null ? null : dec(v).abs().toString());

  const rows: StatementRow[] = [];
  const problems: Statement['problems'] = [];
  const ignored = new IgnoredCounter();
  const currencies = new Set<string>();

  if (col.date < 0) problems.push({ line: t.headerLine, message: 'Alege coloana cu data operațiunii.' });

  t.rows.forEach((row, i) => {
    const line = t.headerLine + i + 1;
    if (col.date < 0) return;
    const when = parseWhen(at(row, 'date'), mapping.dateOrder);
    if (!when) {
      // Rândurile de total de la final nu au dată și nici instrument.
      if (cellText(at(row, 'symbol')) || cellText(at(row, 'type'))) problems.push({ line, message: `Data „${cellText(at(row, 'date'))}” nu poate fi citită.` });
      return;
    }
    const quantityRaw = num(row, 'quantity');
    let kind: StatementKind | null;
    if (col.type >= 0) {
      const typeText = cellText(at(row, 'type'));
      const mapped = mapping.types[normalizeKey(typeText)] ?? classifyKind(typeText);
      if (mapped === 'ignore') return ignored.add(typeText);
      if (!mapped) return void problems.push({ line, message: `Tipul „${typeText || '(gol)'}” nu este recunoscut: alege ce înseamnă în lista tipurilor.` });
      kind = mapped;
    } else {
      // Fără coloană de tip: cantitate pozitivă = cumpărare, negativă = vânzare.
      if (quantityRaw === null || dec(quantityRaw).isZero()) return void problems.push({ line, message: 'Fără coloană de tip, fiecare rând are nevoie de cantitate (cu minus la vânzări).' });
      kind = dec(quantityRaw).isNegative() ? 'sell' : 'buy';
    }

    const symbolText = cellText(at(row, 'symbol')).toUpperCase();
    const isinText = cellText(at(row, 'isin')).toUpperCase();
    const isin = isIsin(isinText) ? isinText : isIsin(symbolText) ? symbolText : null;
    const symbol = symbolText && !isIsin(symbolText) ? symbolText : null;
    const currency = cleanCurrency(at(row, 'currency')) ?? mapping.defaultCurrency;
    if (currency) currencies.add(currency);
    const name = cellText(at(row, 'name')) || null;
    const quantity = abs(quantityRaw);
    const fee = abs(num(row, 'fee'));
    const tax = abs(num(row, 'tax'));
    const amount = abs(num(row, 'amount'));
    let price = abs(num(row, 'price'));
    const instrument = { symbol: symbol ?? isin, isin, name, guess: symbol ? guessSymbol(symbol, { currency, isin }) : null };
    const needsInstrument = kind === 'buy' || kind === 'sell' || kind === 'dividend' || kind === 'coupon' || kind === 'split';
    if (needsInstrument && !instrument.symbol) return void problems.push({ line, message: 'Lipsește simbolul (sau ISIN-ul) instrumentului.' });

    switch (kind) {
      case 'buy':
      case 'sell': {
        if (quantity === null || dec(quantity).isZero()) return void problems.push({ line, message: 'Lipsește cantitatea.' });
        if (price === null && amount !== null) {
          // Prețul din suma totală: la cumpărare suma include comisionul, la vânzare îl are deja scăzut.
          const net = kind === 'buy' ? dec(amount).minus(fee ?? 0) : dec(amount).plus(fee ?? 0);
          price = net.div(quantity).toDecimalPlaces(10).toString();
        }
        if (price === null) return void problems.push({ line, message: 'Lipsește prețul (sau suma totală).' });
        rows.push(statementRow({ line, kind, ...when, ...instrument, quantity, price, fee, currency }));
        return;
      }
      case 'dividend':
      case 'coupon':
      case 'interest': {
        // Fără sumă: dividendul pe acțiune × numărul de acțiuni.
        const gross = amount ?? (quantity !== null && price !== null ? dec(quantity).times(price).toString() : null);
        if (gross === null || dec(gross).isZero()) return void problems.push({ line, message: 'Lipsește suma.' });
        rows.push(statementRow({ line, kind, ...when, ...(kind === 'interest' ? {} : instrument), currency, amount: gross, tax }));
        return;
      }
      case 'tax': {
        const value = amount ?? tax;
        if (value === null) return void problems.push({ line, message: 'Lipsește suma impozitului.' });
        rows.push(statementRow({ line, kind, ...when, ...instrument, currency, amount: value }));
        return;
      }
      case 'split':
        if (quantityRaw === null || dec(quantityRaw).isZero()) return void problems.push({ line, message: 'Split-ul are nevoie de cantitatea primită (acțiunile noi).' });
        rows.push(statementRow({ line, kind, ...when, ...instrument, quantity: quantityRaw }));
        return;
      default: {
        if (amount === null || dec(amount).isZero()) return void problems.push({ line, message: 'Lipsește suma.' });
        rows.push(statementRow({ line, kind, ...when, currency, amount, symbol: null, note: name }));
      }
    }
  });

  return {
    format: 'csv',
    formatLabel: label,
    brokerName: '',
    accountCurrency: currencies.size === 1 ? [...currencies][0] : mapping.defaultCurrency,
    rows,
    problems,
    ignored: ignored.list(),
    warnings: [],
    openPositions: null
  };
}
