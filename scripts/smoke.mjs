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
/** Alege portofoliul din selectorul din bara de sus. */
async function selectPortfolio(name) {
  await page.getByRole('button', { name: 'Alege portofoliul' }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

const nav = (label) => page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
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
  // Graficul randament vs. indicele de referință (S&P 500 implicit).
  const benchTitle = page.getByText(/Randamentul tău vs\. /);
  check((await benchTitle.count()) === 1, 'Lipsește graficul „Randamentul tău vs. S&P 500” de pe panoul principal.');
  await benchTitle.scrollIntoViewIfNeeded();
  await shot('07b-demo-benchmark');

  await nav('Portofoliu');
  await page.getByRole('cell', { name: /AAPL/ }).first().waitFor();
  await shot('08-demo-portofoliu');
  await page.getByRole('radio', { name: 'Pe broker' }).click();
  await shot('09-demo-portofoliu-pe-broker');

  // Ecranul „Risc”: scor, volatilitate, concentrare, expuneri.
  await nav('Risc');
  await page.getByText('Scor de diversificare').waitFor({ timeout: 30000 });
  check((await page.getByText('Concentrare: ponderea fiecărei poziții').count()) === 1, 'Ecranul Risc nu are tabelul de concentrare.');
  await shot('09e-risc');
  await page.locator('main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('09f-risc-jos');

  // Calendarul de dividende: venitul pe luni, calendarul lunii și randamentele.
  await nav('Dividende');
  await page.getByText('Venit pasiv pe luni').first().waitFor({ timeout: 30000 });
  check((await page.getByText('Randament din dividende pe poziții').count()) === 1, 'Pagina Dividende nu are tabelul de randamente.');
  await shot('09g-dividende');
  await page.locator('main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('09h-dividende-jos');

  // Raportul fiscal pe 2025 (toate portofoliile), export PDF și CSV.
  await nav('Raport fiscal');
  await page.getByText('Raport informativ pentru Declarația Unică').first().waitFor({ timeout: 30000 });
  await page.getByLabel('Anul raportului').selectOption('2025');
  await page.getByText('Brokeri străini').first().waitFor({ timeout: 30000 });
  check((await page.getByText('Brokeri din România').count()) >= 1, 'Raportul fiscal nu are secțiunea „Brokeri din România” (Tradeville).');
  await shot('09i-raport-fiscal');
  await page.locator('main').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('09j-raport-fiscal-detalii');
  const taxPdf = resolve(outDir, 'raport-fiscal-2025.pdf');
  await stubDialogs(taxPdf);
  await page.getByRole('button', { name: 'Export PDF' }).click();
  await page.getByText(/Raportul fiscal 2025 a fost salvat/).first().waitFor({ timeout: 30000 });
  check(existsSync(taxPdf) && readFileSync(taxPdf).subarray(0, 5).toString() === '%PDF-', 'Exportul PDF al raportului fiscal nu a creat un PDF.');
  const taxCsv = resolve(outDir, 'raport-fiscal-2025.csv');
  await stubDialogs(taxCsv);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await page.waitForTimeout(1500);
  check(existsSync(taxCsv) && readFileSync(taxCsv, 'utf8').includes('Data;Tip;Broker;Tip broker'), 'Exportul CSV al raportului fiscal lipsește.');

  // Jurnalul: o notă cu plan pe AAPL (înainte de vânzarea din demo), apoi planul lângă rezultatul vânzării.
  await nav('Jurnal');
  await page.getByText('Jurnalul este gol').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Notează în jurnal' }).click();
  const position = page.getByLabel('Poziția');
  await position.selectOption((await position.locator('option', { hasText: 'AAPL' }).first().getAttribute('value')) ?? '');
  await page.getByLabel('Data', { exact: true }).fill('2025-01-15');
  await page.getByLabel('Motivul deciziei').fill('Servicii în creștere și răscumpărări de acțiuni.');
  await page.getByLabel(/Preț țintă/).fill('250');
  await page.getByLabel(/Stop-loss/).fill('180');
  await page.getByLabel('Orizont de timp').selectOption('12');
  await page.getByRole('radio', { name: 'Încredere 4 din 5' }).click();
  await page.getByLabel(/^Etichete/).fill('tech, termen lung');
  await page.getByRole('button', { name: 'Salvează' }).click();
  await page.getByText('Planul tău vs. rezultatul real').first().waitFor({ timeout: 30000 });
  check((await page.getByText('#tech').count()) >= 1, 'Eticheta din jurnal nu apare în cronologie.');
  await shot('09k-jurnal');
  const journalCsvFile = resolve(outDir, 'jurnal.csv');
  await stubDialogs(journalCsvFile);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await page.getByText(/Jurnalul \(\d+ intrări\) a fost salvat/).first().waitFor({ timeout: 30000 });
  check(readFileSync(journalCsvFile, 'utf8').includes('Servicii în creștere'), 'Exportul CSV al jurnalului nu conține nota.');
  await nav('Portofoliu');
  await page.getByRole('button', { name: 'Vinde AAPL' }).first().click();
  await page.getByText(/Planul tău din 15\.01\.2025/).waitFor({ timeout: 30000 });
  await shot('09l-vanzare-cu-plan');
  await page.getByRole('button', { name: 'Renunță' }).click();
  console.log('jurnal: notă cu plan, comparație la vânzare, export CSV');
  console.log(`raport fiscal: PDF ${Math.round(readFileSync(taxPdf).length / 1024)} KB, CSV ${readFileSync(taxCsv, 'utf8').trim().split(/\r?\n/).length} rânduri`);

  // Simulatorul: la deschidere, depunerile din demo investite în S&P 500 (istoricul vine de pe internet).
  await nav('Simulator');
  const simDone = page.getByText(/Dacă depunerile tale ar fi fost investite/).or(page.locator('form [role=status]'));
  await simDone.first().waitFor({ timeout: 90000 });
  if ((await page.getByText(/Dacă depunerile tale ar fi fost investite/).count()) === 1) {
    await shot('09m-simulator-piata');
    await page.getByRole('radio', { name: 'Investiție lunară' }).click();
    await page.getByRole('button', { name: 'Simulează' }).click();
    await page.getByText('Valoarea de azi').waitFor({ timeout: 90000 });
    await shot('09n-simulator-dca');
    console.log('simulator: comparație cu piața și investiție lunară');
  } else {
    await shot('09m-simulator-fara-internet');
    console.log('simulator: fără istoric (probabil fără internet) - mesajul de eroare apare');
  }

  // Obiectivele: un obiectiv cu dată-țintă, proiecția Monte Carlo, sliderele și valorile în bani de azi.
  await nav('Obiective');
  await page.getByText('Niciun obiectiv încă').waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Adaugă obiectiv' }).click();
  await page.getByLabel('Numele obiectivului').fill('Fond pentru casă');
  await page.getByLabel(/^Suma-țintă/).fill('250000');
  await page.getByLabel(/^Data-țintă/).fill('2032-12-31');
  await page.getByRole('button', { name: 'Salvează' }).click();
  await page.getByText(/Ajungi la .+ în aproximativ|Ai atins deja obiectivul|În scenariul realist nu ajungi/).first().waitFor({ timeout: 90000 });
  check((await page.getByText(/% șanse/).count()) === 1, 'Lipsește probabilitatea de a atinge obiectivul până la data-țintă.');
  check((await page.getByText(/trebuie să depui aproximativ|chiar fără depuneri noi/).count()) === 1, 'Lipsește contribuția lunară necesară.');
  check((await page.getByText(/Proiecție estimativă bazată pe date istorice/).count()) === 1, 'Lipsește avertismentul proiecției.');
  await shot('09o-obiective');
  await page.getByRole('slider', { name: 'Contribuția lunară' }).evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '3000');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Înapoi la datele din aplicație' }).waitFor();
  await page.getByRole('radio', { name: /În bani de azi/ }).click();
  await shot('09p-obiective-slider-real');
  await nav('Panou principal');
  const goalsCard = page.locator('main').getByRole('heading', { name: 'Obiective' });
  await goalsCard.waitFor({ timeout: 60000 });
  await goalsCard.scrollIntoViewIfNeeded();
  await shot('09q-panou-obiective');
  console.log('obiective: proiecție, slider, bani de azi, card pe panoul principal');

  // Portofoliile: contul demo are „Principal” și „Crypto”; ecranul de comparație și selectorul din bara de sus.
  await nav('Portofolii');
  await page.getByRole('cell', { name: /Crypto/ }).first().waitFor({ timeout: 30000 });
  check((await page.getByRole('cell', { name: /Principal/ }).count()) === 1, 'Comparația portofoliilor nu conține „Principal”.');
  await shot('09b-demo-portofolii');
  await page.getByRole('button', { name: 'Alege portofoliul' }).click();
  await page.getByRole('menuitemradio', { name: /Crypto/ }).waitFor();
  await shot('09c-selector-portofoliu');
  await page.getByRole('menuitemradio', { name: /Crypto/ }).click();
  await nav('Portofoliu');
  await page.getByRole('cell', { name: /BTC-USD/ }).first().waitFor();
  check((await page.getByRole('cell', { name: /AAPL/ }).count()) === 0, 'Portofoliul „Crypto” arată și pozițiile din „Principal”.');
  await shot('09d-portofoliu-crypto');
  await selectPortfolio('Toate portofoliile');

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
  await nav('Risc');
  await page.getByText('Scor de diversificare').waitFor();
  await shot('13b-risc-dark');
  await nav('Obiective');
  await page.getByText(/Ajungi la .+ în aproximativ|Ai atins deja obiectivul|În scenariul realist nu ajungi/).first().waitFor({ timeout: 60000 });
  await shot('13c-obiective-dark');

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
  // Butonul din pagina Tranzacții duce la ecranul Import și deschide direct alegerea fișierului.
  await stubDialogs(csvFile);
  await page.getByRole('button', { name: 'Import Excel / CSV' }).click();
  await page.getByText(/tranzacții importate/).waitFor();
  // Exportul demo are coloana „portofoliu”: tranzacțiile crypto au intrat în portofoliul „Crypto”, creat automat.
  await selectPortfolio('Toate portofoliile');
  await nav('Tranzacții');
  await page.waitForTimeout(800);
  rows = await page.locator('tbody tr').count();
  check(rows === demoRows + 1, `După import ar trebui ${demoRows + 1} tranzacții, sunt ${rows}.`);
  console.log(`import CSV: ${rows} tranzacții în contul ana`);

  // 8b. Import din extrasul Excel exportat din xStation (XTB), din ecranul Import: previzualizare, apoi import.
  const xtbFile = resolve(outDir, 'USD_1234567_2025-01-01_2025-12-31.xlsx');
  writeXtbReport(xtbFile);
  await stubDialogs(xtbFile);
  await page.getByRole('button', { name: 'Import Excel / CSV' }).click();
  await page.getByText('XTB (xStation)').first().waitFor({ timeout: 30000 });
  // AAPL are deja tranzacții introduse manual la XTB (din CSV): aplicația le arată și nu le înlocuiește fără acord.
  await page.getByText(/introduse manual/).waitFor();
  const importButton = page.getByRole('button', { name: /^Importă 4 tranzacții$/ });
  await importButton.waitFor();
  await shot('14b-import-previzualizare');
  await importButton.click();
  await page.getByText('Import finalizat').waitFor();
  await page.getByText('Am adăugat').waitFor();
  check((await page.getByRole('cell', { name: /^MSFT/ }).count()) >= 1, 'Poziția MSFT nu apare în rezumatul importului.');
  await shot('14c-import-rezultat');
  await page.getByRole('button', { name: 'Gata' }).click();
  await nav('Tranzacții');
  await page.getByRole('cell', { name: /MSFT/ }).first().waitFor();
  await page.waitForTimeout(500);
  rows = await page.locator('tbody tr').count();
  check(rows === demoRows + 5, `După importul XTB ar trebui ${demoRows + 5} tranzacții, sunt ${rows}.`);
  const dividend = page.locator('tbody tr', { hasText: 'MSFT' }).filter({ hasText: 'Dividend' });
  check((await dividend.count()) === 1, 'Dividendul MSFT nu a fost importat.');
  check((await dividend.first().innerText()).includes('0,37'), 'Impozitul reținut la dividendul MSFT lipsește.');

  // Reimportul aceluiași fișier: totul este recunoscut ca deja în aplicație.
  await page.getByRole('button', { name: 'Import Excel / CSV' }).click();
  await page.getByRole('button', { name: 'Nimic nou de importat' }).waitFor({ timeout: 30000 });
  check(await page.getByRole('button', { name: 'Nimic nou de importat' }).isDisabled(), 'Reimportul ar adăuga din nou tranzacții.');
  await page.getByRole('button', { name: 'Renunță' }).click();
  console.log('import XTB (Excel): 4 tranzacții noi, fără dubluri la reimport');

  // Anularea importului: din lista importurilor anterioare.
  await page.getByText('Importuri anterioare').waitFor();
  await shot('14d-importuri-anterioare');
  const xtbBatch = page.locator('tbody tr', { hasText: 'USD_1234567' });
  await xtbBatch.getByRole('button', { name: 'Anulează' }).click();
  await page.getByRole('button', { name: 'Anulează importul' }).click();
  await page.getByText(/Importul a fost anulat/).waitFor();
  await nav('Tranzacții');
  await page.waitForTimeout(800);
  rows = await page.locator('tbody tr').count();
  check(rows === demoRows + 1, `După anularea importului XTB ar trebui ${demoRows + 1} tranzacții, sunt ${rows}.`);
  console.log('anularea importului: tranzacțiile XTB au fost șterse');

  // 8c. Watchlist: urmărirea unui simbol cu preț țintă, o listă nouă și cumpărarea direct din listă.
  await nav('Watchlist');
  await page.getByRole('tab', { name: /De urmărit/ }).waitFor();
  const watchSearch = page.getByLabel('Caută simbolul de adăugat în listă');
  await watchSearch.fill('NVDA');
  await page.getByRole('button', { name: 'Adaugă', exact: true }).click();
  await page.getByText('NVDA a fost adăugat în listă.').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Editează NVDA (preț țintă, notă, listă)' }).click();
  await page.getByLabel(/Preț țintă de cumpărare/).fill('100');
  await page.getByLabel('Notă personală').fill('aștept o corecție');
  await page.getByRole('button', { name: 'Salvează' }).click();
  await page.getByRole('cell', { name: 'aștept o corecție' }).waitFor();
  check((await page.getByRole('cell', { name: /^100,00 USD/ }).count()) === 1, 'Prețul țintă NVDA nu apare în listă.');

  await page.getByRole('button', { name: 'Listă nouă' }).click();
  await page.getByLabel('Numele listei').fill('Dividende');
  await page.getByRole('button', { name: 'Salvează' }).click();
  await page.getByRole('tab', { name: /Dividende/, selected: true }).waitFor();
  await watchSearch.fill('KO');
  await page.getByRole('button', { name: 'Adaugă', exact: true }).click();
  await page.getByText('KO a fost adăugat în listă.').waitFor({ timeout: 30000 });
  await page.getByRole('tab', { name: /De urmărit/ }).click();
  await page.getByRole('cell', { name: 'aștept o corecție' }).waitFor();
  await shot('14e-watchlist');

  // Cumpărarea din watchlist: formularul vine completat, iar instrumentul iese din listă.
  await page.getByRole('button', { name: 'Cumpără' }).first().click();
  await page.getByRole('heading', { name: 'Adaugă activ' }).waitFor();
  check((await page.getByLabel('Simbol / ticker').inputValue()) === 'NVDA', 'Formularul de cumpărare nu are simbolul din watchlist.');
  await page.getByLabel('Număr de unități').fill('2');
  await page.getByLabel(/^Preț de cumpărare/).fill('120');
  await page.getByRole('button', { name: 'Adaugă achiziția' }).click();
  await page.getByText(/Achiziția NVDA a fost adăugată/).waitFor();
  await page.getByText('Lista este goală').waitFor();
  console.log('watchlist: simbol urmărit cu preț țintă, listă nouă, cumpărare din listă');

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
