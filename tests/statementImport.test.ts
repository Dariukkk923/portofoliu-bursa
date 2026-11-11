/**
 * Importul din extrasele brokerilor, pe fișierele din /samples (date inventate):
 * recunoașterea brokerului după structura fișierului, cititoarele dedicate
 * (Trading 212, Revolut, Interactive Brokers, XTB), maparea universală cu
 * șabloane, dublurile la reimport, anularea completă a unui lot, simbolurile
 * ținute minte, identificarea după ISIN și alegerea portofoliului.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportOptions, User } from '@shared/types';
import { classifyKind, detectReader, extractTable, guessMapping, guessSymbol, isIsin, parseDecimal, parseWhen, readWithMapping } from '@shared/import';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBackup, restoreBackup } from '@main/services/backup';
import { createBroker, listBrokers } from '@main/services/brokers';
import { listAssets } from '@main/services/assets';
import { addPurchase, createTransaction, listTransactions } from '@main/services/transactions';
import { getOverview } from '@main/services/portfolio';
import { createPortfolio, listPortfolios } from '@main/services/portfolios';
import { exportTransactionsCsv, importTransactionsCsv } from '@main/services/csvio';
import {
  applyImport,
  deleteImportTemplate,
  listImportBatches,
  listImportTemplates,
  openImport,
  previewImport,
  readImportFile,
  undoImport,
  type ImportLookup,
  type SymbolInfo
} from '@main/services/statementImport';

const SAMPLES = fileURLToPath(new URL('../samples/', import.meta.url));
const sample = (path: string): Buffer => readFileSync(join(SAMPLES, path));

const T212 = 'trading212/from_2025-01-01_to_2025-12-31_exemplu.csv';
const REVOLUT = 'revolut/revolut-account-statement-exemplu.csv';
const IBKR = 'ibkr/U0000000_2024_activity_exemplu.csv';
const XTB_XLSX = 'xtb/USD_00000000_2026-01-01_2026-06-30_exemplu.xlsx';
const XTB_CSV = 'xtb/xStation5_cashOperations_0000000_2024-01-01_2024-12-31_EUR.csv';
const GENERIC = 'generic/extras-broker-romania-exemplu.csv';

/** Furnizorul de prețuri simulat: știe doar simbolurile din listă; căutarea după ISIN știe câteva ETF-uri. */
const KNOWN: Record<string, SymbolInfo> = {
  AAPL: { currency: 'USD', assetType: 'stock', name: 'Apple Inc.' },
  'SAP.DE': { currency: 'EUR', assetType: 'stock', name: 'SAP SE' },
  'SAP.F': { currency: 'EUR', assetType: 'stock', name: 'SAP SE (Frankfurt)' },
  MSFT: { currency: 'USD', assetType: 'stock', name: 'Microsoft Corporation' },
  TSLA: { currency: 'USD', assetType: 'stock', name: 'Tesla, Inc.' },
  NVDA: { currency: 'USD', assetType: 'stock', name: 'NVIDIA Corporation' },
  'IWDA.AS': { currency: 'EUR', assetType: 'etf', name: 'iShares Core MSCI World UCITS ETF' },
  'VWCE.DE': { currency: 'EUR', assetType: 'etf', name: 'Vanguard FTSE All-World UCITS ETF' },
  'TLV.RO': { currency: 'RON', assetType: 'stock', name: 'Banca Transilvania' },
  'SNP.RO': { currency: 'RON', assetType: 'stock', name: 'OMV Petrom' },
  KO: { currency: 'USD', assetType: 'stock', name: 'The Coca-Cola Company' },
  'CSPX.L': { currency: 'USD', assetType: 'etf', name: 'iShares Core S&P 500 UCITS ETF' }
};
const BY_ISIN: Record<string, string> = { IE00BK5BQT80: 'VWCE.DE' };

function makeLookup(known: Record<string, SymbolInfo> = KNOWN): ImportLookup & { searched: string[] } {
  const searched: string[] = [];
  return {
    searched,
    quotes: async (symbols) => ({ quotes: new Map(symbols.filter((s) => known[s]).map((s) => [s, known[s]])), offline: false }),
    search: async (query) => {
      searched.push(query);
      const symbol = BY_ISIN[query];
      return symbol ? [{ symbol, name: known[symbol]?.name ?? symbol, exchange: 'XETRA', currency: known[symbol]?.currency ?? 'EUR', type: 'etf' as const }] : [];
    }
  };
}
const lookup = makeLookup();

let db: Db;
let alice: User;
let bob: User;
const tmp = mkdtempSync(join(tmpdir(), 'portofoliu-import-'));

