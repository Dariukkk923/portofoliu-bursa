/**
 * Calendarul de dividende: frecvența și estimarea plăților viitoare, randamentul pe 12 luni,
 * cupoanele obligațiunilor, potrivirea cu dividendele încasate, propunerile de înregistrare,
 * dividendele introduse manual și randamentul fiecărei poziții.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderId, User } from '@shared/types';
import { couponDates, forwardAnnualDividend, inferSchedule, projectDividends, trailingDividends, type DividendPoint } from '@shared/calc';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase, createTransaction } from '@main/services/transactions';
import { updateSettings } from '@main/services/settings';
import { addManualDividend, deleteManualDividend, dismissDividend, getDividendCalendar, saveDividendEvents } from '@main/services/dividends';
import { saveQuote } from '@main/prices/store';
import { createAesBox } from '@main/secrets';
import { PriceService } from '@main/prices/service';
import type { PriceProvider, ProviderDividend, SymbolRef } from '@main/prices/provider';

const quarterly: DividendPoint[] = [
  { exDate: '2024-11-08', payDate: '2024-11-14', amount: 0.25 },
  { exDate: '2025-02-10', payDate: '2025-02-13', amount: 0.25 },
  { exDate: '2025-05-12', payDate: '2025-05-15', amount: 0.26 },
  { exDate: '2025-08-11', payDate: '2025-08-14', amount: 0.26 },
  { exDate: '2025-11-10', payDate: null, amount: 0.26 }
];

describe('frecvența și estimarea dividendelor', () => {
  it('deduce plățile trimestriale și întârzierea plății', () => {
    expect(inferSchedule(quarterly, '2025-11-20')).toEqual({ frequency: 4, payLagDays: 3, lastExDate: '2025-11-10', regularAmount: 0.26 });
    expect(inferSchedule([{ exDate: '2025-06-01', payDate: null, amount: 1.2 }], '2025-11-20').frequency).toBe(1);
    expect(inferSchedule([], '2025-11-20').frequency).toBeNull();
  });

  it('un dividend special nu devine suma obișnuită', () => {
    const withSpecial = [...quarterly.slice(0, 4), { exDate: '2025-11-10', payDate: null, amount: 1.5 }];
    expect(inferSchedule(withSpecial, '2025-11-20').regularAmount).toBe(0.26);
  });

  it('estimează plățile viitoare după ultimul dividend cunoscut, inclusiv cele anunțate', () => {
    expect(projectDividends(quarterly, '2025-11-20', '2026-06-30')).toEqual([
      { exDate: '2026-02-10', payDate: '2026-02-13', payDateEstimated: true, amount: 0.26 },
      { exDate: '2026-05-10', payDate: '2026-05-13', payDateEstimated: true, amount: 0.26 }
    ]);
    // Un dividend anunțat (viitor) mută începutul estimărilor.
    const announced = [...quarterly, { exDate: '2026-02-09', payDate: '2026-02-12', amount: 0.27 }];
    expect(projectDividends(announced, '2025-11-20', '2026-06-30').map((p) => p.exDate)).toEqual(['2026-05-09']);
  });

  it('nu estimează nimic dacă plățile s-au oprit', () => {
    // Trimestrial până în februarie 2025, apoi nimic: ultima plată e prea veche.
    const stopped = ['2024-05-10', '2024-08-09', '2024-11-08', '2025-02-10'].map((exDate) => ({ exDate, payDate: null, amount: 0.2 }));
    expect(projectDividends(stopped, '2025-11-20', '2026-12-31')).toEqual([]);
    expect(projectDividends([{ exDate: '2023-05-02', payDate: null, amount: 1 }], '2025-11-20', '2026-12-31')).toEqual([]);
    // O plată anuală de acum un an continuă.
    expect(projectDividends(quarterly.slice(0, 1), '2025-11-20', '2026-12-31').map((p) => p.exDate)).toEqual(['2026-11-08']);
  });

  it('randamentul pe 12 luni și dividendul anual estimat', () => {
    expect(trailingDividends(quarterly, '2025-11-20')).toBeCloseTo(1.03, 10);
    expect(forwardAnnualDividend(quarterly, '2025-11-20')).toBeCloseTo(1.04, 10);
  });

  it('datele de cupon se numără înapoi de la scadență', () => {
    expect(couponDates('2027-06-15', 2, '2025-01-01', '2025-12-31')).toEqual(['2025-06-15', '2025-12-15']);
    expect(couponDates('2026-03-31', 4, '2025-10-01', '2026-12-31')).toEqual(['2025-12-31', '2026-03-31']);
  });
});

let db: Db;
let user: User;
const TODAY = '2025-11-20';

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'rentier', password: 'parola-div-1' });
  updateSettings(db, user.id, { baseCurrency: 'USD' });
});
afterAll(() => db.close());
beforeEach(() => {
  for (const table of ['transactions', 'dividend_events', 'dividend_dismissals', 'assets', 'brokers', 'prices']) db.prepare(`DELETE FROM ${table}`).run();
});

describe('calendarul de dividende', () => {
  const setup = () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    const { asset } = addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: broker.id, date: '2025-01-02', quantity: 10, price: 150, fee: 0 });
    createTransaction(db, user.id, { assetId: asset.id, brokerId: broker.id, type: 'sell', date: '2025-06-01', quantity: 4, price: 190, fee: 0 });
    // Încasate: februarie și mai (10 acțiuni); august și noiembrie nu au fost înregistrate.
    createTransaction(db, user.id, { assetId: asset.id, brokerId: broker.id, type: 'dividend', date: '2025-02-13', grossAmount: 2.5, taxWithheld: 0.25 });
    createTransaction(db, user.id, { assetId: asset.id, brokerId: broker.id, type: 'dividend', date: '2025-05-15', grossAmount: 2.6, taxWithheld: 0.26 });
    saveDividendEvents(db, user.id, 'AAPL', quarterly.map((q) => ({ ...q, currency: 'USD' })), 'yahoo');
    saveQuote(db, user.id, { symbol: 'AAPL', price: 200, currency: 'USD', asOf: `${TODAY}T12:00:00Z`, provider: 'yahoo' });
    return { broker, asset };
  };

  it('încasat vs. estimat pe luni, cu cantitatea deținută la data ex-dividend', () => {
    setup();
    const c = getDividendCalendar(db, user.id, 2025, {}, TODAY);
    expect(c.entries.map((e) => `${e.payDate} ${e.status} ${e.quantity} ${e.gross}`)).toEqual([
      '2025-02-13 received 10 2.5',
      '2025-05-15 received 10 2.6',
      // Plătit acum 98 de zile, neînregistrat: în afara ferestrei de propuneri, nu mai apare.
      // Noiembrie: data plății estimată (ex + 3 zile), 6 acțiuni după vânzare.
      '2025-11-13 announced 6 1.56'
    ]);
    expect(c.entries[2]).toMatchObject({ payDateEstimated: true, amountPerShare: 0.26 });
    expect(c.months[1].received).toBe(2.5);
    expect(c.months[4].received).toBe(2.6);
    expect(c.months[10].estimated).toBeCloseTo(1.56, 10);
    expect(c.receivedTotal).toBeCloseTo(5.1, 10);
    // Următoarele 12 luni: februarie, mai, august și noiembrie 2026, câte 6 × 0,26.
    expect(c.next12Months).toBeCloseTo(6.24, 10);
  });

  it('propune înregistrarea dividendului plătit, cu impozitul după cele anterioare; „nu l-am primit” îl ascunde', () => {
    const { asset } = setup();
    const c = getDividendCalendar(db, user.id, 2025, {}, TODAY);
    expect(c.proposals).toHaveLength(1);
    expect(c.proposals[0]).toMatchObject({ symbol: 'AAPL', exDate: '2025-11-10', payDate: '2025-11-13', quantity: 6, gross: 1.56, tax: 0.16, brokerName: 'XTB', coupon: false });
    dismissDividend(db, user.id, asset.id, '2025-11-10');
    expect(getDividendCalendar(db, user.id, 2025, {}, TODAY).proposals).toHaveLength(0);
  });

  it('după înregistrare, dividendul apare ca încasat și nu mai e propus', () => {
    const { asset, broker } = setup();
    createTransaction(db, user.id, { assetId: asset.id, brokerId: broker.id, type: 'dividend', date: '2025-11-13', grossAmount: 1.56, taxWithheld: 0.16 });
    const c = getDividendCalendar(db, user.id, 2025, {}, TODAY);
    expect(c.proposals).toHaveLength(0);
    expect(c.entries[c.entries.length - 1]).toMatchObject({ status: 'received', gross: 1.56, quantity: 6 });
  });

  it('dividendul introdus manual înlocuiește estimarea din aceeași perioadă', () => {
    const { asset } = setup();
    addManualDividend(db, user.id, { assetId: asset.id, exDate: '2026-02-09', payDate: '2026-02-12', amount: 0.3 });
    const c = getDividendCalendar(db, user.id, 2026, {}, TODAY);
    const feb = c.entries.filter((e) => e.payDate.startsWith('2026-02'));
    expect(feb).toHaveLength(1);
    expect(feb[0]).toMatchObject({ status: 'manual', amountPerShare: 0.3, gross: 1.8, payDateEstimated: false });
    expect(c.entries.find((e) => e.payDate.startsWith('2026-05'))?.status).toBe('estimated');
    expect(() => addManualDividend(db, user.id, { assetId: asset.id, exDate: '2026-02-09', payDate: '2026-02-01', amount: 0.3 })).toThrow(/înaintea datei ex-dividend/);
    deleteManualDividend(db, user.id, feb[0].manualId!);
    expect(getDividendCalendar(db, user.id, 2026, {}, TODAY).entries.find((e) => e.payDate.startsWith('2026-02'))?.status).toBe('estimated');
  });

  it('randamentul din dividende și cel raportat la prețul de cumpărare', () => {
    setup();
    const [y] = getDividendCalendar(db, user.id, 2025, {}, TODAY).yields;
    expect(y).toMatchObject({ symbol: 'AAPL', quantity: 6, frequency: 4 });
    expect(y.trailingPerShare).toBeCloseTo(1.03, 10);
    expect(y.yield).toBeCloseTo(1.03 / 200, 10);
    expect(y.yieldOnCost).toBeCloseTo(1.03 / 150, 10);
    expect(y.annualIncomeBase).toBeCloseTo(6.24, 10);
  });

  it('cupoanele obligațiunilor apar în calendar; activele fără date sunt semnalate', () => {
    const broker = createBroker(db, user.id, { name: 'Tradeville' });
    addPurchase(db, user.id, {
      asset: { type: 'bond', symbol: 'R2706A', currency: 'USD', faceValue: 100, couponRate: 6, couponFrequency: 2, maturityDate: '2027-06-15' },
      brokerId: broker.id,
      date: '2025-01-02',
      quantity: 10,
      price: 100,
      fee: 0
    });
    addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'TSLA', currency: 'USD' }, brokerId: broker.id, date: '2025-01-02', quantity: 1, price: 300, fee: 0 });
    const c = getDividendCalendar(db, user.id, 2025, {}, TODAY);
    expect(c.entries.filter((e) => e.coupon).map((e) => `${e.payDate} ${e.gross}`)).toEqual(['2025-12-15 30']);
    expect(c.withoutData).toEqual(['TSLA']);
  });
});

describe('dividendele de la provideri', () => {
  class DividendProvider implements PriceProvider {
    readonly id: ProviderId = 'yahoo';
    calls: string[] = [];
    async getQuote(ref: SymbolRef) {
      return { symbol: ref.symbol, price: 10, currency: 'USD', asOf: new Date().toISOString() };
    }
    async getHistory() {
      return { points: [], splitAdjusted: true };
    }
    async search() {
      return [];
    }
    async getDividends(ref: SymbolRef): Promise<ProviderDividend[] | null> {
      this.calls.push(ref.symbol);
      return ref.symbol === 'KO' ? [{ exDate: '2025-06-13', payDate: '2025-07-01', amount: 0.51, currency: 'USD' }] : [];
    }
  }

  it('se descarcă pentru acțiunile deținute, o dată la câteva zile; cele introduse manual rămân', async () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    for (const symbol of ['KO', 'TSLA']) {
      addPurchase(db, user.id, { asset: { type: 'stock', symbol, currency: 'USD' }, brokerId: broker.id, date: '2025-01-10', quantity: 1, price: 10, fee: 0 });
    }
    addPurchase(db, user.id, { asset: { type: 'crypto', symbol: 'BTC-USD', currency: 'USD' }, brokerId: broker.id, date: '2025-01-10', quantity: 1, price: 10, fee: 0 });
    const ko = db.prepare("SELECT id FROM assets WHERE symbol = 'KO'").get() as { id: number };
    addManualDividend(db, user.id, { assetId: ko.id, exDate: '2025-12-12', payDate: '2026-01-02', amount: 0.53 });
    const provider = new DividendProvider();
    const secrets = createAesBox(randomBytes(32));
    const service = new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? provider : null) });
    await service.refresh(user.id);
    expect(provider.calls.sort()).toEqual(['KO', 'TSLA']); // crypto nu are dividende
    const rows = db.prepare("SELECT ex_date, source FROM dividend_events WHERE symbol = 'KO' ORDER BY ex_date").all();
    expect(rows).toEqual([
      { ex_date: '2025-06-13', source: 'yahoo' },
      { ex_date: '2025-12-12', source: 'manual' }
    ]);
    await service.refresh(user.id, { force: true });
    expect(provider.calls).toHaveLength(2);
  });
});
