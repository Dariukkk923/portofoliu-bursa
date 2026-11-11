/**
 * Depuneri, retrageri și cash la broker: soldul de cash, randamentul ponderat
 * în timp (TWR) și cel ponderat cu banii (XIRR).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/types';
import { annualize, Ledger, periodReturn, sortTransactions, twrSeries, xirr, type LedgerTx } from '@shared/calc';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase, createTransaction, listTransactions } from '@main/services/transactions';
import { getOverview, getPerformance } from '@main/services/portfolio';
import { exportTransactionsCsv, importTransactionsCsv } from '@main/services/csvio';
import { saveHistory, saveQuote } from '@main/prices/store';
import { buy, sell, tx } from './helpers';

const cashTx = (type: LedgerTx['type'], date: string, amount: number | string, currency = 'RON', extra: Partial<LedgerTx> = {}): LedgerTx =>
  tx({ type, date, assetId: null, currency, grossAmount: amount, netAmount: amount, ...extra });

const balances = (txs: LedgerTx[]) =>
  Object.fromEntries(
    new Ledger({ method: 'AVG', currencyOf: () => 'RON' })
      .applyAll(sortTransactions(txs))
      .cashBalances()
      .map((c) => [`${c.brokerId}:${c.currency}`, { amount: c.amount, tracked: c.tracked }])
  );

describe('soldul de cash pe broker', () => {
  it('depuneri − retrageri − cumpărări + vânzări + dividende nete − comisioane, exact', () => {
    const txs = [
      cashTx('deposit', '2024-01-02', 1000),
      buy('2024-01-03', 5, 100, { fee: 2, currency: 'RON' }), // −502
      sell('2024-02-01', 2, 120, { fee: 1, currency: 'RON' }), // +239
      tx({ type: 'dividend', date: '2024-03-01', currency: 'RON', grossAmount: 11.9, taxWithheld: 1.9, netAmount: 10 }), // +10
      cashTx('fee', '2024-03-15', 3), // −3
      cashTx('withdrawal', '2024-04-01', 100), // −100
      cashTx('adjustment', '2024-04-02', '-0.5') // −0,50
    ];
    expect(balances(txs)).toEqual({ '1:RON': { amount: 643.5, tracked: true } });
  });

  it('fără depuneri, brokerul nu are cash urmărit', () => {
    expect(balances([buy('2024-01-03', 5, 100, { currency: 'RON' })])).toEqual({ '1:RON': { amount: -500, tracked: false } });
  });

  it('folosește suma debitată efectiv de broker, în moneda contului', () => {
    const txs = [
      cashTx('deposit', '2024-01-02', 5000),
      buy('2024-01-03', 10, 100, { currency: 'USD', cashAmount: '-4512.3', cashCurrency: 'RON' })
    ];
    expect(balances(txs)).toEqual({ '1:RON': { amount: 487.7, tracked: true } });
  });

  it('fără sumă raportată, cumpărarea debitează moneda activului', () => {
    const txs = [cashTx('deposit', '2024-01-02', 1000, 'USD'), buy('2024-01-03', 3, 99.99, { currency: 'USD', fee: 0.03 })];
    expect(balances(txs)).toEqual({ '1:USD': { amount: 700, tracked: true } });
  });

  it('dobânzile și comisioanele generale intră la venituri și în cash', () => {
    const ledger = new Ledger({ method: 'AVG' }).applyAll(
      sortTransactions([
        cashTx('deposit', '2024-01-02', 100),
        tx({ type: 'interest', date: '2024-02-01', assetId: null, currency: 'RON', grossAmount: 5, taxWithheld: 0.5, netAmount: 4.5 }),
        cashTx('fee', '2024-02-02', 1.2)
      ])
    );
    expect(ledger.otherIncome()[0].otherIncome.get('RON')?.toString()).toBe('3.3');
    expect(ledger.cashBalances()[0].amount).toBe(103.3);
  });
});

describe('randamentul ponderat în timp (TWR)', () => {
  it('fără fluxuri este randamentul simplu', () => {
    const s = twrSeries([
      { date: '2024-01-01', value: 100, flows: [] },
      { date: '2024-01-02', value: 110, flows: [] }
    ]);
    expect(s[1].twr).toBeCloseTo(0.1, 12);
  });

  it('banii depuși nu schimbă randamentul: +10% și apoi încă +10% dau +21%', () => {
    const s = twrSeries([
      { date: '2024-01-01', value: 100, flows: [] },
      { date: '2024-01-02', value: 110, flows: [] },
      // se depun 100 la începutul zilei, iar 210 cresc cu 10% până la 231
      { date: '2024-01-03', value: 231, flows: [{ date: '2024-01-03', amount: 100 }] }
    ]);
    expect(s.map((p) => p.twr)).toEqual([0, expect.closeTo(0.1, 12), expect.closeTo(0.21, 12)]);
  });

  it('Modified Dietz: un flux din mijlocul perioadei contează proporțional cu timpul investit', () => {
    // 10 zile; depunerea de 500 în ziua 6 stă investită 5 zile din 10 (pondere 0,5)
    expect(periodReturn(1000, 1600, [{ date: '2024-01-07', amount: 500 }], '2024-01-01', '2024-01-11')).toBeCloseTo(0.08, 12);
  });

  it('anualizează doar perioadele de cel puțin un an', () => {
    expect(annualize(0.21, 730)).toBeCloseTo(0.1, 3);
    expect(annualize(0.05, 100)).toBeNull();
  });
});

describe('randamentul ponderat cu banii (XIRR)', () => {
  it('o investiție de 1000 care devine 1100 după un an are 10%', () => {
    expect(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }])).toBeCloseTo(0.1, 9);
  });

  it('găsește rata la care valoarea actualizată a tuturor fluxurilor este zero', () => {
    const flows = [
      { date: '2023-01-01', amount: -1000 },
      { date: '2023-07-02', amount: -1000 },
      { date: '2024-01-01', amount: 2200 }
    ];
    const r = xirr(flows) as number;
    expect(r).toBeGreaterThan(0.1); // jumătate din bani a stat investită doar jumătate de an
    const npv = flows.reduce((s, f) => s + f.amount / (1 + r) ** ((Date.parse(f.date) - Date.parse('2023-01-01')) / 86_400_000 / 365), 0);
    expect(Math.abs(npv)).toBeLessThan(1e-6);
  });

  it('fără bani puși și primiți nu există randament', () => {
    expect(xirr([{ date: '2023-01-01', amount: 1000 }])).toBeNull();
  });
});

describe('cash și randament în aplicație', () => {
  let db: Db;
  let user: User;
  beforeAll(async () => {
    db = openDatabase(':memory:');
    user = await register(db, { username: 'cash', password: 'parola-cash-1' });
  });
  afterAll(() => db.close());
  beforeEach(() => {
    for (const t of ['transactions', 'assets', 'brokers', 'prices', 'price_history', 'history_sync']) db.prepare(`DELETE FROM ${t}`).run();
  });

  const SNP = { type: 'stock', symbol: 'SNP.RO', currency: 'RON' } as const;
  const prices = (): void => {
    saveHistory(db, user.id, 'SNP.RO', [{ date: '2024-01-02', close: 50 }, { date: '2024-01-10', close: 60 }], true, 'yahoo');
    saveQuote(db, user.id, { symbol: 'SNP.RO', price: 60, currency: 'RON', asOf: '2024-01-10T15:00:00Z', provider: 'yahoo' });
  };

  it('cash-ul neinvestit intră în valoarea totală, iar TWR nu ține cont de depuneri', () => {
    const broker = createBroker(db, user.id, { name: 'Tradeville' });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: broker.id, date: '2024-01-01', currency: 'RON', amount: 1000 });
    addPurchase(db, user.id, { asset: SNP, brokerId: broker.id, date: '2024-01-02', quantity: 10, price: 50, fee: 0 });
    prices();

    const o = getOverview(db, user.id, {}, '2024-01-10');
    expect(o.cashBalances).toEqual([
      { portfolioId: expect.any(Number), portfolioName: 'Principal', brokerId: broker.id, brokerName: 'Tradeville', currency: 'RON', amount: 500, amountBase: 500 }
    ]);
    expect(o.totals).toMatchObject({ holdingsValue: 600, cash: 500, totalValue: 1100 });
    expect(o.untrackedCashBrokers).toEqual([]);

    const perf = getPerformance(db, user.id, 'ALL', {}, '2024-01-10');
    expect(perf.cashTracked).toBe(true);
    expect(perf.twr).toBeCloseTo(0.1, 10); // 1000 -> 1100 (jumătate din bani a stat cash)
    expect(perf.allTime).toEqual({ netContributions: 1000, currentValue: 1100, gain: 100 });
    expect(perf.xirr).not.toBeNull();
    expect(perf.points[0]).toMatchObject({ date: '2024-01-01', value: 1000, twr: 0 });
  });

  it('fără depuneri, cumpărările sunt banii puși și vânzările banii scoși', () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    addPurchase(db, user.id, { asset: SNP, brokerId: broker.id, date: '2024-01-02', quantity: 10, price: 50, fee: 0 });
    prices();
    const o = getOverview(db, user.id, {}, '2024-01-10');
    expect(o.totals.cash).toBe(0);
    expect(o.untrackedCashBrokers).toEqual(['XTB']);

    const perf = getPerformance(db, user.id, 'ALL', {}, '2024-01-10');
    expect(perf.cashTracked).toBe(false);
    expect(perf.twr).toBeCloseTo(0.2, 10);
    expect(perf.allTime).toEqual({ netContributions: 500, currentValue: 600, gain: 100 });
  });

  it('o ajustare de sold corectează cash-ul; tranzacțiile de cash se exportă și se importă în CSV', () => {
    const broker = createBroker(db, user.id, { name: 'BT Trade' });
    createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: broker.id, date: '2024-01-01', currency: 'RON', amount: 1000 });
    createTransaction(db, user.id, { type: 'withdrawal', assetId: null, brokerId: broker.id, date: '2024-01-05', currency: 'RON', amount: 250.25 });
    createTransaction(db, user.id, { type: 'adjustment', assetId: null, brokerId: broker.id, date: '2024-01-06', currency: 'RON', amount: -0.75 });
    createTransaction(db, user.id, { type: 'interest', assetId: null, brokerId: broker.id, date: '2024-01-07', currency: 'RON', grossAmount: 2, taxWithheld: 0.2 });
    expect(getOverview(db, user.id, {}, '2024-01-10').cashBalances[0].amount).toBe(750.8);
    expect(() =>
      createTransaction(db, user.id, { type: 'deposit', assetId: null, brokerId: broker.id, date: '2024-01-01', currency: 'RON', amount: -5 })
    ).toThrow(/mai mare decât zero/);

    const { csv, count } = exportTransactionsCsv(db, user.id);
    expect(count).toBe(4);
    db.prepare('DELETE FROM transactions').run();
    const result = importTransactionsCsv(db, user.id, csv);
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(4);
    expect(listTransactions(db, user.id).map((t) => `${t.type} ${t.netAmount} ${t.currency}`)).toEqual([
      'interest 1.8 RON',
      'adjustment -0.75 RON',
      'withdrawal 250.25 RON',
      'deposit 1000 RON'
    ]);
  });
});
