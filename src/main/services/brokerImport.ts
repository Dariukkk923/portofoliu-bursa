/**
 * Preluarea automată a pozițiilor din raportul exportat de la broker (XTB).
 *
 * Aplicația nu se conectează la contul de la broker și nu cere niciodată
 * parola lui: XTB nu mai are API public, așa că utilizatorul exportă din
 * xStation istoricul contului (Excel), iar aici fișierul este citit și
 * transformat în tranzacții. Utilizatorul doar alege fișierul; restul se
 * decide automat:
 *
 *  - brokerul este cel numit „XTB” (creat dacă lipsește);
 *  - fiecare instrument este legat de activul existent sau de unul nou, cu
 *    simbolul, moneda și tipul confirmate la furnizorul de prețuri;
 *  - instrumentele cu istoric incomplet (vânzări fără cumpărările lor) sunt
 *    sărite și raportate, restul se importă;
 *  - fiecare tranzacție păstrează identificatorul operațiunii din XTB
 *    (`external_id`), deci același raport — sau unul mai nou, care îl include
 *    pe cel vechi — poate fi importat de oricâte ori fără dubluri.
 *
 * Sunt doi pași: `previewXtbImport` citește raportul fără să scrie nimic (și
 * află dacă există tranzacții introduse manual care ar dubla raportul), iar
 * `applyXtbImport` salvează, într-o singură tranzacție SQL.
 */
import type { Asset, AssetType, BrokerImportOptions, BrokerImportPreview, BrokerImportResult, Broker } from '@shared/types';
import { parseCsv } from '@shared/csv';
import { addDays, daysBetween } from '@shared/dates';
import { Ledger, roundQty, sortTransactions, validateLedger, type LedgerTx } from '@shared/calc';
import {
  mapXtbSymbol,
  parseXtbReport,
  XtbParseError,
  type XtbDividend,
  type XtbOperation,
  type XtbReport,
  type XtbTrade
} from '@shared/brokers/xtb';
import type { Db } from '../db/database';
import { looksLikeZip, readXlsx } from '../xlsx';
import { getCachedPrices, resolveFx, type CachedPrice } from '../prices/store';
import { AppError, assert, rowToAsset, rowToBroker } from './common';
import { createAsset, findAssetBySymbol } from './assets';
import { createBroker } from './brokers';
import { getSettings } from './settings';
import { importTransactions, ledgerOf, type ImportedTransaction } from './transactions';

const SOURCE = 'xtb';
const DEFAULT_BROKER = 'XTB';
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const NOTE = 'Import XTB';

/** Identificatorul sub care se reține o operațiune XTB în `transactions.external_id`. */
const externalId = (op: XtbOperation): string => `${SOURCE}:${op.id}`;

/** Activul propus pentru un instrument care nu există încă în aplicație. */
interface Proposal {
  symbol: string;
  type: 'stock' | 'etf';
  currency: string;
  name: string;
  /** Simbolul a fost găsit la furnizorul de prețuri. */
  confirmed: boolean;
}

/** Raportul citit, păstrat în memorie între previzualizare și import. */
export interface XtbImportSession {
  report: XtbReport;
  fileName: string;
  proposals: Map<string, Proposal>;
  /** Furnizorul de prețuri nu a putut fi contactat: propunerile sunt deduse doar din simbol. */
  offline: boolean;
}

/** Ce știe furnizorul de prețuri despre un simbol propus. */
export interface SymbolInfo {
  name?: string | null;
  currency: string | null;
  assetType?: AssetType | null;
}
export type SymbolLookup = (symbols: string[]) => Promise<{ quotes: Map<string, SymbolInfo>; offline: boolean }>;

/* ------------------------------------------------------------ citirea fișierului */

