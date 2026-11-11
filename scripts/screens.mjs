/**
 * Capturi de ecran pentru verificarea aspectului: fiecare ecran principal, la dimensiune de
 * calculator (1440×900) și de iPhone (390×844), în tema luminoasă și în cea întunecată.
 *
 *   npm run build && npm run screens
 *
 * Folosește contul demo, într-un folder de date temporar (.screens/data). Capturile ajung în .screens/.
 */
import { _electron as electron } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve('.screens');
const dataDir = resolve(outDir, 'data');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'iphone', width: 390, height: 844 }
];
const PAGES = [
  ['dashboard', 'Panou principal'],
  ['positions', 'Portofoliu'],
  ['transactions', 'Tranzacții'],
  ['watchlist', 'Watchlist'],
  ['risk', 'Risc'],
  ['dividends', 'Dividende'],
  ['tax', 'Raport fiscal'],
  ['goals', 'Obiective'],
  ['journal', 'Jurnal'],
  ['simulator', 'Simulator'],
  ['import', 'Import'],
  ['portfolios', 'Portofolii'],
  ['brokers', 'Brokeri'],
  ['settings', 'Setări']
];

const app = await electron.launch({ args: ['.'], env: { ...process.env, PORTOFOLIU_DATA_DIR: dataDir } });
const page = await app.firstWindow();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

/** Dimensiunea zonei de conținut a ferestrei (limita minimă a aplicației se coboară doar aici). */
const resize = (w, h) =>
  app.evaluate(({ BrowserWindow }, [width, height]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(320, 480);
    win.setContentSize(width, height);
  }, [w, h]);

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(outDir, `${name}.png`) });
  console.log('captură:', name);
};

/** Deschide un ecran din meniu: lateral pe calculator; tab bar sau „Mai mult” pe telefon. */
async function go(view, label) {
  const name = new RegExp(`^${label}`);
  if (view === 'desktop') {
    await page.getByRole('navigation', { name: 'Meniu principal' }).getByRole('button', { name }).click();
  } else {
    const tabs = page.getByRole('navigation', { name: 'Meniu rapid' });
    const tab = tabs.getByRole('button', { name: new RegExp(`^${label === 'Panou principal' ? 'Panou' : label}$`) });
    if ((await tab.count()) > 0) await tab.click();
    else {
      await tabs.getByRole('button', { name: /^Mai mult/ }).click();
      await page.getByRole('dialog').getByRole('button', { name }).click();
    }
  }
  await page.waitForTimeout(1500);
  await page.locator('main').evaluate((el) => el.scrollTo(0, 0));
}

async function setTheme(view, label) {
  await go(view, 'Setări');
  await page.getByRole('radio', { name: label }).click();
  await page.waitForTimeout(300);
}

// Ecranul de autentificare, la ambele dimensiuni.
for (const v of VIEWS) {
  await resize(v.width, v.height);
  await page.getByRole('button', { name: 'Încearcă contul demo' }).waitFor({ timeout: 30000 });
  await shot(`${v.name}-light-00-login`);
}

await page.getByRole('button', { name: 'Încearcă contul demo' }).click();
await page.getByText('Valoarea totală a portofoliului').waitFor({ timeout: 30000 });
await page.waitForTimeout(9000); // prețuri + istoric de la Yahoo, dacă există internet

// Un obiectiv, ca ecranul Obiective să arate proiecția.
await resize(1440, 900);
await go('desktop', 'Obiective');
await page.getByRole('button', { name: 'Adaugă obiectiv' }).click();
await page.getByLabel('Numele obiectivului').fill('Fond pentru casă');
await page.getByLabel(/^Suma-țintă/).fill('250000');
await page.getByLabel(/^Data-țintă/).fill('2032-12-31');
await page.getByRole('button', { name: 'Salvează' }).click();
await page.getByText(/Ajungi la|Ai atins deja|nu ajungi/).first().waitFor({ timeout: 90000 });

for (const theme of [
  { name: 'light', label: 'Luminoasă' },
  { name: 'dark', label: 'Întunecată' }
]) {
  for (const v of VIEWS) {
    await resize(v.width, v.height);
    await setTheme(v.name, theme.label);
    for (const [id, label] of PAGES) {
      await go(v.name, label);
      await shot(`${v.name}-${theme.name}-${String(PAGES.findIndex((p) => p[0] === id) + 1).padStart(2, '0')}-${id}`);
    }
    if (v.name === 'iphone') {
      await page.getByRole('navigation', { name: 'Meniu rapid' }).getByRole('button', { name: /^Mai mult/ }).click();
      await shot(`${v.name}-${theme.name}-15-mai-mult`);
      await page.getByRole('button', { name: 'Închide' }).click();
      await go(v.name, 'Portofoliu');
      await page.locator('main ul button').first().click();
      await shot(`${v.name}-${theme.name}-16-pozitie-actiuni`);
      await page.getByRole('button', { name: 'Închide' }).click();
      await go(v.name, 'Panou principal');
      await page.locator('main').evaluate((el) => el.scrollTo(0, 700));
      await shot(`${v.name}-${theme.name}-17-dashboard-jos`);
    }
  }
}

await app.close();
if (errors.length > 0) {
  console.error('Erori în consolă:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Gata, fără erori în consolă.');
