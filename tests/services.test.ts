/**
 * Teste de integrare pentru serviciile din procesul principal, pe o bază
 * SQLite în memorie: conturi, izolarea datelor între utilizatori, validările
 * tranzacțiilor, portofoliul evaluat, CSV, backup/restaurare și contul demo.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/types';
import { openDatabase, schemaVersion, type Db } from '@main/db/database';
import { LATEST_SCHEMA_VERSION } from '@main/db/migrations';
import { createAesBox } from '@main/secrets';
import { AppError } from '@main/services/common';
import * as auth from '@main/services/auth';
import { createBroker, deleteBroker, listBrokers, updateBroker } from '@main/services/brokers';
import { deleteAsset, listAssets, updateAsset } from '@main/services/assets';
import {
  addPurchase,
  createTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction
} from '@main/services/transactions';
import { getHistory, getOverview } from '@main/services/portfolio';
import { getApiKey, getSettings, setApiKey, updateSettings } from '@main/services/settings';
import { exportTransactionsCsv, importTransactionsCsv } from '@main/services/csvio';
import { createBackup, restoreBackup } from '@main/services/backup';
import { ensureDemoAccount } from '@main/services/demo';
import { saveHistory, saveQuote } from '@main/prices/store';

let db: Db;
let alice: User;
let bob: User;
const tmp = mkdtempSync(join(tmpdir(), 'portofoliu-test-'));

beforeAll(async () => {
  db = openDatabase(':memory:');
  alice = await auth.register(db, { username: 'alice', email: 'alice@example.com', password: 'parola-alice' });
  bob = await auth.register(db, { username: 'bob', password: 'parola-bob-123' });
});

afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Șterge datele de portofoliu ale ambilor utilizatori între teste. */
beforeEach(() => {
  for (const table of ['transactions', 'assets', 'brokers', 'prices', 'price_history', 'history_sync', 'api_keys']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  updateSettings(db, alice.id, { baseCurrency: 'RON', costMethod: 'AVG' });
  updateSettings(db, bob.id, { baseCurrency: 'RON', costMethod: 'AVG' });
});

const AAPL = { type: 'stock', symbol: 'AAPL', name: 'Apple', currency: 'USD' } as const;

describe('schema bazei de date', () => {
  it('aplică toate migrările', () => {
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('toate tabelele au user_id (în afară de users)', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[];
    expect(tables.length).toBeGreaterThanOrEqual(9);
    for (const { name } of tables) {
      if (name === 'users') continue;
      const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols, `tabela ${name}`).toContain('user_id');
    }
  });
});

describe('conturi și autentificare', () => {
  it('salvează parola doar ca hash bcrypt', () => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(alice.id) as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.password_hash).not.toContain('parola-alice');
  });

  it('autentifică doar cu parola corectă', async () => {
    await expect(auth.verifyLogin(db, 'ALICE', 'parola-alice')).resolves.toMatchObject({ id: alice.id });
    await expect(auth.verifyLogin(db, 'alice', 'gresita')).rejects.toThrow(AppError);
    await expect(auth.verifyLogin(db, 'nimeni', 'parola-alice')).rejects.toThrow('Nume de utilizator sau parolă incorectă.');
  });

  it('respinge numele duplicate, parolele scurte și emailurile invalide', async () => {
    await expect(auth.register(db, { username: 'Alice', password: 'altaparola1' })).rejects.toThrow(/Există deja/);
    await expect(auth.register(db, { username: 'carol', password: 'scurta' })).rejects.toThrow(/cel puțin 8/);
    await expect(auth.register(db, { username: 'carol', email: 'nu-e-email', password: 'parola-lunga' })).rejects.toThrow(/email/);
  });

  it('„ține-mă minte”: tokenul valid restaurează sesiunea, iar cel revocat nu', () => {
    const token = auth.createRememberToken(db, alice.id);
    const stored = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(alice.id) as { token_hash: string };
    expect(stored.token_hash).not.toBe(token); // în bază stă doar hash-ul
    expect(auth.userFromToken(db, token)?.id).toBe(alice.id);
    expect(auth.userFromToken(db, 'token-inventat')).toBeNull();
    auth.revokeToken(db, token);
    expect(auth.userFromToken(db, token)).toBeNull();
  });

  it('schimbarea parolei cere parola veche și invalidează sesiunile salvate', async () => {
    const carol = await auth.register(db, { username: 'carol', password: 'parola-veche' });
    const token = auth.createRememberToken(db, carol.id);
    await expect(auth.changePassword(db, carol.id, 'gresita', 'parola-noua-1')).rejects.toThrow(/incorectă/);
    await auth.changePassword(db, carol.id, 'parola-veche', 'parola-noua-1');
    await expect(auth.verifyLogin(db, 'carol', 'parola-veche')).rejects.toThrow(AppError);
    await expect(auth.verifyLogin(db, 'carol', 'parola-noua-1')).resolves.toMatchObject({ id: carol.id });
    expect(auth.userFromToken(db, token)).toBeNull();
  });
});

