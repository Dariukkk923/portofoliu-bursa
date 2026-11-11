/**
 * Importul din extrasele brokerilor (XTB, Trading 212, Revolut, Interactive
 * Brokers sau orice CSV/Excel prin maparea coloanelor).
 *
 * Totul se întâmplă local: fișierul ales este citit în memorie și nu este trimis
 * nicăieri; la furnizorul de prețuri se cer doar simbolurile instrumentelor noi,
 * ca să le confirme moneda și tipul. Aplicația nu se conectează la contul de la
 * broker și nu cere parola lui.
 *
 * Pașii:
 *  1. `openImport` citește fișierul și îi recunoaște formatul după structură;
 *     la un format necunoscut întoarce coloanele, ca utilizatorul să le mapeze;
 *  2. `previewImport` arată ce s-ar importa, fără să scrie nimic: fiecare rând
 *     este nou, dublură (există deja), eroare sau ignorat, iar instrumentele
 *     neidentificate sunt marcate ca utilizatorul să spună ce simbol au;
 *  3. `applyImport` salvează tot ca un lot, într-o singură tranzacție SQL;
 *  4. `undoImport` anulează complet un lot (inclusiv activele create și
 *     tranzacțiile manuale înlocuite, care sunt puse la loc).
 *
 * Dublurile: o operațiune este deja în aplicație dacă are același identificator
 * de la broker sau aceeași dată, același instrument, aceeași cantitate și același
 * preț (sumă, la dividende și cash). Fiecare tranzacție existentă „acoperă” un
 * singur rând din fișier, deci două cumpărări identice în aceeași zi rămân două.
 */
import type {
  Asset,
  AssetType,
  Broker,
  ImportBatchView,
  ImportInstrument,
  ImportOptions,
  ImportPreview,
  ImportPreviewRow,
  ImportResult,
  ImportRowStatus,
  ImportSessionView,
  ImportTemplate,
  SymbolSearchResult
} from '@shared/types';
import { parseCsv, normalizeKey } from '@shared/csv';
import { addDays, daysBetween } from '@shared/dates';
import {
  detectReader,
  extractTable,
  guessMapping,
  guessSymbol,
  headerSignature,
  readWithMapping,
  sortRows,
  StatementError,
  STATEMENT_KIND_LABEL,
  typeValues,
  type ColumnMapping,
  type GenericTable,
  type Statement,
  type StatementKind,
  type StatementRow,
  type Table
} from '@shared/import';
import { Ledger, roundQty, sortTransactions, splitFactorExact, validateLedger, type LedgerTx } from '@shared/calc';
import { dec, Decimal, toNum, ZERO } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { looksLikeZip, readXlsx } from '../xlsx';
import { getCachedPrices, resolveFx, type CachedPrice } from '../prices/store';
import { AppError, assert, rowToAsset, rowToBroker, rowToLedgerTx } from './common';
import { createAsset, findAssetBySymbol, getAsset } from './assets';
import { createBroker, findBrokerByName, getBroker } from './brokers';
import { getPortfolio, resolvePortfolioId } from './portfolios';
import { getSettings } from './settings';
import { ensureValidLedger, importTransactions, invalidateHistory, ledgerOf, type ImportedTransaction } from './transactions';

const MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 5000;
type Row = Record<string, unknown>;

/* ------------------------------------------------------------ citirea fișierului */

/** Textul unui CSV: UTF-8, UTF-16 sau (exporturile vechi din Excel) Windows-1250. */
function decodeText(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  const utf8 = data.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('windows-1250').decode(data);
  } catch {
    return data.toString('latin1');
  }
}

/** Foile fișierului Excel sau conținutul CSV-ului. Erorile au mesaje gata de afișat. */
export function readImportFile(data: Buffer): Table[] {
  assert(data.length > 0, 'Fișierul ales este gol.');
  assert(data.length <= MAX_FILE_BYTES, 'Fișierul este prea mare pentru un extras de cont.');
  if (looksLikeZip(data)) {
    try {
      return readXlsx(data);
    } catch {
      throw new AppError('Fișierul Excel nu a putut fi citit. Exportă din nou extrasul și încearcă iar.');
    }
  }
  if (data.subarray(0, 4).toString('latin1') === '%PDF') {
    throw new AppError('Extrasele în format PDF nu pot fi citite. Exportă-le din aplicația brokerului în format CSV sau Excel (.xlsx).');
  }
  if (data.length >= 4 && data.readUInt32BE(0) === 0xd0cf11e0) {
    throw new AppError('Formatul Excel vechi (.xls) nu este acceptat. Deschide fișierul în Excel și salvează-l ca .xlsx sau .csv.');
  }
  const text = decodeText(data);
  if (/<html|<table/i.test(text.slice(0, 4000))) {
    throw new AppError('Extrasul în format HTML nu poate fi citit. Exportă-l în format CSV sau Excel (.xlsx).');
  }
  return [{ name: '', rows: parseCsv(text) }];
}

/* -------------------------------------------------------------------- sesiunea */

/** Ce știe furnizorul de prețuri despre un simbol. */
export interface SymbolInfo {
  name?: string | null;
  currency: string | null;
  assetType?: AssetType | null;
}

export interface ImportLookup {
  quotes(symbols: string[]): Promise<{ quotes: Map<string, SymbolInfo>; offline: boolean }>;
  search(query: string): Promise<SymbolSearchResult[]>;
}

/** Fișierul citit, păstrat în memorie între previzualizare și import. */
export interface ImportSession {
  token: string;
  userId: number;
  fileName: string;
  generic: GenericTable | null;
  mapping: ColumnMapping | null;
  templateId: number | null;
  templateName: string | null;
  statement: Statement | null;
  /** Răspunsurile furnizorului de prețuri (null = simbol negăsit), ca să nu fie cerute de două ori. */
  info: Map<string, SymbolInfo | null>;
  /** Simbolul găsit pentru un ISIN (null = negăsit). */
  isinSymbols: Map<string, string | null>;
  offline: boolean;
}

function templateFor(db: Db, userId: number, signature: string): { id: number; name: string; mapping: ColumnMapping } | null {
  const r = db.prepare('SELECT id, name, mapping FROM import_templates WHERE user_id = ? AND signature = ?').get(userId, signature) as
    | { id: number; name: string; mapping: string }
    | undefined;
  if (!r) return null;
  try {
    return { id: r.id, name: r.name, mapping: JSON.parse(r.mapping) as ColumnMapping };
  } catch {
    return null;
  }
}

/** Pasul 1: citește fișierul și îi recunoaște formatul. */
export function openImport(db: Db, userId: number, tables: Table[], fileName: string, token: string): ImportSession {
  const session: ImportSession = {
    token,
    userId,
    fileName,
    generic: null,
    mapping: null,
    templateId: null,
    templateName: null,
    statement: null,
    info: new Map(),
    isinSymbols: new Map(),
    offline: false
  };
  const reader = detectReader(tables, fileName);
  if (reader) {
    try {
      session.statement = reader.read(tables, fileName);
    } catch (err) {
      if (err instanceof StatementError) throw new AppError(err.message);
      throw err;
    }
    return session;
  }
  const generic = extractTable(tables);
  assert(generic && generic.rows.length > 0, 'Fișierul nu conține un tabel cu operațiuni (un antet și cel puțin un rând de date).');
  session.generic = generic;
  const template = templateFor(db, userId, headerSignature(generic.keys));
  if (template) {
    session.mapping = template.mapping;
    session.templateId = template.id;
    session.templateName = template.name;
    session.statement = readWithMapping(generic, template.mapping, `Șablon „${template.name}”`);
  } else {
    session.mapping = guessMapping(generic);
  }
  return session;
}

