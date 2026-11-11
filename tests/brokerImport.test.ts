/**
 * Teste pentru preluarea pozițiilor din raportul XTB (xStation): cititorul de
 * fișiere Excel, interpretarea raportului și importul lui prin ecranul Import
 * (fără dubluri la reimport, dividende în moneda activului, istoric incomplet, backup).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderId, User } from '@shared/types';
import { mapXtbSymbol, parseXtbReport, summarizeXtbSymbols, XtbParseError, type XtbDividend, type XtbTrade } from '@shared/brokers/xtb';
import { parseCsv } from '@shared/csv';
import { migrate, openDatabase, schemaVersion, type Db } from '@main/db/database';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '@main/db/migrations';
import { createAesBox } from '@main/secrets';
import { looksLikeZip, readXlsx, XlsxError } from '@main/xlsx';
import { register } from '@main/services/auth';
import { createBackup, restoreBackup } from '@main/services/backup';
import { applyImport, openImport, previewImport, readImportFile, type ImportLookup } from '@main/services/statementImport';
import { createBroker, listBrokers } from '@main/services/brokers';
import { listAssets } from '@main/services/assets';
import { addPurchase, listTransactions } from '@main/services/transactions';
import { getOverview } from '@main/services/portfolio';
import type { PriceProvider, Quote, SymbolRef } from '@main/prices/provider';
import { PriceService } from '@main/prices/service';
import { buildXlsx, zip, type TestCell } from './xlsxWriter';

/* ------------------------------------------------------------ date de test */

/** Raport CSV (formatul vechi al xStation) pentru un cont în EUR. Rândurile urmează exemple reale. */
const CSV_NAME = 'xStation5_cashOperations_1234567_2023-01-01_2024-12-31_EUR.csv';
const CSV = [
  'ID;Type;Time;Symbol;Comment;Amount',
  '650000001;Free funds interests;01.10.2024 08:00:00;;Free-funds Interest 2024-09;0.42',
  '623424924;Withholding tax;26.09.2024 11:00:23;FB.US;FB.US USD WHT 15%;-0.69',
  '623424923;Dividend;26.09.2024 11:00:23;FB.US;FB.US USD 0.5000/ SHR;4.60',
  '600000001;Stocks/ETF purchase;02.09.2024 16:00:00;FB.US;OPEN BUY 10 @ 500.00;-4600',
  '579214169;Dividend;12.07.2024 11:00:27;SPYL.DE;SPYL.DE USD 0.6600/ SHR;1.21',
  '547615042;Stocks/ETF purchase;14.05.2024 17:21:09;CSPX.UK;OPEN BUY 0.1799 @ 550.30;-91.08',
  '530692719;Stocks/ETF purchase;12.04.2024 13:01:45;SPYL.DE;OPEN BUY 34/42.5658 @ 11.7480;-399.43',
  '530692712;Stocks/ETF purchase;12.04.2024 13:01:44;SPYL.DE;OPEN BUY 0.5658/42.5658 @ 11.7470;-6.65',
  '524538242;Stocks/ETF purchase;02.04.2024 14:48:16;SPYL.DE;OPEN BUY 85 @ 11.7305;-997.09',
  '524303821;Stocks/ETF sale;02.04.2024 11:42:37;ZAL.DE;CLOSE BUY 1 @ 26.280;26.28',
  '419846716;Ações/ETF compra;25.07.2023 20:56:07;GOOGL.US;OPEN BUY 1 @ 122.34;-111.25',
  '100000001;Deposit;02.01.2023 10:00:00;;Deposit;5000'
].join('\r\n');

/** Data și ora ca număr de serie Excel (zile de la 30.12.1899). */
const serial = (iso: string): number => Date.parse(`${iso}Z`) / 86_400_000 + 25569;

/**
 * Raport Excel pentru un cont în RON, cu structura exportului nou: rânduri goale
 * și datele contului deasupra tabelului, prima coloană liberă, rând de total.
 */
function ronWorkbook(options: { currencyLabel?: boolean } = {}): Buffer {
  const meta: (TestCell[] | null)[] =
    options.currencyLabel === false
      ? [null, null]
      : [null, null, [null, 'Name and surname', 'Account', 'Currency', 'Balance'], [null, 'Ion Popescu', 1234567, 'RON', 15230.55]];
  return buildXlsx([
    {
      name: 'CLOSED POSITION HISTORY',
      rows: [null, [null, 'Position', 'Symbol', 'Type', 'Volume', 'Open time', 'Open price', 'Close time', 'Close price', 'Comment']]
    },
    {
      name: 'OPEN POSITION 11112026',
      rows: [
        null,
        [null, 'Position', 'Symbol', 'Type', 'Volume', 'Open time', 'Open price', 'Market price'],
        [null, 900001, 'AAPL.US', 'BUY', 10, serial('2024-03-04T16:35:00'), 200, 230],
        [null, 900002, 'SPYL.DE', 'BUY', 60, serial('2024-03-05T10:00:00'), 12, 13],
        [null, 900003, 'SPYL.DE', 'BUY', 40, serial('2024-03-05T10:00:01'), 12, 13],
        [null, 900004, 'MSFT.US', 'BUY', 3, serial('2022-01-10T16:35:00'), 310, 420],
        [null, null, 'Total', null, 113]
      ]
    },
    {
      name: 'CASH OPERATION HISTORY',
      rows: [
        ...meta,
        null,
        [null, 'ID', 'Type', 'Time', 'Comment', 'Symbol', 'Amount'],
        [null, 700000001, 'deposit', serial('2024-03-01T09:00:00'), 'Deposit', null, 20000],
        [null, 700000002, 'Stock purchase', serial('2024-03-04T16:35:00'), 'OPEN BUY 10 @ 200.00', 'AAPL.US', -9200],
        [null, 700000003, 'Stock purchase', serial('2024-03-05T10:00:00'), 'OPEN BUY 100 @ 12.0000', 'SPYL.DE', -6000],
        [null, 700000004, 'DIVIDENT', serial('2024-05-16T11:00:00'), 'AAPL.US USD 0.2500/ SHR', 'AAPL.US', 11.5],
        [null, 700000005, 'Withholding Tax', serial('2024-05-16T11:00:00'), 'AAPL.US USD WHT 10%', 'AAPL.US', -1.15],
        [null, 700000006, 'DIVIDENT', serial('2024-06-20T11:00:00'), 'SPYL.DE USD 0.0700/ SHR', 'SPYL.DE', 32.2],
        [null, 700000007, 'swap', serial('2024-06-21T00:00:00'), 'Swap EURUSD', 'EURUSD', -0.8],
        [null, null, null, null, 'Total', null, 4841.75]
      ]
    }
  ]);
}