describe('izolarea datelor între utilizatori', () => {
  it('un utilizator nu vede și nu poate modifica datele altuia', () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    const { asset, transaction } = addPurchase(db, alice.id, {
      asset: AAPL,
      brokerId: broker.id,
      date: '2024-02-12',
      quantity: 10,
      price: 187.15,
      fee: 1
    });

    expect(listBrokers(db, bob.id)).toEqual([]);
    expect(listAssets(db, bob.id)).toEqual([]);
    expect(listTransactions(db, bob.id)).toEqual([]);
    expect(getOverview(db, bob.id).positions).toEqual([]);

    // Id-urile lui Alice, folosite din contul lui Bob, sunt tratate ca inexistente.
    expect(() => updateBroker(db, bob.id, broker.id, { name: 'Furat' })).toThrow(AppError);
    expect(() => deleteBroker(db, bob.id, broker.id)).toThrow(AppError);
    expect(() => updateAsset(db, bob.id, asset.id, { name: 'x' })).toThrow(AppError);
    expect(() => deleteAsset(db, bob.id, asset.id)).toThrow(AppError);
    expect(() => deleteTransaction(db, bob.id, transaction.id)).toThrow(AppError);
    expect(() =>
      createTransaction(db, bob.id, { assetId: asset.id, brokerId: broker.id, type: 'sell', date: '2024-03-01', quantity: 1, price: 1 })
    ).toThrow(AppError);

    // Datele lui Alice au rămas neatinse.
    expect(listTransactions(db, alice.id)).toHaveLength(1);
    expect(listBrokers(db, alice.id)[0].name).toBe('XTB');
  });

  it('doi utilizatori pot avea același simbol și același nume de broker', () => {
    for (const user of [alice, bob]) {
      const broker = createBroker(db, user.id, { name: 'XTB' });
      addPurchase(db, user.id, { asset: AAPL, brokerId: broker.id, date: '2024-02-12', quantity: user === alice ? 10 : 3, price: 100, fee: 0 });
    }
    expect(getOverview(db, alice.id).aggregated[0].quantity).toBe(10);
    expect(getOverview(db, bob.id).aggregated[0].quantity).toBe(3);
  });
});