beforeAll(async () => {
  db = openDatabase(':memory:');
  alice = await register(db, { username: 'alice', password: 'parola-alice' });
  bob = await register(db, { username: 'bob', password: 'parola-bob-123' });
});

afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of ['transactions', 'broker_symbols', 'import_batches', 'import_templates', 'assets', 'brokers', 'prices', 'price_history', 'history_sync']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM portfolios WHERE name <> 'Principal'").run();
});

/** Alege fișierul (ecranul Import): îl citește, îi recunoaște formatul și arată previzualizarea. */
async function open(user: User, data: Buffer | string, fileName: string, options: ImportOptions = {}, using: ImportLookup = lookup) {
  const tables = readImportFile(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  const session = openImport(db, user.id, tables, fileName, `tok-${fileName}`);
  const view = await previewImport(db, user.id, session, options, using);
  return {
    session,
    view,
    preview: view.preview,
    again: (next: ImportOptions) => previewImport(db, user.id, session, next, using),
    apply: (next: ImportOptions = options) => applyImport(db, user.id, session, next)
  };
}

const quantities = (userId: number, filter = {}): Record<string, number> =>
  Object.fromEntries(getOverview(db, userId, filter).positions.map((p) => [p.symbol, p.quantity]));
const cash = (userId: number): string[] => getOverview(db, userId, {}).cashBalances.map((c) => `${c.brokerName} ${c.currency} ${c.amount}`);
const principal = (userId: number): number => listPortfolios(db, userId).find((p) => p.name === 'Principal')!.id;

/* --------------------------------------------------------- recunoașterea */

describe('recunoașterea extraselor', () => {
  it('recunoaște brokerul după structura fișierului, nu după nume', () => {
    const id = (path: string): string | null => detectReader(readImportFile(sample(path)), 'extras.csv')?.id ?? null;
    expect(id(T212)).toBe('trading212');
    expect(id(REVOLUT)).toBe('revolut');
    expect(id(IBKR)).toBe('ibkr');
    expect(id(XTB_XLSX)).toBe('xtb');
    expect(detectReader(readImportFile(sample(XTB_CSV)), XTB_CSV.split('/')[1])?.id).toBe('xtb');
    // Un tabel oarecare nu este forțat într-un format: urmează maparea coloanelor.
    expect(id(GENERIC)).toBeNull();
  });

  it('explică de ce un fișier nu poate fi citit', () => {
    expect(() => readImportFile(Buffer.alloc(0))).toThrow(/gol/);
    expect(() => readImportFile(Buffer.from('%PDF-1.7 ...'))).toThrow(/PDF/);
    expect(() => readImportFile(Buffer.from('<html><body><table></table></body></html>'))).toThrow(/HTML/);
    const xls = Buffer.alloc(16);
    xls.writeUInt32BE(0xd0cf11e0, 0);
    expect(() => readImportFile(xls)).toThrow(/\.xls/);
    expect(() => openImport(db, alice.id, readImportFile(Buffer.from('doar un rând')), 'x.csv', 't')).toThrow(/nu conține un tabel/);
  });

  it('citește valorile în orice format: zecimale cu virgulă, monedă în sumă, minus la final, date variate', () => {
    expect(parseDecimal('1.234,56', true)).toBe('1234.56');
    expect(parseDecimal('1,234.56', false)).toBe('1234.56');
    expect(parseDecimal('USD 150.25')).toBe('150.25');
    expect(parseDecimal('(12.50)')).toBe('-12.5');
    expect(parseDecimal('12.50-')).toBe('-12.5');
    expect(parseDecimal('−3')).toBe('-3');
    expect(parseWhen('2025-01-10T14:35:12.123Z')).toEqual({ date: '2025-01-10', time: '14:35:12' });
    expect(parseWhen('"2024-03-04, 10:02:13"'.slice(1, -1), 'ymd')).toEqual({ date: '2024-03-04', time: '10:02:13' });
    expect(parseWhen('03.02.2025', 'dmy')).toEqual({ date: '2025-02-03', time: '' });
    expect(parseWhen('02/03/2025', 'mdy')).toEqual({ date: '2025-02-03', time: '' });
    expect(parseWhen('20250203')).toEqual({ date: '2025-02-03', time: '' });
    expect(parseWhen(45691)).toEqual({ date: '2025-02-03', time: '00:00:00' }); // număr de serie Excel
  });

  it('recunoaște tipul operațiunii în mai multe limbi', () => {
    expect(['Cumpărare', 'Market buy', 'BUY - MARKET', 'Kauf', 'B'].map(classifyKind)).toEqual(['buy', 'buy', 'buy', 'buy', 'buy']);
    expect(['Vânzare', 'Limit sell', 'S'].map(classifyKind)).toEqual(['sell', 'sell', 'sell']);
    expect(['Impozit dividend', 'Withholding Tax', 'DIVIDEND TAX (CORRECTION)'].map(classifyKind)).toEqual(['tax', 'tax', 'tax']);
    expect(['Dividend (Ordinary)', 'Depunere', 'CASH TOP-UP', 'Retragere', 'Comision custodie', 'Taxa administrare', 'Dobândă'].map(classifyKind)).toEqual([
      'dividend',
      'deposit',
      'deposit',
      'withdrawal',
      'fee',
      'fee',
      'interest'
    ]);
    expect(classifyKind('Ceva necunoscut')).toBeNull();
  });

  it('normalizează simbolurile brokerilor (NVDA.US -> NVDA) și verifică ISIN-ul', () => {
    expect(guessSymbol('NVDA.US')).toEqual({ symbol: 'NVDA', currency: 'USD', type: null });
    expect(guessSymbol('CSPX.UK').symbol).toBe('CSPX.L');
    expect(guessSymbol('BRK.B').symbol).toBe('BRK-B');
    expect(guessSymbol('SAP', { currency: 'EUR', isin: 'DE0007164600' }).symbol).toBe('SAP.DE');
    expect(guessSymbol('VWCE', { currency: 'EUR', isin: 'IE00BK5BQT80' }).symbol).toBe('VWCE.DE');
    expect(guessSymbol('TLV', { currency: 'RON' }).symbol).toBe('TLV.RO');
    expect(isIsin('US0378331005')).toBe(true);
    expect(isIsin('US0378331006')).toBe(false); // cifra de control greșită
  });

  it('Trading 212: comisioanele trec în moneda prețului, dividendul brut = net + impozit', () => {
    const tables = readImportFile(sample(T212));
    const statement = detectReader(tables, 'x.csv')!.read(tables, 'x.csv');
    expect(statement).toMatchObject({ format: 'trading212', brokerName: 'Trading 212', accountCurrency: 'EUR', ignored: [{ label: 'Currency conversion', count: 1 }] });
    expect(statement.rows.map((r) => `${r.date} ${r.kind} ${r.symbol ?? r.currency}`)).toEqual([
      '2025-01-06 deposit EUR',
      '2025-01-07 buy AAPL',
      '2025-01-08 buy SAP',
      '2025-02-13 dividend AAPL',
      '2025-03-01 interest EUR',
      '2025-03-20 sell AAPL',
      '2025-04-01 withdrawal EUR'
    ]);
    // 1,41 EUR comision × 1,035 USD/EUR = 1,45935 USD.
    expect(statement.rows[1]).toMatchObject({ quantity: '4', price: '243.1', currency: 'USD', fee: '1.45935', cashAmount: '-940.93', cashCurrency: 'EUR', externalId: 't212:EOF0000000001' });
    expect(statement.rows[3]).toMatchObject({ amount: '1', tax: '0.15', currency: 'USD', cashAmount: '0.82', cashCurrency: 'EUR' });
  });

  it('Revolut: sume cu moneda în față, comision de custodie, transferurile interne ignorate', () => {
    const tables = readImportFile(sample(REVOLUT));
    const statement = detectReader(tables, 'x.csv')!.read(tables, 'x.csv');
    expect(statement).toMatchObject({ format: 'revolut', accountCurrency: 'USD' });
    expect(statement.rows.map((r) => `${r.kind} ${r.symbol ?? ''} ${r.amount ?? r.quantity}`)).toEqual([
      'deposit  2000',
      'buy MSFT 1.5',
      'buy TSLA 2',
      'dividend MSFT 1.25',
      'tax MSFT 0.1',
      'fee  0.15',
      'sell TSLA 1',
      'withdrawal  200'
    ]);
    expect(statement.ignored).toEqual([{ label: 'TRANSFER FROM REVOLUT BANK UAB TO REVOLUT SECURITIES EUROPE UAB', count: 1 }]);
  });

  it('Interactive Brokers: secțiunile raportului, bursa din „Listing Exch”, split-ul și pozițiile raportate', () => {
    const tables = readImportFile(sample(IBKR));
    const statement = detectReader(tables, 'x.csv')!.read(tables, 'x.csv');
    expect(statement).toMatchObject({ format: 'ibkr', accountCurrency: 'EUR', openPositions: { IWDA: 10, NVDA: 15 } });
    expect(statement.ignored).toEqual([{ label: 'Forex', count: 1 }]);
    expect(statement.warnings[0]).toMatch(/Forex/);
    const byKind = (kind: string) => statement.rows.filter((r) => r.kind === kind);
    expect(byKind('buy').map((r) => `${r.symbol} ${r.guess?.symbol} ${r.isin} ${r.quantity}@${r.price} fee ${r.fee} cash ${r.cashAmount}`)).toEqual([
      'IWDA IWDA.AS IE00B4L5Y983 10@88.5 fee 1.25 cash -886.25',
      'NVDA NVDA US67066G1040 2@852.37 fee 1 cash -1705.74'
    ]);
    expect(byKind('sell')).toMatchObject([{ symbol: 'NVDA', quantity: '5', price: '128', cashAmount: '639' }]);
    expect(byKind('split')).toMatchObject([{ symbol: 'NVDA', date: '2024-06-07', ratio: '10:1' }]);
    expect(byKind('dividend')).toMatchObject([{ symbol: 'NVDA', amount: '0.2', perShare: '0.01', perShareCurrency: 'USD' }]);
    expect(byKind('tax')).toMatchObject([{ symbol: 'NVDA', amount: '0.03' }]);
    expect(byKind('deposit')).toMatchObject([{ currency: 'EUR', amount: '3000' }]);
    expect(byKind('fee')).toMatchObject([{ currency: 'USD', amount: '1.5', symbol: null }]);
    expect(byKind('interest')).toMatchObject([{ currency: 'EUR', amount: '2.14' }]);
  });

  it('CSV oarecare: propune maparea după denumirile coloanelor (în română) și formatul valorilor', () => {
    const table = extractTable(readImportFile(sample(GENERIC)))!;
    const mapping = guessMapping(table);
    expect(mapping).toMatchObject({
      columns: { date: 'data', type: 'tipoperatiune', symbol: 'simbol', isin: 'isin', quantity: 'cantitate', price: 'pret', amount: 'valoare', fee: 'comision', currency: 'moneda' },
      dateOrder: 'dmy',
      decimalComma: true
    });
    const statement = readWithMapping(table, mapping);
    expect(statement.problems).toEqual([]);
    expect(statement.rows.map((r) => `${r.date} ${r.kind} ${r.guess?.symbol ?? r.currency} ${r.quantity ?? ''} ${r.amount ?? r.price}`)).toEqual([
      '2025-02-03 deposit RON  20000',
      '2025-02-04 buy TLV.RO 500 28.4',
      '2025-02-10 buy SNP.RO 3000 0.612',
      '2025-06-05 dividend SNP.RO  131.1',
      '2025-06-05 tax SNP.RO  13.11',
      '2025-07-15 sell TLV.RO 200 32.1',
      '2025-07-31 fee RON  5'
    ]);
  });
});

/* ------------------------------------------------------------- importul */

describe('importul din extras', () => {
  it('Trading 212: previzualizare, import, poziții și cash', async () => {
    const { preview, apply } = await open(alice, sample(T212), 'trading212.csv');
    expect(preview).toMatchObject({
      format: 'trading212',
      brokerName: 'Trading 212',
      brokerId: null,
      portfolioId: principal(alice.id),
      accountCurrency: 'EUR',
      dateFrom: '2025-01-06',
      dateTo: '2025-04-01',
      counts: { new: 7, duplicate: 0, error: 0, warning: 0 },
      byKind: { deposit: 1, buy: 2, dividend: 1, interest: 1, sell: 1, withdrawal: 1 }
    });
    expect(preview!.instruments.map((i) => `${i.key} ${i.symbol} ${i.status}`)).toEqual(['AAPL AAPL confirmed', 'SAP SAP.DE confirmed']);
    expect(preview!.warnings.some((w) => /depuneri și retrageri/.test(w))).toBe(true);

    const result = apply();
    expect(result).toMatchObject({ imported: 7, createdAssets: 2, portfolioName: 'Principal', brokerName: 'Trading 212', unconfirmed: [] });
    expect(result.positions.map((p) => `${p.symbol} ${p.quantity}`)).toEqual(['AAPL 3', 'SAP.DE 3']);
    expect(listBrokers(db, alice.id).map((b) => b.name)).toEqual(['Trading 212']);
    expect(quantities(alice.id)).toEqual({ AAPL: 3, 'SAP.DE': 3 });
    // Cash-ul vine din sumele efectiv debitate/creditate (în EUR), nu din cursul de azi.
    expect(cash(alice.id)).toEqual(['Trading 212 EUR 506.88']);
    const [dividend] = listTransactions(db, alice.id, { type: 'dividend' });
    expect(dividend).toMatchObject({ symbol: 'AAPL', grossAmount: 1, taxWithheld: 0.15, netAmount: 0.85, currency: 'USD', cashAmount: 0.82, cashCurrency: 'EUR' });
    expect(listTransactions(db, alice.id, { type: 'buy', symbol: 'AAPL' })[0]).toMatchObject({ fee: 1.45935, price: 243.1 });
    // Simbolul și ISIN-ul se țin minte pentru importurile viitoare.
    expect(listAssets(db, alice.id).map((a) => `${a.symbol} ${a.isin}`)).toEqual(['AAPL US0378331005', 'SAP.DE DE0007164600']);
  });

  it('reimportul aceluiași extras nu dublează nimic', async () => {
    (await open(alice, sample(T212), 'trading212.csv')).apply();
    const again = await open(alice, sample(T212), 'trading212.csv');
    expect(again.preview!.counts).toMatchObject({ new: 0, duplicate: 7 });
    expect(again.preview!.instruments.every((i) => i.status === 'existing')).toBe(true);
    expect(again.apply()).toMatchObject({ imported: 0, duplicates: 7, batchId: null });
    expect(listTransactions(db, alice.id)).toHaveLength(7);
    expect(listImportBatches(db, alice.id)).toHaveLength(1);
  });

  it('fiecare import este un lot care se anulează complet (tranzacții, active și brokerul create)', async () => {
    const { apply } = await open(alice, sample(T212), 'trading212.csv');
    const { batchId } = apply();
    expect(listImportBatches(db, alice.id)).toMatchObject([
      { id: batchId, fileName: 'trading212.csv', formatLabel: 'Trading 212', brokerName: 'Trading 212', portfolioName: 'Principal', txCount: 7, remaining: 7, dateFrom: '2025-01-06', dateTo: '2025-04-01' }
    ]);
    expect(undoImport(db, alice.id, batchId!)).toEqual({ removed: 7, restored: 0 });
    expect(listTransactions(db, alice.id)).toEqual([]);
    expect(listAssets(db, alice.id)).toEqual([]);
    expect(listBrokers(db, alice.id)).toEqual([]);
    expect(listImportBatches(db, alice.id)).toEqual([]);
    // După anulare, același fișier se poate importa din nou.
    expect((await open(alice, sample(T212), 'trading212.csv')).apply().imported).toBe(7);
  });

  it('anularea pune la loc tranzacțiile manuale înlocuite și păstrează activele folosite în altă parte', async () => {
    const broker = createBroker(db, alice.id, { name: 'Trading 212' });
    // Cumpărarea introdusă de mână, cu prețul rotunjit (deci nu identică).
    addPurchase(db, alice.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: broker.id, date: '2025-01-07', quantity: 4, price: 243, fee: 0 });
    const first = await open(alice, sample(T212), 'trading212.csv');
    expect(first.preview!.manualCount).toBe(1);
    const result = first.apply({ replaceManual: true });
    expect(result).toMatchObject({ imported: 7, replaced: 1, createdAssets: 1 });
    expect(listTransactions(db, alice.id, { symbol: 'AAPL', type: 'buy' }).map((t) => t.price)).toEqual([243.1]);

    expect(undoImport(db, alice.id, result.batchId!)).toEqual({ removed: 7, restored: 1 });
    // Tranzacția manuală revine; AAPL și brokerul existau dinainte, deci rămân; SAP.DE (creat de import) dispare.
    expect(listTransactions(db, alice.id).map((t) => `${t.type} ${t.symbol} ${t.price}`)).toEqual(['buy AAPL 243']);
    expect(listAssets(db, alice.id).map((a) => a.symbol)).toEqual(['AAPL']);
    expect(listBrokers(db, alice.id).map((b) => b.name)).toEqual(['Trading 212']);
  });

  it('refuză anularea dacă o tranzacție adăugată ulterior depinde de import', async () => {
    const { batchId } = (await open(alice, sample(T212), 'trading212.csv')).apply();
    const [aapl] = listAssets(db, alice.id).filter((a) => a.symbol === 'AAPL');
    const broker = listBrokers(db, alice.id)[0];
    createTransaction(db, alice.id, { type: 'sell', assetId: aapl.id, brokerId: broker.id, date: '2025-05-02', quantity: 3, price: 260, fee: 0 });
    expect(() => undoImport(db, alice.id, batchId!)).toThrow(/nu poate fi anulat.*AAPL/);
    expect(listTransactions(db, alice.id)).toHaveLength(8); // nimic nu s-a schimbat
    expect(() => undoImport(db, bob.id, batchId!)).toThrow(/nu a fost găsit/); // lotul altui utilizator
  });

  it('întreabă de simbolurile negăsite și ține minte răspunsul', async () => {
    const withoutSapDe = makeLookup(Object.fromEntries(Object.entries(KNOWN).filter(([s]) => s !== 'SAP.DE')));
    const first = await open(alice, sample(T212), 'trading212.csv', {}, withoutSapDe);
    expect(first.preview!.instruments[0]).toMatchObject({ key: 'SAP', symbol: 'SAP.DE', status: 'unconfirmed', isin: 'DE0007164600' });

    // Răspunsul utilizatorului: simbolul corect la furnizorul de prețuri.
    const answered = await first.again({ symbols: { SAP: 'sap.f' } });
    expect(answered.preview!.instruments.find((i) => i.key === 'SAP')).toMatchObject({ symbol: 'SAP.F', status: 'confirmed', currency: 'EUR' });
    expect(() => first.apply({ symbols: { SAP: 'SAP F?' } })).toThrow(/nu este valid/);
    first.apply({ symbols: { SAP: 'SAP.F' } });
    expect(listAssets(db, alice.id).map((a) => a.symbol)).toEqual(['AAPL', 'SAP.F']);

    // La următorul import, SAP din Trading 212 este recunoscut fără nicio întrebare.
    const second = await open(alice, sample(T212), 'trading212.csv', {}, withoutSapDe);
    expect(second.preview!.instruments.find((i) => i.key === 'SAP')).toMatchObject({ symbol: 'SAP.F', status: 'existing' });

    // Un instrument lăsat fără simbol nu se importă.
    const skipped = await open(bob, sample(T212), 'trading212.csv', { symbols: { SAP: '' } });
    expect(skipped.preview!.instruments.find((i) => i.key === 'SAP')).toMatchObject({ status: 'skipped' });
    expect(skipped.preview!.counts.skipped).toBe(1);
    expect(skipped.apply().imported).toBe(6);
  });

  it('identifică instrumentele după ISIN (activ existent sau căutare la furnizor)', async () => {
    (await open(alice, sample(T212), 'trading212.csv')).apply(); // AAPL primește ISIN-ul US0378331005
    const searching = makeLookup();
    const file = ['Data;Tip;ISIN;Cantitate;Pret;Moneda', '01.08.2025;Cumparare;US0378331005;1;220;USD', '02.08.2025;Cumparare;IE00BK5BQT80;10;130,5;EUR'].join('\n');
    const view = await open(alice, file, 'isin.csv', {}, searching);
    expect(view.preview).toBeNull(); // format necunoscut: întâi maparea
    const { preview } = await view.again({ mapping: view.view.mapping!.mapping });
    expect(preview!.instruments.map((i) => `${i.key} ${i.symbol} ${i.status}`)).toEqual(['US0378331005 AAPL existing', 'IE00BK5BQT80 VWCE.DE confirmed']);
    expect(searching.searched).toEqual(['IE00BK5BQT80']);
    const result = view.apply({ mapping: view.view.mapping!.mapping, brokerName: 'Alt broker' });
    expect(result).toMatchObject({ imported: 2, createdAssets: 1, brokerName: 'Alt broker' });
    expect(listAssets(db, alice.id).find((a) => a.symbol === 'VWCE.DE')).toMatchObject({ isin: 'IE00BK5BQT80', type: 'etf', currency: 'EUR' });
  });

  it('Interactive Brokers: split, dividend cu impozitul reținut, comisioane și poziții ca în raport', async () => {
    const { preview, apply } = await open(alice, sample(IBKR), 'ibkr.csv');
    expect(preview).toMatchObject({ format: 'ibkr', accountCurrency: 'EUR', counts: { new: 8, error: 0 }, ignored: [{ label: 'Forex', count: 1 }] });
    expect(preview!.warnings.some((w) => /Forex/.test(w))).toBe(true);
    // Dividendul și impozitul lui (două rânduri în raport) devin o singură tranzacție.
    expect(preview!.rows.find((r) => r.kind === 'dividend')).toMatchObject({ symbol: 'NVDA', amount: 0.2, tax: 0.03, message: expect.stringMatching(/Include rândurile/) });

    const result = apply();
    expect(result).toMatchObject({ imported: 8, byKind: { buy: 2, sell: 1, split: 1, dividend: 1, deposit: 1, fee: 1, interest: 1 } });
    expect(result.positions).toEqual([
      { symbol: 'IWDA.AS', brokerSymbol: 'IWDA', name: 'iShares Core MSCI World UCITS ETF', quantity: 10, reportedQuantity: 10 },
      { symbol: 'NVDA', brokerSymbol: 'NVDA', name: 'NVIDIA Corporation', quantity: 15, reportedQuantity: 15 }
    ]);
    expect(listTransactions(db, alice.id, { type: 'split' })).toMatchObject([{ symbol: 'NVDA', splitNumerator: 10, splitDenominator: 1, portfolioId: null }]);
    expect(listTransactions(db, alice.id, { type: 'dividend' })).toMatchObject([{ grossAmount: 0.2, taxWithheld: 0.03, netAmount: 0.17, currency: 'USD' }]);
    // Cash pe monede, din sumele raportate (fără schimburile valutare, care nu se importă).
    expect(cash(alice.id).sort()).toEqual(['Interactive Brokers EUR 2115.89', 'Interactive Brokers USD -1068.07']);
  });

  it('Revolut: impozitul corectat se adaugă dividendului, comisionul de custodie scade din cash', async () => {
    const { apply } = await open(alice, sample(REVOLUT), 'revolut.csv');
    expect(apply()).toMatchObject({ imported: 7, byKind: { deposit: 1, buy: 2, dividend: 1, fee: 1, sell: 1, withdrawal: 1 } });
    expect(listTransactions(db, alice.id, { type: 'dividend' })).toMatchObject([{ symbol: 'MSFT', grossAmount: 1.25, taxWithheld: 0.1, netAmount: 1.15 }]);
    expect(quantities(alice.id)).toEqual({ MSFT: 1.5, TSLA: 1 });
    expect(cash(alice.id)).toEqual(['Revolut USD 821']);
  });

  it('XTB (Excel, formatul actual): dividend cu impozit, poziții comparate cu raportul', async () => {
    const { apply } = await open(alice, sample(XTB_XLSX), XTB_XLSX.split('/')[1]);
    const result = apply();
    expect(result).toMatchObject({ imported: 9, byKind: { deposit: 1, buy: 5, sell: 1, dividend: 1, interest: 1 }, unconfirmed: ['GOOG'] });
    expect(result.positions.map((p) => `${p.symbol} ${p.quantity}/${p.reportedQuantity}`)).toEqual(['CSPX.L 1.2345/1.2345', 'KO 10/10', 'NVDA 2/2']);
    expect(listTransactions(db, alice.id, { type: 'dividend' })).toMatchObject([{ symbol: 'KO', grossAmount: 5.1, taxWithheld: 0.51, currency: 'USD' }]);
    expect(cash(alice.id)).toEqual(['XTB USD 1100.94']);
  });

  it('XTB (CSV vechi): cont în EUR, dividende în moneda activului', async () => {
    const { apply } = await open(alice, sample(XTB_CSV), XTB_CSV.split('/')[1]);
    expect(apply()).toMatchObject({ imported: 9, byKind: { deposit: 1, buy: 5, dividend: 2, interest: 1 } });
    expect(cash(alice.id)).toEqual(['XTB EUR 411.29']);
  });

  it('CSV oarecare: maparea se salvează ca șablon și se aplică singură data viitoare', async () => {
    const first = await open(alice, sample(GENERIC), 'extras-ro.csv');
    expect(first.preview).toBeNull();
    expect(first.view.mapping).toMatchObject({ templateId: null, headers: ['Data', 'Tip operațiune', 'Simbol', 'ISIN', 'Cantitate', 'Preț', 'Valoare', 'Comision', 'Monedă'] });
    expect(first.view.mapping!.typeValues.map((t) => `${t.value}=${t.kind}`)).toEqual([
      'Cumpărare=buy',
      'Depunere=deposit',
      'Dividend=dividend',
      'Impozit dividend=tax',
      'Vânzare=sell',
      'Comision custodie=fee'
    ]);
    // Comisionul de custodie nu se importă (alegerea utilizatorului din lista tipurilor).
    const mapping = { ...first.view.mapping!.mapping, types: { comisioncustodie: 'ignore' as const } };
    const { preview } = await first.again({ mapping, brokerName: 'Broker RO' });
    expect(preview).toMatchObject({ format: 'csv', formatLabel: 'Fișier cu mapare proprie', brokerName: 'Broker RO', accountCurrency: 'RON', counts: { new: 5, error: 0 } });
    expect(preview!.ignored).toEqual([{ label: 'Comision custodie', count: 1 }]);
    const result = first.apply({ mapping, brokerName: 'Broker RO', templateName: 'Broker RO (CSV)' });
    expect(result).toMatchObject({ imported: 5, templateSaved: 'Broker RO (CSV)', createdAssets: 2 });
    expect(quantities(alice.id)).toEqual({ 'TLV.RO': 300, 'SNP.RO': 3000 });
    expect(listTransactions(db, alice.id, { type: 'dividend' })).toMatchObject([{ symbol: 'SNP.RO', grossAmount: 131.1, taxWithheld: 13.11 }]);
    expect(listTransactions(db, alice.id, { type: 'buy', symbol: 'TLV.RO' })).toMatchObject([{ quantity: 500, price: 28.4, fee: 22.72, currency: 'RON' }]);

    const templates = listImportTemplates(db, alice.id);
    expect(templates).toMatchObject([{ name: 'Broker RO (CSV)' }]);
    // Același fișier (sau unul nou cu aceleași coloane): șablonul se aplică direct, cu tot cu tipurile ignorate.
    const second = await open(alice, sample(GENERIC), 'extras-ro-august.csv', { brokerName: 'Broker RO' });
    expect(second.view.mapping).toMatchObject({ templateName: 'Broker RO (CSV)' });
    expect(second.preview).toMatchObject({ formatLabel: 'Șablon „Broker RO (CSV)”', counts: { new: 0, duplicate: 5 }, ignored: [{ label: 'Comision custodie', count: 1 }] });
    // Șabloanele sunt ale fiecărui utilizator.
    expect(listImportTemplates(db, bob.id)).toEqual([]);
    expect((await open(bob, sample(GENERIC), 'extras-ro.csv')).preview).toBeNull();
    deleteImportTemplate(db, alice.id, templates[0].id);
    expect(listImportTemplates(db, alice.id)).toEqual([]);
  });

  it('tranzacțiile intră în portofoliul ales', async () => {
    const pension = createPortfolio(db, alice.id, { name: 'Pensie', color: 'teal', icon: 'piggy-bank', baseCurrency: 'RON', benchmark: '^GSPC' });
    const { preview, apply } = await open(alice, sample(T212), 'trading212.csv', { portfolioId: pension.id });
    expect(preview!.portfolioId).toBe(pension.id);
    expect(apply()).toMatchObject({ imported: 7, portfolioName: 'Pensie' });
    expect(listTransactions(db, alice.id).every((t) => t.portfolioName === 'Pensie')).toBe(true);
    expect(quantities(alice.id, { portfolioId: pension.id })).toEqual({ AAPL: 3, 'SAP.DE': 3 });
    expect(quantities(alice.id, { portfolioId: principal(alice.id) })).toEqual({});
    expect(listImportBatches(db, alice.id)[0]).toMatchObject({ portfolioName: 'Pensie' });
    // Identificatorii de la broker sunt unici: același extras nu se poate dubla nici în alt portofoliu.
    const other = await open(alice, sample(T212), 'trading212.csv', { portfolioId: principal(alice.id) });
    expect(other.preview!.counts.duplicate).toBe(7);
  });

  it('CSV-ul exportat din aplicație se importă tot ca lot, care se poate anula', async () => {
    (await open(alice, sample(T212), 'trading212.csv')).apply();
    const { csv } = exportTransactionsCsv(db, alice.id);
    const res = importTransactionsCsv(db, bob.id, csv, 'tranzactii.csv');
    expect(res).toMatchObject({ imported: 7, errors: [] });
    const [batch] = listImportBatches(db, bob.id);
    expect(batch).toMatchObject({ fileName: 'tranzactii.csv', formatLabel: 'CSV din aplicație', txCount: 7, dateFrom: '2025-01-06', dateTo: '2025-04-01' });
    // Tranzacțiile din CSV-ul aplicației sunt ale utilizatorului (nu dintr-un extras): la importul extrasului contează ca manuale,
    // iar cele identice sunt recunoscute ca dubluri.
    const statement = await open(bob, sample(T212), 'trading212.csv');
    expect(statement.preview).toMatchObject({ manualCount: 4, counts: { new: 0, duplicate: 7 } });
    expect(undoImport(db, bob.id, batch.id)).toEqual({ removed: 7, restored: 0 });
    expect(listTransactions(db, bob.id)).toEqual([]);
    expect(listAssets(db, bob.id)).toEqual([]);
    expect(listBrokers(db, bob.id)).toEqual([]);
  });

  it('backup-ul păstrează loturile și șabloanele: după restaurare, importul se poate anula', async () => {
    const generic = await open(alice, sample(GENERIC), 'extras-ro.csv');
    generic.apply({ mapping: generic.view.mapping!.mapping, templateName: 'RO' });
    (await open(alice, sample(T212), 'trading212.csv')).apply();
    const file = join(tmp, 'backup-import.db');
    createBackup(db, alice.id, file);

    restoreBackup(db, bob.id, file);
    expect(listImportTemplates(db, bob.id)).toMatchObject([{ name: 'RO' }]);
    const batches = listImportBatches(db, bob.id);
    expect(batches.map((b) => `${b.formatLabel} ${b.remaining}`)).toEqual(['Trading 212 7', 'Șablon „RO” 6']);
    expect(undoImport(db, bob.id, batches[0].id)).toEqual({ removed: 7, restored: 0 });
    // Activele create de importul anulat dispar, cele din celălalt import rămân.
    expect(listAssets(db, bob.id).map((a) => a.symbol)).toEqual(['SNP.RO', 'TLV.RO']);
    expect(listTransactions(db, alice.id)).toHaveLength(13); // datele lui Alice nu sunt atinse
  });
});