/**
 * Raport Excel în formatul actual al xStation (2026), pentru un cont în USD:
 * foile „Closed Positions”, „Cash Operations” și „Open Positions”, datele
 * contului deasupra fiecărui tabel, coloanele Ticker / Category / Instrument,
 * comentarii cu sau fără simbol și un rând de total pe instrument la pozițiile deschise.
 */
const CURRENT_NAME = 'USD_12345678_2026-01-01_2026-11-11.xlsx';
function currentWorkbook(): Buffer {
  const head = (title: string): (TestCell[] | null)[] => [
    ['Account number', 12345678],
    [title],
    ['Date from (UTC)', serial('2026-01-01T00:00:00')],
    ['Date to (UTC)', serial('2026-11-11T23:59:59')],
    null
  ];
  const cashHeader = ['Type', 'Instrument', 'Ticker', 'Category', 'Time', 'Amount', 'ID', 'Comment', 'Product', 'Position ID'];
  return buildXlsx([
    {
      name: 'Closed Positions',
      rows: [
        ...head('Closed Positions'),
        ['Instrument', 'Ticker', 'Category', 'Type', 'Volume', 'Open Price', 'Open Time (UTC)', 'Close Price', 'Close Time (UTC)', 'Product', 'Profit/Loss', 'Position ID', 'Comment'],
        ['Alphabet', 'GOOGC.US', 'STOCK', 'BUY', 1.5, 180, serial('2026-01-07T15:31:00'), 195, serial('2026-03-10T15:45:00'), 'My Trades', 22.5, 2000000002],
        ['Total', null, null, null, null, null, null, null, null, null, 22.5]
      ]
    },
    {
      name: 'Cash Operations',
      rows: [
        ...head('Cash Operations'),
        cashHeader,
        ['Deposit', null, null, null, serial('2026-01-05T09:00:00'), 3000, '1000000001', 'BRIDGER_PAY deposit, BRIDGER_PAY provider transaction id=ab12, id=7654321', 'My Trades'],
        ['Stock purchase', 'Nvidia', 'NVDA.US', 'STOCK', serial('2026-01-06T15:31:00'), -362.5, '1000000002', 'OPEN BUY NVDA.US 2 @ 181.25', 'My Trades', '2000000001'],
        ['Stock purchase', 'Alphabet', 'GOOGC.US', 'STOCK', serial('2026-01-07T15:31:00'), -270, '1000000003', 'OPEN BUY 1.5 @ 180.00', 'My Trades', '2000000002'],
        ['Stock purchase', 'Core S&P 500', 'CSPX.UK', 'ETF', serial('2026-02-02T09:05:00'), -700.5, '1000000004', 'OPEN BUY CSPX.UK 1/1.2345 @ 700.50', 'My Trades', '2000000003'],
        ['Stock purchase', 'Core S&P 500', 'CSPX.UK', 'ETF', serial('2026-02-02T09:05:01'), -164.27, '1000000005', 'OPEN BUY CSPX.UK 0.2345/1.2345 @ 700.50', 'My Trades', '2000000004'],
        ['Stock sell', 'Alphabet', 'GOOGC.US', 'STOCK', serial('2026-03-10T15:45:00'), 292.5, '1000000006', 'CLOSE BUY GOOGC.US 1.5 @ 195.00', 'My Trades', '2000000002'],
        ['Free funds interest', null, null, null, serial('2026-04-01T08:00:00'), 1.12, '1000000007', 'Free-funds Interest 2026-03', 'My Trades'],
        ['Transfer', null, null, null, serial('2026-04-02T10:00:00'), -50, '1000000008', 'Currency conversion, GBP to USD from TA: 111 to: 222, Exchange rate:1.250000', 'My Trades'],
        ['Total', null, null, null, null, 1746.35]
      ]
    },
    {
      name: 'Open Positions',
      rows: [
        ['Account number', 12345678],
        ['Open Positions'],
        ['Data as of report generated', serial('2026-11-11T17:00:00')],
        ['Product', 'Metric', 'Amount', 'Currency'],
        ['My Trades', 'Open position value', 1300.1, 'USD'],
        ['My Trades', 'Open position profit', 73.4, 'USD'],
        ['Note', 'Summary values and open positions are shown as of the report generation time'],
        ['Product', 'Instrument/Position', 'Ticker', 'Category', 'Type', 'Volume', 'Value', 'Current price', 'Open price', 'Open time (UTC)'],
        // Un rând de total pe instrument, urmat de câte un rând pentru fiecare poziție.
        ['My Trades', 'Core S&P 500', 'CSPX.UK', 'ETF', null, 1.2345, 900, null, 700.5],
        ['My Trades', '2000000003', 'CSPX.UK', null, 'BUY', 1, 729, 729, 700.5, serial('2026-02-02T09:05:00')],
        ['My Trades', '2000000004', 'CSPX.UK', null, 'BUY', 0.2345, 171, 729, 700.5, serial('2026-02-02T09:05:01')],
        ['My Trades', 'Nvidia', 'NVDA.US', 'STOCK', null, 2, 400, null, 181.25],
        ['My Trades', '2000000001', 'NVDA.US', null, 'BUY', 2, 400, 200, 181.25, serial('2026-01-06T15:31:00')]
      ]
    }
  ]);
}

