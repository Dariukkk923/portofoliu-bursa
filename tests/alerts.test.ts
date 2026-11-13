/**
 * Alertele: evaluarea fiecărui tip de condiție (cu date false), regulile de livrare (o dată / repetat,
 * pauză, interval orar, amânare) cu `now` injectat, separarea pe utilizatori și backup-ul.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlertCondition, AlertInput, User } from '@shared/types';
import { blockedBy, evaluateCondition, inTimeWindow, type AlertData, type AlertRules } from '@shared/alerts';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase } from '@main/services/transactions';
import { createBackup, restoreBackup } from '@main/services/backup';
import { createJournalEntry } from '@main/services/journal';
import { createGoal } from '@main/services/goals';
import {
  createAlert,
  createAlertFromJournal,
  deleteAlert,
  evaluateAlerts,
  listAlertEvents,
  listAlerts,
  markAlertEventsRead,
  registerEarningsSource,
  setAlertEnabled,
  snoozeAlert,
  updateAlert
} from '@main/services/alerts';

/* ---------------------------------------------------------- date false */

const TODAY = '2026-03-10';
const fake = (over: Partial<AlertData> = {}): AlertData => ({
  today: TODAY,
  quote: () => null,
  watchTarget: () => null,
  position: () => null,
  portfolio: () => null,
  benchmark: () => null,
  dividends: () => [],
  concentration: () => ({ limit: 0.2, positions: [] }),
  goal: () => null,
  journalDue: () => ({ count: 0, symbols: [] }),
  ...over
});
const ev = (c: AlertCondition, data: AlertData, state = {}) => evaluateCondition(c, data, null, state);
const q = (price: number, changePct: number | null = null) => () => ({ price, currency: 'USD', changePct });

