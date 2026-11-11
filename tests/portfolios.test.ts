/**
 * Mai multe portofolii: migrarea datelor existente în „Principal”, evidența
 * separată pe portofoliu, totalurile combinate în monede diferite, mutarea
 * tranzacțiilor (cu recalcularea costului și a cash-ului) și backup-ul.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/types';
import { annualizedVolatility, Ledger, maxDrawdown, sortTransactions } from '@shared/calc';
import { migrate, openDatabase, schemaVersion, type Db } from '@main/db/database';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '@main/db/migrations';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase, createTransaction, ledgerOf, listTransactions } from '@main/services/transactions';
import { comparePortfolios, getOverview, getPerformance } from '@main/services/portfolio';
import {
  createPortfolio,
  deletePortfolio,
  duplicatePortfolio,
  listPortfolios,
  setPortfolioArchived
} from '@main/services/portfolios';
import { moveTransactions, positionTransactionIds, previewMove } from '@main/services/portfolioMove';
import { getSettings, updateSettings } from '@main/services/settings';
import { createBackup, restoreBackup } from '@main/services/backup';
import { saveQuote } from '@main/prices/store';
import { buy, sell, tx } from './helpers';

describe('migrarea la mai multe portofolii', () => {
  it('mută toate datele existente în portofoliul „Principal”, fără pierderi', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
      old.exec(m.sql);
      m.after?.(old);
    }
    old.pragma('user_version = 3');
    old.exec(`
      INSERT INTO users (username, password_hash) VALUES ('ana', 'h'), ('dan', 'h');
      INSERT INTO settings (user_id, base_currency) VALUES (1, 'EUR'), (2, 'RON');
      INSERT INTO brokers (user_id, name) VALUES (1, 'XTB'), (2, 'BT');
      INSERT INTO assets (user_id, type, symbol, currency) VALUES (1, 'stock', 'AAPL', 'USD'), (2, 'stock', 'SNP.RO', 'RON');
      INSERT INTO transactions (user_id, asset_id, broker_id, type, date, quantity, price, fee, currency, net_amount)
        VALUES (1, 1, 1, 'buy', '2024-01-10', '2', '180.12', '0.5', 'USD', '0'),
               (2, 2, 2, 'buy', '2024-01-11', '1000', '0.621', '0', 'RON', '0');
      INSERT INTO transactions (user_id, asset_id, broker_id, type, date, currency, gross_amount, net_amount)
        VALUES (1, NULL, 1, 'deposit', '2024-01-02', 'USD', '1000', '1000');
      INSERT INTO transactions (user_id, asset_id, broker_id, type, date, currency, split_numerator, split_denominator)
        VALUES (1, 1, NULL, 'split', '2024-06-10', 'USD', '4', '1');
    `);
    const before = old.prepare('SELECT id, user_id, type, quantity, price, fee, net_amount FROM transactions ORDER BY id').all();

    migrate(old);
    expect(schemaVersion(old)).toBe(LATEST_SCHEMA_VERSION);
    expect(old.prepare('SELECT user_id, name, base_currency, archived FROM portfolios ORDER BY user_id').all()).toEqual([
      { user_id: 1, name: 'Principal', base_currency: 'EUR', archived: 0 },
      { user_id: 2, name: 'Principal', base_currency: 'RON', archived: 0 }
    ]);
    // Aceleași tranzacții, cu aceleași sume; fiecare în portofoliul proprietarului, split-ul fără portofoliu.
    expect(old.prepare('SELECT id, user_id, type, quantity, price, fee, net_amount FROM transactions ORDER BY id').all()).toEqual(before);
    const rows = old
      .prepare('SELECT t.type, t.portfolio_id IS NULL AS no_portfolio, p.user_id = t.user_id AS same_user FROM transactions t LEFT JOIN portfolios p ON p.id = t.portfolio_id ORDER BY t.id')
      .all();
    expect(rows).toEqual([
      { type: 'buy', no_portfolio: 0, same_user: 1 },
      { type: 'buy', no_portfolio: 0, same_user: 1 },
      { type: 'deposit', no_portfolio: 0, same_user: 1 },
      { type: 'split', no_portfolio: 1, same_user: null }
    ]);
    old.close();
  });
});

describe('evidența pe portofoliu în motorul de calcul', () => {
  it('o vânzare dintr-un portofoliu consumă doar loturile lui; split-ul fără portofoliu se aplică peste tot', () => {
    const ledger = new Ledger({ method: 'AVG' }).applyAll(
      sortTransactions([
        buy('2024-01-02', 1, 100, { portfolioId: 1 }),
        buy('2024-01-03', 1, 200, { portfolioId: 2 }),
        sell('2024-01-04', 1, 150, { portfolioId: 1 }),
        tx({ type: 'split', date: '2024-02-01', brokerId: null, portfolioId: null, splitNumerator: 2, splitDenominator: 1 })
      ])
    );
    expect(ledger.get(1, 1, 1)).toMatchObject({ quantity: 0, realizedPnl: 50 });
    // Portofoliul 2 își păstrează costul de 200; după split are 2 unități.
    expect(ledger.get(1, 1, 2)).toMatchObject({ quantity: 2, costBasis: 200, realizedPnl: 0 });
  });

  it('nu poți vinde dintr-un portofoliu ce deții în altul', () => {
    const ledger = new Ledger({ method: 'AVG' });
    expect(() => ledger.applyAll([buy('2024-01-02', 5, 10, { portfolioId: 2 }), sell('2024-01-03', 1, 10, { portfolioId: 1 })])).toThrow();
  });

  it('cash-ul și urmărirea lui sunt pe cont (portofoliu + broker)', () => {
    const ledger = new Ledger({ method: 'AVG', currencyOf: () => 'RON' }).applyAll(
      sortTransactions([
        tx({ type: 'deposit', date: '2024-01-01', assetId: null, currency: 'RON', netAmount: 1000, grossAmount: 1000, portfolioId: 1 }),
        buy('2024-01-02', 2, 100, { portfolioId: 1, currency: 'RON' }),
        buy('2024-01-02', 1, 100, { portfolioId: 2, currency: 'RON' })
      ])
    );
    const cash = ledger.cashBalances().map((c) => [c.portfolioId, c.amount, c.tracked]);
    expect(cash).toEqual([
      [1, 800, true],
      [2, -100, false]
    ]);
  });
});

describe('portofolii în aplicație', () => {
  let db: Db;
  let user: User;
  let principal: number;
  beforeAll(async () => {
    db = openDatabase(':memory:');
    user = await register(db, { username: 'portof', password: 'parola-pf-123' });
  });
  afterAll(() => db.close());
  beforeEach(() => {
    for (const t of ['transactions', 'assets', 'brokers', 'prices', 'price_history', 'history_sync']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM portfolios WHERE name <> 'Principal'").run();
    db.prepare("UPDATE settings SET base_currency = 'RON', active_portfolio = NULL").run();
    principal = listPortfolios(db, user.id)[0].id;
  });

  const quotes = (): void => {
    const asOf = '2024-01-10T15:00:00Z';
    for (const [symbol, price, currency] of [
      ['AAPL', 200, 'USD'],
      ['VWCE.DE', 110, 'EUR'],
      ['USDRON=X', 4.5, 'RON'],
      ['EURRON=X', 5, 'RON'],
      ['USDEUR=X', 0.9, 'EUR']
    ] as const) {
      saveQuote(db, user.id, { symbol, price, currency, asOf, provider: 'yahoo' });
    }
  };

  it('fiecare cont nou are portofoliul „Principal”, iar tranzacțiile noi intră în portofoliul selectat', () => {
    expect(listPortfolios(db, user.id).map((p) => p.name)).toEqual(['Principal']);
    const trading = createPortfolio(db, user.id, { name: 'Trading', color: 'rose', icon: 'rocket' });
    const broker = createBroker(db, user.id, { name: 'XTB' });
    updateSettings(db, user.id, { activePortfolio: trading.id });
    expect(getSettings(db, user.id).activePortfolio).toBe(trading.id);
    const t = createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: broker.id, date: '2024-01-01', currency: 'RON', amount: 100 });
    expect(t.portfolioId).toBe(trading.id);
    // Portofoliul selectat a fost șters: aplicația revine la primul portofoliu activ.
    deletePortfolio(db, user.id, trading.id);
    expect(getSettings(db, user.id).activePortfolio).toBe(principal);
    expect(listTransactions(db, user.id)).toEqual([]);
    expect(() => deletePortfolio(db, user.id, principal)).toThrow(/singurul portofoliu/);
  });

  it('totalurile combinate adună portofolii cu monede de bază diferite, în moneda din setări', () => {
    quotes();
    const xtb = createBroker(db, user.id, { name: 'XTB' });
    const eu = createPortfolio(db, user.id, { name: 'Europa', baseCurrency: 'EUR' });
    addPurchase(db, user.id, { portfolioId: principal, asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: xtb.id, date: '2024-01-02', quantity: 2, price: 150, fee: 0 });
    addPurchase(db, user.id, { portfolioId: eu.id, asset: { type: 'etf', symbol: 'VWCE.DE', currency: 'EUR' }, brokerId: xtb.id, date: '2024-01-02', quantity: 10, price: 100, fee: 0 });
    // Același activ în două portofolii, cu costuri diferite.
    addPurchase(db, user.id, { portfolioId: eu.id, asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: xtb.id, date: '2024-01-03', quantity: 1, price: 180, fee: 0 });

    const a = getOverview(db, user.id, { portfolioId: principal }, '2024-01-10');
    expect(a.totals).toMatchObject({ baseCurrency: 'RON', holdingsValue: 1800 }); // 2 × 200 USD × 4,5
    const b = getOverview(db, user.id, { portfolioId: eu.id }, '2024-01-10');
    expect(b.totals).toMatchObject({ baseCurrency: 'EUR', holdingsValue: 1280 }); // 10 × 110 + 200 × 0,9

    const all = getOverview(db, user.id, {}, '2024-01-10');
    expect(all.totals.baseCurrency).toBe('RON');
    expect(all.totals.holdingsValue).toBe(1800 + 1100 * 5 + 200 * 4.5); // 8200
    // AAPL apare pe câte o linie în fiecare portofoliu și o singură dată agregat.
    expect(all.positions.filter((p) => p.symbol === 'AAPL').map((p) => [p.portfolioName, p.quantity, p.avgPrice])).toEqual([
      ['Principal', 2, 150],
      ['Europa', 1, 180]
    ]);
    expect(all.aggregated.find((p) => p.symbol === 'AAPL')).toMatchObject({ quantity: 3, portfolioId: null });

    // Un portofoliu arhivat nu mai intră în vederea combinată.
    setPortfolioArchived(db, user.id, eu.id, true);
    expect(getOverview(db, user.id, {}, '2024-01-10').totals.holdingsValue).toBe(1800);

    const cmp = comparePortfolios(db, user.id, '2024-01-10');
    expect(cmp.map((c) => [c.name, c.value])).toEqual([['Principal', 1800]]);
  });

  it('mută o poziție în alt portofoliu: costul se mută cu ea, iar banii doar la cerere', () => {
    const tv = createBroker(db, user.id, { name: 'Tradeville' });
    const lung = createPortfolio(db, user.id, { name: 'Pe termen lung' });
    createTransaction(db, user.id, { portfolioId: principal, type: 'deposit', assetId: null, brokerId: tv.id, date: '2024-01-01', currency: 'RON', amount: 1000 });
    const { asset } = addPurchase(db, user.id, {
      portfolioId: principal,
      asset: { type: 'stock', symbol: 'SNP.RO', currency: 'RON' },
      brokerId: tv.id,
      date: '2024-01-02',
      quantity: 10,
      price: 50,
      fee: 0
    });
    const cashOf = (portfolioId: number): number | undefined =>
      getOverview(db, user.id, { portfolioId }, '2024-01-10').cashBalances.find((c) => c.currency === 'RON')?.amount;
    expect(cashOf(principal)).toBe(500);

    const ids = positionTransactionIds(db, user.id, principal, asset.id, tv.id);
    expect(previewMove(db, user.id, ids, lung.id)).toMatchObject({ count: 1, from: ['Principal'], to: 'Pe termen lung', cash: [{ amount: -500, currency: 'RON' }] });

    const res = moveTransactions(db, user.id, ids, lung.id, { moveCash: true });
    expect(res).toEqual({ moved: 1, cashTransfers: 1 });
    // Cash-ul din „Principal” rămâne 500 (banii au plecat odată cu poziția), iar în „Pe termen lung” este 0.
    expect(cashOf(principal)).toBe(500);
    expect(cashOf(lung.id)).toBeUndefined();
    const moved = getOverview(db, user.id, { portfolioId: lung.id }, '2024-01-10');
    expect(moved.positions.map((p) => [p.symbol, p.quantity, p.costBasis])).toEqual([['SNP.RO', 10, 500]]);
    expect(getOverview(db, user.id, { portfolioId: principal }, '2024-01-10').positions).toEqual([]);
    // Totalul combinat nu se schimbă la mutare.
    expect(getOverview(db, user.id, {}, '2024-01-10').totals.cash).toBe(500);
  });

  it('refuză mutarea unei cumpărări de care depinde o vânzare rămasă în portofoliul vechi', () => {
    const tv = createBroker(db, user.id, { name: 'Tradeville' });
    const other = createPortfolio(db, user.id, { name: 'Altul' });
    const { asset, transaction } = addPurchase(db, user.id, {
      portfolioId: principal,
      asset: { type: 'stock', symbol: 'TLV.RO', currency: 'RON' },
      brokerId: tv.id,
      date: '2024-01-02',
      quantity: 10,
      price: 20,
      fee: 0
    });
    createTransaction(db, user.id, { portfolioId: principal, type: 'sell', assetId: asset.id, brokerId: tv.id, date: '2024-01-05', quantity: 4, price: 25, fee: 0 });
    expect(() => moveTransactions(db, user.id, [transaction.id], other.id, { moveCash: false })).toThrow(/Nu poți vinde mai mult/);
    // Nimic nu s-a schimbat.
    expect(ledgerOf(db, user.id, asset.id).every((t) => t.portfolioId === principal)).toBe(true);
  });

  it('duplică un portofoliu cu tranzacțiile lui, fără legătura cu extrasele brokerilor', () => {
    const tv = createBroker(db, user.id, { name: 'Tradeville' });
    addPurchase(db, user.id, { portfolioId: principal, asset: { type: 'stock', symbol: 'H2O.RO', currency: 'RON' }, brokerId: tv.id, date: '2024-01-02', quantity: 3, price: 10, fee: 1 });
    db.prepare("UPDATE transactions SET external_id = 'tv:1'").run();
    const copy = duplicatePortfolio(db, user.id, principal);
    expect(copy.name).toBe('Principal (copie)');
    expect(copy.transactionCount).toBe(1);
    const copied = listTransactions(db, user.id, { portfolioId: copy.id });
    expect(copied.map((t) => [t.quantity, t.price, t.fee, t.externalId])).toEqual([[3, 10, 1, null]]);
  });

  it('backup-ul păstrează portofoliile și apartenența fiecărei tranzacții', async () => {
    const tv = createBroker(db, user.id, { name: 'Tradeville' });
    const pensie = createPortfolio(db, user.id, { name: 'Pensie', color: 'teal', icon: 'piggy-bank', baseCurrency: 'EUR' });
    addPurchase(db, user.id, { portfolioId: pensie.id, asset: { type: 'stock', symbol: 'BRD.RO', currency: 'RON' }, brokerId: tv.id, date: '2024-01-02', quantity: 5, price: 18, fee: 0 });
    updateSettings(db, user.id, { activePortfolio: pensie.id });

    const dir = mkdtempSync(join(tmpdir(), 'pf-backup-'));
    try {
      const file = join(dir, 'b.db');
      createBackup(db, user.id, file);
      const other = await register(db, { username: 'pf-alt', password: 'parola-pf-456' });
      restoreBackup(db, other.id, file);
      const restored = listPortfolios(db, other.id);
      expect(restored.map((p) => [p.name, p.color, p.icon, p.baseCurrency])).toEqual([
        ['Principal', 'blue', 'wallet', 'RON'],
        ['Pensie', 'teal', 'piggy-bank', 'EUR']
      ]);
      const pensieCopy = restored.find((p) => p.name === 'Pensie');
      expect(listTransactions(db, other.id).map((t) => t.portfolioName)).toEqual(['Pensie']);
      expect(getSettings(db, other.id).activePortfolio).toBe(pensieCopy?.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('randamentul pe portofoliu nu amestecă depunerile altor portofolii', () => {
    quotes();
    const xtb = createBroker(db, user.id, { name: 'XTB' });
    const second = createPortfolio(db, user.id, { name: 'Al doilea' });
    createTransaction(db, user.id, { portfolioId: second.id, type: 'deposit', assetId: null, brokerId: xtb.id, date: '2024-01-01', currency: 'RON', amount: 5000 });
    addPurchase(db, user.id, { portfolioId: principal, asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: xtb.id, date: '2024-01-02', quantity: 1, price: 200, fee: 0 });
    const perf = getPerformance(db, user.id, 'ALL', { portfolioId: second.id }, '2024-01-10');
    expect(perf.allTime).toEqual({ netContributions: 5000, currentValue: 5000, gain: 0 });
    expect(perf.twr).toBeCloseTo(0, 10);
  });
});

describe('volatilitatea și scăderea maximă', () => {
  it('calculează scăderea maximă de la un vârf și data revenirii', () => {
    const points = [
      { date: '2024-01-01', twr: 0 },
      { date: '2024-01-02', twr: 0.2 },
      { date: '2024-01-03', twr: -0.04 }, // 0,96 / 1,2 − 1 = −20%
      { date: '2024-01-04', twr: 0.1 },
      { date: '2024-01-05', twr: 0.25 }
    ];
    expect(maxDrawdown(points)).toEqual({ value: expect.closeTo(-0.2, 12), peakDate: '2024-01-02', troughDate: '2024-01-03', recoveryDate: '2024-01-05' });
    expect(maxDrawdown([{ date: '2024-01-01', twr: 0 }, { date: '2024-01-02', twr: 0.1 }])).toBeNull();
  });

  it('anualizează abaterea standard după lungimea pasului', () => {
    // Randamente zilnice alternând +1% / −1%: abaterea standard de selecție este cunoscută.
    const points = [{ date: '2024-01-01', twr: 0 }];
    let wealth = 1;
    for (let i = 1; i <= 20; i++) {
      wealth *= i % 2 === 1 ? 1.01 : 0.99;
      const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
      points.push({ date: d, twr: wealth - 1 });
    }
    const returns = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const mean = returns.reduce((s, r) => s + r, 0) / 20;
    const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / 19);
    expect(annualizedVolatility(points)).toBeCloseTo(sd * Math.sqrt(365), 10);
    expect(annualizedVolatility(points.slice(0, 5))).toBeNull();
  });
});