/** Furnizor de prețuri simulat: știe doar simbolurile din listă. */
const KNOWN: Record<string, { currency: string; assetType: 'stock' | 'etf'; name: string }> = {
  'SPYL.DE': { currency: 'EUR', assetType: 'etf', name: 'SPDR S&P 500 UCITS ETF' },
  'CSPX.L': { currency: 'USD', assetType: 'etf', name: 'iShares Core S&P 500 UCITS ETF' },
  GOOGL: { currency: 'USD', assetType: 'stock', name: 'Alphabet Inc.' },
  AAPL: { currency: 'USD', assetType: 'stock', name: 'Apple Inc.' },
  NVDA: { currency: 'USD', assetType: 'stock', name: 'NVIDIA Corporation' },
  'ZAL.DE': { currency: 'EUR', assetType: 'stock', name: 'Zalando SE' }
};
const lookup: ImportLookup = {
  quotes: async (symbols) => ({ quotes: new Map(symbols.filter((s) => KNOWN[s]).map((s) => [s, KNOWN[s]])), offline: false }),
  search: async () => []
};
const offlineLookup: ImportLookup = {
  quotes: async () => {
    throw new Error('fără rețea');
  },
  search: async () => {
    throw new Error('fără rețea');
  }
};

/** Fișierul ales (Excel sau CSV), citit ca la import și interpretat ca raport XTB. */
const readXtbFile = (data: Buffer, fileName: string) => parseXtbReport(readImportFile(data), fileName);

/* --------------------------------------------------------- cititorul .xlsx */

describe('cititorul de fișiere .xlsx', () => {
  it('citește foile, textul și numerele, păstrând poziția coloanelor', () => {
    const sheets = readXlsx(
      buildXlsx([
        { name: 'Prima & a doua', rows: [['A', 'B <b>', 3.5], null, [null, 'sub', -2]] },
        { name: 'Goală', rows: [] }
      ])
    );
    expect(sheets.map((s) => s.name)).toEqual(['Prima & a doua', 'Goală']);
    // Rândul gol dispare; celula liberă din stânga rămâne ca null.
    expect(sheets[0].rows).toEqual([
      ['A', 'B <b>', 3.5],
      [null, 'sub', -2]
    ]);
    expect(sheets[1].rows).toEqual([]);
  });

  it('acceptă text în celulă, text formatat pe bucăți și elemente cu prefix de namespace', () => {
    const file = zip({
      'xl/workbook.xml': '<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="Date" sheetId="7" r:id="rId9"/></x:sheets></x:workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId9" Target="/xl/worksheets/date.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<x:sst><x:si><x:r><x:rPr><x:b/></x:rPr><x:t>OPEN </x:t></x:r><x:r><x:t xml:space="preserve">BUY 1 @ 2</x:t></x:r></x:si></x:sst>',
      'xl/worksheets/date.xml':
        '<x:worksheet><x:sheetData><x:row r="1" ht="15"/><x:row r="3" spans="2:6"><x:c r="B3" t="s"><x:v>0</x:v></x:c><x:c r="C3" s="2"/>' +
        '<x:c r="D3" t="inlineStr"><x:is><x:t>A&amp;B &#233;</x:t></x:is></x:c><x:c r="E3" t="str"><x:f>1+1</x:f><x:v>text</x:v></x:c>' +
        '<x:c r="F3"><x:v>45384.5</x:v></x:c></x:row></x:sheetData></x:worksheet>'
    });
    expect(readXlsx(file)).toEqual([{ name: 'Date', rows: [[null, 'OPEN BUY 1 @ 2', null, 'A&B é', 'text', 45384.5]] }]);
  });

  it('respinge fișierele care nu sunt registre Excel', () => {
    expect(looksLikeZip(Buffer.from('ID;Type;Time'))).toBe(false);
    expect(() => readXlsx(Buffer.from('acesta nu este un fișier zip, oricât de lung ar fi textul'))).toThrow(XlsxError);
    expect(() => readXlsx(zip({ 'altceva.txt': 'salut' }))).toThrow(XlsxError);
  });
});

/* ------------------------------------------------- interpretarea raportului */