describe('condițiile alertelor', () => {
  it('preț: peste / sub o valoare', () => {
    const above: AlertCondition = { kind: 'price', symbol: 'NVDA', direction: 'above', value: 200 };
    expect(ev(above, fake({ quote: q(201) })).hit).toBe(true);
    expect(ev(above, fake({ quote: q(199.9) })).hit).toBe(false);
    expect(ev(above, fake()).hit).toBe(false); // fără preț nu sună
    const below: AlertCondition = { kind: 'price', symbol: 'NVDA', direction: 'below', value: 100 };
    expect(ev(below, fake({ quote: q(100) })).hit).toBe(true);
    expect(ev(below, fake({ quote: q(101) })).hit).toBe(false);
  });

  it('țintă de cumpărare din watchlist', () => {
    const c: AlertCondition = { kind: 'watchlist_target', symbol: 'MSFT' };
    expect(ev(c, fake({ quote: q(380), watchTarget: () => 400 })).hit).toBe(true);
    expect(ev(c, fake({ quote: q(420), watchTarget: () => 400 })).hit).toBe(false);
    expect(ev(c, fake({ quote: q(380) })).hit).toBe(false); // fără țintă
  });

  it('mișcare zilnică în sus și în jos', () => {
    const up: AlertCondition = { kind: 'daily_move', symbol: 'TSLA', direction: 'up', pct: 5 };
    const down: AlertCondition = { kind: 'daily_move', symbol: 'TSLA', direction: 'down', pct: 5 };
    expect(ev(up, fake({ quote: q(100, 0.051) })).hit).toBe(true);
    expect(ev(up, fake({ quote: q(100, 0.04) })).hit).toBe(false);
    expect(ev(up, fake({ quote: q(100, -0.08) })).hit).toBe(false);
    expect(ev(down, fake({ quote: q(100, -0.06) })).hit).toBe(true);
    expect(ev(down, fake({ quote: q(100, null) })).hit).toBe(false);
  });

  it('profit / pierdere pe poziție, în procente și în bani', () => {
    const pos = (pct: number | null, base: number) => () => ({ symbol: 'AAPL', price: 1, currency: 'USD', baseCurrency: 'RON', unrealizedBase: base, unrealizedBasePct: pct, breakEvenPrice: 1 });
    const profitPct: AlertCondition = { kind: 'position_pnl', symbol: 'AAPL', metric: 'pct', direction: 'profit', value: 20 };
    expect(ev(profitPct, fake({ position: pos(0.2, 500) })).hit).toBe(true);
    expect(ev(profitPct, fake({ position: pos(0.19, 500) })).hit).toBe(false);
    const lossAmount: AlertCondition = { kind: 'position_pnl', symbol: 'AAPL', metric: 'amount', direction: 'loss', value: 1000 };
    expect(ev(lossAmount, fake({ position: pos(-0.3, -1200) })).hit).toBe(true);
    expect(ev(lossAmount, fake({ position: pos(-0.3, -900) })).hit).toBe(false);
    expect(ev(lossAmount, fake({ position: pos(-0.3, 1200) })).hit).toBe(false);
  });

  it('break-even: sună doar după ce poziția a fost pe minus', () => {
    const c: AlertCondition = { kind: 'break_even', symbol: 'AAPL' };
    const at = (price: number) => fake({ position: () => ({ symbol: 'AAPL', price, currency: 'USD', baseCurrency: 'RON', unrealizedBase: 0, unrealizedBasePct: 0, breakEvenPrice: 100 }) });
    // Deja pe plus de la început: nu sună.
    expect(ev(c, at(110), {}).hit).toBe(false);
    // Pe minus: se armează.
    const armed = ev(c, at(90), {});
    expect(armed.hit).toBe(false);
    expect(armed.state).toEqual({ below: true });
    // Revine la break-even: sună și se dezarmează la declanșare.
    const back = ev(c, at(100), armed.state);
    expect(back.hit).toBe(true);
    expect(back.onFire).toEqual({ below: false });
  });

  it('țintă de vânzare: profit și stop-loss', () => {
    const c: AlertCondition = { kind: 'sell_target', symbol: 'AAPL', takeProfit: 250, stopLoss: 170 };
    const tp = ev(c, fake({ quote: q(251) }));
    expect(tp.hit).toBe(true);
    expect(tp.title).toContain('profit');
    const sl = ev(c, fake({ quote: q(169) }));
    expect(sl.hit).toBe(true);
    expect(sl.title).toContain('stop-loss');
    expect(ev(c, fake({ quote: q(200) })).hit).toBe(false);
    expect(ev({ ...c, takeProfit: null }, fake({ quote: q(300) })).hit).toBe(false);
  });

  it('portofoliu: valoare și profit total', () => {
    const totals = () => ({ baseCurrency: 'RON', totalValue: 100_000, totalPnl: -2_000 });
    expect(ev({ kind: 'portfolio', metric: 'value', direction: 'above', value: 90_000 }, fake({ portfolio: totals })).hit).toBe(true);
    expect(ev({ kind: 'portfolio', metric: 'value', direction: 'above', value: 110_000 }, fake({ portfolio: totals })).hit).toBe(false);
    expect(ev({ kind: 'portfolio', metric: 'profit', direction: 'below', value: -1_000 }, fake({ portfolio: totals })).hit).toBe(true);
    expect(ev({ kind: 'portfolio', metric: 'profit', direction: 'above', value: 0 }, fake({ portfolio: totals })).hit).toBe(false);
  });

  it('piață: portofoliul în urma indicelui cu mai mult de X%', () => {
    const bench = (mine: number, index: number) => () => ({ name: 'S&P 500', portfolioReturn: mine, benchmarkReturn: index });
    const c: AlertCondition = { kind: 'benchmark_lag', range: '1Y', lagPct: 5 };
    expect(ev(c, fake({ benchmark: bench(0.05, 0.12) })).hit).toBe(true);
    expect(ev(c, fake({ benchmark: bench(0.09, 0.12) })).hit).toBe(false);
    expect(ev(c, fake({ benchmark: bench(0.2, 0.1) })).hit).toBe(false);
    expect(ev(c, fake()).hit).toBe(false);
  });

  it('dividende: ex-dividend aproape (o singură dată per eveniment) și dividend primit', () => {
    const div = (over = {}) => ({ symbol: 'KO', exDate: '2026-03-12', payDate: '2026-04-01', received: false, amountPerShare: 0.5, currency: 'USD', quantity: 10, ...over });
    const soon: AlertCondition = { kind: 'dividend', symbol: 'KO', event: 'ex_soon', daysBefore: 3 };
    const r = ev(soon, fake({ dividends: () => [div()] }));
    expect(r.hit).toBe(true);
    expect(r.onFire?.seen).toEqual(['x:KO:2026-03-12']);
    // Același eveniment, deja anunțat: nu mai sună.
    expect(ev(soon, fake({ dividends: () => [div()] }), { seen: ['x:KO:2026-03-12'] }).hit).toBe(false);
    // Prea departe, deja trecut sau fără acțiuni deținute.
    expect(ev(soon, fake({ dividends: () => [div({ exDate: '2026-03-20' })] })).hit).toBe(false);
    expect(ev(soon, fake({ dividends: () => [div({ exDate: '2026-03-09' })] })).hit).toBe(false);
    expect(ev(soon, fake({ dividends: () => [div({ quantity: 0 })] })).hit).toBe(false);
    // Alt simbol decât cel urmărit.
    expect(ev(soon, fake({ dividends: () => [div({ symbol: 'PEP' })] })).hit).toBe(false);
    expect(ev({ ...soon, symbol: null }, fake({ dividends: () => [div({ symbol: 'PEP' })] })).hit).toBe(true);

    const paid: AlertCondition = { kind: 'dividend', symbol: null, event: 'paid', daysBefore: 0 };
    const p = ev(paid, fake({ dividends: () => [div({ received: true, payDate: '2026-03-08' })] }));
    expect(p.hit).toBe(true);
    expect(ev(paid, fake({ dividends: () => [div({ received: true, payDate: '2026-02-01' })] })).hit).toBe(false);
  });

  it('concentrare: pragul din setări sau unul propriu', () => {
    const conc = () => ({ limit: 0.2, positions: [{ symbol: 'NVDA', weight: 0.35 }, { symbol: 'AAPL', weight: 0.15 }] });
    expect(ev({ kind: 'concentration', symbol: null, limitPct: null }, fake({ concentration: conc })).hit).toBe(true);
    expect(ev({ kind: 'concentration', symbol: 'AAPL', limitPct: null }, fake({ concentration: conc })).hit).toBe(false);
    expect(ev({ kind: 'concentration', symbol: 'AAPL', limitPct: 10 }, fake({ concentration: conc })).hit).toBe(true);
    expect(ev({ kind: 'concentration', symbol: 'NVDA', limitPct: 40 }, fake({ concentration: conc })).hit).toBe(false);
  });

  it('obiective: procent atins și în urma ritmului', () => {
    const goal = (over = {}) => () => ({ name: 'Casă', progress: 0.5, targetAmount: 100_000, targetDate: '2028-03-10', currentValue: 50_000, monthly: 0, annualReturn: 0, currency: 'RON', ...over });
    const progress: AlertCondition = { kind: 'goal', goalId: 1, mode: 'progress', pct: 50 };
    expect(ev(progress, fake({ goal: goal() })).hit).toBe(true);
    expect(ev(progress, fake({ goal: goal({ progress: 0.49 }) })).hit).toBe(false);
    expect(ev(progress, fake()).hit).toBe(false); // obiectiv șters

    const behind: AlertCondition = { kind: 'goal', goalId: 1, mode: 'behind', pct: null };
    // 50.000 de adăugat în 24 de luni, fără randament: ~2.083/lună necesar, depui 0.
    expect(ev(behind, fake({ goal: goal() })).hit).toBe(true);
    expect(ev(behind, fake({ goal: goal({ monthly: 2_500 }) })).hit).toBe(false);
    expect(ev(behind, fake({ goal: goal({ targetDate: null }) })).hit).toBe(false);
    expect(ev(behind, fake({ goal: goal({ progress: 1 }) })).hit).toBe(false);
    expect(ev(behind, fake({ goal: goal({ targetDate: '2026-01-01' }) })).hit).toBe(true); // data a trecut
  });

  it('jurnal: teze de revizuit', () => {
    const c: AlertCondition = { kind: 'journal_review', entryId: null };
    expect(ev(c, fake({ journalDue: () => ({ count: 2, symbols: [] }) })).hit).toBe(true);
    expect(ev(c, fake()).hit).toBe(false);
  });

  it('rezultate: fără sursă de date nu sună; cu sursă înregistrată funcționează', () => {
    const soon: AlertCondition = { kind: 'earnings', symbol: 'AAPL', event: 'soon', daysBefore: 3 };
    const published: AlertCondition = { kind: 'earnings', symbol: 'AAPL', event: 'published', daysBefore: 0 };
    expect(ev(soon, fake()).hit).toBe(false);
    expect(ev(soon, fake({ earnings: () => ({ nextDate: '2026-03-12', lastPublishedDate: null }) })).hit).toBe(true);
    expect(ev(soon, fake({ earnings: () => ({ nextDate: '2026-03-20', lastPublishedDate: null }) })).hit).toBe(false);
    expect(ev(published, fake({ earnings: () => ({ nextDate: null, lastPublishedDate: '2026-03-09' }) })).hit).toBe(true);
    expect(ev(published, fake({ earnings: () => ({ nextDate: null, lastPublishedDate: '2026-03-09' }) }), { seen: ['p:AAPL:2026-03-09'] }).hit).toBe(false);
  });
});

