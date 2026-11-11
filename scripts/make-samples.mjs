/**
 * Generează exemplul Excel pentru XTB din /samples (extrasele CSV sunt scrise direct, ca text).
 * Datele sunt inventate: niciun cont, nume sau sumă reală.
 *
 *   node scripts/make-samples.mjs
 *
 * Folosește generatorul .xlsx din teste (Node 22.18+ rulează direct fișierele TypeScript).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildXlsx } from '../tests/xlsxWriter.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Data și ora ca număr de serie Excel (zile de la 30.12.1899). */
const serial = (iso) => Date.parse(`${iso}Z`) / 86_400_000 + 25569;

/** Antetul fiecărei foi din exportul xStation (2026): contul, titlul și perioada. */
const head = (title) => [
  ['Account number', 0],
  [title],
  ['Date from (UTC)', serial('2026-01-01T00:00:00')],
  ['Date to (UTC)', serial('2026-06-30T23:59:59')],
  null
];

const workbook = buildXlsx([
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
      ['Type', 'Instrument', 'Ticker', 'Category', 'Time', 'Amount', 'ID', 'Comment', 'Product', 'Position ID'],
      ['Deposit', null, null, null, serial('2026-01-05T09:00:00'), 3000, '1000000001', 'Bank transfer deposit', 'My Trades'],
      ['Stock purchase', 'Nvidia', 'NVDA.US', 'STOCK', serial('2026-01-06T15:31:00'), -362.5, '1000000002', 'OPEN BUY NVDA.US 2 @ 181.25', 'My Trades', '2000000001'],
      ['Stock purchase', 'Alphabet', 'GOOGC.US', 'STOCK', serial('2026-01-07T15:31:00'), -270, '1000000003', 'OPEN BUY 1.5 @ 180.00', 'My Trades', '2000000002'],
      ['Stock purchase', 'Coca-Cola', 'KO.US', 'STOCK', serial('2026-01-08T15:40:00'), -700, '1000000004', 'OPEN BUY KO.US 10 @ 70.00', 'My Trades', '2000000005'],
      ['Stock purchase', 'Core S&P 500', 'CSPX.UK', 'ETF', serial('2026-02-02T09:05:00'), -700.5, '1000000005', 'OPEN BUY CSPX.UK 1/1.2345 @ 700.50', 'My Trades', '2000000003'],
      ['Stock purchase', 'Core S&P 500', 'CSPX.UK', 'ETF', serial('2026-02-02T09:05:01'), -164.27, '1000000006', 'OPEN BUY CSPX.UK 0.2345/1.2345 @ 700.50', 'My Trades', '2000000004'],
      ['Stock sell', 'Alphabet', 'GOOGC.US', 'STOCK', serial('2026-03-10T15:45:00'), 292.5, '1000000007', 'CLOSE BUY GOOGC.US 1.5 @ 195.00', 'My Trades', '2000000002'],
      ['Dividend', 'Coca-Cola', 'KO.US', 'STOCK', serial('2026-04-01T11:00:00'), 5.1, '1000000008', 'KO.US USD 0.5100/ SHR', 'My Trades'],
      ['Withholding tax', 'Coca-Cola', 'KO.US', 'STOCK', serial('2026-04-01T11:00:00'), -0.51, '1000000009', 'KO.US USD WHT 10%', 'My Trades'],
      ['Free funds interest', null, null, null, serial('2026-04-01T08:00:00'), 1.12, '1000000010', 'Free-funds Interest 2026-03', 'My Trades'],
      ['Total', null, null, null, null, 1100.94]
    ]
  },
  {
    name: 'Open Positions',
    rows: [
      ['Account number', 0],
      ['Open Positions'],
      ['Data as of report generated', serial('2026-06-30T17:00:00')],
      ['Product', 'Metric', 'Amount', 'Currency'],
      ['My Trades', 'Open position value', 2002.1, 'USD'],
      ['My Trades', 'Open position profit', 75.2, 'USD'],
      ['Note', 'Summary values and open positions are shown as of the report generation time'],
      ['Product', 'Instrument/Position', 'Ticker', 'Category', 'Type', 'Volume', 'Value', 'Current price', 'Open price', 'Open time (UTC)'],
      ['My Trades', 'Core S&P 500', 'CSPX.UK', 'ETF', null, 1.2345, 900, null, 700.5],
      ['My Trades', '2000000003', 'CSPX.UK', null, 'BUY', 1, 729, 729, 700.5, serial('2026-02-02T09:05:00')],
      ['My Trades', '2000000004', 'CSPX.UK', null, 'BUY', 0.2345, 171, 729, 700.5, serial('2026-02-02T09:05:01')],
      ['My Trades', 'Coca-Cola', 'KO.US', 'STOCK', null, 10, 702, null, 70],
      ['My Trades', '2000000005', 'KO.US', null, 'BUY', 10, 702, 70.2, 70, serial('2026-01-08T15:40:00')],
      ['My Trades', 'Nvidia', 'NVDA.US', 'STOCK', null, 2, 400, null, 181.25],
      ['My Trades', '2000000001', 'NVDA.US', null, 'BUY', 2, 400, 200, 181.25, serial('2026-01-06T15:31:00')]
    ]
  }
]);

const out = join(root, 'samples', 'xtb', 'USD_00000000_2026-01-01_2026-06-30_exemplu.xlsx');
writeFileSync(out, workbook);
console.log(`scris: ${out}`);