describe('interpretarea raportului XTB', () => {
  it('recunoaște cumpărările, vânzările și dividendele din CSV, în ordine cronologică', () => {
    const report = parseXtbReport([{ name: '', rows: parseCsv(CSV) }], CSV_NAME);
    expect(report.accountCurrency).toBe('EUR');
    expect(report.openPositions).toBeNull();
    expect(report.operations.map((o) => `${o.date} ${o.kind} ${o.symbol}`)).toEqual([
      '2023-07-25 buy GOOGL.US', // tipul este în portugheză: clasificarea se face după comentariu
      '2024-04-02 sell ZAL.DE',
      '2024-04-02 buy SPYL.DE',
      '2024-04-12 buy SPYL.DE',
      '2024-04-12 buy SPYL.DE',
      '2024-05-14 buy CSPX.UK',
      '2024-07-12 dividend SPYL.DE',
      '2024-09-02 buy FB.US',
      '2024-09-26 dividend FB.US'
    ]);

    // Execuție parțială: „34/42.5658” înseamnă 34 de unități din ordinul de 42,5658.
    const partial = report.operations.find((o) => o.id === '530692719') as XtbTrade;
    expect(partial).toMatchObject({ kind: 'buy', quantity: 34, price: 11.748, amount: 399.43, time: '13:01:45' });
    expect(report.operations.find((o) => o.id === '524303821')).toMatchObject({ kind: 'sell', quantity: 1, price: 26.28, amount: 26.28 });

    // Impozitul reținut este atașat dividendului din aceeași zi.
    const dividend = report.operations.find((o) => o.symbol === 'FB.US' && o.kind === 'dividend') as XtbDividend;
    expect(dividend).toMatchObject({ id: '623424923', amount: 4.6, perShare: 0.5, perShareCurrency: 'USD' });
    expect(dividend.tax).toBeCloseTo(0.69, 10);

    // Depunerile și dobânzile la cash sunt operațiuni de cash, nu se mai ignoră.
    expect(report.ignored).toEqual([]);
    expect(report.cash.map((c) => `${c.date} ${c.kind} ${c.amount} ${c.label}`)).toEqual([
      '2023-01-02 deposit 5000 Deposit',
      '2024-10-01 interest 0.42 Free funds interests'
    ]);
  });

  it('citește exportul Excel: antet sub datele contului, date ca numere de serie, rând de total', () => {
    const report = readXtbFile(ronWorkbook(), 'account_1234567_ro_xlsx_2024-01-01_2024-12-31.xlsx');
    expect(report.accountCurrency).toBe('RON');
    expect(report.operations.map((o) => `${o.date} ${o.time} ${o.kind} ${o.symbol}`)).toEqual([
      '2024-03-04 16:35:00 buy AAPL.US',
      '2024-03-05 10:00:00 buy SPYL.DE',
      '2024-05-16 11:00:00 dividend AAPL.US',
      '2024-06-20 11:00:00 dividend SPYL.DE'
    ]);
    expect(report.operations[0]).toMatchObject({ id: '700000002', quantity: 10, price: 200, amount: 9200 });
    expect(report.operations[2]).toMatchObject({ amount: 11.5, perShare: 0.25 });
    expect((report.operations[2] as XtbDividend).tax).toBeCloseTo(1.15, 10);
    // Pozițiile deschise se adună pe simbol; rândul „Total” nu este o poziție.
    expect(report.openPositions).toEqual({ 'AAPL.US': 10, 'SPYL.DE': 100, 'MSFT.US': 3 });
    expect(report.ignored).toEqual([{ label: 'swap', count: 1, symbols: ['EURUSD'] }]);
    expect(report.cash.map((c) => `${c.kind} ${c.amount}`)).toEqual(['deposit 20000']);
  });

  it('citește exportul actual al xStation: coloanele Ticker și Category, comentarii cu simbol', () => {
    const report = readXtbFile(currentWorkbook(), 'raport.xlsx');
    // Moneda contului apare doar în rezumatul de la „Open Positions”.
    expect(report.accountCurrency).toBe('USD');
    expect(report.operations.map((o) => `${o.date} ${o.kind} ${o.symbol} ${o.category} "${o.name}"`)).toEqual([
      '2026-01-06 buy NVDA.US stock "Nvidia"',
      '2026-01-07 buy GOOGC.US stock "Alphabet"',
      '2026-02-02 buy CSPX.UK etf "Core S&P 500"',
      '2026-02-02 buy CSPX.UK etf "Core S&P 500"',
      '2026-03-10 sell GOOGC.US stock "Alphabet"'
    ]);
    // Comentariul poate conține simbolul („OPEN BUY NVDA.US 2 @ 181.25”) sau nu („OPEN BUY 1.5 @ 180.00”).
    expect(report.operations[0]).toMatchObject({ id: '1000000002', quantity: 2, price: 181.25, amount: 362.5, time: '15:31:00' });
    expect(report.operations[1]).toMatchObject({ quantity: 1.5, price: 180 });
    expect(report.operations[3]).toMatchObject({ id: '1000000005', quantity: 0.2345, price: 700.5 });
    expect(report.operations[4]).toMatchObject({ kind: 'sell', quantity: 1.5, price: 195, amount: 292.5 });
    expect(report.ignored).toEqual([]);
    // Transferul spre alt subcont (conversia în GBP) scoate bani din acest cont: retragere.
    expect(report.cash.map((c) => `${c.date} ${c.kind} ${c.amount}`)).toEqual(['2026-01-05 deposit 3000', '2026-04-01 interest 1.12', '2026-04-02 withdrawal 50']);
    // Rândul de total pe instrument nu se adună cu pozițiile lui.
    expect(report.openPositions).toEqual({ 'CSPX.UK': 1.2345, 'NVDA.US': 2 });
    // Fără foaia „Open Positions”, moneda se ia din numele fișierului.
    expect(parseXtbReport([{ name: 'Cash Operations', rows: [['Type', 'Ticker', 'Time', 'Amount', 'ID', 'Comment'], ['Stock purchase', 'NVDA.US', serial('2026-01-06T15:31:00'), -362.5, '1', 'OPEN BUY NVDA.US 2 @ 181.25']] }], CURRENT_NAME).accountCurrency).toBe('USD');
  });

  it('găsește coloanele după conținut când antetul este într-o limbă necunoscută', () => {
    const rows = [
      ['Nr. crt.', 'Operațiune', 'Moment', 'Titlu', 'Observații', 'Sumă'],
      ['530692719', 'Cumpărare titluri', '2024-04-12 13:01:45', 'SPYL.DE', 'OPEN BUY 34/42.5658 @ 11.7480', '-399,43'],
      ['579214169', 'Dividende', '12/07/2024 11:00:27', 'SPYL.DE', 'SPYL.DE USD 0.6600/ SHR', '1,21'],
      ['579214170', 'Impozit pe dividende', '12/07/2024 11:00:27', 'SPYL.DE', 'SPYL.DE USD WHT 15%', '-0,18']
    ];
    const report = parseXtbReport([{ name: 'Foaie1', rows }]);
    expect(report.accountCurrency).toBeNull();
    expect(report.operations).toHaveLength(2);
    expect(report.operations[0]).toMatchObject({ kind: 'buy', id: '530692719', date: '2024-04-12', quantity: 34, amount: 399.43 });
    expect(report.operations[1]).toMatchObject({ kind: 'dividend', date: '2024-07-12', amount: 1.21, tax: 0.18 });
  });

  it('explică de ce un fișier nu poate fi folosit', () => {
    expect(() => parseXtbReport([{ name: '', rows: parseCsv('nume;varsta\nIon;40\nAna;35') }])).toThrow(/nu arată ca un raport XTB/);
    // Un raport doar cu depuneri este valid (cash-ul se urmărește), dar unul fără nicio operațiune nu.
    const onlyCash = 'ID;Type;Time;Symbol;Comment;Amount\n1;Deposit;02.01.2023 10:00:00;;Deposit;5000';
    expect(parseXtbReport([{ name: '', rows: parseCsv(onlyCash) }]).cash).toHaveLength(1);
    const nothing = 'ID;Type;Time;Symbol;Comment;Amount\n1;Swap;02.01.2023 10:00:00;EURUSD;Swap;-1';
    expect(() => parseXtbReport([{ name: '', rows: parseCsv(nothing) }])).toThrow(XtbParseError);
    expect(() => parseXtbReport([{ name: '', rows: parseCsv(nothing) }])).toThrow(/nu conține cumpărări/);
    expect(() => readXtbFile(Buffer.from('%PDF-1.7 ...'), 'raport.pdf')).toThrow(/PDF/);
    expect(() => readXtbFile(Buffer.from('<html><body><table></table></body></html>'), 'raport.html')).toThrow(/HTML/);
    expect(() => readXtbFile(Buffer.alloc(0), 'gol.xlsx')).toThrow(/gol/);
    expect(() => readXtbFile(zip({ 'altceva.txt': 'x' }), 'arhiva.xlsx')).toThrow(/nu a putut fi citit/);
  });

  it('rezumă ce rezultă pentru fiecare instrument și semnalează istoricul incomplet', () => {
    const report = parseXtbReport([{ name: '', rows: parseCsv(CSV) }], CSV_NAME);
    const summary = Object.fromEntries(summarizeXtbSymbols(report.operations).map((s) => [s.symbol, s]));
    expect(summary['SPYL.DE']).toMatchObject({ buys: 3, sells: 0, dividends: 1, quantity: 119.5658, incomplete: false, firstDate: '2024-04-02' });
    // Vânzare fără cumpărare: raportul nu acoperă perioada în care a fost cumpărat.
    expect(summary['ZAL.DE']).toMatchObject({ sells: 1, quantity: 0, incomplete: true });
  });

  it('traduce simbolurile XTB în formatul Yahoo Finance', () => {
    expect(mapXtbSymbol('AAPL.US')).toEqual({ symbol: 'AAPL', currency: 'USD' });
    expect(mapXtbSymbol('CSPX.UK')).toEqual({ symbol: 'CSPX.L', currency: 'GBP' });
    expect(mapXtbSymbol('vwce.de')).toEqual({ symbol: 'VWCE.DE', currency: 'EUR' });
    expect(mapXtbSymbol('EDP.PT')).toEqual({ symbol: 'EDP.LS', currency: 'EUR' });
    expect(mapXtbSymbol('MC.FR')).toEqual({ symbol: 'MC.PA', currency: 'EUR' });
    expect(mapXtbSymbol('TLV.RO')).toEqual({ symbol: 'TLV.RO', currency: 'RON' });
    expect(mapXtbSymbol('AAPL.US_9')).toEqual({ symbol: 'AAPL', currency: 'USD' });
    // Instrumente pe care XTB le numește altfel decât bursa.
    expect(mapXtbSymbol('GOOGC.US')).toEqual({ symbol: 'GOOG', currency: 'USD' });
    expect(mapXtbSymbol('BRKB.US')).toEqual({ symbol: 'BRK-B', currency: 'USD' });
  });
});