/* ------------------------------------------------------- reguli de livrare */

describe('regulile de livrare', () => {
  const rules = (over: Partial<AlertRules> = {}): AlertRules => ({
    enabled: true,
    repeat: 'repeat',
    minPauseMin: 60,
    windowStart: null,
    windowEnd: null,
    snoozedUntil: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    ...over
  });
  const at = (h: number, m = 0) => new Date(2026, 2, 10, h, m);

  it('dezactivată și „o dată” după declanșare', () => {
    expect(blockedBy(rules({ enabled: false }), at(12))).toBe('disabled');
    expect(blockedBy(rules({ repeat: 'once' }), at(12))).toBeNull();
    expect(blockedBy(rules({ repeat: 'once', triggerCount: 1 }), at(12))).toBe('done');
  });

  it('pauza minimă dintre declanșări', () => {
    const last = at(10).toISOString();
    expect(blockedBy(rules({ lastTriggeredAt: last }), at(10, 59))).toBe('pause');
    expect(blockedBy(rules({ lastTriggeredAt: last }), at(11, 0))).toBeNull();
    expect(blockedBy(rules({ lastTriggeredAt: last, minPauseMin: 1440 }), at(23, 59))).toBe('pause');
  });

  it('interval orar, inclusiv peste miezul nopții', () => {
    const day = rules({ windowStart: '09:00', windowEnd: '18:00' });
    expect(blockedBy(day, at(8, 59))).toBe('outside_window');
    expect(blockedBy(day, at(9, 0))).toBeNull();
    expect(blockedBy(day, at(17, 59))).toBeNull();
    expect(blockedBy(day, at(18, 0))).toBe('outside_window');
    const night = rules({ windowStart: '22:00', windowEnd: '06:00' });
    expect(blockedBy(night, at(23, 0))).toBeNull();
    expect(blockedBy(night, at(5, 59))).toBeNull();
    expect(blockedBy(night, at(12, 0))).toBe('outside_window');
    expect(inTimeWindow(null, null, at(3))).toBe(true);
  });

  it('amânarea', () => {
    const until = at(15).toISOString();
    expect(blockedBy(rules({ snoozedUntil: until }), at(14, 59))).toBe('snoozed');
    expect(blockedBy(rules({ snoozedUntil: until }), at(15, 0))).toBeNull();
  });
});

