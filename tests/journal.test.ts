/**
 * Jurnalul de investiții: compararea planului cu vânzarea, etichetele, intrările legate de
 * tranzacții, filtrele cronologiei, mementourile de revizuire, separarea pe portofolii,
 * mutarea și backup-ul.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@shared/types';
import { comparePlan, normalizeTags } from '@shared/calc';
import { openDatabase, type Db } from '@main/db/database';
import { register } from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase, createTransaction, deleteTransaction } from '@main/services/transactions';
import { createPortfolio, listPortfolios } from '@main/services/portfolios';
import { moveTransactions } from '@main/services/portfolioMove';
import { createBackup, restoreBackup } from '@main/services/backup';
import {
  createJournalEntry,
  journalCsv,
  journalDueCount,
  journalHtml,
  journalPlanFor,
  listJournal,
  markJournalReviewed,
  updateJournalEntry
} from '@main/services/journal';
import { saveHistory } from '@main/prices/store';

describe('planul comparat cu vânzarea', () => {
  const plan = { date: '2025-01-10', targetPrice: 250, stopLoss: 150, horizonMonths: 12 };

  it('ținta atinsă înainte de vânzare, dar vândut mai jos: planul nu a fost respectat', () => {
    const closes = [
      { date: '2025-03-03', close: 240 },
      { date: '2025-04-01', close: 251 },
      { date: '2025-06-02', close: 220 }
    ];
    const r = comparePlan(plan, { date: '2025-07-15', price: 209.11 }, closes, 'USD');
    expect(r.targetHitDate).toBe('2025-04-01');
    expect(r.stopHitDate).toBeNull();
    expect(r.respected).toBe(false);
    expect(r.checks.map((c) => c.tone)).toEqual(['warn', 'ok', 'info']);
    expect(r.checks[0].text).toBe('Prețul a atins ținta de 250 USD pe 01.04.2025, dar ai vândut mai târziu, la 209,11 USD.');
    expect(r.checks[2].text).toBe('Ai vândut după 6 luni, înainte de orizontul planificat de 12 luni.');
  });

  it('vândut la țintă, după orizont: plan respectat', () => {
    const r = comparePlan(plan, { date: '2026-02-01', price: 255 }, [{ date: '2025-08-01', close: 200 }]);
    expect(r.respected).toBe(true);
    expect(r.checks.map((c) => c.text)).toEqual([
      'Ai vândut la ținta de 250 sau peste ea.',
      'Stop-loss-ul de 150 nu a fost atins.',
      'Ai păstrat poziția 13 luni; orizontul planificat era de 12 luni.'
    ]);
  });

  it('stop-loss-ul atins și vânzarea amânată', () => {
    const r = comparePlan({ ...plan, targetPrice: null, horizonMonths: null }, { date: '2025-05-20', price: 120 }, [{ date: '2025-04-07', close: 148 }]);
    expect(r.stopHitDate).toBe('2025-04-07');
    expect(r.respected).toBe(false);
    expect(r.checks[0].text).toMatch(/a coborât sub stop-loss-ul de 150 pe 07\.04\.2025, dar ai vândut abia pe 20\.05\.2025/);
    // Vândut chiar la stop-loss, fără ca prețul să fi trecut sub el înainte: respectat.
    expect(comparePlan({ ...plan, targetPrice: null, horizonMonths: null }, { date: '2025-05-20', price: 149 }, []).respected).toBe(true);
  });

  it('etichetele: fără #, unice, cel mult 10', () => {
    expect(normalizeTags(['#dividende', 'Dividende', '  termen   lung ', '', 'tech'])).toEqual(['dividende', 'termen lung', 'tech']);
    expect(normalizeTags('a, b; c')).toEqual(['a', 'b', 'c']);
    expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
});

let db: Db;
let user: User;
let other: User;
const TODAY = '2025-11-20';

beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'jurnalist', password: 'parola-jurnal-1' });
  other = await register(db, { username: 'altcineva', password: 'parola-jurnal-2' });
});
afterAll(() => db.close());
beforeEach(() => {
  for (const table of ['journal_tags', 'journal_entries', 'transactions', 'assets', 'brokers', 'price_history']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM portfolios WHERE name <> 'Principal'").run();
});

describe('jurnalul', () => {
  const setup = () => {
    const broker = createBroker(db, user.id, { name: 'XTB' });
    const { asset, transaction: buy } = addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'AAPL', currency: 'USD' }, brokerId: broker.id, date: '2025-01-10', quantity: 10, price: 200, fee: 0 });
    const entry = createJournalEntry(
      db,
      user.id,
      { transactionId: buy.id, reason: 'iPhone nou, servicii în creștere', targetPrice: 250, stopLoss: 170, horizonMonths: 12, confidence: 4, tags: ['#tech', 'termen lung'], reviewInMonths: 3 },
      '2025-01-10'
    );
    return { broker, asset, buy, entry };
  };

  it('o intrare la cumpărare ia activul, portofoliul și data tranzacției', () => {
    const { entry } = setup();
    expect(entry).toMatchObject({ kind: 'buy', date: '2025-01-10', symbol: 'AAPL', portfolioName: 'Principal', targetPrice: 250, stopLoss: 170, confidence: 4, reviewDate: '2025-04-10' });
    expect(entry.tags).toEqual(['tech', 'termen lung']);
    expect(entry.trade).toEqual({ type: 'buy', quantity: 10, price: 200 });
  });

  it('validează planul și cere măcar motivul sau un element al planului', () => {
    const { asset } = setup();
    expect(() => createJournalEntry(db, user.id, { assetId: asset.id, targetPrice: 100, stopLoss: 120 })).toThrow(/sub prețul țintă/);
    expect(() => createJournalEntry(db, user.id, { assetId: asset.id, confidence: 7 })).toThrow(/de la 1 la 5/);
    expect(() => createJournalEntry(db, user.id, { assetId: asset.id, horizonMonths: 5 })).toThrow(/Orizontul/);
    expect(() => createJournalEntry(db, user.id, { assetId: asset.id, reason: '   ' })).toThrow(/motivul/);
    // Celălalt utilizator nu poate scrie în jurnal pe activul meu.
    expect(() => createJournalEntry(db, other.id, { assetId: asset.id, reason: 'x' })).toThrow(/Activul nu a fost găsit/);
  });

  it('la vânzare, planul apare lângă rezultatul real (și fără notă la vânzare)', () => {
    const { asset, broker } = setup();
    saveHistory(db, user.id, 'AAPL', [{ date: '2025-04-01', close: 252 }, { date: '2025-06-02', close: 215 }], true, 'yahoo');
    const sell = createTransaction(db, user.id, { assetId: asset.id, brokerId: broker.id, type: 'sell', date: '2025-07-15', quantity: 4, price: 210, fee: 0 });
    let list = listJournal(db, user.id, {}, TODAY);
    const sale = list.entries.find((e) => e.kind === 'sell')!;
    expect(sale).toMatchObject({ key: `s:${sell.id}`, id: null, symbol: 'AAPL' });
    expect(sale.outcome).toMatchObject({ salePrice: 210, quantity: 4, gain: 40, respected: false });
    expect(sale.outcome!.gainPct).toBeCloseTo(0.05, 10);
    expect(sale.outcome!.plan).toMatchObject({ targetPrice: 250, stopLoss: 170, horizonMonths: 12, reason: 'iPhone nou, servicii în creștere' });

    // Cu notă la vânzare, intrarea salvată poartă comparația (și vânzarea nu mai apare de două ori).
    createJournalEntry(db, user.id, { transactionId: sell.id, reason: 'Am avut nevoie de bani' }, TODAY);
    list = listJournal(db, user.id, {}, TODAY);
    const sells = list.entries.filter((e) => e.kind === 'sell');
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ reason: 'Am avut nevoie de bani', trade: { type: 'sell', quantity: 4, price: 210 } });
    expect(sells[0].outcome?.respected).toBe(false);
    expect(journalPlanFor(db, user.id, null, asset.id, TODAY)?.targetPrice).toBe(250);
  });

  it('cronologia: căutare și filtre după simbol, etichetă și perioadă', () => {
    const { broker } = setup();
    const { asset: ko } = addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'KO', currency: 'USD' }, brokerId: broker.id, date: '2025-05-02', quantity: 5, price: 60, fee: 0 });
    createJournalEntry(db, user.id, { assetId: ko.id, date: '2025-05-02', reason: 'Dividend stabil', tags: ['dividende'] }, TODAY);
    expect(listJournal(db, user.id, {}, TODAY).entries.map((e) => e.symbol)).toEqual(['KO', 'AAPL']);
    expect(listJournal(db, user.id, { symbol: 'AAPL' }, TODAY).entries).toHaveLength(1);
    expect(listJournal(db, user.id, { tag: 'DIVIDENDE' }, TODAY).entries.map((e) => e.symbol)).toEqual(['KO']);
    expect(listJournal(db, user.id, { from: '2025-03-01', to: '2025-12-31' }, TODAY).entries.map((e) => e.symbol)).toEqual(['KO']);
    expect(listJournal(db, user.id, { search: 'iphone' }, TODAY).entries.map((e) => e.symbol)).toEqual(['AAPL']);
    expect(listJournal(db, user.id, {}, TODAY).tags).toEqual(['dividende', 'tech', 'termen lung']);
  });

  it('mementoul de revizuire: la termen apare, „revizuit” îl închide sau îl mută', () => {
    const { entry } = setup();
    expect(journalDueCount(db, user.id, '2025-04-09')).toBe(0);
    expect(journalDueCount(db, user.id, '2025-04-10')).toBe(1);
    expect(listJournal(db, user.id, {}, '2025-04-10').dueReviews.map((e) => e.id)).toEqual([entry.id]);
    expect(markJournalReviewed(db, user.id, entry.id!, 6, '2025-04-12')).toMatchObject({ reviewDate: '2025-10-12', reviewedAt: null });
    expect(journalDueCount(db, user.id, '2025-04-12')).toBe(0);
    expect(markJournalReviewed(db, user.id, entry.id!, null, '2025-10-12').reviewedAt).not.toBeNull();
    expect(journalDueCount(db, user.id, '2026-01-01')).toBe(0);
    // Editarea cu o dată nouă de revizuire repornește mementoul.
    expect(updateJournalEntry(db, user.id, entry.id!, { reason: 'Teză reconfirmată', reviewDate: '2026-03-01', targetPrice: 260 }, TODAY)).toMatchObject({
      reviewDate: '2026-03-01',
      reviewedAt: null,
      targetPrice: 260,
      stopLoss: null
    });
  });

  it('pe portofolii: filtrul, mutarea tranzacției și ștergerea ei', () => {
    const { buy, entry } = setup();
    const second = createPortfolio(db, user.id, { name: 'Pensie' });
    const main = listPortfolios(db, user.id).find((p) => p.name === 'Principal')!;
    expect(listJournal(db, user.id, { portfolioId: second.id }, TODAY).entries).toHaveLength(0);
    moveTransactions(db, user.id, [buy.id], second.id, { moveCash: false });
    expect(listJournal(db, user.id, { portfolioId: second.id }, TODAY).entries.map((e) => e.id)).toEqual([entry.id]);
    expect(listJournal(db, user.id, { portfolioId: main.id }, TODAY).entries).toHaveLength(0);
    deleteTransaction(db, user.id, buy.id);
    const [kept] = listJournal(db, user.id, {}, TODAY).entries;
    expect(kept).toMatchObject({ id: entry.id, transactionId: null, trade: null, reason: 'iPhone nou, servicii în creștere' });
    expect(listJournal(db, other.id, {}, TODAY).entries).toHaveLength(0);
  });

  it('backup-ul păstrează intrările, etichetele și legătura cu tranzacțiile', () => {
    const { entry } = setup();
    const dir = mkdtempSync(join(tmpdir(), 'jurnal-test-'));
    try {
      createBackup(db, user.id, join(dir, 'b.db'));
      restoreBackup(db, user.id, join(dir, 'b.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const [restored] = listJournal(db, user.id, {}, TODAY).entries;
    expect(restored.id).not.toBe(entry.id);
    expect(restored).toMatchObject({ kind: 'buy', reason: 'iPhone nou, servicii în creștere', tags: ['tech', 'termen lung'], trade: { type: 'buy', quantity: 10, price: 200 } });
  });

  it('exportul CSV și documentul pentru PDF', () => {
    setup();
    const list = listJournal(db, user.id, {}, TODAY);
    const csv = journalCsv(list);
    expect(csv.startsWith('﻿Data;Tip;Portofoliu;Simbol;')).toBe(true);
    expect(csv).toContain('2025-01-10;Cumpărare;Principal;AAPL;');
    expect(csv).toContain(';250;170;1 an;4;tech, termen lung;2025-04-10;');
    const html = journalHtml(list, 'Jurnal de investiții');
    expect(html).toContain('iPhone nou, servicii în creștere');
    expect(html).toContain('#tech');
    expect(html).not.toMatch(/<script/i);
  });
});
