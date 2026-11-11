/**
 * Raportul fiscal: cursurile BNR (citire, zile fără curs, descărcare cu rezervă), totalurile pe
 * broker și monedă (vânzări, dividende, comisioane) în moneda originală și în lei, gruparea după
 * brokerii din România / străini, filtrul pe portofoliu și exportul CSV / HTML.
 */
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/types';
import { guessResidence, TAX_DISCLAIMER } from '@shared/tax';
import { migrate, openDatabase, type Db } from '@main/db/database';
import { MIGRATIONS } from '@main/db/migrations';
import { register } from '@main/services/auth';
import { createBroker, listBrokers, updateBroker } from '@main/services/brokers';
import { addPurchase, createTransaction } from '@main/services/transactions';
import { createPortfolio, listPortfolios, setPortfolioArchived } from '@main/services/portfolios';
import { bnrRateOn, ensureBnrYears, loadBnrRates, parseBnrXml } from '@main/services/bnr';
import { getTaxReport, prepareTaxReport, taxReportCsv, taxReportHtml } from '@main/services/taxReport';
import { saveHistory } from '@main/prices/store';

const xml = (cubes: Record<string, Record<string, string>>): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
${Object.entries(cubes)
  .map(
    ([date, rates]) =>
      `<Cube date="${date}">${Object.entries(rates)
        .map(([c, v]) => (c === 'HUF' ? `<Rate currency="HUF" multiplier="100">${v}</Rate>` : `<Rate currency="${c}">${v}</Rate>`))
        .join('')}</Cube>`
  )
  .join('\n')}