/* --------------------------------------------- baza de date: evaluare, utilizatori */

let db: Db;
let user: User;
let other: User;
const NOW = new Date(2026, 2, 10, 12, 0);
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'alerta', password: 'parola-alerta-1' });
  other = await register(db, { username: 'altcineva-a', password: 'parola-alerta-2' });
});
afterAll(() => db.close());
beforeEach(() => {
  registerEarningsSource(null);
  for (const table of ['alert_events', 'alerts', 'journal_tags', 'journal_entries', 'goals', 'transactions', 'assets', 'brokers']) db.prepare(`DELETE FROM ${table}`).run();
});

const alwaysHit: AlertData = fake({ quote: q(300) });
const priceAlert = (extra: Partial<AlertInput> = {}): AlertInput => ({ condition: { kind: 'price', symbol: 'NVDA', direction: 'above', value: 200 }, ...extra });

describe('evaluarea și livrarea', () => {
  it('„o dată”: sună o singură dată, apoi se oprește; repornirea o rearmează', () => {
    const a = createAlert(db, user.id, priceAlert({ repeat: 'once' }));
    expect(evaluateAlerts(db, user.id, NOW, alwaysHit)).toHaveLength(1);
    expect(evaluateAlerts(db, user.id, later(5), alwaysHit)).toHaveLength(0);
    expect(listAlerts(db, user.id)[0]).toMatchObject({ enabled: false, triggerCount: 1 });
    setAlertEnabled(db, user.id, a.id, true);
    expect(evaluateAlerts(db, user.id, later(10), alwaysHit)).toHaveLength(1);
  });

  it('repetat: respectă pauza minimă', () => {
    createAlert(db, user.id, priceAlert({ repeat: 'repeat', minPauseMin: 60 }));
    expect(evaluateAlerts(db, user.id, NOW, alwaysHit)).toHaveLength(1);
    expect(evaluateAlerts(db, user.id, later(30), alwaysHit)).toHaveLength(0);
    expect(evaluateAlerts(db, user.id, later(61), alwaysHit)).toHaveLength(1);
    expect(listAlertEvents(db, user.id).events).toHaveLength(2);
  });

  it('interval orar: în afara lui așteaptă, apoi sună când se deschide', () => {
    createAlert(db, user.id, priceAlert({ windowStart: '14:00', windowEnd: '16:00' }));
    expect(evaluateAlerts(db, user.id, NOW, alwaysHit)).toHaveLength(0);
    expect(evaluateAlerts(db, user.id, later(150), alwaysHit)).toHaveLength(1); // 14:30
  });

  it('amânare: nu sună cât e amânată', () => {
    const a = createAlert(db, user.id, priceAlert());
    snoozeAlert(db, user.id, a.id, 120, NOW);
    expect(evaluateAlerts(db, user.id, later(60), alwaysHit)).toHaveLength(0);
    expect(evaluateAlerts(db, user.id, later(121), alwaysHit)).toHaveLength(1);
  });

  it('nota și sunetul ajung în declanșare; condiția neîndeplinită nu sună', () => {
    createAlert(db, user.id, priceAlert({ note: 'Vinde jumătate', sound: false }));
    expect(evaluateAlerts(db, user.id, NOW, fake({ quote: q(150) }))).toHaveLength(0);
    const [fired] = evaluateAlerts(db, user.id, NOW, alwaysHit);
    expect(fired.sound).toBe(false);
    expect(fired.event.note).toBe('Vinde jumătate');
  });

  it('break-even: starea „armat” se păstrează între evaluări', () => {
    createAlert(db, user.id, { condition: { kind: 'break_even', symbol: 'AAPL' }, repeat: 'once' });
    const at = (price: number) => fake({ position: () => ({ symbol: 'AAPL', price, currency: 'USD', baseCurrency: 'RON', unrealizedBase: 0, unrealizedBasePct: 0, breakEvenPrice: 100 }) });
    expect(evaluateAlerts(db, user.id, NOW, at(110))).toHaveLength(0);
    expect(evaluateAlerts(db, user.id, later(5), at(90))).toHaveLength(0);
    expect(evaluateAlerts(db, user.id, later(10), at(100))).toHaveLength(1);
  });

  it('dividend: același eveniment nu se anunță de două ori, nici cu „repetat”', () => {
    createAlert(db, user.id, { condition: { kind: 'dividend', symbol: 'KO', event: 'ex_soon', daysBefore: 3 }, repeat: 'repeat', minPauseMin: 1 });
    const data = fake({ dividends: () => [{ symbol: 'KO', exDate: '2026-03-12', payDate: '2026-04-01', received: false, amountPerShare: 0.5, currency: 'USD', quantity: 10 }] });
    expect(evaluateAlerts(db, user.id, NOW, data)).toHaveLength(1);
    expect(evaluateAlerts(db, user.id, later(10), data)).toHaveLength(0);
  });

  it('alertele pe rezultate folosesc sursa înregistrată', () => {
    createAlert(db, user.id, { condition: { kind: 'earnings', symbol: 'AAPL', event: 'soon', daysBefore: 3 } });
    expect(evaluateAlerts(db, user.id, NOW)).toHaveLength(0); // fără sursă
    registerEarningsSource(() => ({ nextDate: '2026-03-12', lastPublishedDate: null }));
    expect(evaluateAlerts(db, user.id, NOW)).toHaveLength(1);
  });

  it('cu date reale: alerta de portofoliu sună pe valoarea calculată', () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: broker.id, date: '2025-01-10', quantity: 10, price: 200, fee: 0 });
    createAlert(db, user.id, { condition: { kind: 'portfolio', metric: 'value', direction: 'above', value: 1 } });
    createAlert(db, user.id, { condition: { kind: 'concentration', symbol: null, limitPct: 50 } });
    createAlert(db, user.id, { condition: { kind: 'journal_review', entryId: null } });
    const fired = evaluateAlerts(db, user.id, NOW);
    expect(fired.map((f) => f.event.kind).sort()).toEqual(['concentration', 'portfolio']);
  });
});