/* ---------------------------------------------------------------- importul */

let db: Db;
let alice: User;
let bob: User;
const tmp = mkdtempSync(join(tmpdir(), 'portofoliu-xtb-'));

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
});

/** Alege fișierul, se uită la previzualizare și importă, ca în ecranul Import. */
async function importFile(user: User, data: Buffer | string, fileName: string, options = { replaceManual: false }, using = lookup) {
  const tables = readImportFile(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  const session = openImport(db, user.id, tables, fileName, 'token');
  const { preview } = await previewImport(db, user.id, session, options, using);
  if (!preview) throw new Error('fără previzualizare');
  return { preview, result: applyImport(db, user.id, session, options) };
}

const quantities = (userId: number): Record<string, number> =>
  Object.fromEntries(getOverview(db, userId).positions.map((p) => [p.symbol, p.quantity]));

describe('importul raportului XTB', () => {
  it('creează brokerul, activele și tranzacțiile dintr-un singur fișier', async () => {
    const { preview, result } = await importFile(alice, CSV, CSV_NAME);

    expect(preview).toMatchObject({
      fileName: CSV_NAME,
      format: 'xtb',
      brokerName: 'XTB',
      accountCurrency: 'EUR',
      dateFrom: '2023-01-02',
      dateTo: '2024-10-01',
      counts: { new: 10, duplicate: 0, error: 1 },
      byKind: { buy: 6, dividend: 2, interest: 1, deposit: 1 },
      manualCount: 0
    });
    // Vânzarea ZAL.DE nu are cumpărarea în fișier: rândul este o eroare, restul se importă.
    expect(preview.instruments.find((i) => i.key === 'ZAL.DE')).toMatchObject({ status: 'incomplete' });
    expect(preview.rows.find((r) => r.status === 'error')).toMatchObject({ kind: 'sell', symbol: 'ZAL.DE', message: expect.stringMatching(/Lipsesc cumpărări/) });
    // Impozitul reținut este comasat cu dividendul lui.
    expect(preview.rows.find((r) => r.kind === 'dividend' && r.symbol === 'META')).toMatchObject({ amount: 5, tax: 0.75, currency: 'USD' });

    expect(result).toMatchObject({
      brokerName: 'XTB',
      portfolioName: 'Principal',
      imported: 10,
      byKind: { buy: 6, dividend: 2, interest: 1, deposit: 1 },
      duplicates: 0,
      errors: 1,
      createdAssets: 4,
      replaced: 0,
      approximated: 0,
      unconfirmed: ['META'], // simbol negăsit la furnizorul de prețuri simulat
      offline: false
    });
    expect(result.positions).toEqual([
      { symbol: 'CSPX.L', brokerSymbol: 'CSPX.UK', name: 'iShares Core S&P 500 UCITS ETF', quantity: 0.1799, reportedQuantity: null },
      { symbol: 'GOOGL', brokerSymbol: 'GOOGL.US', name: 'Alphabet Inc.', quantity: 1, reportedQuantity: null },
      { symbol: 'META', brokerSymbol: 'FB.US', name: '', quantity: 10, reportedQuantity: null },
      { symbol: 'SPYL.DE', brokerSymbol: 'SPYL.DE', name: 'SPDR S&P 500 UCITS ETF', quantity: 119.5658, reportedQuantity: null }
    ]);

    expect(listBrokers(db, alice.id).map((b) => b.name)).toEqual(['XTB']);
    // Moneda și tipul vin de la furnizorul de prețuri (CSPX se tranzacționează la Londra în USD), altfel din sufixul bursei.
    expect(listAssets(db, alice.id).map((a) => `${a.symbol} ${a.type} ${a.currency}`)).toEqual([
      'CSPX.L etf USD',
      'GOOGL stock USD',
      'META stock USD',
      'SPYL.DE etf EUR'
    ]);
    expect(quantities(alice.id)).toEqual({ 'CSPX.L': 0.1799, GOOGL: 1, META: 10, 'SPYL.DE': 119.5658 });

    const txs = listTransactions(db, alice.id);
    expect(txs).toHaveLength(10);
    expect(txs.every((t) => t.brokerName === 'XTB' && t.portfolioName === 'Principal' && t.notes?.startsWith('Import XTB'))).toBe(true);
    expect(txs.find((t) => t.symbol === 'GOOGL')).toMatchObject({ type: 'buy', date: '2023-07-25', quantity: 1, price: 122.34, fee: 0, currency: 'USD', cashAmount: -111.25, cashCurrency: 'EUR' });
    expect(txs.find((t) => t.type === 'deposit')).toMatchObject({ date: '2023-01-02', netAmount: 5000, currency: 'EUR', externalId: 'xtb:100000001' });
    expect(txs.find((t) => t.type === 'interest')).toMatchObject({ grossAmount: 0.42, currency: 'EUR' });
  });

  it('trece dividendele în moneda activului', async () => {
    await importFile(alice, CSV, CSV_NAME);
    const dividends = listTransactions(db, alice.id, { type: 'dividend' });
    // Cont în EUR, acțiune în USD: 10 acțiuni × 0,50 USD = 5 USD brut, 15% impozit.
    expect(dividends.find((t) => t.symbol === 'META')).toMatchObject({ date: '2024-09-26', grossAmount: 5, taxWithheld: 0.75, netAmount: 4.25, currency: 'USD', cashAmount: 3.91 });
    // Activ în moneda contului: suma din raport, neschimbată.
    expect(dividends.find((t) => t.symbol === 'SPYL.DE')).toMatchObject({ grossAmount: 1.21, taxWithheld: 0, currency: 'EUR' });
  });

  it('reimportul nu dublează nimic, iar un raport mai nou adaugă doar ce lipsește', async () => {
    await importFile(alice, CSV, CSV_NAME);
    const again = await importFile(alice, CSV, CSV_NAME);
    expect(again.preview.counts).toMatchObject({ new: 0, duplicate: 10 });
    expect(again.result).toMatchObject({ imported: 0, duplicates: 10, createdAssets: 0, batchId: null });
    expect(listTransactions(db, alice.id)).toHaveLength(10);

    // Același raport exportat mai târziu: o vânzare parțială și o cumpărare nouă.
    const newer =
      CSV +
      '\r\n700000010;Stocks/ETF sale;03.02.2025 10:15:00;FB.US;CLOSE BUY 4/10 @ 610.00;2244.8' +
      '\r\n700000011;Stocks/ETF purchase;04.02.2025 10:15:00;GOOGL.US;OPEN BUY 2 @ 190.00;-349.6';
    const { result } = await importFile(alice, newer, CSV_NAME);
    expect(result).toMatchObject({ imported: 2, byKind: { buy: 1, sell: 1 }, duplicates: 10, createdAssets: 0 });
    expect(quantities(alice.id)).toMatchObject({ META: 6, GOOGL: 3 });
  });

  it('citește exportul Excel, deduce cursul din raport și compară cu pozițiile deschise', async () => {
    const { preview, result } = await importFile(alice, ronWorkbook(), 'account_1234567_ro_xlsx_2024-01-01_2024-12-31.xlsx');
    expect(result).toMatchObject({ imported: 5, byKind: { deposit: 1, buy: 2, dividend: 2 }, createdAssets: 2, approximated: 1 });
    // MSFT apare la poziții deschise, dar raportul nu conține cumpărarea lui: se vede diferența.
    expect(result.positions).toEqual([
      { symbol: 'AAPL', brokerSymbol: 'AAPL.US', name: 'Apple Inc.', quantity: 10, reportedQuantity: 10 },
      { symbol: 'MSFT', brokerSymbol: 'MSFT.US', name: '', quantity: 0, reportedQuantity: 3 },
      { symbol: 'SPYL.DE', brokerSymbol: 'SPYL.DE', name: 'SPDR S&P 500 UCITS ETF', quantity: 100, reportedQuantity: 100 }
    ]);
    expect(preview.ignored.map((i) => i.label)).toEqual(['swap']);

    const dividends = listTransactions(db, alice.id, { type: 'dividend' });
    // Cont în RON: 10 acțiuni × 0,25 USD = 2,50 USD (confirmat de cursul din raport: 11,50 RON / 4,60).
    expect(dividends.find((t) => t.symbol === 'AAPL')).toMatchObject({ grossAmount: 2.5, taxWithheld: 0.25, notes: 'Import XTB (xStation)' });
    // ETF în EUR care distribuie în USD: suma se convertește la cursul din raport (32,20 RON / 5,00) și este marcată.
    const approx = dividends.find((t) => t.symbol === 'SPYL.DE');
    expect(approx).toMatchObject({ grossAmount: 6.44, taxWithheld: 0, currency: 'EUR' });
    expect(approx?.notes).toMatch(/aproximativ din RON/);
    expect(preview.rows.find((r) => r.symbol === 'SPYL.DE' && r.kind === 'dividend')).toMatchObject({ status: 'warning' });
  });

  it('importă exportul actual al xStation, cu tipul și denumirea din raport', async () => {
    const { preview, result } = await importFile(alice, currentWorkbook(), CURRENT_NAME);
    expect(preview).toMatchObject({ dateFrom: '2026-01-05', dateTo: '2026-04-02', byKind: { buy: 4, sell: 1, deposit: 1, interest: 1, withdrawal: 1 } });
    expect(preview.instruments).toHaveLength(3);
    expect(result).toMatchObject({ imported: 8, createdAssets: 3, errors: 0, unconfirmed: ['GOOG'] });
    // Alphabet clasa C se numește GOOGC.US la XTB și GOOG la bursă; poziția a fost închisă, deci nu mai apare.
    expect(result.positions).toEqual([
      { symbol: 'CSPX.L', brokerSymbol: 'CSPX.UK', name: 'iShares Core S&P 500 UCITS ETF', quantity: 1.2345, reportedQuantity: 1.2345 },
      { symbol: 'NVDA', brokerSymbol: 'NVDA.US', name: 'NVIDIA Corporation', quantity: 2, reportedQuantity: 2 }
    ]);
    expect(listAssets(db, alice.id).map((a) => `${a.symbol} ${a.type} ${a.currency} ${a.name}`)).toEqual([
      'CSPX.L etf USD iShares Core S&P 500 UCITS ETF',
      'GOOG stock USD Alphabet', // negăsit la furnizorul simulat: denumirea vine din raport
      'NVDA stock USD NVIDIA Corporation'
    ]);
    // Transferul (conversia valutară) a scos bani din cont: retragere.
    expect(listTransactions(db, alice.id, { type: 'withdrawal' })).toMatchObject([{ netAmount: 50, currency: 'USD' }]);

    // Fără internet, tipul (ETF) și denumirea vin tot din raport.
    await importFile(bob, currentWorkbook(), CURRENT_NAME, { replaceManual: false }, offlineLookup);
    expect(listAssets(db, bob.id).map((a) => `${a.symbol} ${a.type} ${a.currency} ${a.name}`)).toEqual([
      'CSPX.L etf GBP Core S&P 500',
      'GOOG stock USD Alphabet',
      'NVDA stock USD Nvidia'
    ]);
  });

  it('deduce moneda contului când raportul nu o spune', async () => {
    // Fără eticheta „Currency” și fără monedă în numele fișierului: cursurile din raport arată un cont în RON.
    const ron = await importFile(alice, ronWorkbook({ currencyLabel: false }), 'raport.xlsx');
    expect(ron.preview.accountCurrency).toBe('RON');
    expect(ron.result.imported).toBe(5);
    expect(listTransactions(db, alice.id, { type: 'dividend' }).find((t) => t.symbol === 'AAPL')).toMatchObject({ grossAmount: 2.5, taxWithheld: 0.25 });

    // ETF-ul în EUR a fost plătit „unu la unu”: contul lui Bob este în EUR.
    const eur = await importFile(bob, CSV, 'operatiuni.csv');
    expect(eur.preview.accountCurrency).toBe('EUR');
    const dividends = listTransactions(db, bob.id, { type: 'dividend' });
    expect(dividends.find((t) => t.symbol === 'META')).toMatchObject({ grossAmount: 5, taxWithheld: 0.75 });
    expect(dividends.find((t) => t.symbol === 'SPYL.DE')).toMatchObject({ grossAmount: 1.21 });
  });

  it('funcționează și fără internet: simbolul și moneda se deduc din sufixul bursei', async () => {
    const { result } = await importFile(alice, CSV, CSV_NAME, { replaceManual: false }, offlineLookup);
    expect(result).toMatchObject({ imported: 10, offline: true, unconfirmed: [] });
    expect(listAssets(db, alice.id).map((a) => `${a.symbol} ${a.type} ${a.currency}`)).toEqual([
      'CSPX.L stock GBP',
      'GOOGL stock USD',
      'META stock USD',
      'SPYL.DE stock EUR'
    ]);
  });

  it('întreabă de tranzacțiile introduse manual și le înlocuiește doar la cerere', async () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    // Aceeași cumpărare ca în raport, introdusă de mână (cu prețul rotunjit) înainte de import.
    addPurchase(db, alice.id, { asset: { type: 'etf', symbol: 'SPYL.DE', currency: 'EUR' }, brokerId: broker.id, date: '2024-04-02', quantity: 85, price: 11.73, fee: 0 });

    const kept = await importFile(alice, CSV, CSV_NAME);
    expect(kept.preview.manualCount).toBe(1);
    expect(kept.result.replaced).toBe(0);
    expect(quantities(alice.id)['SPYL.DE']).toBeCloseTo(204.5658, 6); // apare de două ori

    for (const table of ['transactions', 'broker_symbols', 'import_batches']) db.prepare(`DELETE FROM ${table}`).run();
    addPurchase(db, alice.id, { asset: { type: 'etf', symbol: 'SPYL.DE', currency: 'EUR' }, brokerId: broker.id, date: '2024-04-02', quantity: 85, price: 11.73, fee: 0 });
    const replaced = await importFile(alice, CSV, CSV_NAME, { replaceManual: true });
    expect(replaced.result.replaced).toBe(1);
    expect(quantities(alice.id)['SPYL.DE']).toBe(119.5658);
    expect(listBrokers(db, alice.id)).toHaveLength(1); // se folosește brokerul XTB existent
  });

  it('recunoaște ca dublură o tranzacție introdusă manual identică cu cea din raport', async () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    addPurchase(db, alice.id, { asset: { type: 'etf', symbol: 'SPYL.DE', currency: 'EUR' }, brokerId: broker.id, date: '2024-04-02', quantity: 85, price: 11.7305, fee: 0 });
    const { preview, result } = await importFile(alice, CSV, CSV_NAME);
    expect(preview.rows.find((r) => r.symbol === 'SPYL.DE' && r.quantity === 85)).toMatchObject({ status: 'duplicate' });
    expect(result).toMatchObject({ imported: 9, duplicates: 1 });
    expect(quantities(alice.id)['SPYL.DE']).toBe(119.5658);
  });

  it('păstrează o cumpărare introdusă manual dacă vânzarea din raport depinde de ea', async () => {
    const broker = createBroker(db, alice.id, { name: 'Contul meu XTB' });
    // Cumpărarea este dinaintea perioadei exportate; raportul conține doar vânzarea.
    addPurchase(db, alice.id, { asset: { type: 'stock', symbol: 'ZAL.DE', currency: 'EUR' }, brokerId: broker.id, date: '2023-02-01', quantity: 1, price: 40, fee: 0 });

    const { preview, result } = await importFile(alice, CSV, CSV_NAME, { replaceManual: true });
    expect(preview).toMatchObject({ brokerName: 'Contul meu XTB', manualCount: 1 });
    expect(result).toMatchObject({ brokerName: 'Contul meu XTB', imported: 11, byKind: { sell: 1 }, replaced: 0, errors: 0 });
    expect(listTransactions(db, alice.id, { symbol: 'ZAL.DE' }).map((t) => t.type).sort()).toEqual(['buy', 'sell']);
    expect(quantities(alice.id)['ZAL.DE']).toBeUndefined(); // poziție închisă
  });

  it('ține minte legătura dintre simbolul XTB și activ și izolează utilizatorii', async () => {
    await importFile(alice, CSV, CSV_NAME);
    const links = db.prepare("SELECT broker_symbol FROM broker_symbols WHERE user_id = ? AND source = 'xtb' ORDER BY broker_symbol").all(alice.id);
    expect(links).toEqual([{ broker_symbol: 'CSPX.UK' }, { broker_symbol: 'FB.US' }, { broker_symbol: 'GOOGL.US' }, { broker_symbol: 'SPYL.DE' }]);

    // Același raport în contul lui Bob: date proprii, fără nicio legătură cu ale lui Alice.
    const forBob = await importFile(bob, CSV, CSV_NAME);
    expect(forBob.result).toMatchObject({ imported: 10, duplicates: 0, createdAssets: 4 });
    expect(listTransactions(db, alice.id)).toHaveLength(10);
    expect(listTransactions(db, bob.id)).toHaveLength(10);
  });

  it('backup-ul păstrează identificatorii operațiunilor: după restaurare, reimportul nu dublează', async () => {
    await importFile(alice, CSV, CSV_NAME);
    const file = join(tmp, 'backup-xtb.db');
    createBackup(db, alice.id, file);

    expect(restoreBackup(db, bob.id, file)).toEqual({ brokers: 1, assets: 4, transactions: 10 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM broker_symbols WHERE user_id = ? AND source = 'xtb'").get(bob.id)).toEqual({ n: 4 });
    const { result } = await importFile(bob, CSV, CSV_NAME);
    expect(result).toMatchObject({ imported: 0, duplicates: 10, createdAssets: 0 });
    expect(listTransactions(db, bob.id)).toHaveLength(10);
  });
});

/* -------------------------------------------------- schema și prețurile */

describe('migrarea schemei pentru import', () => {
  it('actualizează o bază din versiunea 1 fără să piardă date', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(MIGRATIONS[0].sql);
    old.pragma('user_version = 1');
    old.exec(`
      INSERT INTO users (username, password_hash) VALUES ('vechi', 'hash');
      INSERT INTO brokers (user_id, name) VALUES (1, 'XTB');
      INSERT INTO assets (user_id, type, symbol, currency) VALUES (1, 'stock', 'AAPL', 'USD');
      INSERT INTO transactions (user_id, asset_id, broker_id, type, date, quantity, price, currency) VALUES (1, 1, 1, 'buy', '2024-01-10', 2, 180, 'USD');
    `);
    migrate(old);
    expect(schemaVersion(old)).toBe(LATEST_SCHEMA_VERSION);
    // Sumele se păstrează de acum ca text zecimal exact.
    expect(old.prepare('SELECT quantity, price, external_id FROM transactions').get()).toEqual({ quantity: '2', price: '180', external_id: null });
    expect(old.prepare('SELECT COUNT(*) AS n FROM broker_symbols').get()).toEqual({ n: 0 });
    // Același identificator extern nu poate fi salvat de două ori pentru același utilizator.
    const insert = old.prepare(
      "INSERT INTO transactions (user_id, asset_id, broker_id, type, date, quantity, price, currency, external_id) VALUES (1, 1, 1, 'buy', '2024-02-01', 1, 190, 'USD', 'xtb:1')"
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE/);
    old.close();
  });
});