/* -------------------------------------------------------------- instrumentele */

interface Instrument {
  key: string;
  brokerSymbol: string | null;
  isin: string | null;
  name: string | null;
  rows: StatementRow[];
  asset: Asset | null;
  proposal: { symbol: string; currency: string; type: AssetType; name: string; confirmed: boolean } | null;
  status: ImportInstrument['status'];
  /** Id provizoriu (negativ) pentru activele care se vor crea. */
  ledgerId: number;
}

const ASSET_KINDS: StatementKind[] = ['buy', 'sell', 'dividend', 'coupon', 'split'];
const keyOf = (row: StatementRow): string | null => row.symbol ?? row.isin ?? null;
const cleanSymbol = (s: string): string => s.trim().toUpperCase();
const validSymbol = (s: string): boolean => /^[A-Z0-9.\-=^_/]{1,24}$/.test(s);

function savedAsset(db: Db, userId: number, source: string, key: string): Asset | null {
  const r = db
    .prepare(
      `SELECT a.* FROM broker_symbols s JOIN assets a ON a.id = s.asset_id AND a.user_id = s.user_id
       WHERE s.user_id = ? AND s.source = ? AND s.broker_symbol = ?`
    )
    .get(userId, source, key) as Row | undefined;
  return r ? rowToAsset(r) : null;
}

function assetByIsin(db: Db, userId: number, isin: string): Asset | null {
  const r = db.prepare('SELECT * FROM assets WHERE user_id = ? AND isin = ? ORDER BY id LIMIT 1').get(userId, isin) as Row | undefined;
  return r ? rowToAsset(r) : (savedAsset(db, userId, 'isin', isin) ?? null);
}

/** Simbolul propus pentru un instrument nou: răspunsul utilizatorului, ghicirea cititorului sau simbolul găsit după ISIN. */
function proposedSymbol(session: ImportSession, inst: { key: string; isin: string | null; rows: StatementRow[] }, answer: string | undefined): string {
  if (answer) return cleanSymbol(answer);
  const guess = inst.rows.find((r) => r.guess)?.guess;
  if (guess && (session.info.get(guess.symbol) || !inst.isin)) return guess.symbol;
  if (inst.isin) {
    const found = session.isinSymbols.get(inst.isin);
    if (found) return found;
  }
  return guess?.symbol ?? cleanSymbol(inst.key);
}

/** Pasul de rețea: confirmă la furnizorul de prețuri simbolurile instrumentelor noi (și le caută după ISIN). */
async function lookupSymbols(db: Db, userId: number, session: ImportSession, statement: Statement, options: ImportOptions, lookup: ImportLookup): Promise<void> {
  const groups = new Map<string, { key: string; isin: string | null; rows: StatementRow[] }>();
  for (const row of statement.rows) {
    const key = keyOf(row);
    if (!key) continue;
    const g = groups.get(key) ?? { key, isin: row.isin, rows: [] };
    g.isin ??= row.isin;
    g.rows.push(row);
    groups.set(key, g);
  }
  const wanted = new Set<string>();
  for (const g of groups.values()) {
    const answer = options.symbols?.[g.key];
    if (answer === '') continue;
    if (!answer && (savedAsset(db, userId, statement.format, g.key) || (g.isin && assetByIsin(db, userId, g.isin)))) continue;
    for (const s of [answer, g.rows.find((r) => r.guess)?.guess?.symbol].filter((x): x is string => !!x)) {
      const symbol = cleanSymbol(s);
      if (!findAssetBySymbol(db, userId, symbol) && !session.info.has(symbol)) wanted.add(symbol);
    }
  }
  if (wanted.size > 0) {
    try {
      const { quotes, offline } = await lookup.quotes([...wanted]);
      session.offline = offline;
      for (const s of wanted) session.info.set(s, quotes.get(s) ?? null);
    } catch {
      session.offline = true;
    }
  }
  // Instrumentele negăsite după simbol, dar cu ISIN: căutare după ISIN (ex.: ETF-uri listate la mai multe burse).
  if (session.offline) return;
  for (const g of groups.values()) {
    if (!g.isin || options.symbols?.[g.key] !== undefined || session.isinSymbols.has(g.isin)) continue;
    const guess = g.rows.find((r) => r.guess)?.guess;
    if (guess && (session.info.get(guess.symbol) || findAssetBySymbol(db, userId, guess.symbol))) continue;
    if (savedAsset(db, userId, statement.format, g.key) || assetByIsin(db, userId, g.isin)) continue;
    let found: string | null = null;
    try {
      const results = await lookup.search(g.isin);
      const currency = g.rows.find((r) => r.currency)?.currency;
      found = (results.find((r) => !currency || r.currency === currency) ?? results[0])?.symbol ?? null;
      if (found && !session.info.has(found)) {
        const { quotes } = await lookup.quotes([found]);
        session.info.set(found, quotes.get(found) ?? null);
      }
    } catch {
      // fără rezultat: instrumentul rămâne neconfirmat
    }
    session.isinSymbols.set(g.isin, found);
  }
}

/* -------------------------------------------------------------------- planul */

interface Planned {
  row: StatementRow;
  /** Rândurile din fișier comasate în această tranzacție (ex.: dividendul și impozitul lui). */
  lines: number[];
  instrument: Instrument | null;
  input: ImportedTransaction | null;
  status: ImportRowStatus;
  message: string | null;
  approximate: boolean;
}

interface Plan {
  statement: Statement;
  broker: Broker | null;
  brokerName: string;
  portfolioId: number;
  accountCurrency: string;
  instruments: Instrument[];
  planned: Planned[];
  /** Tranzacțiile manuale care se înlocuiesc (pe activ). */
  replaceIds: number[];
  manualCount: number;
}

const round2 = (d: Decimal): Decimal => d.toDecimalPlaces(2);
const text = (d: Decimal | null): string | null => (d === null ? null : d.toString());

/** Brokerul importului: cel ales, cel cu numele dat sau cel al formatului (ex.: un broker al cărui nume conține „XTB”). */
function chooseBroker(db: Db, userId: number, statement: Statement, options: ImportOptions): { broker: Broker | null; name: string } {
  if (options.brokerId) {
    const b = getBroker(db, userId, options.brokerId);
    assert(b, 'Brokerul ales nu a fost găsit.');
    return { broker: b, name: b.name };
  }
  const requested = options.brokerName?.trim();
  if (requested) return { broker: findBrokerByName(db, userId, requested), name: requested };
  if (statement.brokerName) {
    const exact = findBrokerByName(db, userId, statement.brokerName);
    if (exact) return { broker: exact, name: exact.name };
    const word = statement.brokerName.split(' ')[0];
    const r = db.prepare("SELECT * FROM brokers WHERE user_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY id LIMIT 1").get(userId, `%${word.replace(/[\\%_]/g, '\\$&')}%`) as
      | Row
      | undefined;
    if (r) {
      const b = rowToBroker(r);
      return { broker: b, name: b.name };
    }
    return { broker: null, name: statement.brokerName };
  }
  const first = db.prepare('SELECT * FROM brokers WHERE user_id = ? ORDER BY id LIMIT 1').get(userId) as Row | undefined;
  if (first) {
    const b = rowToBroker(first);
    return { broker: b, name: b.name };
  }
  return { broker: null, name: 'Broker' };
}

