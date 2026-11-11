/**
 * Test „de fum” al aplicației construite: pornește Electron cu un folder de
 * date temporar, parcurge principalele ecrane și salvează capturi în .smoke/.
 *
 *   npm run build && npm run smoke
 *
 * Implicit se testează build-ul din out/. Cu SMOKE_EXE se testează aplicația împachetată:
 *   SMOKE_EXE="release/win-unpacked/Portofoliu Bursa.exe" npm run smoke
 *
 * Nu atinge datele reale ale utilizatorului (folosește PORTOFOLIU_DATA_DIR).
 */
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32 } from 'node:zlib';

const outDir = resolve('.smoke');
const dataDir = resolve(outDir, 'data');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const env = { ...process.env, PORTOFOLIU_DATA_DIR: dataDir };
const errors = [];
let app;
let page;

/** Pornește aplicația (din out/ sau din executabilul împachetat) și întoarce fereastra ei. */
async function launch() {
  app = process.env.SMOKE_EXE
    ? await electron.launch({ executablePath: resolve(process.env.SMOKE_EXE), args: [], env })
    : await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
}

const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(outDir, `${name}.png`) });
  console.log('captură:', name);
};
const nav = (label) => page.getByRole('navigation').getByRole('button', { name: label }).click();
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
/** Înlocuiește dialogurile native de fișier cu răspunsuri fixe (nu pot fi apăsate dintr-un test). */
const stubDialogs = (filePath) =>
  app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
  }, filePath);
/**
 * Scrie un raport de cont în formatul exportat de xStation (XTB): un registru
 * .xlsx cu foile „Open Positions” și „Cash Operations”, datele contului
 * deasupra fiecărui tabel și coloanele Ticker / Category / Instrument.
 * Arhiva ZIP este scrisă fără compresie, ca testul să nu aibă nevoie de dependențe.
 */
function writeXtbReport(path) {
  const cell = (ref, v) =>
    v === null ? '' : typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const sheet = (rows) =>
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows.map((row, r) => (row ? `<row r="${r + 1}">${row.map((v, c) => cell(String.fromCharCode(65 + c) + (r + 1), v)).join('')}</row>` : '')).join('') +
    '</sheetData></worksheet>';
  const files = {
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Open Positions" sheetId="1" r:id="rId1"/><sheet name="Cash Operations" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet([
      ['Account number', 1234567],
      ['Open Positions'],
      ['Product', 'Metric', 'Amount', 'Currency'],
      ['My Trades', 'Open position value', 1720, 'USD'],
      ['Product', 'Instrument/Position', 'Ticker', 'Category', 'Type', 'Volume', 'Value', 'Current price', 'Open price', 'Open time (UTC)'],
      // Un rând de total pe instrument, urmat de rândul fiecărei poziții.
      ['My Trades', 'Apple', 'AAPL.US', 'STOCK', null, 2, 460, null, 200],
      ['My Trades', '900001', 'AAPL.US', null, 'BUY', 2, 460, 230, 200, '03.02.2025 16:35:02'],
      ['My Trades', 'Microsoft', 'MSFT.US', 'STOCK', null, 3, 1260, null, 400],
      ['My Trades', '900002', 'MSFT.US', null, 'BUY', 3, 1260, 420, 400, '04.02.2025 16:40:10']
    ]),
    'xl/worksheets/sheet2.xml': sheet([
      ['Account number', 1234567],
      ['Cash Operations'],
      ['Date from (UTC)', '01.01.2025 00:00:00'],
      ['Date to (UTC)', '31.12.2025 23:59:59'],
      null,
      ['Type', 'Instrument', 'Ticker', 'Category', 'Time', 'Amount', 'ID', 'Comment', 'Product', 'Position ID'],
      ['Deposit', null, null, null, '03.02.2025 09:00:00', 2500, '800000001', 'Deposit', 'My Trades'],
      ['Stock purchase', 'Apple', 'AAPL.US', 'STOCK', '03.02.2025 16:35:02', -400, '800000002', 'OPEN BUY AAPL.US 2 @ 200.00', 'My Trades', '900001'],
      ['Stock purchase', 'Microsoft', 'MSFT.US', 'STOCK', '04.02.2025 16:40:10', -1200, '800000003', 'OPEN BUY MSFT.US 3 @ 400.00', 'My Trades', '900002'],
      ['DIVIDENT', 'Microsoft', 'MSFT.US', 'STOCK', '13.03.2025 11:00:00', 2.49, '800000004', 'MSFT.US USD 0.8300/ SHR', 'My Trades'],
      ['Withholding Tax', 'Microsoft', 'MSFT.US', 'STOCK', '13.03.2025 11:00:00', -0.37, '800000005', 'MSFT.US USD WHT 15%', 'My Trades'],
      ['Total', null, null, null, null, 902.12]
    ])
  };

  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...parts, directory, end]));
}