</Body></DataSet>`;

describe('cursurile BNR', () => {
  it('citește fișierul XML, cu multiplicator (100 HUF)', () => {
    const rates = parseBnrXml(xml({ '2025-01-03': { EUR: '4.9743', USD: '4.8012', HUF: '1.2056' } }));
    expect(rates).toEqual([
      { date: '2025-01-03', currency: 'EUR', rate: '4.9743' },
      { date: '2025-01-03', currency: 'USD', rate: '4.8012' },
      { date: '2025-01-03', currency: 'HUF', rate: '0.012056' }
    ]);
  });

  it('în weekend se folosește cursul ultimei zile lucrătoare, dar nu unul mai vechi de 10 zile', () => {
    const rows = [
      { date: '2025-01-31', rate: '4.77' },
      { date: '2025-02-03', rate: '4.79' }
    ];
    expect(bnrRateOn(rows, '2025-02-01')).toEqual({ date: '2025-01-31', rate: '4.77' }); // sâmbătă
    expect(bnrRateOn(rows, '2025-02-03')?.rate).toBe('4.79');
    expect(bnrRateOn(rows, '2025-01-30')).toBeNull(); // înainte de primul curs
    expect(bnrRateOn(rows, '2025-03-01')).toBeNull(); // prea departe de ultimul curs
  });
});

let db: Db;
let user: User;
const RATES_2024 = { '2024-03-01': { USD: '4.6' }, '2024-12-30': { USD: '4.8' } };
const RATES_2025 = {
  '2025-01-31': { USD: '4.7' },
  '2025-05-15': { USD: '4.5' },
  '2025-06-02': { USD: '4.4' },
  '2025-12-30': { USD: '4.3' }
};
let calls: string[] = [];
const fetcher = async (url: string): Promise<string> => {
  calls.push(url);
  if (url.endsWith('2024.xml')) return xml(RATES_2024);
  if (url.endsWith('2025.xml')) return xml(RATES_2025);
  throw new Error('HTTP 404');
};

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'contabil', password: 'parola-taxe-1' });
});
afterAll(() => db.close());
beforeEach(() => {
  calls = [];
  for (const table of ['transactions', 'assets', 'brokers', 'fx_official', 'fx_official_sync', 'price_history']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM portfolios WHERE name <> 'Principal'").run();
});

describe('descărcarea cursurilor BNR', () => {
  it('descarcă anii lipsă o singură dată; un an încheiat nu se mai cere', async () => {
    expect(await ensureBnrYears(db, user.id, [2024, 2025], fetcher)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(await ensureBnrYears(db, user.id, [2024, 2025], fetcher)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(loadBnrRates(db, user.id, ['USD']).get('USD')).toHaveLength(6);
  });

  it('dacă BNR nu răspunde, raportul spune că folosește cursul din aplicație', async () => {
    const notice = await ensureBnrYears(db, user.id, [2023], async () => {
      throw new Error('fetch failed');
    });
    expect(notice).toMatch(/2023 nu au putut fi descărcate/);
  });
});

describe('brokerii din România și cei străini', () => {
  it('se deduc din nume și se pot schimba', () => {
    expect(guessResidence('Tradeville')).toBe('ro');
    expect(guessResidence('BT Capital Partners')).toBe('ro');
    expect(guessResidence('XTB')).toBe('foreign');
    const b = createBroker(db, user.id, { name: 'Interactive Brokers' });
    expect(b.residence).toBe('foreign');
    expect(updateBroker(db, user.id, b.id, { name: 'Interactive Brokers', residence: 'ro' }).residence).toBe('ro');
    // Fără câmpul nou (formular vechi), opțiunea rămâne neschimbată.
    expect(updateBroker(db, user.id, b.id, { name: 'IBKR' }).residence).toBe('ro');
  });
});

describe('raportul anual', () => {
  const setup = () => {
    const xtb = createBroker(db, user.id, { name: 'XTB' });
    const tv = createBroker(db, user.id, { name: 'Tradeville' });
    const { asset: aapl } = addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: xtb.id, date: '2024-03-01', quantity: 10, price: 100, fee: 1 });
    createTransaction(db, user.id, { assetId: aapl.id, brokerId: xtb.id, type: 'sell', date: '2025-06-02', quantity: 4, price: 150, fee: 1 });
    createTransaction(db, user.id, { assetId: aapl.id, brokerId: xtb.id, type: 'dividend', date: '2025-05-15', grossAmount: 2.6, taxWithheld: 0.26 });
    createTransaction(db, user.id, { assetId: null, brokerId: xtb.id, type: 'fee', date: '2025-02-01', currency: 'USD', amount: 5 });
    const { asset: snp } = addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'SNP.RO', currency: 'RON' }, brokerId: tv.id, date: '2024-01-10', quantity: 1000, price: 0.5, fee: 2 });
    createTransaction(db, user.id, { assetId: snp.id, brokerId: tv.id, type: 'sell', date: '2024-09-02', quantity: 100, price: 0.6, fee: 0 });
    createTransaction(db, user.id, { assetId: snp.id, brokerId: tv.id, type: 'sell', date: '2025-03-03', quantity: 400, price: 0.4, fee: 1 });
    createTransaction(db, user.id, { assetId: snp.id, brokerId: tv.id, type: 'dividend', date: '2025-06-05', grossAmount: 100, taxWithheld: 10 });
    return { xtb, tv, aapl, snp };
  };

  it('vânzări, dividende și comisioane, pe broker și monedă, în moneda originală și în lei (curs BNR)', async () => {
    setup();
    const r = await prepareTaxReport(db, user.id, 2025, null, fetcher);
    expect(r.bnrNotice).toBeNull();
    expect(r.sections.map((s) => s.residence)).toEqual(['ro', 'foreign']);

    const [ro, foreign] = r.sections;
    // Tradeville: 400 SNP vândute cu 0,40 − 1 leu comision; costul mediu (500 + 2) / 1000 = 0,502 → 200,80 lei.
    expect(ro.groups).toHaveLength(1);
    expect(ro.groups[0]).toMatchObject({ brokerName: 'Tradeville', currency: 'RON', sales: 1, proceeds: 159, cost: 200.8, gains: 0, losses: -41.8, net: -41.8 });
    expect(ro.groups[0].dividends).toMatchObject({ gross: 100, tax: 10, net: 90, grossRon: 100, taxRon: 10, netRon: 90 });
    expect(ro.totalRon).toMatchObject({ net: -41.8, dividendsGross: 100, fees: 1 });

    // XTB: 4 AAPL, cost (1000 + 1) / 10 × 4 = 400,40 $ la 4,6 (ziua cumpărării); încasare 599 $ la 4,4 (ziua vânzării).
    const x = foreign.groups[0];
    expect(x).toMatchObject({ brokerName: 'XTB', currency: 'USD', sales: 1, proceeds: 599, cost: 400.4, gains: 198.6, net: 198.6 });
    expect(x.proceedsRon).toBeCloseTo(2635.6, 10);
    expect(x.costRon).toBeCloseTo(1841.84, 10);
    expect(x.netRon).toBeCloseTo(793.76, 10);
    // Dividendul la cursul din ziua plății (4,5); comisioanele: 1 $ la vânzare (4,4) + 5 $ custodie, sâmbătă → cursul de vineri (4,7).
    expect(x.dividends.grossRon).toBeCloseTo(11.7, 10);
    expect(x.dividends.taxRon).toBeCloseTo(1.17, 10);
    expect(x.fees).toBe(6);
    expect(x.feesRon).toBeCloseTo(4.4 + 23.5, 10);

    // Detalierea: doar anul ales (vânzarea din 2024 nu apare), cu sursa cursului.
    expect(r.details.map((d) => `${d.date} ${d.type}`)).toEqual(['2025-02-01 fee', '2025-03-03 sell', '2025-05-15 dividend', '2025-06-02 sell', '2025-06-05 dividend']);
    expect(r.details.find((d) => d.type === 'fee')).toMatchObject({ fxSource: 'bnr', fxDate: '2025-01-31', fxRate: 4.7 });
    expect(r.fxSources).toMatchObject({ bnr: 3, ron: 2, app: 0, current: 0 });
    expect(r.years).toContain(2024);
  });

  it('fără curs BNR folosește istoricul din aplicație și o spune', async () => {
    setup();
    saveHistory(db, user.id, 'USDRON=X', [{ date: '2025-01-31', close: 4.71 }, { date: '2025-05-15', close: 4.51 }, { date: '2025-06-02', close: 4.41 }], true, 'yahoo');
    const r = await prepareTaxReport(db, user.id, 2025, null, async () => {
      throw new Error('fetch failed');
    });
    expect(r.bnrNotice).toMatch(/nu au putut fi descărcate/);
    expect(r.details.find((d) => d.type === 'dividend' && d.currency === 'USD')).toMatchObject({ fxSource: 'app', fxRate: 4.51 });
  });

  it('toate portofoliile (inclusiv cele arhivate) sau doar unul', async () => {
    const { xtb } = setup();
    await ensureBnrYears(db, user.id, [2024, 2025], fetcher);
    const second = createPortfolio(db, user.id, { name: 'Pensie' });
    const { asset } = addPurchase(db, user.id, { portfolioId: second.id, asset: { type: 'stock', symbol: 'MSFT', currency: 'USD' }, brokerId: xtb.id, date: '2024-03-01', quantity: 2, price: 300, fee: 0 });
    createTransaction(db, user.id, { portfolioId: second.id, assetId: asset.id, brokerId: xtb.id, type: 'sell', date: '2025-06-02', quantity: 2, price: 400, fee: 0 });
    setPortfolioArchived(db, user.id, second.id, true);

    const all = getTaxReport(db, user.id, 2025, null);
    expect(all.details.filter((d) => d.type === 'sell')).toHaveLength(3);
    expect(all.details.find((d) => d.symbol === 'MSFT')?.portfolioName).toBe('Pensie');
    const main = listPortfolios(db, user.id).find((p) => p.name === 'Principal')!;
    const only = getTaxReport(db, user.id, 2025, main.id);
    expect(only.portfolioName).toBe('Principal');
    expect(only.details.some((d) => d.symbol === 'MSFT')).toBe(false);
    expect(getTaxReport(db, user.id, 2025, second.id).details.map((d) => d.symbol)).toEqual(['MSFT']);
  });

  it('exportul CSV (Excel în română) și documentul pentru PDF', async () => {
    setup();
    const r = await prepareTaxReport(db, user.id, 2025, null, fetcher);
    const csv = taxReportCsv(r);
    expect(csv.startsWith('﻿Data;Tip;Broker;Tip broker;')).toBe(true);
    expect(csv).toContain('2025-06-02;Vânzare;XTB;Broker străin;Principal;AAPL;');
    expect(csv).toContain(';599,00;400,40;198,60;');
    expect(csv).toContain(`Notă;${TAX_DISCLAIMER}`);
    const html = taxReportHtml(r, new Date('2026-01-15T10:00:00Z'));
    expect(html).toContain('Raport fiscal 2025');
    expect(html).toContain(TAX_DISCLAIMER);
    expect(html).toContain('Brokeri din România');
    expect(html).toContain('Brokeri străini');
    expect(html).not.toMatch(/<script/i);
  });

  it('brokerii existenți primesc opțiunea la migrare (după nume)', () => {
    const old = new Database(':memory:');
    for (const m of MIGRATIONS.filter((x) => x.version <= 7)) {
      old.exec(m.sql);
      m.after?.(old);
    }
    old.pragma('user_version = 7');
    old.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'vechi', 'x')").run();
    old.prepare("INSERT INTO brokers (user_id, name) VALUES (1, 'Tradeville'), (1, 'XTB')").run();
    migrate(old);
    expect(listBrokers(old, 1).map((b) => `${b.name} ${b.residence}`)).toEqual(['Tradeville ro', 'XTB foreign']);
    old.close();
  });
});