/** Comasează dividendele din aceeași zi și atașează impozitul reținut dividendului (sau dobânzii) la care se referă. */
function mergeRows(rows: StatementRow[]): { merged: { row: StatementRow; lines: number[] }[]; orphanTaxes: StatementRow[] } {
  const out: { row: StatementRow; lines: number[] }[] = [];
  const incomeByKey = new Map<string, { row: StatementRow; lines: number[] }>();
  const taxes: StatementRow[] = [];
  for (const row of sortRows(rows)) {
    if (row.kind === 'tax') {
      taxes.push(row);
      continue;
    }
    if (row.kind === 'dividend' || row.kind === 'coupon') {
      const key = `${row.kind}|${keyOf(row)}|${row.date}|${row.currency}`;
      const existing = incomeByKey.get(key);
      if (existing) {
        const e = existing.row;
        e.amount = dec(e.amount ?? 0).plus(row.amount ?? 0).toString();
        e.tax = dec(e.tax ?? 0).plus(row.tax ?? 0).toString();
        e.cashAmount = e.cashAmount === null && row.cashAmount === null ? null : dec(e.cashAmount ?? 0).plus(row.cashAmount ?? 0).toString();
        e.perShare = e.perShare !== null && row.perShare !== null && e.perShareCurrency === row.perShareCurrency ? dec(e.perShare).plus(row.perShare).toString() : e.perShare;
        existing.lines.push(row.line);
        continue;
      }
      const entry = { row: { ...row }, lines: [row.line] };
      incomeByKey.set(key, entry);
      out.push(entry);
      continue;
    }
    out.push({ row: { ...row }, lines: [row.line] });
  }
  const orphanTaxes: StatementRow[] = [];
  for (const tax of taxes) {
    const key = keyOf(tax);
    const day = Date.parse(`${tax.date}T00:00:00Z`);
    let target: { row: StatementRow; lines: number[] } | null = null;
    let best = 7 * 86_400_000;
    for (const e of out) {
      const r = e.row;
      const fits = key ? (r.kind === 'dividend' || r.kind === 'coupon') && keyOf(r) === key : r.kind === 'interest' && !keyOf(r);
      if (!fits || (tax.currency && r.currency && tax.currency !== r.currency)) continue;
      const distance = Math.abs(Date.parse(`${r.date}T00:00:00Z`) - day);
      if (distance < best) {
        best = distance;
        target = e;
      }
    }
    if (!target) {
      orphanTaxes.push(tax);
      continue;
    }
    target.row.tax = dec(target.row.tax ?? 0).plus(tax.amount ?? 0).toString();
    // Impozitul nu scade de două ori: suma mișcată în cont scade doar dacă rândul de impozit nu era deja inclus.
    if (target.row.cashAmount !== null && tax.cashAmount === null) target.row.cashAmount = dec(target.row.cashAmount).minus(tax.amount ?? 0).toString();
    target.lines.push(tax.line);
  }
  return { merged: out, orphanTaxes };
}

/** Semnătura unei tranzacții pentru recunoașterea dublurilor (dată, tip, activ, cantitate, preț sau sumă). */
function signature(t: {
  type: string;
  assetId: number | null;
  date: string;
  currency?: string | null;
  quantity?: unknown;
  price?: unknown;
  grossAmount?: unknown;
  netAmount?: unknown;
  amount?: unknown;
  splitNumerator?: unknown;
  splitDenominator?: unknown;
}): string {
  const d = (v: unknown, places: number): string => (v === null || v === undefined || v === '' ? '0' : dec(v as string).toDecimalPlaces(places).toString());
  switch (t.type) {
    case 'buy':
    case 'sell':
      return `${t.type}|${t.assetId}|${t.date}|${d(t.quantity, 8)}|${d(t.price, 4)}`;
    case 'dividend':
    case 'coupon':
      return `${t.type}|${t.assetId}|${t.date}|${d(t.grossAmount, 2)}`;
    case 'split':
      return `split|${t.assetId}|${t.date}|${dec(d(t.splitNumerator, 8)).div(d(t.splitDenominator, 8)).toDecimalPlaces(8).toString()}`;
    case 'interest':
      return `interest|${t.currency}|${t.date}|${d(t.grossAmount ?? t.amount, 2)}`;
    default:
      return `${t.type}|${t.assetId ?? ''}|${t.currency}|${t.date}|${d(t.amount ?? t.netAmount, 2)}`;
  }
}

/** Cantitatea deținută (la broker, în portofoliu) în ultimele săptămâni dinaintea unei date: candidații pentru dividend. */
function holdingLevels(txs: LedgerTx[], date: string): Decimal[] {
  const from = addDays(date, -45);
  const levels: Decimal[] = [];
  let q = ZERO;
  for (const t of sortTransactions(txs)) {
    if (t.date > date) break;
    if (t.date >= from && q.gt(0)) levels.push(q);
    if (t.type === 'buy') q = q.plus(dec(t.quantity));
    else if (t.type === 'sell') q = Decimal.max(q.minus(dec(t.quantity)), ZERO);
    else if (t.type === 'split') q = q.times(splitFactorExact(t));
  }
  if (q.gt(0)) levels.push(q);
  return levels;
}

/** Cursurile efective din fișier (moneda activului -> moneda contului), din sumele cumpărărilor și vânzărilor. */
type Rates = Map<string, { date: string; rate: Decimal }[]>;

function nearestRate(rates: Rates, from: string, to: string, date: string): Decimal | null {
  let best: { date: string; rate: Decimal } | null = null;
  for (const p of rates.get(`${from}>${to}`) ?? []) {
    if (!best || Math.abs(daysBetween(p.date, date)) < Math.abs(daysBetween(best.date, date))) best = p;
  }
  return best?.rate ?? null;
}

const median = (values: Decimal[]): Decimal => [...values].sort((a, b) => a.comparedTo(b))[Math.floor(values.length / 2)];