describe('verificarea simbolurilor la furnizorul de prețuri', () => {
  it('cere toate simbolurile într-o singură cerere și raportează lipsa conexiunii', async () => {
    class BatchProvider implements PriceProvider {
      readonly id: ProviderId = 'yahoo';
      calls = 0;
      constructor(private readonly fail = false) {}
      async getQuotes(refs: SymbolRef[]): Promise<Map<string, Quote>> {
        this.calls++;
        if (this.fail) throw new Error('fetch failed');
        const out = new Map<string, Quote>();
        for (const ref of refs) {
          const known = KNOWN[ref.symbol];
          if (known) out.set(ref.symbol, { symbol: ref.symbol, price: 1, currency: known.currency, asOf: new Date().toISOString(), name: known.name, assetType: known.assetType });
        }
        return out;
      }
      async getQuote(ref: SymbolRef): Promise<Quote> {
        const q = (await this.getQuotes([ref])).get(ref.symbol);
        if (!q) throw new Error('negăsit');
        return q;
      }
      async getHistory() {
        return { points: [], splitAdjusted: true };
      }
      async search() {
        return [];
      }
    }
    const secrets = createAesBox(randomBytes(32));
    const provider = new BatchProvider();
    const service = new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? provider : null) });
    const found = await service.lookupMany(alice.id, ['aapl', 'AAPL', 'SPYL.DE', 'INEXISTENT']);
    expect(provider.calls).toBe(1);
    expect(found.offline).toBe(false);
    expect([...found.quotes.keys()].sort()).toEqual(['AAPL', 'SPYL.DE']);
    expect(found.quotes.get('SPYL.DE')).toMatchObject({ currency: 'EUR', assetType: 'etf' });

    const down = new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? new BatchProvider(true) : null) });
    expect(await down.lookupMany(alice.id, ['AAPL'])).toMatchObject({ offline: true });
  });
});