describe('portofoliu și tranzacții', () => {
  it('o achiziție creează activul și o tranzacție de tip Cumpărare', () => {
    const broker = createBroker(db, alice.id, { name: 'Binance' });
    addPurchase(db, alice.id, {
      asset: { type: 'crypto', symbol: 'btc-usd', currency: 'usd' },
      brokerId: broker.id,
      date: '2024-01-10',
      quantity: 0.03512345,
      price: 46627.78,
      fee: 5,
      notes: 'prima cumpărare'
    });
    const [tx] = listTransactions(db, alice.id);
    expect(tx).toMatchObject({ type: 'buy', symbol: 'BTC-USD', brokerName: 'Binance', quantity: 0.03512345, currency: 'USD' });
    expect(listAssets(db, alice.id)[0]).toMatchObject({ symbol: 'BTC-USD', type: 'crypto', priceMode: 'auto' });
  });

  it('nu poți vinde mai mult decât deții la acel broker', () => {
    const xtb = createBroker(db, alice.id, { name: 'XTB' });
    const tv = createBroker(db, alice.id, { name: 'Tradeville' });
    const { asset, transaction: buyTx } = addPurchase(db, alice.id, { asset: AAPL, brokerId: xtb.id, date: '2024-02-12', quantity: 10, price: 187, fee: 0 });
    addPurchase(db, alice.id, { asset: AAPL, brokerId: tv.id, date: '2024-03-01', quantity: 5, price: 190, fee: 0 });
    const sellAt = (brokerId: number, date: string, quantity: number) =>
      createTransaction(db, alice.id, { assetId: asset.id, brokerId, type: 'sell', date, quantity, price: 200 });

    expect(() => sellAt(tv.id, '2024-04-01', 6)).toThrow(/Nu poți vinde mai mult decât deții/); // totalul e 15, dar la Tradeville sunt 5
    expect(() => sellAt(xtb.id, '2024-02-01', 1)).toThrow(AppError); // înainte de cumpărare
    const sale = sellAt(xtb.id, '2024-04-01', 8);

    // Modificări indirecte care ar lăsa vânzarea fără acoperire:
    expect(() => deleteTransaction(db, alice.id, buyTx.id)).toThrow(AppError);
    expect(() =>
      updateTransaction(db, alice.id, buyTx.id, { assetId: asset.id, brokerId: xtb.id, type: 'buy', date: '2024-02-12', quantity: 7, price: 187 })
    ).toThrow(AppError);
    expect(() =>
      updateTransaction(db, alice.id, buyTx.id, { assetId: asset.id, brokerId: xtb.id, type: 'buy', date: '2024-05-01', quantity: 10, price: 187 })
    ).toThrow(AppError);

    // Modificări valide.
    updateTransaction(db, alice.id, sale.id, { assetId: asset.id, brokerId: xtb.id, type: 'sell', date: '2024-04-02', quantity: 10, price: 201 });
    expect(getOverview(db, alice.id).positions.map((p) => [p.brokerName, p.quantity])).toEqual([['Tradeville', 5]]);
    deleteTransaction(db, alice.id, sale.id);
    deleteTransaction(db, alice.id, buyTx.id);
  });

  it('validează câmpurile în funcție de tipul tranzacției', () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    const { asset } = addPurchase(db, alice.id, { asset: AAPL, brokerId: broker.id, date: '2024-02-12', quantity: 10, price: 187, fee: 0 });
    const base = { assetId: asset.id, brokerId: broker.id, date: '2024-03-01' };
    expect(() => createTransaction(db, alice.id, { ...base, type: 'buy', quantity: 0, price: 1 })).toThrow(/Cantitatea/);
    expect(() => createTransaction(db, alice.id, { ...base, type: 'buy', quantity: 1, price: -1 })).toThrow(/Prețul/);
    expect(() => createTransaction(db, alice.id, { ...base, type: 'buy', quantity: 1, price: 1, date: '2999-01-01' })).toThrow(/viitor/);
    expect(() => createTransaction(db, alice.id, { ...base, type: 'dividend', grossAmount: 10, taxWithheld: 11 })).toThrow(/Impozitul/);
    expect(() => createTransaction(db, alice.id, { ...base, type: 'coupon', grossAmount: 10 })).toThrow(/obligațiuni/);
    expect(() => createTransaction(db, alice.id, { ...base, type: 'split', splitNumerator: 1, splitDenominator: 1 })).toThrow(/1:1/);

    const dividend = createTransaction(db, alice.id, { ...base, type: 'dividend', grossAmount: 10, taxWithheld: 1 });
    expect(dividend).toMatchObject({ grossAmount: 10, taxWithheld: 1, netAmount: 9 });
  });

  it('un broker cu tranzacții nu poate fi șters', () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    addPurchase(db, alice.id, { asset: AAPL, brokerId: broker.id, date: '2024-02-12', quantity: 1, price: 1, fee: 0 });
    expect(() => deleteBroker(db, alice.id, broker.id)).toThrow(/tranzacții/);
    expect(() => createBroker(db, alice.id, { name: 'xtb' })).toThrow(/Ai deja/);
  });

  it('filtrează istoricul după tip, simbol, broker și perioadă', () => {
    const xtb = createBroker(db, alice.id, { name: 'XTB' });
    const tv = createBroker(db, alice.id, { name: 'Tradeville' });
    const { asset } = addPurchase(db, alice.id, { asset: AAPL, brokerId: xtb.id, date: '2024-02-12', quantity: 10, price: 187, fee: 0 });
    addPurchase(db, alice.id, { asset: { type: 'stock', symbol: 'SNP.RO', currency: 'RON' }, brokerId: tv.id, date: '2024-03-04', quantity: 100, price: 0.6, fee: 0 });
    createTransaction(db, alice.id, { assetId: asset.id, brokerId: xtb.id, type: 'dividend', date: '2024-05-16', grossAmount: 2.5, taxWithheld: 0.25 });

    expect(listTransactions(db, alice.id)).toHaveLength(3);
    expect(listTransactions(db, alice.id, { type: 'dividend' })).toHaveLength(1);
    expect(listTransactions(db, alice.id, { symbol: 'snp' })).toHaveLength(1);
    expect(listTransactions(db, alice.id, { brokerId: xtb.id })).toHaveLength(2);
    expect(listTransactions(db, alice.id, { dateFrom: '2024-03-01', dateTo: '2024-03-31' })).toHaveLength(1);
    expect(listTransactions(db, alice.id, { assetType: 'bond' })).toHaveLength(0);
  });
});