describe('validare și gestionare', () => {
  it('respinge valori greșite', () => {
    expect(() => createAlert(db, user.id, priceAlert({ condition: { kind: 'price', symbol: 'NVDA', direction: 'above', value: -1 } }))).toThrow();
    expect(() => createAlert(db, user.id, priceAlert({ condition: { kind: 'sell_target', symbol: 'A', takeProfit: null, stopLoss: null } }))).toThrow();
    expect(() => createAlert(db, user.id, priceAlert({ windowStart: '09:00', windowEnd: null }))).toThrow();
    expect(() => createAlert(db, user.id, priceAlert({ windowStart: '25:00', windowEnd: '10:00' }))).toThrow();
    expect(() => createAlert(db, user.id, priceAlert({ portfolioId: 99_999 }))).toThrow();
    expect(() => createAlert(db, user.id, { condition: { kind: 'nu-exista' } as unknown as AlertCondition })).toThrow();
  });

  it('modificarea resetează starea; ștergerea păstrează istoricul', () => {
    const a = createAlert(db, user.id, priceAlert({ repeat: 'once' }));
    evaluateAlerts(db, user.id, NOW, alwaysHit);
    const edited = updateAlert(db, user.id, a.id, priceAlert({ repeat: 'once', condition: { kind: 'price', symbol: 'NVDA', direction: 'above', value: 250 } }));
    expect(edited).toMatchObject({ triggerCount: 0, summary: expect.stringContaining('250') });
    deleteAlert(db, user.id, a.id);
    expect(listAlerts(db, user.id)).toHaveLength(0);
    expect(listAlertEvents(db, user.id).events).toHaveLength(1);
  });

  it('centrul de notificări: necitite și marcare ca citite', () => {
    createAlert(db, user.id, priceAlert({ repeat: 'repeat', minPauseMin: 1 }));
    evaluateAlerts(db, user.id, NOW, alwaysHit);
    evaluateAlerts(db, user.id, later(5), alwaysHit);
    const center = listAlertEvents(db, user.id);
    expect(center.unread).toBe(2);
    markAlertEventsRead(db, user.id, [center.events[0].id], NOW);
    expect(listAlertEvents(db, user.id).unread).toBe(1);
    markAlertEventsRead(db, user.id, null, NOW);
    expect(listAlertEvents(db, user.id).unread).toBe(0);
  });

  it('alertă dintr-o intrare din jurnal: țintă și stop-loss din plan', () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    const { transaction } = addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: broker.id, date: '2025-01-10', quantity: 10, price: 200, fee: 0 });
    const entry = createJournalEntry(db, user.id, { transactionId: transaction.id, reason: 'Servicii în creștere', targetPrice: 250, stopLoss: 170 });
    const a = createAlertFromJournal(db, user.id, entry.id as number);
    expect(a.condition).toEqual({ kind: 'sell_target', symbol: 'AAPL', takeProfit: 250, stopLoss: 170 });
    expect(a.note).toBe('Servicii în creștere');
    const noPlan = createJournalEntry(db, user.id, { transactionId: transaction.id, reason: 'doar o notă' });
    expect(() => createAlertFromJournal(db, user.id, noPlan.id as number)).toThrow();
  });
});