/** Moneda contului, când fișierul nu o spune: moneda în care cursurile din fișier seamănă cel mai bine cu cele cunoscute. */
function inferAccountCurrency(trades: { currency: string; date: string; rate: Decimal }[], cache: Map<string, CachedPrice>, fallback: string): string {
  const byCurrency = new Map<string, Decimal[]>();
  for (const t of trades) byCurrency.set(t.currency, [...(byCurrency.get(t.currency) ?? []), t.rate]);
  const medians = [...byCurrency].map(([currency, rates]) => ({ currency, rate: median(rates) }));
  if (medians.length === 0) return fallback;
  const same = medians.find((m) => m.rate.minus(1).abs().lte(0.015));
  if (same) return same.currency;
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of new Set(['RON', 'EUR', 'USD', fallback])) {
    let distance = 0;
    for (const m of medians) distance += Math.abs(Math.log(toNum(m.rate) / resolveFx(cache, m.currency, candidate).rate));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Calculul complet al importului (fără nicio scriere). Rulează la fiecare previzualizare și, din nou, la import. */
function buildPlan(db: Db, userId: number, session: ImportSession, statement: Statement, options: ImportOptions): Plan {
  const portfolioId = resolvePortfolioId(db, userId, options.portfolioId);
  const { broker, name: brokerName } = chooseBroker(db, userId, statement, options);
  const settings = getSettings(db, userId);
  const cache = getCachedPrices(db, userId);
  const label = `Import ${statement.formatLabel}`;

  // 1. Instrumentele din fișier și activele lor.
  const instruments = new Map<string, Instrument>();
  let nextLedgerId = -1;
  for (const row of statement.rows) {
    const key = keyOf(row);
    if (!key || !(ASSET_KINDS.includes(row.kind) || row.kind === 'tax' || row.kind === 'fee')) continue;
    const inst = instruments.get(key) ?? {
      key,
      brokerSymbol: row.symbol,
      isin: row.isin,
      name: row.name,
      rows: [],
      asset: null,
      proposal: null,
      status: 'existing' as const,
      ledgerId: 0
    };
    inst.isin ??= row.isin;
    inst.name ??= row.name;
    inst.rows.push(row);
    instruments.set(key, inst);
  }
  for (const inst of instruments.values()) {
    const answer = options.symbols?.[inst.key];
    if (answer === '') {
      inst.status = 'skipped';
      continue;
    }
    const answered = answer ? cleanSymbol(answer) : null;
    if (answered) assert(validSymbol(answered), `Simbolul „${answer}” nu este valid (litere, cifre, punct și cratimă).`);
    inst.asset = answered
      ? findAssetBySymbol(db, userId, answered)
      : (savedAsset(db, userId, statement.format, inst.key) ??
        (inst.isin ? assetByIsin(db, userId, inst.isin) : null) ??
        findAssetBySymbol(db, userId, proposedSymbol(session, inst, undefined)));
    if (inst.asset) {
      inst.status = 'existing';
      continue;
    }
    const symbol = answered ?? proposedSymbol(session, inst, undefined);
    const info = session.info.get(symbol) ?? null;
    const guess = inst.rows.find((r) => r.guess)?.guess ?? null;
    const tradeCurrency = inst.rows.find((r) => (r.kind === 'buy' || r.kind === 'sell') && r.currency)?.currency ?? null;
    const fromInfo = info?.currency && /^[A-Z]{3}$/.test(info.currency) ? info.currency : null;
    let currency = fromInfo ?? guess?.currency ?? tradeCurrency ?? statement.accountCurrency ?? settings.baseCurrency;
    if (currency === 'GBX') currency = 'GBP';
    const type: AssetType = guess?.type ?? (info?.assetType && info.assetType !== 'bond' ? info.assetType : null) ?? (/-(USD|EUR|RON)$/.test(symbol) ? 'crypto' : 'stock');
    inst.proposal = { symbol, currency, type, name: info?.name || inst.name || '', confirmed: !!info };
    inst.status = info ? 'confirmed' : 'unconfirmed';
    inst.ledgerId = nextLedgerId--;
  }
  const assetIdOf = (inst: Instrument): number => inst.asset?.id ?? inst.ledgerId;
  const currencyOfInst = (inst: Instrument): string => inst.asset?.currency ?? inst.proposal?.currency ?? settings.baseCurrency;
  const typeOfInst = (inst: Instrument): AssetType => inst.asset?.type ?? inst.proposal?.type ?? 'stock';

  // 2. Moneda contului: din fișier sau dedusă din cursurile efective ale tranzacțiilor.
  const implied: { currency: string; date: string; rate: Decimal }[] = [];
  for (const row of statement.rows) {
    if ((row.kind !== 'buy' && row.kind !== 'sell') || row.cashAmount === null || row.cashCurrency !== null) continue;
    const inst = instruments.get(keyOf(row) ?? '');
    if (!inst || inst.status === 'skipped' || !row.quantity || !row.price) continue;
    const value = dec(row.quantity).times(row.price);
    if (value.gt(0) && !dec(row.cashAmount).isZero()) implied.push({ currency: currencyOfInst(inst), date: row.date, rate: dec(row.cashAmount).abs().div(value) });
  }
  const accountCurrency = statement.accountCurrency ?? inferAccountCurrency(implied, cache, settings.baseCurrency);
  const rates: Rates = new Map();
  for (const row of statement.rows) {
    if ((row.kind !== 'buy' && row.kind !== 'sell') || row.cashAmount === null || !row.quantity || !row.price) continue;
    const inst = instruments.get(keyOf(row) ?? '');
    if (!inst || inst.status === 'skipped') continue;
    const from = currencyOfInst(inst);
    const to = row.cashCurrency ?? accountCurrency;
    const value = dec(row.quantity).times(row.price);
    if (from === to || !value.gt(0) || dec(row.cashAmount).isZero()) continue;
    const key = `${from}>${to}`;
    rates.set(key, [...(rates.get(key) ?? []), { date: row.date, rate: dec(row.cashAmount).abs().div(value) }]);
  }

  // 3. Tranzacțiile propuse, rând cu rând.
  const { merged, orphanTaxes } = mergeRows(statement.rows);
  const planned: Planned[] = [];
  const base = (row: StatementRow, inst: Instrument | null): Pick<ImportedTransaction, 'portfolioId' | 'brokerId' | 'date' | 'externalId' | 'notes'> => ({
    portfolioId,
    brokerId: broker?.id ?? -1,
    date: row.date,
    externalId: row.externalId,
    notes: row.note && inst === null ? `${label} · ${row.note}`.slice(0, 500) : label
  });
  const priceIn = (value: string | null, from: string | null, to: string): { value: Decimal | null; ok: boolean } => {
    if (value === null) return { value: null, ok: true };
    if (!from || from === to) return { value: dec(value), ok: true };
    if (from === 'GBX' && to === 'GBP') return { value: dec(value).div(100), ok: true };
    return { value: null, ok: false };
  };

  for (const { row, lines } of merged) {
    const key = keyOf(row);
    const inst = key ? (instruments.get(key) ?? null) : null;
    const p: Planned = { row, lines, instrument: inst, input: null, status: 'new', message: null, approximate: false };
    planned.push(p);
    if (inst?.status === 'skipped') {
      p.status = 'skipped';
      p.message = 'Instrument ignorat la cererea ta.';
      continue;
    }
    if (row.date > new Date().toISOString().slice(0, 10)) {
      p.status = 'error';
      p.message = 'Data este în viitor.';
      continue;
    }
    switch (row.kind) {
      case 'buy':
      case 'sell': {
        const target = currencyOfInst(inst as Instrument);
        const price = priceIn(row.price, row.currency, target);
        const fee = priceIn(row.fee, row.currency, target);
        if (!price.ok || !fee.ok) {
          p.status = 'error';
          p.message = `Prețul este în ${row.currency}, dar ${inst?.asset?.symbol ?? inst?.proposal?.symbol} este în ${target}.`;
          break;
        }
        p.input = {
          ...base(row, inst),
          type: row.kind,
          assetId: assetIdOf(inst as Instrument),
          quantity: (row.quantity as string),
          price: text(price.value) as string,
          fee: text(fee.value) ?? '0',
          cashAmount: row.cashAmount,
          cashCurrency: row.cashAmount === null ? null : (row.cashCurrency ?? accountCurrency)
        };
        break;
      }
      case 'dividend':
      case 'coupon': {
        const i = inst as Instrument;
        const target = currencyOfInst(i);
        const from = row.currency ?? accountCurrency;
        let gross = dec(row.amount ?? 0);
        let tax = dec(row.tax ?? 0);
        if (from === 'GBX' && target === 'GBP') {
          gross = gross.div(100);
          tax = tax.div(100);
        } else if (from !== target) {
          // Dividend în moneda contului: suma exactă = acțiuni deținute × dividend pe acțiune, verificată cu cursul din fișier.
          const rate = nearestRate(rates, target, from, row.date);
          const perShare = row.perShare !== null && row.perShareCurrency === target ? dec(row.perShare) : null;
          const txs = [...ledgerTxs(db, userId, i).filter((t) => (t.portfolioId === portfolioId && t.brokerId === broker?.id) || t.type === 'split'), ...plannedTrades(planned, i)];
          const candidates = perShare ? holdingLevels(txs, row.date).map((q) => q.times(perShare)) : [];
          const original = gross;
          if (rate !== null) {
            const converted = gross.div(rate);
            const exact = candidates.sort((a, b) => a.minus(converted).abs().comparedTo(b.minus(converted).abs()))[0];
            if (exact !== undefined && exact.div(converted).minus(1).abs().lte(0.1)) gross = exact;
            else {
              gross = converted;
              p.approximate = true;
            }
          } else {
            gross = candidates.length === 1 ? candidates[0] : gross.div(dec(resolveFx(cache, target, from).rate));
            p.approximate = true;
          }
          gross = Decimal.max(round2(gross), dec('0.01'));
          tax = original.gt(0) ? round2(gross.times(tax).div(original)) : ZERO;
        }
        if (!gross.gt(0)) {
          p.status = 'skipped';
          p.message = 'Dividend corectat ulterior (sumă negativă sau zero).';
          break;
        }
        if (tax.lt(0)) tax = ZERO;
        if (tax.gt(gross)) tax = gross;
        p.input = {
          ...base(row, inst),
          type: typeOfInst(i) === 'bond' ? 'coupon' : 'dividend',
          assetId: assetIdOf(i),
          grossAmount: gross.toString(),
          taxWithheld: tax.toString(),
          cashAmount: row.cashAmount,
          cashCurrency: row.cashAmount === null ? null : (row.cashCurrency ?? accountCurrency),
          notes: p.approximate ? `${label} · sumă convertită aproximativ din ${from}` : label
        };
        if (p.approximate) {
          p.status = 'warning';
          p.message = `Sumă convertită aproximativ din ${from} în ${target}.`;
        }
        break;
      }
      case 'split': {
        const i = inst as Instrument;
        let numerator: Decimal | null = null;
        let denominator: Decimal | null = null;
        const m = row.ratio?.match(/^([0-9.]+):([0-9.]+)$/);
        if (m) {
          numerator = dec(m[1]);
          denominator = dec(m[2]);
        } else if (row.quantity) {
          // Split dat ca acțiuni primite: raportul = (deținute + primite) / deținute.
          const txs = [...ledgerTxs(db, userId, i).filter((t) => (t.portfolioId === portfolioId && t.brokerId === broker?.id) || t.type === 'split'), ...plannedTrades(planned, i)];
          const held = holdingLevels(txs.filter((t) => t.date < row.date), row.date).at(-1) ?? ZERO;
          if (held.gt(0) && held.plus(row.quantity).gt(0)) {
            numerator = held.plus(row.quantity);
            denominator = held;
          }
        }
        if (!numerator || !denominator || numerator.eq(denominator)) {
          p.status = 'error';
          p.message = 'Raportul split-ului nu poate fi stabilit (nu există acțiuni deținute înainte).';
          break;
        }
        p.input = { ...base(row, inst), portfolioId: null, type: 'split', assetId: assetIdOf(i), splitNumerator: numerator.toString(), splitDenominator: denominator.toString() };
        break;
      }
      case 'interest':
      case 'fee':
      case 'deposit':
      case 'withdrawal': {
        const currency = row.currency ?? accountCurrency;
        const currencyOk = currency !== 'GBX';
        if (!currencyOk) {
          p.status = 'error';
          p.message = 'Moneda GBX (pence) nu poate fi folosită pentru sume de cash.';
          break;
        }
        const amount = dec(row.amount ?? 0).abs();
        if (row.kind === 'interest') {
          let tax = dec(row.tax ?? 0);
          if (tax.lt(0)) tax = ZERO;
          if (tax.gt(amount)) tax = amount;
          p.input = { ...base(row, null), type: 'interest', assetId: null, currency, grossAmount: amount.toString(), taxWithheld: tax.toString() };
        } else {
          p.input = {
            ...base(row, inst),
            type: row.kind,
            assetId: row.kind === 'fee' && inst ? assetIdOf(inst) : null,
            currency,
            amount: amount.toString()
          };
        }
        break;
      }
      default:
        p.status = 'skipped';
    }
  }
  for (const tax of orphanTaxes) {
    planned.push({
      row: tax,
      lines: [tax.line],
      instrument: instruments.get(keyOf(tax) ?? '') ?? null,
      input: null,
      status: 'skipped',
      message: 'Impozit reținut fără dividend în fișier (nu se importă separat).',
      approximate: false
    });
  }

  // 4. Tranzacțiile manuale (fără identificator de la broker și nevenite dintr-un extras) care pot dubla fișierul.
  //    Cele aduse dintr-un CSV exportat din aplicație sunt tot introduse de utilizator, deci se numără ca manuale.
  const manualByAsset = new Map<number, LedgerTx[]>();
  let manualCount = 0;
  if (broker) {
    for (const inst of instruments.values()) {
      if (!inst.asset) continue;
      const rows = db
        .prepare(
          `SELECT * FROM transactions WHERE user_id = ? AND asset_id = ? AND broker_id = ? AND portfolio_id = ? AND external_id IS NULL AND type <> 'split'
             AND (batch_id IS NULL OR batch_id IN (SELECT id FROM import_batches WHERE user_id = ? AND source = 'app-csv'))`
        )
        .all(userId, inst.asset.id, broker.id, portfolioId, userId) as Row[];
      if (rows.length > 0) {
        manualByAsset.set(inst.asset.id, rows.map(rowToLedgerTx));
        manualCount += rows.length;
      }
    }
  }

  // 5. Dubluri și istoricul fiecărui instrument.
  const externalIds = new Set(
    (db.prepare('SELECT external_id FROM transactions WHERE user_id = ? AND external_id IS NOT NULL').all(userId) as { external_id: string }[]).map((r) => r.external_id)
  );
  const replaceIds: number[] = [];
  // Tranzacțiile existente la broker: în portofoliul ales (pentru istoricul activului) sau în oricare portofoliu
  // (pentru dubluri: același extras importat o dată nu se mai adaugă nici în alt portofoliu).
  const existingAt = (assetId: number | null, anyPortfolio = false): LedgerTx[] => {
    if (!broker) return [];
    const portfolioClause = anyPortfolio ? '' : ' AND portfolio_id = ?';
    const params: unknown[] = anyPortfolio ? [] : [portfolioId];
    const rows =
      assetId === null
        ? (db.prepare(`SELECT * FROM transactions WHERE user_id = ? AND broker_id = ?${portfolioClause} AND asset_id IS NULL`).all(userId, broker.id, ...params) as Row[])
        : (db
            .prepare(`SELECT * FROM transactions WHERE user_id = ? AND asset_id = ? AND ((broker_id = ?${portfolioClause}) OR type = 'split')`)
            .all(userId, assetId, broker.id, ...params) as Row[]);
    return rows.map(rowToLedgerTx);
  };

  // Pe activ: se înlocuiesc tranzacțiile manuale doar dacă s-a cerut și istoricul rămâne valid fără ele.
  const groups = new Map<string, Planned[]>();
  for (const p of planned) {
    if (!p.input) continue;
    const g = p.instrument && p.input.assetId !== null ? `a${p.input.assetId}` : 'cash';
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  for (const [group, list] of groups) {
    const assetId = group === 'cash' ? null : Number(group.slice(1));
    const real = assetId !== null && assetId > 0 ? assetId : null;
    let existing = real !== null ? existingAt(real) : assetId === null ? existingAt(null) : [];
    let seen = real !== null ? existingAt(real, true) : assetId === null ? existingAt(null, true) : [];
    const manual = real !== null ? (manualByAsset.get(real) ?? []) : [];
    // Dublurile după identificatorul de la broker.
    for (const p of list) {
      if (p.input?.externalId && externalIds.has(p.input.externalId)) {
        p.status = 'duplicate';
        p.message = 'Importată deja.';
      }
    }
    const fresh = (): Planned[] => list.filter((p) => p.status === 'new' || p.status === 'warning');
    const toLedger = (p: Planned, i: number): LedgerTx => ({
      id: Number.MAX_SAFE_INTEGER - 100_000 + i,
      portfolioId: p.input?.portfolioId ?? null,
      assetId: p.input?.assetId ?? null,
      brokerId: p.input?.brokerId ?? null,
      type: p.input?.type as LedgerTx['type'],
      date: p.input?.date as string,
      quantity: (p.input?.quantity as string) ?? '0',
      price: (p.input?.price as string) ?? '0',
      fee: (p.input?.fee as string) ?? '0',
      grossAmount: '0',
      taxWithheld: '0',
      netAmount: '0',
      splitNumerator: (p.input?.splitNumerator as string) ?? null,
      splitDenominator: (p.input?.splitDenominator as string) ?? null
    });
    if (options.replaceManual && manual.length > 0) {
      const ids = new Set(manual.map((t) => t.id));
      const without = existing.filter((t) => !ids.has(t.id));
      if (!validateLedger([...without.filter((t) => t.assetId === real), ...fresh().map(toLedger)].filter((t) => t.assetId !== null))) {
        replaceIds.push(...ids);
        existing = without;
        seen = seen.filter((t) => !ids.has(t.id));
      }
    }
    // Dublurile după conținut: fiecare tranzacție existentă acoperă un singur rând din fișier.
    const pool = new Map<string, number>();
    for (const t of seen) {
      const s = signature({ ...t, amount: t.netAmount });
      pool.set(s, (pool.get(s) ?? 0) + 1);
    }
    for (const p of fresh()) {
      const s = signature(p.input as never);
      const n = pool.get(s) ?? 0;
      if (n > 0) {
        pool.set(s, n - 1);
        p.status = 'duplicate';
        p.message = 'Există deja o tranzacție identică în aplicație.';
      }
    }
    // Istoricul activului trebuie să rămână coerent (nicio vânzare fără cumpărările ei).
    if (assetId !== null) {
      const ledger = [...existing.filter((t) => t.assetId === real), ...fresh().map(toLedger)];
      if (validateLedger(ledger)) {
        const inst = list[0].instrument;
        if (inst) inst.status = 'incomplete';
        for (const p of fresh()) {
          if (p.input?.type === 'buy' || p.input?.type === 'sell' || p.input?.type === 'split' || p.input?.type === 'dividend' || p.input?.type === 'fee') {
            p.status = 'error';
            p.message = 'Lipsesc cumpărări anterioare: fișierul nu începe de la prima cumpărare a acestui instrument (sau lipsește un split).';
          }
        }
      }
    }
  }

  return { statement, broker, brokerName, portfolioId, accountCurrency, instruments: [...instruments.values()], planned, replaceIds, manualCount };
}

/** Tranzacțiile unui instrument deja în aplicație (toate portofoliile), în forma motorului. */
function ledgerTxs(db: Db, userId: number, inst: Instrument): LedgerTx[] {
  return inst.asset ? ledgerOf(db, userId, inst.asset.id) : [];
}

/** Cumpărările, vânzările și split-urile propuse până acum pentru un instrument. */
function plannedTrades(planned: Planned[], inst: Instrument): LedgerTx[] {
  return planned
    .filter((p) => p.instrument === inst && p.input && (p.input.type === 'buy' || p.input.type === 'sell' || p.input.type === 'split'))
    .map((p, i) => ({
      id: Number.MAX_SAFE_INTEGER - 200_000 + i,
      portfolioId: p.input?.portfolioId ?? null,
      assetId: p.input?.assetId ?? null,
      brokerId: p.input?.brokerId ?? null,
      type: p.input?.type as LedgerTx['type'],
      date: p.input?.date as string,
      quantity: (p.input?.quantity as string) ?? '0',
      price: (p.input?.price as string) ?? '0',
      fee: '0',
      grossAmount: '0',
      taxWithheld: '0',
      netAmount: '0',
      splitNumerator: (p.input?.splitNumerator as string) ?? null,
      splitDenominator: (p.input?.splitDenominator as string) ?? null
    }));
}

/* ----------------------------------------------------------- previzualizarea */

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

function previewOf(session: ImportSession, plan: Plan): ImportPreview {
  const counts: Record<ImportRowStatus, number> = { new: 0, duplicate: 0, error: 0, warning: 0, skipped: 0 };
  const byKind: Partial<Record<StatementKind, number>> = {};
  const rows: ImportPreviewRow[] = [];
  for (const p of plan.planned) {
    counts[p.status]++;
    if ((p.status === 'new' || p.status === 'warning') && p.input) {
      const kind = p.input.type === 'coupon' ? 'coupon' : (p.row.kind as StatementKind);
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const inst = p.instrument;
    const input = p.input;
    rows.push({
      line: p.row.line,
      kind: input?.type === 'coupon' ? 'coupon' : p.row.kind,
      date: p.row.date,
      symbol: inst ? (inst.asset?.symbol ?? inst.proposal?.symbol ?? null) : null,
      brokerSymbol: inst?.brokerSymbol ?? inst?.isin ?? null,
      quantity: numOrNull(input?.quantity ?? p.row.quantity),
      price: numOrNull(input?.price ?? p.row.price),
      amount: numOrNull(input?.grossAmount ?? input?.amount ?? p.row.amount),
      fee: numOrNull(input?.fee ?? p.row.fee),
      tax: numOrNull(input?.taxWithheld ?? p.row.tax),
      currency: (input?.currency as string | undefined) ?? (inst ? (inst.asset?.currency ?? inst.proposal?.currency ?? null) : (p.row.currency ?? plan.accountCurrency)),
      status: p.status,
      message: p.lines.length > 1 && !p.message ? `Include rândurile ${p.lines.slice(1).join(', ')} (impozit sau corecție).` : p.message
    });
  }
  for (const problem of plan.statement.problems) {
    counts.error++;
    rows.push({ line: problem.line, kind: 'buy', date: '', symbol: null, brokerSymbol: null, quantity: null, price: null, amount: null, fee: null, tax: null, currency: null, status: 'error', message: problem.message });
  }
  rows.sort((a, b) => a.line - b.line);
  const dates = plan.planned.map((p) => p.row.date).filter(Boolean).sort();
  const warnings = [...plan.statement.warnings];
  if (plan.statement.rows.some((r) => r.kind === 'deposit' || r.kind === 'withdrawal')) {
    warnings.push(
      'Fișierul are depuneri și retrageri: cash-ul la broker se calculează din ele. Dacă extrasul nu acoperă tot istoricul contului, corectează soldul din Panou → Cash disponibil.'
    );
  }
  const instrumentRows = (inst: Instrument): number => plan.planned.filter((p) => p.instrument === inst).length;
  return {
    fileName: session.fileName,
    format: plan.statement.format,
    formatLabel: plan.statement.formatLabel,
    brokerId: plan.broker?.id ?? null,
    brokerName: plan.brokerName,
    portfolioId: plan.portfolioId,
    accountCurrency: plan.accountCurrency,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    counts,
    byKind,
    rows: rows.slice(0, MAX_PREVIEW_ROWS),
    instruments: plan.instruments
      .map((i) => ({
        key: i.key,
        brokerSymbol: i.brokerSymbol,
        isin: i.isin,
        name: i.asset?.name || i.proposal?.name || i.name,
        symbol: i.asset?.symbol ?? i.proposal?.symbol ?? i.key,
        currency: i.asset?.currency ?? i.proposal?.currency ?? '',
        assetType: i.asset?.type ?? i.proposal?.type ?? 'stock',
        status: i.status,
        rows: instrumentRows(i)
      }))
      .sort((a, b) => (a.status === 'unconfirmed' ? 0 : 1) - (b.status === 'unconfirmed' ? 0 : 1) || a.symbol.localeCompare(b.symbol)),
    manualCount: plan.manualCount,
    ignored: plan.statement.ignored,
    warnings,
    offline: session.offline
  };
}

function mappingInfo(session: ImportSession): ImportSessionView['mapping'] {
  const g = session.generic;
  if (!g || !session.mapping) return null;
  return {
    headers: g.headers,
    keys: g.keys,
    sample: g.rows.slice(0, 6).map((r) => g.headers.map((_, i) => (r[i] === null || r[i] === undefined ? '' : String(r[i])))),
    mapping: session.mapping,
    typeValues: typeValues(g, session.mapping),
    templateId: session.templateId,
    templateName: session.templateName
  };
}

/** Pasul 2: ce s-ar importa, cu opțiunile alese. Nu modifică baza de date. */
/** La importul universal: citește tabelul cu maparea aleasă (dacă s-a trimis una). */
function useMapping(session: ImportSession, options: ImportOptions): void {
  if (!session.generic || !options.mapping) return;
  session.mapping = options.mapping;
  const name = options.templateName?.trim() || session.templateName;
  session.statement = readWithMapping(session.generic, options.mapping, name ? `Șablon „${name.slice(0, 60)}”` : 'Fișier cu mapare proprie');
}

export async function previewImport(db: Db, userId: number, session: ImportSession, options: ImportOptions, lookup: ImportLookup): Promise<ImportSessionView> {
  useMapping(session, options);
  const view: ImportSessionView = { token: session.token, fileName: session.fileName, mapping: mappingInfo(session), preview: null };
  if (!session.statement) return view;
  await lookupSymbols(db, userId, session, session.statement, options, lookup);
  view.preview = previewOf(session, buildPlan(db, userId, session, session.statement, options));
  return view;
}

/* ------------------------------------------------------------------ importul */

/** Pasul 3: salvează tranzacțiile noi ca un lot, într-o singură tranzacție SQL. */
export function applyImport(db: Db, userId: number, session: ImportSession, options: ImportOptions): ImportResult {
  useMapping(session, options);
  const statement = session.statement;
  assert(statement, 'Alege întâi ce conține fiecare coloană a fișierului.');
  return db.transaction((): ImportResult => {
    const plan = buildPlan(db, userId, session, statement, options);
    const portfolio = getPortfolio(db, userId, plan.portfolioId);
    const toImport = plan.planned.filter((p) => (p.status === 'new' || p.status === 'warning') && p.input);
    const result: ImportResult = {
      batchId: null,
      brokerName: plan.brokerName,
      portfolioName: portfolio?.name ?? '',
      imported: 0,
      byKind: {},
      duplicates: plan.planned.filter((p) => p.status === 'duplicate').length,
      errors: plan.planned.filter((p) => p.status === 'error').length + statement.problems.length,
      createdAssets: 0,
      replaced: 0,
      approximated: toImport.filter((p) => p.approximate).length,
      positions: [],
      unconfirmed: [],
      offline: session.offline,
      templateSaved: null
    };

    // Șablonul de mapare (importul universal), salvat chiar dacă nu este nimic nou de importat.
    if (session.generic && session.mapping) {
      const name = options.templateName?.trim() || session.templateName;
      if (name) {
        db.prepare(
          `INSERT INTO import_templates (user_id, name, signature, mapping, last_used_at) VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT (user_id, signature) DO UPDATE SET name = excluded.name, mapping = excluded.mapping, last_used_at = excluded.last_used_at`
        ).run(userId, name.slice(0, 60), headerSignature(session.generic.keys), JSON.stringify(session.mapping));
        result.templateSaved = name;
      }
    }
    if (toImport.length === 0) return result;

    // Brokerul și activele noi (ținute minte în lot, ca anularea să le poată șterge).
    let broker = plan.broker;
    let createdBroker: number | null = null;
    if (!broker) {
      broker = createBroker(db, userId, { name: plan.brokerName });
      createdBroker = broker.id;
    }
    const createdAssets: number[] = [];
    const remember = db.prepare(
      `INSERT INTO broker_symbols (user_id, source, broker_symbol, asset_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, source, broker_symbol) DO UPDATE SET asset_id = excluded.asset_id`
    );
    const used = new Set(toImport.map((p) => p.instrument).filter((i): i is Instrument => i !== null));
    for (const inst of used) {
      if (!inst.asset && inst.proposal) {
        const p = inst.proposal;
        const existing = findAssetBySymbol(db, userId, p.symbol);
        inst.asset = existing ?? createAsset(db, userId, { type: p.type, symbol: p.symbol, currency: p.currency, name: p.name });
        if (!existing) {
          createdAssets.push(inst.asset.id);
          result.createdAssets++;
          if (!p.confirmed && !session.offline) result.unconfirmed.push(inst.asset.symbol);
        }
      }
      if (!inst.asset) continue;
      // Corespondența simbol (și ISIN) -> activ: la următorul import nu mai e nevoie de nicio întrebare.
      remember.run(userId, statement.format, inst.key, inst.asset.id);
      if (inst.isin) {
        remember.run(userId, 'isin', inst.isin, inst.asset.id);
        db.prepare('UPDATE assets SET isin = ? WHERE id = ? AND user_id = ? AND isin IS NULL').run(inst.isin, inst.asset.id, userId);
      }
    }

    // Tranzacțiile manuale înlocuite: păstrate în lot, ca anularea să le pună la loc.
    let replaced: Row[] = [];
    if (plan.replaceIds.length > 0) {
      replaced = plan.replaceIds.map((id) => db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, userId) as Row).filter(Boolean);
      const del = db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?');
      for (const id of plan.replaceIds) result.replaced += del.run(id, userId).changes;
    }

    const dates = toImport.map((p) => p.row.date).sort();
    const batch = Number(
      db
        .prepare(
          `INSERT INTO import_batches (user_id, source, file_name, broker_id, portfolio_id, format_label, date_from, date_to, created, replaced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          statement.format,
          session.fileName.slice(0, 200),
          broker.id,
          plan.portfolioId,
          statement.formatLabel,
          dates[0],
          dates[dates.length - 1],
          JSON.stringify({ assets: createdAssets, broker: createdBroker }),
          replaced.length > 0 ? JSON.stringify(replaced) : null
        ).lastInsertRowid
    );
    const inputs = toImport.map((p) => {
      const input = { ...(p.input as ImportedTransaction), brokerId: (broker as Broker).id, batchId: batch };
      if (p.instrument && input.assetId !== null) input.assetId = (p.instrument.asset as Asset).id;
      const kind = input.type === 'coupon' ? 'coupon' : p.row.kind;
      result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
      return input;
    });
    result.imported = importTransactions(db, userId, inputs);
    db.prepare('UPDATE import_batches SET tx_count = ?, summary = ? WHERE id = ?').run(result.imported, JSON.stringify(result.byKind), batch);
    result.batchId = batch;

    // Ce deține acum utilizatorul la broker (în portofoliu), alături de cantitatea raportată de broker.
    const held = (asset: Asset): number =>
      roundQty(new Ledger({ method: 'AVG', strict: false }).applyAll(sortTransactions(ledgerOf(db, userId, asset.id))).get(asset.id, (broker as Broker).id, plan.portfolioId)?.quantity ?? 0);
    const listed = new Set<string>();
    for (const inst of used) {
      if (!inst.asset) continue;
      const key = inst.brokerSymbol ?? inst.key;
      listed.add(key);
      const quantity = held(inst.asset);
      const reported = statement.openPositions ? (statement.openPositions[key] ?? 0) : null;
      if (quantity > 0 || (reported ?? 0) > 0) {
        result.positions.push({ symbol: inst.asset.symbol, brokerSymbol: key, name: inst.asset.name, quantity, reportedQuantity: reported });
      }
    }
    // Pozițiile raportate de broker pentru instrumente fără operațiuni în fișier (cumpărate înaintea perioadei exportate).
    for (const [key, reported] of Object.entries(statement.openPositions ?? {})) {
      if (listed.has(key) || !(reported > 0)) continue;
      const symbol = guessSymbol(key).symbol;
      const asset = savedAsset(db, userId, statement.format, key) ?? findAssetBySymbol(db, userId, symbol);
      result.positions.push({ symbol: asset?.symbol ?? symbol, brokerSymbol: key, name: asset?.name ?? '', quantity: asset ? held(asset) : 0, reportedQuantity: reported });
    }
    result.positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return result;
  })();
}

/* -------------------------------------------------------- loturi și șabloane */

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function listImportBatches(db: Db, userId: number): ImportBatchView[] {
  const rows = db
    .prepare(
      `SELECT ib.*, b.name AS broker_name, p.name AS portfolio_name,
         (SELECT COUNT(*) FROM transactions t WHERE t.batch_id = ib.id AND t.user_id = ib.user_id) AS remaining
       FROM import_batches ib
       LEFT JOIN brokers b ON b.id = ib.broker_id AND b.user_id = ib.user_id
       LEFT JOIN portfolios p ON p.id = ib.portfolio_id AND p.user_id = ib.user_id
       WHERE ib.user_id = ? ORDER BY ib.id DESC`
    )
    .all(userId) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    createdAt: r.created_at as string,
    fileName: (r.file_name as string | null) ?? null,
    formatLabel: (r.format_label as string | null) ?? String(r.source),
    brokerName: (r.broker_name as string | null) ?? null,
    portfolioName: (r.portfolio_name as string | null) ?? null,
    txCount: (r.tx_count as number) ?? 0,
    remaining: (r.remaining as number) ?? 0,
    dateFrom: (r.date_from as string | null) ?? null,
    dateTo: (r.date_to as string | null) ?? null,
    summary: parseJson(r.summary, {})
  }));
}

/**
 * Pasul 4: anulează complet un import. Se șterg tranzacțiile lotului, se pun la
 * loc tranzacțiile manuale înlocuite și se șterg activele (și brokerul) create de
 * import, dacă nu mai au alte tranzacții. Refuză dacă ar rămâne vânzări fără
 * acoperire (ex.: o vânzare adăugată după import, care depinde de cumpărările lui).
 */
export function undoImport(db: Db, userId: number, batchId: number): { removed: number; restored: number } {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ? AND user_id = ?').get(batchId, userId) as Row | undefined;
  assert(batch, 'Importul nu a fost găsit.');
  return db.transaction(() => {
    const assetIds = (db.prepare('SELECT DISTINCT asset_id FROM transactions WHERE user_id = ? AND batch_id = ? AND asset_id IS NOT NULL').all(userId, batchId) as { asset_id: number }[]).map(
      (r) => r.asset_id
    );
    const hadSplit = !!db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND batch_id = ? AND type = 'split' LIMIT 1").get(userId, batchId);
    const removed = db.prepare('DELETE FROM transactions WHERE user_id = ? AND batch_id = ?').run(userId, batchId).changes;

    // Tranzacțiile manuale înlocuite de import revin (doar dacă activul și brokerul lor mai există).
    let restored = 0;
    for (const row of parseJson<Row[]>(batch.replaced, [])) {
      const { id: _id, ...rest } = row;
      if (rest.asset_id != null && !getAsset(db, userId, rest.asset_id as number)) continue;
      if (rest.broker_id != null && !getBroker(db, userId, rest.broker_id as number)) continue;
      if (rest.portfolio_id != null && !getPortfolio(db, userId, rest.portfolio_id as number)) continue;
      // Lotul din care venea tranzacția (un CSV din aplicație) poate să fi fost anulat între timp.
      if (rest.batch_id != null && !db.prepare('SELECT 1 FROM import_batches WHERE id = ? AND user_id = ?').get(rest.batch_id, userId)) rest.batch_id = null;
      const cols = Object.keys(rest);
      db.prepare(`INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => rest[c] as never));
      if (rest.asset_id != null && !assetIds.includes(rest.asset_id as number)) assetIds.push(rest.asset_id as number);
      restored++;
    }

    for (const assetId of assetIds) {
      const asset = getAsset(db, userId, assetId);
      if (!asset) continue;
      const txs = ledgerOf(db, userId, assetId);
      try {
        ensureValidLedger(db, userId, asset, txs);
      } catch (err) {
        throw new AppError(
          `Importul nu poate fi anulat: ${asset.symbol} are tranzacții adăugate după import care depind de el. ${err instanceof Error ? err.message : ''}`.trim()
        );
      }
      if (hadSplit) invalidateHistory(db, userId, asset.symbol);
    }

    // Activele și brokerul create de import, dacă nu mai sunt folosite.
    const created = parseJson<{ assets?: number[]; broker?: number | null; brokers?: number[]; portfolios?: number[] }>(batch.created, {});
    for (const id of created.assets ?? []) {
      const usedBy = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND asset_id = ?').get(userId, id) as { n: number };
      if (usedBy.n === 0) db.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?').run(id, userId);
    }
    for (const id of new Set([...(created.brokers ?? []), ...(created.broker ? [created.broker] : [])])) {
      const usedBy = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND broker_id = ?').get(userId, id) as { n: number };
      if (usedBy.n === 0) db.prepare('DELETE FROM brokers WHERE id = ? AND user_id = ?').run(id, userId);
    }
    // Portofoliile create de import (din coloana „portofoliu”), dacă au rămas goale; cel puțin unul rămâne mereu.
    for (const id of created.portfolios ?? []) {
      const usedBy = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND portfolio_id = ?').get(userId, id) as { n: number };
      const others = db.prepare('SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ? AND id <> ? AND archived = 0').get(userId, id) as { n: number };
      if (usedBy.n === 0 && others.n > 0) db.prepare('DELETE FROM portfolios WHERE id = ? AND user_id = ?').run(id, userId);
    }
    db.prepare('DELETE FROM import_batches WHERE id = ? AND user_id = ?').run(batchId, userId);
    return { removed, restored };
  })();
}

export function listImportTemplates(db: Db, userId: number): ImportTemplate[] {
  const rows = db.prepare('SELECT * FROM import_templates WHERE user_id = ? ORDER BY name').all(userId) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    signature: r.signature as string,
    createdAt: r.created_at as string,
    lastUsedAt: (r.last_used_at as string | null) ?? null
  }));
}

export function deleteImportTemplate(db: Db, userId: number, id: number): void {
  db.prepare('DELETE FROM import_templates WHERE id = ? AND user_id = ?').run(id, userId);
}

/** Denumirea unui tip de operațiune (pentru mesaje). */
export const kindLabel = (kind: StatementKind): string => STATEMENT_KIND_LABEL[kind];

/** Folosit de interfață: cheia normalizată a unei valori din coloana de tip. */
export const typeKey = (value: string): string => normalizeKey(value);