describe('portofoliul evaluat', () => {
  /** Portofoliu cu două monede, doi brokeri, un split, o vânzare și o obligațiune cu preț manual. */
  function seed(userId: number): { xtb: number; tv: number } {
    const xtb = createBroker(db, userId, { name: 'XTB' }).id;
    const tv = createBroker(db, userId, { name: 'Tradeville' }).id;
    const { asset } = addPurchase(db, userId, { asset: AAPL, brokerId: xtb, date: '2024-01-10', quantity: 10, price: 150, fee: 1 });
    addPurchase(db, userId, { asset: AAPL, brokerId: tv, date: '2024-02-10', quantity: 5, price: 170, fee: 1 });
    createTransaction(db, userId, { assetId: asset.id, brokerId: xtb, type: 'sell', date: '2024-03-10', quantity: 4, price: 200, fee: 1 });
    createTransaction(db, userId, { assetId: asset.id, brokerId: xtb, type: 'dividend', date: '2024-05-15', grossAmount: 10, taxWithheld: 1 });
    const bond = addPurchase(db, userId, {
      asset: { type: 'bond', symbol: 'R2710A', currency: 'RON', faceValue: 100, couponRate: 7.2, couponFrequency: 1, maturityDate: '2027-10-15', manualPrice: 101.2 },
      brokerId: tv,
      date: '2024-04-01',
      quantity: 50,
      price: 100,
      fee: 0
    }).asset;
    createTransaction(db, userId, { assetId: bond.id, brokerId: tv, type: 'coupon', date: '2025-04-01', grossAmount: 360 });
    saveQuote(db, userId, { symbol: 'AAPL', price: 210, currency: 'USD', asOf: '2025-06-01T00:00:00Z', provider: 'yahoo' });
    saveQuote(db, userId, { symbol: 'USDRON=X', price: 4.5, currency: 'RON', asOf: '2025-06-01T00:00:00Z', provider: 'yahoo' });
    return { xtb, tv };
  }

  it('calculează pozițiile pe broker, agregatul și totalurile în moneda de bază', () => {
    seed(alice.id);
    const o = getOverview(db, alice.id);

    expect(o.positions).toHaveLength(3); // AAPL@XTB, AAPL@Tradeville, obligațiunea
    const aapl = o.aggregated.find((p) => p.symbol === 'AAPL')!;
    expect(aapl.quantity).toBe(11);
    expect(aapl.costBasis).toBeCloseTo(1751.6, 6);
    expect(aapl.marketValueBase).toBeCloseTo(2310 * 4.5, 6);
    expect(aapl.priceSource).toBe('api');

    const bond = o.aggregated.find((p) => p.symbol === 'R2710A')!;
    expect(bond.priceSource).toBe('manual'); // obligațiunea folosește prețul introdus manual
    expect(bond.marketValue).toBeCloseTo(5060, 6);

    expect(o.totals.totalValue).toBeCloseTo(2310 * 4.5 + 5060, 6);
    expect(o.totals.realizedSales).toBeCloseTo(198.6 * 4.5, 6);
    expect(o.totals.income).toBeCloseTo(9 * 4.5 + 360, 6);
    expect(o.totals.unrealized).toBeCloseTo(558.4 * 4.5 + 60, 6);
    expect(o.totals.totalPnl).toBeCloseTo(o.totals.realized + o.totals.unrealized, 6);
    expect(o.approximateFx).toBe(false);
    expect(o.missingPrices).toEqual([]);

    expect(o.allocationByBroker.map((s) => s.label).sort()).toEqual(['Tradeville', 'XTB']);
    expect(o.allocationByType.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(1, 10);
    expect(o.topGainers[0].symbol).toBe('AAPL');
  });

  it('filtrul pe broker și pe tip de activ restrânge pozițiile și totalurile', () => {
    const { xtb } = seed(alice.id);
    const onlyXtb = getOverview(db, alice.id, { brokerId: xtb });
    expect(onlyXtb.positions.map((p) => p.symbol)).toEqual(['AAPL']);
    expect(onlyXtb.totals.totalValue).toBeCloseTo(6 * 210 * 4.5, 6);
    expect(onlyXtb.totals.income).toBeCloseTo(9 * 4.5, 6);

    const onlyBonds = getOverview(db, alice.id, { assetType: 'bond' });
    expect(onlyBonds.positions.map((p) => p.symbol)).toEqual(['R2710A']);
    expect(onlyBonds.totals.totalValue).toBeCloseTo(5060, 6);
  });

  it('schimbarea metodei (FIFO) și a monedei de bază se reflectă în calcule', () => {
    seed(alice.id);
    saveQuote(db, alice.id, { symbol: 'RONEUR=X', price: 0.2, currency: 'EUR', asOf: '2025-06-01T00:00:00Z', provider: 'yahoo' });
    saveQuote(db, alice.id, { symbol: 'USDEUR=X', price: 0.9, currency: 'EUR', asOf: '2025-06-01T00:00:00Z', provider: 'yahoo' });
    updateSettings(db, alice.id, { costMethod: 'FIFO', baseCurrency: 'EUR' });
    const o = getOverview(db, alice.id);
    expect(o.totals.baseCurrency).toBe('EUR');
    expect(o.totals.totalValue).toBeCloseTo(2310 * 0.9 + 5060 * 0.2, 6);
    // FIFO la XTB: 4 buc. vândute din lotul de 150.1 => realizat 799 - 600.4 (aici identic cu media, un singur lot)
    expect(o.totals.realizedSales).toBeCloseTo(198.6 * 0.9, 6);
  });

  it('fără niciun preț, poziția se evaluează la cost și simbolul este semnalat', () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    addPurchase(db, alice.id, { asset: { type: 'stock', symbol: 'SNP.RO', currency: 'RON' }, brokerId: broker.id, date: '2024-03-04', quantity: 100, price: 0.6, fee: 1 });
    const o = getOverview(db, alice.id);
    expect(o.positions[0].priceSource).toBe('cost');
    expect(o.positions[0].unrealizedPnl).toBe(0);
    expect(o.missingPrices).toEqual(['SNP.RO']);
  });

  it('split-ul ajustează cantitatea și prețul mediu fără să schimbe costul', () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    const { asset } = addPurchase(db, alice.id, { asset: { type: 'stock', symbol: 'NVDA', currency: 'USD' }, brokerId: broker.id, date: '2024-03-15', quantity: 2, price: 878.37, fee: 0 });
    saveHistory(db, alice.id, 'NVDA', [{ date: '2024-03-15', close: 87.8 }], true, 'yahoo');
    createTransaction(db, alice.id, { assetId: asset.id, brokerId: null, type: 'split', date: '2024-06-10', splitNumerator: 10, splitDenominator: 1 });
    const p = getOverview(db, alice.id).positions[0];
    expect(p.quantity).toBe(20);
    expect(p.avgPrice).toBeCloseTo(87.837, 6);
    expect(p.costBasis).toBeCloseTo(1756.74, 6);
    // Istoricul salvat al simbolului este invalidat, ca să fie descărcat din nou cu prețuri ajustate.
    expect(db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE symbol = 'NVDA'").get()).toEqual({ n: 0 });
  });

  it('reconstruiește evoluția valorii din tranzacții și prețuri istorice', () => {
    const broker = createBroker(db, alice.id, { name: 'XTB' });
    addPurchase(db, alice.id, { asset: AAPL, brokerId: broker.id, date: '2024-01-10', quantity: 10, price: 150, fee: 0 });
    saveHistory(db, alice.id, 'AAPL', [{ date: '2024-01-10', close: 150 }, { date: '2024-01-12', close: 160 }], true, 'yahoo');
    saveHistory(db, alice.id, 'USDRON=X', [{ date: '2024-01-09', close: 4.5 }, { date: '2024-01-12', close: 4.6 }], true, 'yahoo');
    saveQuote(db, alice.id, { symbol: 'AAPL', price: 170, currency: 'USD', asOf: '2024-01-15T00:00:00Z', provider: 'yahoo' });
    saveQuote(db, alice.id, { symbol: 'USDRON=X', price: 4.7, currency: 'RON', asOf: '2024-01-15T00:00:00Z', provider: 'yahoo' });

    const series = getHistory(db, alice.id, 'ALL', {}, '2024-01-15');
    expect(series.map((p) => p.date)).toEqual(['2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13', '2024-01-14', '2024-01-15']);
    expect(series[0].value).toBeCloseTo(10 * 150 * 4.5, 6);
    expect(series[2].value).toBeCloseTo(10 * 160 * 4.6, 6);
    expect(series[4].value).toBeCloseTo(10 * 160 * 4.6, 6); // weekend: ultimul preț cunoscut
    expect(series[5].value).toBeCloseTo(10 * 170 * 4.7, 6); // azi: prețul curent
    // Investit = costul la cursul din ziua cumpărării (cel mai apropiat curs anterior: 4.5).
    expect(series[5].invested).toBe(6750);
    expect(getHistory(db, bob.id, 'ALL')).toEqual([]);
  });
});