describe('separarea pe utilizatori', () => {
  it('alertele, declanșările și evaluarea sunt ale fiecărui utilizator', () => {
    const mine = createAlert(db, user.id, priceAlert());
    createAlert(db, other.id, priceAlert({ note: 'a altuia' }));
    expect(listAlerts(db, user.id)).toHaveLength(1);
    expect(listAlerts(db, other.id)).toHaveLength(1);

    // Evaluarea pentru un utilizator nu atinge alertele celuilalt.
    expect(evaluateAlerts(db, user.id, NOW, alwaysHit)).toHaveLength(1);
    expect(listAlertEvents(db, other.id).events).toHaveLength(0);
    expect(listAlerts(db, other.id)[0].triggerCount).toBe(0);

    // Celălalt utilizator nu poate citi, modifica, amâna sau șterge alerta mea.
    expect(() => updateAlert(db, other.id, mine.id, priceAlert())).toThrow();
    expect(() => setAlertEnabled(db, other.id, mine.id, false)).toThrow();
    expect(() => snoozeAlert(db, other.id, mine.id, 10)).toThrow();
    expect(() => deleteAlert(db, other.id, mine.id)).toThrow();
    markAlertEventsRead(db, other.id, null);
    expect(listAlertEvents(db, user.id).unread).toBe(1);
  });
});

