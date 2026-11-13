/**
 * Verificarea versiunii web într-un browser real, la dimensiune de iPhone (390×844): login, contul demo,
 * pozițiile, bannerul de instalare, persistența datelor după reîncărcare, backup și service worker.
 *
 *   npm run build:web && npm run preview:web      (într-un terminal)
 *   node scripts/web-screens.mjs [http://localhost:4173/portofoliu-bursa/]
 *
 * Folosește Chrome sau Edge instalat (variabila CHROME_PATH poate indica executabilul). Capturile ajung în .screens/web/.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4173/portofoliu-bursa/';
const outDir = resolve('.screens/web');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const check = (cond, text) => {
  console.log(`${cond ? 'OK  ' : 'EROARE'} ${text}`);
  if (!cond) process.exitCode = 1;
};
const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(outDir, `${name}.png`) });
  console.log('captură:', name);
};
const tab = (label) => page.getByRole('navigation', { name: 'Meniu rapid' }).getByRole('button', { name: label });

await page.goto(url);
await page.getByRole('button', { name: 'Încearcă contul demo' }).waitFor({ timeout: 60000 });
check(await page.getByText('Partajare').first().isVisible(), 'bannerul de instalare apare în Safari');
await shot('01-login');

await page.getByRole('button', { name: 'Încearcă contul demo' }).click();
await page.getByText('Valoarea totală a portofoliului').waitFor({ timeout: 60000 });
await page.waitForTimeout(3000);
await shot('02-dashboard');

await tab(/^Portofoliu$/).click();
await page.waitForTimeout(1500);
await shot('03-pozitii');
check((await page.getByText('AAPL').count()) > 0 || (await page.getByText('Apple').count()) > 0, 'pozițiile demo se văd');

// Setări: cardul web și backup-ul.
await tab(/^Mai mult/).click();
await page.getByRole('dialog').getByRole('button', { name: /^Setări/ }).click();
await page.getByText('Versiunea pentru telefon').scrollIntoViewIfNeeded();
await page.getByLabel('Adresa proxy-ului de prețuri').fill('https://proxy.exemplu.workers.dev/');
await page.getByRole('button', { name: 'Salvează adresa' }).click();
await page.getByText('Adresa proxy-ului a fost salvată.').waitFor({ timeout: 10000 });
await shot('04-setari-web');

// Backup: descărcare (share nu există în Playwright), apoi verificăm că fișierul e SQLite.
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /Salvează backup/ }).click()]);
const path = await download.path();
const { readFileSync } = await import('node:fs');
check(readFileSync(path).subarray(0, 15).toString() === 'SQLite format 3', `backup descărcat (${download.suggestedFilename()}) este fișier SQLite`);

// Persistență: după reîncărcare, baza a rămas în IndexedDB și proxy-ul setat se păstrează.
await page.waitForTimeout(2500);
await page.reload();
await page.getByRole('button', { name: 'Încearcă contul demo' }).waitFor({ timeout: 60000 });
const stored = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('portofoliu-bursa');
      req.onsuccess = () => {
        const get = req.result.transaction('kv').objectStore('kv').get('db');
        get.onsuccess = () => resolve(get.result ? get.result.byteLength : 0);
      };
    })
);
check(stored > 50_000, `baza este în IndexedDB (${stored} octeți)`);
await page.getByRole('button', { name: 'Încearcă contul demo' }).click();
await page.getByText('Valoarea totală a portofoliului').waitFor({ timeout: 60000 });
await tab(/^Portofoliu$/).click();
await page.waitForTimeout(1500);
check((await page.getByText('AAPL').count()) > 0 || (await page.getByText('Apple').count()) > 0, 'după reîncărcare, datele sunt tot acolo');
await tab(/^Mai mult/).click();
await page.getByRole('dialog').getByRole('button', { name: /^Setări/ }).click();
await page.getByLabel('Adresa proxy-ului de prețuri').waitFor();
check((await page.getByLabel('Adresa proxy-ului de prețuri').inputValue()) === 'https://proxy.exemplu.workers.dev', 'adresa proxy-ului s-a păstrat');
await shot('05-dupa-reincarcare');

// Service worker: preia controlul și aplicația pornește fără rețea.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 }).catch(() => undefined);
const swReady = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
check(swReady, 'service worker înregistrat');
await page.reload(); // controlat de SW de la această încărcare
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 });
await context.setOffline(true);
await page.reload();
await page.getByRole('button', { name: 'Încearcă contul demo' }).waitFor({ timeout: 30000 });
check(true, 'aplicația pornește offline');
await shot('06-offline');
await context.setOffline(false);

check(errors.length === 0, `fără erori în consolă${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