const login = async (username, password, remember = false) => {
  await page.getByLabel('Nume utilizator').fill(username);
  await page.getByLabel('Parolă', { exact: true }).fill(password);
  if (remember) await page.getByLabel('Ține-mă minte pe acest calculator').check();
  await page.getByRole('button', { name: 'Intră în cont' }).click();
};
const logout = () => page.getByRole('button', { name: 'Ieșire din cont' }).click();

try {
  await launch();

  // 1. Fără sesiune, aplicația pornește pe ecranul de login.
  await page.getByRole('button', { name: 'Intră în cont' }).waitFor();
  await shot('01-login');

  // 2. Înregistrare cont nou -> dashboard gol.
  await page.getByRole('button', { name: 'Cont nou' }).click();
  await page.getByLabel('Nume utilizator').fill('ana');
  await page.getByLabel('Parolă', { exact: true }).fill('parola-ana-1');
  await page.getByLabel('Confirmă parola').fill('parola-ana-1');
  await page.getByRole('button', { name: 'Creează contul' }).click();
  await page.getByText('Portofoliul este gol').waitFor();
  await shot('02-dashboard-gol');

  // 3. Adaugă un activ (cu broker nou) din pagina Portofoliu.
  await nav('Portofoliu');
  await page.getByRole('button', { name: 'Adaugă activ' }).first().click();
  await page.getByLabel('Simbol / ticker').fill('SNP.RO');
  await page.getByLabel('Număr de unități').fill('1000');
  await page.getByLabel('Preț de cumpărare / unitate').fill('0,62');
  await page.getByLabel('Data achiziției').fill('2024-03-04');
  await page.getByLabel('Numele brokerului nou').fill('Tradeville');
  await page.getByLabel('Monedă').selectOption('RON');
  await shot('03-formular-achizitie');
  await page.getByRole('button', { name: 'Adaugă achiziția' }).click();
  await page.getByRole('cell', { name: /SNP\.RO/ }).first().waitFor();
  await page.waitForTimeout(4000); // lasă timp actualizării de prețuri din fundal
  await shot('04-portofoliu');

  // 4. Vânzare peste cantitatea deținută -> eroare de validare.
  await page.getByRole('button', { name: 'Vinde SNP.RO' }).click();
  await page.getByLabel('Cantitate').fill('5000');
  await page.getByLabel(/Preț \/ unitate/).fill('0,9');
  await page.getByRole('button', { name: 'Adaugă tranzacția' }).click();
  await page.getByText('Nu poți vinde mai mult decât deții').waitFor();
  await shot('05-validare-vanzare');
  await page.getByRole('button', { name: 'Renunță' }).click();

  // 5. Ieșire, apoi contul demo.
  await logout();
  await page.getByRole('button', { name: 'Încearcă contul demo' }).click();
  await page.getByText('Valoarea totală a portofoliului').waitFor({ timeout: 30000 });
  await page.waitForTimeout(9000); // prețuri + istoric de la Yahoo, dacă există internet
  await shot('06-demo-dashboard');
  await page.locator('main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('07-demo-dashboard-jos');

  await nav('Portofoliu');
  await page.getByRole('cell', { name: /AAPL/ }).first().waitFor();
  await shot('08-demo-portofoliu');
  await page.getByRole('radio', { name: 'Pe broker' }).click();
  await shot('09-demo-portofoliu-pe-broker');

  await nav('Tranzacții');
  await page.getByRole('cell', { name: /NVDA/ }).first().waitFor();
  const demoRows = await page.locator('tbody tr').count();
  await shot('10-demo-tranzactii');

  // 6. Export CSV și backup din contul demo.
  const csvFile = resolve(outDir, 'export-demo.csv');
  await stubDialogs(csvFile);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await page.getByText(/tranzacții exportate/).waitFor();
  const csvLines = readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
  check(csvLines.length === demoRows + 1, `CSV-ul ar trebui să aibă ${demoRows} rânduri de date, are ${csvLines.length - 1}.`);
  console.log(`export CSV: ${csvLines.length - 1} tranzacții`);

  await nav('Brokeri');
  await shot('11-demo-brokeri');

  await nav('Setări');
  await shot('12-setari');
  const backupFile = resolve(outDir, 'backup-demo.db');
  await stubDialogs(backupFile);
  await page.getByRole('button', { name: 'Salvează backup…' }).click();
  await page.getByText(/Backup salvat/).waitFor();
  check(existsSync(backupFile), 'Fișierul de backup nu a fost creat.');
  console.log('backup creat');

  await page.getByRole('radio', { name: 'Întunecată' }).click();
  await nav('Panou principal');
  await page.getByText('Valoarea totală a portofoliului').waitFor();
  await shot('13-demo-dashboard-dark');

  // 7. Datele demo nu sunt vizibile din contul „ana” (izolare între utilizatori).
  await logout();
  await login('ana', 'parola-ana-1', true); // cu „ține-mă minte”
  await nav('Tranzacții');
  await page.getByRole('cell', { name: /SNP\.RO/ }).first().waitFor();
  let rows = await page.locator('tbody tr').count();
  check(rows === 1, `Contul „ana” ar trebui să vadă o singură tranzacție, nu ${rows}.`);
  console.log('izolare: contul ana vede doar tranzacția proprie');
  await shot('14-ana-tranzactii');

  // 8. Import CSV: exportul demo conține și o vânzare SNP.RO care se adaugă la poziția Anei.
  await stubDialogs(csvFile);
  await page.getByRole('button', { name: 'Import Excel / CSV' }).click();
  await page.getByText(/tranzacții importate/).waitFor();
  await page.waitForTimeout(500);
  rows = await page.locator('tbody tr').count();
  check(rows === demoRows + 1, `După import ar trebui ${demoRows + 1} tranzacții, sunt ${rows}.`);
  console.log(`import CSV: ${rows} tranzacții în contul ana`);

  // 8b. Import din fișierul Excel exportat din xStation (XTB), cu același buton.
  const xtbFile = resolve(outDir, 'USD_1234567_2025-01-01_2025-12-31.xlsx');
  writeXtbReport(xtbFile);
  await stubDialogs(xtbFile);
  await page.getByRole('button', { name: 'Import Excel / CSV' }).click();
  // AAPL are deja tranzacții introduse manual la XTB (din CSV): aplicația întreabă ce face cu ele.
  await page.getByRole('heading', { name: 'Ai deja tranzacții introduse manual' }).waitFor({ timeout: 30000 });
  await shot('14b-import-xtb-intrebare');
  await page.getByRole('button', { name: 'Păstrează-le' }).click();
  await page.getByRole('heading', { name: 'Import finalizat' }).waitFor();
  await page.getByText('Am adăugat').waitFor();
  check((await page.getByRole('dialog').getByRole('cell', { name: /MSFT/ }).count()) === 1, 'Poziția MSFT nu apare în rezumatul importului.');
  await shot('14c-import-xtb-rezultat');
  await page.getByRole('button', { name: 'Gata' }).click();
  await page.getByRole('cell', { name: /MSFT/ }).first().waitFor();
  rows = await page.locator('tbody tr').count();
  check(rows === demoRows + 4, `După importul XTB ar trebui ${demoRows + 4} tranzacții, sunt ${rows}.`);
  const dividend = page.locator('tbody tr', { hasText: 'MSFT' }).filter({ hasText: 'Dividend' });
  check((await dividend.count()) === 1, 'Dividendul MSFT nu a fost importat.');
  check((await dividend.first().innerText()).includes('0,37'), 'Impozitul reținut la dividendul MSFT lipsește.');

  // Reimportul aceluiași fișier nu adaugă nimic.
  await page.getByRole('button', { name: 'Import Excel / CSV' }).click();
  await page.getByRole('button', { name: 'Păstrează-le' }).click();
  await page.getByRole('heading', { name: 'Nimic nou de importat' }).waitFor();
  await page.getByRole('button', { name: 'Gata' }).click();
  rows = await page.locator('tbody tr').count();
  check(rows === demoRows + 4, `Reimportul a dublat tranzacțiile: ${rows} în loc de ${demoRows + 4}.`);
  console.log(`import XTB (Excel): 3 tranzacții noi, fără dubluri la reimport`);

  // 9. Restaurare din backup: datele Anei sunt înlocuite cu cele din backup-ul demo.
  await nav('Setări');
  await stubDialogs(backupFile);
  await page.getByRole('button', { name: 'Restaurează…' }).click();
  await page.getByRole('button', { name: 'Alege fișierul și restaurează' }).click();
  await page.getByText(/Datele au fost restaurate/).waitFor();
  await nav('Tranzacții');
  await page.getByRole('cell', { name: /NVDA/ }).first().waitFor();
  rows = await page.locator('tbody tr').count();
  check(rows === demoRows, `După restaurare ar trebui ${demoRows} tranzacții, sunt ${rows}.`);
  console.log(`restaurare: ${rows} tranzacții`);

  // 10. „Ține-mă minte”: după repornire, sesiunea Anei este restaurată fără login.
  await app.close();
  await launch();
  await page.getByRole('navigation').waitFor({ timeout: 20000 });
  check((await page.getByText('ana', { exact: true }).count()) > 0, 'Sesiunea „ține-mă minte” nu a fost restaurată.');
  console.log('ține-mă minte: sesiunea a fost restaurată după repornire');
  await shot('15-sesiune-restaurata');

  // 11. După ieșirea din cont, repornirea duce din nou la login.
  await logout();
  await page.getByRole('button', { name: 'Intră în cont' }).waitFor();
  await app.close();
  await launch();
  await page.getByRole('button', { name: 'Intră în cont' }).waitFor({ timeout: 20000 });
  console.log('după logout, aplicația pornește pe ecranul de login');

  console.log(errors.length ? `ERORI în consolă:\n${errors.join('\n')}` : 'Fără erori în consolă.');
  console.log('TEST DE FUM REUȘIT');
} catch (err) {
  await page?.screenshot({ path: resolve(outDir, 'eroare.png') }).catch(() => undefined);
  console.error('TEST DE FUM EȘUAT:', err.message);
  if (errors.length) console.error('Erori în consolă:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
}