describe('setări și chei API', () => {
  it('cheile API sunt criptate în bază și nu ajung în interfață', () => {
    const secrets = createAesBox(randomBytes(32));
    setApiKey(db, secrets, alice.id, 'twelvedata', 'cheie-secreta-1234');
    const row = db.prepare("SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = 'twelvedata'").get(alice.id) as {
      encrypted_key: string;
    };
    expect(row.encrypted_key).not.toContain('cheie-secreta');
    expect(getApiKey(db, secrets, alice.id, 'twelvedata')).toBe('cheie-secreta-1234');
    expect(getApiKey(db, createAesBox(randomBytes(32)), alice.id, 'twelvedata')).toBeNull(); // altă cheie de criptare

    const settings = getSettings(db, alice.id);
    expect(settings.apiKeys.twelvedata).toEqual({ configured: true, hint: '…1234' });
    expect(JSON.stringify(settings)).not.toContain('cheie-secreta');
    expect(getSettings(db, bob.id).apiKeys.twelvedata.configured).toBe(false); // cheile sunt per utilizator

    setApiKey(db, secrets, alice.id, 'twelvedata', '');
    expect(getSettings(db, alice.id).apiKeys.twelvedata.configured).toBe(false);
  });

  it('validează valorile setărilor', () => {
    expect(updateSettings(db, alice.id, { refreshIntervalMin: 15, primaryProvider: 'polygon', theme: 'dark' })).toMatchObject({
      refreshIntervalMin: 15,
      primaryProvider: 'polygon',
      theme: 'dark'
    });
    expect(() => updateSettings(db, alice.id, { baseCurrency: 'XYZ' })).toThrow(AppError);
    expect(() => updateSettings(db, alice.id, { refreshIntervalMin: 7 })).toThrow(AppError);
    updateSettings(db, alice.id, { refreshIntervalMin: 5, primaryProvider: 'yahoo', theme: 'system' });
  });
});