/** Citește raportul XTB (Excel sau CSV). Erorile au mesaje gata de afișat. */
export function readXtbFile(data: Buffer, fileName: string): XtbReport {
  assert(data.length > 0, 'Fișierul ales este gol.');
  assert(data.length <= MAX_FILE_BYTES, 'Fișierul este prea mare pentru un raport de cont.');
  try {
    if (looksLikeZip(data)) {
      let sheets;
      try {
        sheets = readXlsx(data);
      } catch {
        throw new AppError('Fișierul Excel nu a putut fi citit. Exportă din nou raportul din xStation și încearcă iar.');
      }
      return parseXtbReport(sheets, fileName);
    }
    if (data.subarray(0, 4).toString('latin1') === '%PDF') {
      throw new AppError('Raportul în format PDF nu poate fi citit. Exportă-l din xStation în format Excel (.xlsx).');
    }
    if (data.length >= 4 && data.readUInt32BE(0) === 0xd0cf11e0) {
      throw new AppError('Formatul Excel vechi (.xls) nu este acceptat. Exportă raportul în format .xlsx.');
    }
    // Text: CSV-ul vechi al xStation (UTF-8) sau, mai rar, UTF-16.
    const utf16 = data[0] === 0xff && data[1] === 0xfe;
    const content = utf16 ? data.subarray(2).toString('utf16le') : data.toString('utf8');
    if (/<html|<table/i.test(content.slice(0, 4000))) {
      throw new AppError('Raportul în format HTML nu poate fi citit. Exportă-l din xStation în format Excel (.xlsx).');
    }
    return parseXtbReport([{ name: '', rows: parseCsv(content) }], fileName);
  } catch (err) {
    if (err instanceof XtbParseError) throw new AppError(err.message);
    throw err;
  }
}

/* -------------------------------------------------------------- active și brokeri */

/** Brokerul XTB al utilizatorului: primul al cărui nume conține „XTB”. */
function findXtbBroker(db: Db, userId: number): Broker | null {
  const row = db
    .prepare("SELECT * FROM brokers WHERE user_id = ? AND name LIKE '%xtb%' ORDER BY (name = 'XTB' COLLATE NOCASE) DESC, id LIMIT 1")
    .get(userId) as Record<string, unknown> | undefined;
  return row ? rowToBroker(row) : null;
}

/** Activul care corespunde unui simbol XTB: corespondența salvată sau simbolul implicit, dacă există deja. */
function resolveAsset(db: Db, userId: number, brokerSymbol: string): Asset | null {
  const saved = db
    .prepare(
      `SELECT a.* FROM broker_symbols s JOIN assets a ON a.id = s.asset_id AND a.user_id = s.user_id
       WHERE s.user_id = ? AND s.source = ? AND s.broker_symbol = ?`
    )
    .get(userId, SOURCE, brokerSymbol) as Record<string, unknown> | undefined;
  if (saved) return rowToAsset(saved);
  return findAssetBySymbol(db, userId, mapXtbSymbol(brokerSymbol).symbol);
}

function importedIds(db: Db, userId: number): Set<string> {
  const rows = db
    .prepare("SELECT external_id FROM transactions WHERE user_id = ? AND external_id LIKE 'xtb:%'")
    .all(userId) as { external_id: string }[];
  return new Set(rows.map((r) => r.external_id));
}