describe('backup', () => {
  it('alertele și istoricul se restaurează, cu id-urile de obiectiv traduse', () => {
    const goal = createGoal(db, user.id, { name: 'Casă', targetAmount: 1000, targetDate: '2030-01-01' } as never);
    createAlert(db, user.id, { condition: { kind: 'goal', goalId: goal.id, mode: 'progress', pct: 50 }, note: 'obiectiv' });
    createAlert(db, user.id, priceAlert({ repeat: 'once' }));
    evaluateAlerts(db, user.id, NOW, alwaysHit);

    const dir = mkdtempSync(join(tmpdir(), 'alerte-backup-'));
    try {
      const file = join(dir, 'b.db');
      createBackup(db, user.id, file);
      db.prepare('DELETE FROM alert_events').run();
      db.prepare('DELETE FROM alerts').run();
      db.prepare('DELETE FROM goals').run();
      // Un obiectiv nou ocupă alt id: alerta restaurată trebuie să indice obiectivul restaurat.
      restoreBackup(db, user.id, file);
      const alerts = listAlerts(db, user.id);
      expect(alerts).toHaveLength(2);
      const g = db.prepare('SELECT id FROM goals WHERE user_id = ?').get(user.id) as { id: number };
      const restored = alerts.find((a) => a.condition.kind === 'goal');
      expect(restored?.condition).toMatchObject({ goalId: g.id });
      expect(restored?.summary).toContain('Casă');
      expect(listAlertEvents(db, user.id).events).toHaveLength(1);
      // Backup-ul nu conține alertele altui utilizator.
      expect(db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?').get(other.id)).toEqual({ n: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