describe('import și export CSV', () => {
  it('exportul unui utilizator poate fi importat de altul, cu aceleași poziții', async () => {
    const demo = await ensureDemoAccount(db);
    const { csv, count } = exportTransactionsCsv(db, demo.id);
    expect(count).toBe(listTransactions(db, demo.id).length);
    expect(csv).toContain('data,tip,tip_activ,simbol');

    const result = importTransactionsCsv(db, bob.id, csv);
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(count);
    expect(result.createdBrokers).toBe(2);
    expect(result.createdAssets).toBe(7);

    const summary = (userId: number) =>
      getOverview(db, userId)
        .positions.map((p) => `${p.symbol}@${p.brokerName}:${p.quantity}:${p.costBasis.toFixed(4)}`)
        .sort();
    expect(summary(bob.id)).toEqual(summary(demo.id));
    db.prepare('DELETE FROM users WHERE id = ?').run(demo.id);
  });

  it('acceptă punct-virgulă, zecimale cu virgulă și date în format românesc', () => {
    const csv = [
      'data;tip;tip_activ;simbol;broker;cantitate;pret;comision;moneda',
      '04.03.2024;Cumparare;Actiune;SNP.RO;Tradeville;5000;0,621;21,70;RON',
      '10.03.2025;Vânzare;;SNP.RO;Tradeville;1.000;0,74;5,18;'
    ].join('\n');
    const result = importTransactionsCsv(db, alice.id, csv);
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(2);
    const p = getOverview(db, alice.id).positions[0];
    expect(p.quantity).toBe(4000); // fișier cu virgulă zecimală => „1.000” înseamnă o mie
    expect(listTransactions(db, alice.id)[1]).toMatchObject({ date: '2024-03-04', price: 0.621, fee: 21.7 });
  });

  it('importul este atomic: la o eroare nu se salvează nimic', () => {
    const csv = [
      'data,tip,tip_activ,simbol,broker,cantitate,pret,comision,moneda',
      '2024-03-04,Cumpărare,Acțiune,SNP.RO,Tradeville,100,0.62,0,RON',
      '2024-03-05,Vânzare,Acțiune,SNP.RO,Tradeville,500,0.70,0,RON',
      '2024-13-45,Cumpărare,Acțiune,SNP.RO,Tradeville,1,1,0,RON'
    ].join('\n');
    const badDate = importTransactionsCsv(db, alice.id, csv);
    expect(badDate.imported).toBe(0);
    expect(badDate.errors).toEqual([{ line: 4, message: expect.stringContaining('Dată invalidă') }]);

    const oversell = importTransactionsCsv(db, alice.id, csv.split('\n').slice(0, 3).join('\n'));
    expect(oversell.imported).toBe(0);
    expect(oversell.errors).toHaveLength(1);
    expect(oversell.errors[0]).toMatchObject({ line: 3, message: expect.stringContaining('Nu poți vinde mai mult') });
    expect(listTransactions(db, alice.id)).toEqual([]);
    expect(listBrokers(db, alice.id)).toEqual([]);
    expect(listAssets(db, alice.id)).toEqual([]);
  });
});