/** Id-urile tranzacțiilor introduse manual (fără identificator de la broker) pentru un activ, la un broker. */
function manualIds(db: Db, userId: number, assetId: number, brokerId: number): Set<number> {
  const rows = db
    .prepare('SELECT id FROM transactions WHERE user_id = ? AND asset_id = ? AND broker_id = ? AND external_id IS NULL')
    .all(userId, assetId, brokerId) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

const isTrade = (op: XtbOperation): op is XtbTrade => op.kind !== 'dividend';
const symbolsOf = (report: XtbReport): string[] => [...new Set(report.operations.map((op) => op.symbol))].sort();

/** Cumpărările și vânzările din raport, în forma motorului de calcul. */
function toLedger(ops: XtbTrade[], assetId: number, brokerId: number): LedgerTx[] {
  return ops.map((op, i) => ({
    id: Number.MAX_SAFE_INTEGER - ops.length + i, // după toate tranzacțiile existente
    assetId,
    brokerId,
    type: op.kind,
    date: op.date,
    quantity: op.quantity,
    price: op.price,
    fee: 0,
    grossAmount: 0,
    taxWithheld: 0,
    netAmount: 0,
    splitNumerator: null,
    splitDenominator: null
  }));
}

/* ---------------------------------------------------------------- previzualizare */

/** Pasul 1: citește raportul și pregătește importul. Nu modifică baza de date. */
export async function previewXtbImport(
  db: Db,
  userId: number,
  report: XtbReport,
  fileName: string,
  token: string,
  lookup: SymbolLookup
): Promise<{ preview: BrokerImportPreview; session: XtbImportSession }> {
  const done = importedIds(db, userId);
  const broker = findXtbBroker(db, userId);

  // Instrumentele fără activ în aplicație se verifică la furnizorul de prețuri (monedă, tip, denumire).
  const unknown = symbolsOf(report).filter((s) => !resolveAsset(db, userId, s));
  const none = { quotes: new Map<string, SymbolInfo>(), offline: false };
  const { quotes, offline } = unknown.length > 0 ? await lookup(unknown.map((s) => mapXtbSymbol(s).symbol)).catch(() => ({ ...none, offline: true })) : none;

  // Ce spune raportul însuși despre fiecare instrument (exportul actual are denumirea și categoria).
  const described = new Map<string, { name: string; category: 'stock' | 'etf' | null }>();
  for (const op of report.operations) {
    const known = described.get(op.symbol);
    described.set(op.symbol, { name: known?.name || op.name, category: known?.category ?? op.category });
  }

  const proposals = new Map<string, Proposal>();
  for (const brokerSymbol of unknown) {
    const guess = mapXtbSymbol(brokerSymbol);
    const info = quotes.get(guess.symbol);
    const fromReport = described.get(brokerSymbol);
    proposals.set(brokerSymbol, {
      symbol: guess.symbol,
      type: fromReport?.category ?? (info?.assetType === 'etf' ? 'etf' : 'stock'),
      currency: info?.currency && /^[A-Z]{3}$/.test(info.currency) ? info.currency : guess.currency,
      name: info?.name || fromReport?.name || '',
      confirmed: !!info
    });
  }

  // Tranzacțiile introduse manual la XTB pentru instrumentele din raport ar putea dubla operațiunile importate.
  let manualCount = 0;
  if (broker) {
    for (const brokerSymbol of symbolsOf(report)) {
      const asset = resolveAsset(db, userId, brokerSymbol);
      if (asset) manualCount += manualIds(db, userId, asset.id, broker.id).size;
    }
  }

  const ops = report.operations;
  const preview: BrokerImportPreview = {
    token,
    fileName,
    brokerName: broker?.name ?? DEFAULT_BROKER,
    dateFrom: ops[0].date,
    dateTo: ops[ops.length - 1].date,
    totals: {
      buys: ops.filter((o) => o.kind === 'buy').length,
      sells: ops.filter((o) => o.kind === 'sell').length,
      dividends: ops.filter((o) => o.kind === 'dividend').length,
      alreadyImported: ops.filter((o) => done.has(externalId(o))).length
    },
    instruments: symbolsOf(report).length,
    manualCount
  };
  return { preview, session: { report, fileName, proposals, offline } };
}

/* --------------------------------------------------------- moneda și dividendele */

interface RatePoint {
  date: string;
  /** Câte unități din moneda contului s-au plătit pentru o unitate din moneda instrumentului. */
  rate: number;
}

/**
 * Cursurile efective din raport: la fiecare cumpărare sau vânzare, suma din
 * moneda contului împărțită la (cantitate × preț) dă cursul aplicat de XTB în
 * acea zi pentru moneda instrumentului.
 */
function impliedRates(ops: XtbOperation[], currencyOf: (symbol: string) => string | undefined): Map<string, RatePoint[]> {
  const rates = new Map<string, RatePoint[]>();
  for (const op of ops) {
    if (!isTrade(op) || op.amount === null) continue;
    const currency = currencyOf(op.symbol);
    const value = op.quantity * op.price;
    if (!currency || !(value > 0) || !(op.amount > 0)) continue;
    rates.set(currency, [...(rates.get(currency) ?? []), { date: op.date, rate: op.amount / value }]);
  }
  return rates;
}

function nearestRate(points: RatePoint[] | undefined, date: string): number | null {
  let best: RatePoint | null = null;
  for (const p of points ?? []) {
    if (!best || Math.abs(daysBetween(p.date, date)) < Math.abs(daysBetween(best.date, date))) best = p;
  }
  return best?.rate ?? null;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Moneda contului, când raportul nu o spune: dacă instrumentele dintr-o monedă
 * au fost plătite „unu la unu”, aceea este moneda contului; altfel se alege
 * moneda pentru care cursurile din raport seamănă cel mai bine cu cele cunoscute.
 */
function inferAccountCurrency(rates: Map<string, RatePoint[]>, cache: Map<string, CachedPrice>, fallback: string): string {
  const medians = [...rates].map(([currency, points]) => ({ currency, rate: median(points.map((p) => p.rate)) }));
  if (medians.length === 0) return fallback;
  const same = medians.find((m) => Math.abs(m.rate - 1) <= 0.015);
  if (same) return same.currency;
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of new Set(['RON', 'EUR', 'USD', fallback])) {
    let distance = 0;
    for (const m of medians) distance += Math.abs(Math.log(m.rate / resolveFx(cache, m.currency, candidate).rate));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Cantitățile deținute în ultimele săptămâni dinaintea plății unui dividend.
 * Dividendul se calculează pe cantitatea de la data de referință (ex-date),
 * care nu apare în raport, deci toate nivelurile recente sunt candidate.
 */
function holdingCandidates(ops: XtbOperation[], symbol: string, date: string): number[] {
  const from = addDays(date, -45);
  const out = new Set<number>();
  let quantity = 0;
  for (const op of ops) {
    if (op.symbol !== symbol || !isTrade(op) || op.date > date) continue;
    if (op.date >= from && quantity > 1e-9) out.add(roundQty(quantity));
    quantity += op.kind === 'buy' ? op.quantity : -op.quantity;
  }
  if (quantity > 1e-9) out.add(roundQty(quantity));
  return [...out];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Dividendul în moneda activului. Raportul îl dă în moneda contului; când
 * cele două diferă, suma exactă este (acțiuni deținute × dividend pe acțiune),
 * verificată cu cursul din raport. Dacă verificarea nu reușește, suma se
 * convertește la cursul cel mai apropiat și este marcată ca aproximativă.
 */
function convertDividend(
  op: XtbDividend,
  asset: Asset,
  accountCurrency: string,
  ops: XtbOperation[],
  rate: number | null,
  fallbackRate: number
): { gross: number; tax: number; approximate: boolean } {
  let gross = op.amount;
  let approximate = false;
  if (asset.currency !== accountCurrency) {
    const perShare = op.perShare !== null && op.perShareCurrency === asset.currency ? op.perShare : null;
    const candidates = perShare ? holdingCandidates(ops, op.symbol, op.date).map((q) => q * perShare) : [];
    if (rate !== null) {
      // Candidatul cel mai apropiat de suma convertită; acceptat dacă diferența se explică prin variația cursului.
      const converted = op.amount / rate;
      const exact = candidates.sort((a, b) => Math.abs(a - converted) - Math.abs(b - converted))[0];
      if (exact !== undefined && Math.abs(exact / converted - 1) <= 0.1) {
        gross = exact;
      } else {
        gross = converted;
        approximate = true;
      }
    } else {
      gross = candidates.length === 1 ? candidates[0] : op.amount / fallbackRate;
      approximate = true;
    }
  }
  gross = Math.max(round2(gross), 0.01);
  const tax = op.amount > 0 ? Math.min(round2(gross * (op.tax / op.amount)), gross) : 0;
  return { gross, tax, approximate };
}

/* --------------------------------------------------------------------- import */

/** Pasul 2: salvează tranzacțiile din raport, într-o singură tranzacție SQL. */
export function applyXtbImport(db: Db, userId: number, session: XtbImportSession, options: BrokerImportOptions): BrokerImportResult {
  const { report } = session;
  const replaceManual = !!options?.replaceManual;

  return db.transaction((): BrokerImportResult => {
    const broker = findXtbBroker(db, userId) ?? createBroker(db, userId, { name: DEFAULT_BROKER });
    const done = importedIds(db, userId);
    const result: BrokerImportResult = {
      brokerName: broker.name,
      imported: 0,
      buys: 0,
      sells: 0,
      dividends: 0,
      alreadyImported: 0,
      createdAssets: 0,
      replaced: 0,
      approximated: 0,
      positions: [],
      incomplete: [],
      unconfirmed: [],
      ignored: report.ignored,
      offline: session.offline
    };

    // 1. Pentru fiecare instrument: activul (existent sau nou) și dacă istoricul lui se leagă.
    const assets = new Map<string, Asset>();
    const remember = db.prepare(
      `INSERT INTO broker_symbols (user_id, source, broker_symbol, asset_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, source, broker_symbol) DO UPDATE SET asset_id = excluded.asset_id`
    );
    const removeManual = db.prepare('DELETE FROM transactions WHERE user_id = ? AND asset_id = ? AND broker_id = ? AND external_id IS NULL');
    for (const brokerSymbol of symbolsOf(report)) {
      const proposal = session.proposals.get(brokerSymbol);
      let asset = resolveAsset(db, userId, brokerSymbol) ?? (proposal ? findAssetBySymbol(db, userId, proposal.symbol) : null);
      const fresh = report.operations.filter((op): op is XtbTrade => op.symbol === brokerSymbol && isTrade(op) && !done.has(externalId(op)));
      const existing = asset ? ledgerOf(db, userId, asset.id) : [];
      const added = toLedger(fresh, asset?.id ?? -1, broker.id);
      const manual = asset ? manualIds(db, userId, asset.id, broker.id) : new Set<number>();

      // Tranzacțiile introduse manual se înlocuiesc doar dacă utilizatorul a cerut-o și istoricul rămâne valid fără ele.
      if (asset && replaceManual && manual.size > 0 && !validateLedger([...existing.filter((t) => !manual.has(t.id)), ...added])) {
        result.replaced += removeManual.run(userId, asset.id, broker.id).changes;
      } else if (validateLedger([...existing, ...added])) {
        // Vânzări fără cumpărările lor: perioadă incompletă sau split. Instrumentul este sărit.
        result.incomplete.push(brokerSymbol);
        continue;
      }

      if (!asset) {
        const p = proposal ?? { ...mapXtbSymbol(brokerSymbol), type: 'stock' as const, name: '', confirmed: false };
        asset = createAsset(db, userId, { type: p.type, symbol: p.symbol, currency: p.currency, name: p.name });
        result.createdAssets++;
        if (!p.confirmed && !session.offline) result.unconfirmed.push(asset.symbol);
      }
      remember.run(userId, SOURCE, brokerSymbol, asset.id);
      assets.set(brokerSymbol, asset);
    }

    // Pozițiile deschise din raport pentru care nu există nicio operațiune în perioada exportată.
    for (const brokerSymbol of Object.keys(report.openPositions ?? {})) {
      if (!assets.has(brokerSymbol) && !result.incomplete.includes(brokerSymbol) && !resolveAsset(db, userId, brokerSymbol)) {
        result.incomplete.push(brokerSymbol);
      }
    }

    // 2. Tranzacțiile noi. Dividendele se trec în moneda activului.
    const cache = getCachedPrices(db, userId);
    const rates = impliedRates(report.operations, (symbol) => assets.get(symbol)?.currency);
    const accountCurrency = report.accountCurrency ?? inferAccountCurrency(rates, cache, getSettings(db, userId).baseCurrency);
    const inputs: ImportedTransaction[] = [];
    for (const op of report.operations) {
      const asset = assets.get(op.symbol);
      if (!asset) continue;
      const id = externalId(op);
      if (done.has(id)) {
        result.alreadyImported++;
        continue;
      }
      done.add(id);
      const base = { assetId: asset.id, brokerId: broker.id, date: op.date, externalId: id };
      if (isTrade(op)) {
        inputs.push({ ...base, type: op.kind, quantity: op.quantity, price: op.price, fee: 0, notes: NOTE });
        if (op.kind === 'buy') result.buys++;
        else result.sells++;
      } else {
        const d = convertDividend(
          op,
          asset,
          accountCurrency,
          report.operations,
          nearestRate(rates.get(asset.currency), op.date),
          resolveFx(cache, asset.currency, accountCurrency).rate
        );
        if (d.approximate) result.approximated++;
        inputs.push({
          ...base,
          type: 'dividend',
          grossAmount: d.gross,
          taxWithheld: d.tax,
          notes: d.approximate ? `${NOTE} · sumă convertită aproximativ din ${accountCurrency}` : NOTE
        });
        result.dividends++;
      }
    }
    result.imported = importTransactions(db, userId, inputs);

    // 3. Ce deține acum utilizatorul la broker, alături de cantitatea din raport (pentru verificare).
    const seen = new Set<number>();
    for (const [brokerSymbol, asset] of assets) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      const position = new Ledger({ method: 'AVG', strict: false }).applyAll(sortTransactions(ledgerOf(db, userId, asset.id))).get(asset.id, broker.id);
      const quantity = roundQty(position?.quantity ?? 0);
      const reported = report.openPositions ? (report.openPositions[brokerSymbol] ?? 0) : null;
      if (quantity > 0 || (reported ?? 0) > 0) {
        result.positions.push({ symbol: asset.symbol, brokerSymbol, name: asset.name, quantity, reportedQuantity: reported });
      }
    }
    result.positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return result;
  })();
}