describe('backup și restaurare', () => {
  it('backup-ul conține doar datele utilizatorului și poate fi restaurat în alt cont', async () => {
    const xtb = createBroker(db, alice.id, { name: 'XTB' });
    const { asset } = addPurchase(db, alice.id, { asset: AAPL, brokerId: xtb.id, date: '2024-01-10', quantity: 10, price: 150, fee: 1 });
    createTransaction(db, alice.id, { assetId: asset.id, brokerId: xtb.id, type: 'sell', date: '2024-03-10', quantity: 4, price: 200 });
    // O depunere (tranzacție de cash, fără activ) trebuie să treacă și ea prin backup.
    createTransaction(db, alice.id, { assetId: null, brokerId: xtb.id, type: 'deposit', date: '2024-01-05', currency: 'USD', amount: 2000 });
    saveQuote(db, alice.id, { symbol: 'AAPL', price: 210, currency: 'USD', asOf: '2025-06-01T00:00:00Z', provider: 'yahoo' });
    updateSettings(db, alice.id, { costMethod: 'FIFO' });
    // Bob are date proprii, care trebuie înlocuite la restaurare, și nu trebuie să apară în backup-ul lui Alice.
    const bobBroker = createBroker(db, bob.id, { name: 'Revolut' });
    addPurchase(db, bob.id, { asset: { type: 'etf', symbol: 'VWCE.DE', currency: 'EUR' }, brokerId: bobBroker.id, date: '2024-01-15', quantity: 3, price: 100, fee: 0 });

    const file = join(tmp, 'backup-alice.db');
    expect(createBackup(db, alice.id, file).transactions).toBe(3);

    const backup = new Database(file, { readonly: true });
    expect(backup.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(backup.prepare('SELECT password_hash FROM users').get()).toEqual({ password_hash: '' });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM assets WHERE symbol = 'VWCE.DE'").get()).toEqual({ n: 0 });
    backup.close();

    expect(restoreBackup(db, bob.id, file)).toEqual({ brokers: 1, assets: 1, transactions: 3 });
    const o = getOverview(db, bob.id);
    expect(o.positions.map((p) => [p.symbol, p.brokerName, p.quantity, p.price])).toEqual([['AAPL', 'XTB', 6, 210]]);
    expect(o.cashBalances.map((c) => [c.brokerName, c.currency, c.amount])).toEqual([['XTB', 'USD', 1299]]); // 2000 − 1501 + 800
    expect(getSettings(db, bob.id).costMethod).toBe('FIFO');
    expect(listTransactions(db, alice.id)).toHaveLength(3); // Alice nu este afectată
  });

  it('refuză fișierele care nu sunt backup-uri ale aplicației', () => {
    const notBackup = join(tmp, 'altceva.db');
    writeFileSync(notBackup, 'acesta nu este un fișier SQLite');
    expect(() => restoreBackup(db, alice.id, notBackup)).toThrow(/nu este un backup/);
    expect(() => restoreBackup(db, alice.id, join(tmp, 'inexistent.db'))).toThrow(/nu a fost găsit/);
  });
});

describe('contul demo', () => {
  it('conține acțiuni, un ETF, o obligațiune și crypto la doi brokeri', async () => {
    const demo = await ensureDemoAccount(db);
    expect(demo.isDemo).toBe(true);
    expect((await ensureDemoAccount(db)).id).toBe(demo.id); // nu se creează de două ori

    expect(listBrokers(db, demo.id).map((b) => b.name)).toEqual(['Tradeville', 'XTB']);
    const types = new Set(listAssets(db, demo.id).map((a) => a.type));
    expect([...types].sort()).toEqual(['bond', 'crypto', 'etf', 'stock']);

    const o = getOverview(db, demo.id);
    expect(o.aggregated).toHaveLength(7);
    expect(o.positions.filter((p) => p.symbol === 'AAPL')).toHaveLength(2); // același simbol la doi brokeri
    expect(o.aggregated.find((p) => p.symbol === 'NVDA')?.quantity).toBe(20); // split 10:1
    expect(o.totals.totalValue).toBeGreaterThan(0);
    expect(o.totals.realized).not.toBe(0);
    expect(o.missingPrices).toEqual([]);
    db.prepare('DELETE FROM users WHERE id = ?').run(demo.id);
  });

  it('un cont obișnuit numit „demo” nu poate fi deschis prin butonul de demo', async () => {
    const other = openDatabase(':memory:');
    const real = await auth.register(other, { username: 'demo', password: 'parola-mea-reala' });
    const demo = await ensureDemoAccount(other);
    expect(demo.id).not.toBe(real.id);
    expect(demo.isDemo).toBe(true);
    other.close();
  });
});
