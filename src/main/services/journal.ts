/**
 * Jurnalul de investiții: la o cumpărare, la o vânzare sau oricând pe o poziție, utilizatorul
 * notează motivul deciziei, planul (preț țintă, stop-loss, orizont), încrederea (1–5) și etichete,
 * cu un memento opțional de revizuire a tezei. La vânzare, planul inițial apare lângă rezultatul
 * real. Cronologia are căutare, filtre și export PDF/CSV.
 */
import {
  JOURNAL_HORIZONS,
  type Asset,
  type JournalEntry,
  type JournalEntryInput,
  type JournalFilters,
  type JournalKind,
  type JournalList,
  type JournalOutcome,
  type TransactionType
} from '@shared/types';
import { addMonths, isIsoDate, todayIso } from '@shared/dates';
import { toCsv } from '@shared/csv';
import { comparePlan, Ledger, normalizeTags, priceMultiplier, type SaleRecord } from '@shared/calc';
import { toNum } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { assert, rowToTransaction } from './common';
import { listAssets } from './assets';
import { getSettings } from './settings';
import { resolvePortfolioId, resolveScope } from './portfolios';
import { allLedgerTxs } from './portfolio';
import { loadHistory, type HistoryRow } from '../prices/store';

interface EntryRow {
  id: number;
  portfolio_id: number;
  asset_id: number;
  transaction_id: number | null;
  kind: JournalKind;
  date: string;
  reason: string;
  target_price: string | null;
  stop_loss: string | null;
  horizon_months: number | null;
  confidence: number | null;
  review_date: string | null;
  reviewed_at: string | null;
}

const MAX_REASON = 2000;

const positiveOrNull = (value: unknown, label: string): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  assert(Number.isFinite(n) && n > 0, `${label} trebuie să fie un număr mai mare decât zero.`);
  return n;
};

interface CleanInput {
  reason: string;
  targetPrice: number | null;
  stopLoss: number | null;
  horizonMonths: number | null;
  confidence: number | null;
  tags: string[];
  reviewDate: string | null;
}

function clean(input: JournalEntryInput, today: string): CleanInput {
  const reason = String(input.reason ?? '').trim().slice(0, MAX_REASON);
  const targetPrice = positiveOrNull(input.targetPrice, 'Prețul țintă');
  const stopLoss = positiveOrNull(input.stopLoss, 'Stop-loss-ul');
  if (targetPrice !== null && stopLoss !== null) assert(stopLoss < targetPrice, 'Stop-loss-ul trebuie să fie sub prețul țintă.');
  const horizonMonths = input.horizonMonths == null ? null : Number(input.horizonMonths);
  assert(horizonMonths === null || (JOURNAL_HORIZONS as readonly number[]).includes(horizonMonths), 'Orizontul de timp nu este valid.');
  const confidence = input.confidence == null ? null : Number(input.confidence);
  assert(confidence === null || (Number.isInteger(confidence) && confidence >= 1 && confidence <= 5), 'Încrederea se notează de la 1 la 5.');
  const tags = normalizeTags(input.tags ?? []);
  let reviewDate: string | null = null;
  if (input.reviewDate) {
    assert(isIsoDate(input.reviewDate), 'Data revizuirii nu este validă.');
    reviewDate = String(input.reviewDate);
  } else if (input.reviewInMonths) {
    const m = Number(input.reviewInMonths);
    assert(Number.isInteger(m) && m >= 1 && m <= 60, 'Mementoul de revizuire nu este valid.');
    reviewDate = addMonths(today, m);
  }
  assert(
    reason || targetPrice !== null || stopLoss !== null || horizonMonths !== null || confidence !== null || tags.length > 0,
    'Scrie motivul deciziei sau completează planul.'
  );
  return { reason, targetPrice, stopLoss, horizonMonths, confidence, tags, reviewDate };
}

function saveTags(db: Db, userId: number, entryId: number, tags: string[]): void {
  db.prepare('DELETE FROM journal_tags WHERE entry_id = ? AND user_id = ?').run(entryId, userId);
  const insert = db.prepare('INSERT OR IGNORE INTO journal_tags (entry_id, user_id, tag) VALUES (?, ?, ?)');
  for (const t of tags) insert.run(entryId, userId, t);
}

/** O intrare nouă: legată de o tranzacție (cumpărare/vânzare) sau o notă pe o poziție. */
export function createJournalEntry(db: Db, userId: number, input: JournalEntryInput, today: string = todayIso()): JournalEntry {
  const data = clean(input, today);
  let portfolioId: number;
  let assetId: number;
  let kind: JournalKind = 'note';
  let date = input.date && isIsoDate(input.date) ? String(input.date) : today;
  let transactionId: number | null = null;
  if (input.transactionId != null) {
    const row = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(Number(input.transactionId), userId) as Record<string, unknown> | undefined;
    assert(row, 'Tranzacția nu a fost găsită.');
    const tx = rowToTransaction(row);
    assert(tx.assetId != null && tx.portfolioId != null, 'Jurnalul se ține doar pentru tranzacțiile cu un activ.');
    transactionId = tx.id;
    assetId = tx.assetId;
    portfolioId = tx.portfolioId;
    kind = tx.type === 'buy' ? 'buy' : tx.type === 'sell' ? 'sell' : 'note';
    date = tx.date;
  } else {
    assert(input.assetId != null, 'Alege poziția la care se referă nota.');
    const asset = listAssets(db, userId).find((a) => a.id === Number(input.assetId));
    assert(asset, 'Activul nu a fost găsit.');
    assetId = asset.id;
    portfolioId = resolvePortfolioId(db, userId, input.portfolioId ?? null);
  }
  const info = db
    .prepare(
      `INSERT INTO journal_entries (user_id, portfolio_id, asset_id, transaction_id, kind, date, reason, target_price, stop_loss, horizon_months, confidence, review_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      portfolioId,
      assetId,
      transactionId,
      kind,
      date,
      data.reason,
      data.targetPrice === null ? null : String(data.targetPrice),
      data.stopLoss === null ? null : String(data.stopLoss),
      data.horizonMonths,
      data.confidence,
      data.reviewDate
    );
  const id = Number(info.lastInsertRowid);
  saveTags(db, userId, id, data.tags);
  return getJournalEntry(db, userId, id, today);
}

/** Modifică motivul, planul, încrederea, etichetele și mementoul (activul și tranzacția rămân). */
export function updateJournalEntry(db: Db, userId: number, id: number, input: JournalEntryInput, today: string = todayIso()): JournalEntry {
  const row = db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').get(id, userId) as EntryRow | undefined;
  assert(row, 'Intrarea din jurnal nu a fost găsită.');
  const data = clean(input, today);
  const date = row.transaction_id == null && input.date && isIsoDate(input.date) ? String(input.date) : row.date;
  db.prepare(
    `UPDATE journal_entries SET date = ?, reason = ?, target_price = ?, stop_loss = ?, horizon_months = ?, confidence = ?, review_date = ?,
       reviewed_at = CASE WHEN ? IS NOT NULL AND (review_date IS NULL OR review_date <> ?) THEN NULL ELSE reviewed_at END,
       updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).run(
    date,
    data.reason,
    data.targetPrice === null ? null : String(data.targetPrice),
    data.stopLoss === null ? null : String(data.stopLoss),
    data.horizonMonths,
    data.confidence,
    data.reviewDate,
    data.reviewDate,
    data.reviewDate,
    id,
    userId
  );
  saveTags(db, userId, id, data.tags);
  return getJournalEntry(db, userId, id, today);
}

export function deleteJournalEntry(db: Db, userId: number, id: number): void {
  const info = db.prepare('DELETE FROM journal_entries WHERE id = ? AND user_id = ?').run(id, userId);
  assert(info.changes === 1, 'Intrarea din jurnal nu a fost găsită.');
}

/** Teza a fost revizuită; opțional, următoarea revizuire peste câteva luni. */
export function markJournalReviewed(db: Db, userId: number, id: number, nextInMonths: number | null, today: string = todayIso()): JournalEntry {
  const row = db.prepare('SELECT id FROM journal_entries WHERE id = ? AND user_id = ?').get(id, userId);
  assert(row, 'Intrarea din jurnal nu a fost găsită.');
  if (nextInMonths) {
    const m = Number(nextInMonths);
    assert(Number.isInteger(m) && m >= 1 && m <= 60, 'Mementoul de revizuire nu este valid.');
    db.prepare("UPDATE journal_entries SET review_date = ?, reviewed_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(addMonths(today, m), id, userId);
  } else {
    db.prepare("UPDATE journal_entries SET reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(id, userId);
  }
  return getJournalEntry(db, userId, id, today);
}

/* ------------------------------------------------------------ citire */

interface Context {
  assets: Map<number, Asset>;
  portfolioNames: Map<number, string>;
  tagsOf: Map<number, string[]>;
  trades: Map<number, { type: TransactionType; quantity: number; price: number; date: string; portfolioId: number | null; assetId: number | null }>;
  sales: Map<number, SaleRecord>;
  closes: Map<string, HistoryRow[]>;
}

function loadContext(db: Db, userId: number, rows: EntryRow[], extraSellIds: number[] = []): Context {
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const portfolioNames = new Map(
    (db.prepare('SELECT id, name FROM portfolios WHERE user_id = ?').all(userId) as { id: number; name: string }[]).map((p) => [p.id, p.name])
  );
  const tagsOf = new Map<number, string[]>();
  for (const t of db.prepare('SELECT entry_id, tag FROM journal_tags WHERE user_id = ? ORDER BY tag').all(userId) as { entry_id: number; tag: string }[]) {
    tagsOf.set(t.entry_id, [...(tagsOf.get(t.entry_id) ?? []), t.tag]);
  }
  const txIds = [...new Set([...rows.map((r) => r.transaction_id).filter((x): x is number => x != null), ...extraSellIds])];
  const trades: Context['trades'] = new Map();
  if (txIds.length > 0) {
    for (const r of db.prepare(`SELECT * FROM transactions WHERE user_id = ? AND id IN (${txIds.map(() => '?').join(',')})`).all(userId, ...txIds) as Record<string, unknown>[]) {
      const t = rowToTransaction(r);
      trades.set(t.id, { type: t.type, quantity: t.quantity, price: t.price, date: t.date, portfolioId: t.portfolioId, assetId: t.assetId });
    }
  }
  // Rezultatul vânzărilor (după metoda de cost din setări) și prețurile pentru comparația cu planul.
  const sales = new Map<number, SaleRecord>();
  const sold = [...trades.values()].filter((t) => t.type === 'sell');
  if (sold.length > 0) {
    const ledger = new Ledger({
      method: getSettings(db, userId).costMethod,
      multiplierOf: (id) => {
        const a = assets.get(id);
        return a ? priceMultiplier(a) : 1;
      },
      currencyOf: (id) => assets.get(id)?.currency,
      strict: false
    }).applyAll(allLedgerTxs(db, userId));
    for (const s of ledger.sales()) sales.set(s.txId, s);
  }
  const symbols = [...new Set(sold.map((t) => (t.assetId != null ? assets.get(t.assetId)?.symbol : undefined)).filter((s): s is string => !!s))];
  return { assets, portfolioNames, tagsOf, trades, sales, closes: loadHistory(db, userId, symbols) };
}

const parseNum = (v: string | null): number | null => (v === null ? null : Number(v));

/** Planul în vigoare la o dată: ultima intrare (cumpărare sau notă) cu țintă, stop-loss sau orizont, pe același activ. */
function planRow(db: Db, userId: number, portfolioId: number, assetId: number, onOrBefore: string): EntryRow | null {
  const sql = `SELECT * FROM journal_entries WHERE user_id = ? AND asset_id = ? AND kind IN ('buy', 'note') AND date <= ?
               AND (target_price IS NOT NULL OR stop_loss IS NOT NULL OR horizon_months IS NOT NULL) %P
               ORDER BY date DESC, id DESC LIMIT 1`;
  const same = db.prepare(sql.replace('%P', 'AND portfolio_id = ?')).get(userId, assetId, onOrBefore, portfolioId) as EntryRow | undefined;
  if (same) return same;
  return (db.prepare(sql.replace('%P', '')).get(userId, assetId, onOrBefore) as EntryRow | undefined) ?? null;
}

function outcomeFor(db: Db, userId: number, ctx: Context, txId: number): JournalOutcome | null {
  const trade = ctx.trades.get(txId);
  if (!trade || trade.type !== 'sell' || trade.assetId == null || trade.portfolioId == null) return null;
  const plan = planRow(db, userId, trade.portfolioId, trade.assetId, trade.date);
  if (!plan) return null;
  const asset = ctx.assets.get(trade.assetId);
  const sale = ctx.sales.get(txId);
  const cmp = comparePlan(
    { date: plan.date, targetPrice: parseNum(plan.target_price), stopLoss: parseNum(plan.stop_loss), horizonMonths: plan.horizon_months },
    { date: trade.date, price: trade.price },
    asset ? (ctx.closes.get(asset.symbol) ?? []) : [],
    asset?.currency ?? ''
  );
  const gain = sale ? toNum(sale.gain) : null;
  const gainPct = sale && sale.cost.gt(0) ? toNum(sale.gain.div(sale.cost)) : null;
  return {
    plan: {
      entryId: plan.id,
      date: plan.date,
      reason: plan.reason,
      targetPrice: parseNum(plan.target_price),
      stopLoss: parseNum(plan.stop_loss),
      horizonMonths: plan.horizon_months,
      confidence: plan.confidence
    },
    saleDate: trade.date,
    salePrice: trade.price,
    quantity: sale ? toNum(sale.quantity) : trade.quantity,
    gain,
    gainPct,
    heldDays: cmp.heldDays,
    checks: cmp.checks,
    respected: cmp.respected
  };
}

function toEntry(db: Db, userId: number, ctx: Context, r: EntryRow): JournalEntry {
  const asset = ctx.assets.get(r.asset_id);
  const trade = r.transaction_id != null ? ctx.trades.get(r.transaction_id) : undefined;
  return {
    key: `e:${r.id}`,
    id: r.id,
    portfolioId: r.portfolio_id,
    portfolioName: ctx.portfolioNames.get(r.portfolio_id) ?? '—',
    assetId: r.asset_id,
    symbol: asset?.symbol ?? '—',
    name: asset?.name ?? '',
    assetType: asset?.type ?? 'stock',
    currency: asset?.currency ?? '',
    transactionId: r.transaction_id,
    kind: r.kind,
    date: r.date,
    reason: r.reason,
    targetPrice: parseNum(r.target_price),
    stopLoss: parseNum(r.stop_loss),
    horizonMonths: r.horizon_months,
    confidence: r.confidence,
    tags: ctx.tagsOf.get(r.id) ?? [],
    reviewDate: r.review_date,
    reviewedAt: r.reviewed_at,
    trade: trade ? { type: trade.type, quantity: trade.quantity, price: trade.price } : null,
    outcome: r.kind === 'sell' && r.transaction_id != null ? outcomeFor(db, userId, ctx, r.transaction_id) : null
  };
}

export function getJournalEntry(db: Db, userId: number, id: number, _today: string = todayIso()): JournalEntry {
  const row = db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').get(id, userId) as EntryRow | undefined;
  assert(row, 'Intrarea din jurnal nu a fost găsită.');
  return toEntry(db, userId, loadContext(db, userId, [row]), row);
}

/** Planul în vigoare pentru o poziție (pentru formularul de vânzare): ultima intrare cu țintă, stop-loss sau orizont. */
export function journalPlanFor(db: Db, userId: number, portfolioId: number | null, assetId: number, today: string = todayIso()): JournalEntry | null {
  const pid = portfolioId ?? resolvePortfolioId(db, userId, null);
  const row = planRow(db, userId, pid, Number(assetId), today);
  return row ? toEntry(db, userId, loadContext(db, userId, [row]), row) : null;
}

/** Câte teze sunt de revizuit acum (în portofoliile active). */
export function journalDueCount(db: Db, userId: number, today: string = todayIso()): number {
  const ids = [...resolveScope(db, userId, null).ids];
  if (ids.length === 0) return 0;
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE user_id = ? AND review_date <= ? AND reviewed_at IS NULL AND portfolio_id IN (${ids.map(() => '?').join(',')})`)
      .get(userId, today, ...ids) as { n: number }
  ).n;
}

/** Cronologia jurnalului (cele mai noi întâi), cu filtre; include vânzările care au un plan, chiar fără notă la vânzare. */
export function listJournal(db: Db, userId: number, filters: JournalFilters = {}, today: string = todayIso()): JournalList {
  const scope = resolveScope(db, userId, filters.portfolioId);
  const ids = [...scope.ids];
  if (ids.length === 0) return { entries: [], tags: [], symbols: [], dueReviews: [] };
  const inList = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM journal_entries WHERE user_id = ? AND portfolio_id IN (${inList}) ORDER BY date DESC, id DESC`).all(userId, ...ids) as EntryRow[];

  // Vânzările din aceleași portofolii fără notă de vânzare, dar cu un plan anterior: apar pentru „plan vs. rezultat”.
  const linkedSells = new Set(rows.filter((r) => r.kind === 'sell' && r.transaction_id != null).map((r) => r.transaction_id as number));
  const planned = new Set(rows.filter((r) => r.target_price !== null || r.stop_loss !== null || r.horizon_months !== null).map((r) => r.asset_id));
  const sellRows =
    planned.size > 0
      ? (db
          .prepare(`SELECT id, asset_id, portfolio_id, date FROM transactions WHERE user_id = ? AND type = 'sell' AND portfolio_id IN (${inList}) AND asset_id IN (${[...planned].map(() => '?').join(',')})`)
          .all(userId, ...ids, ...planned) as { id: number; asset_id: number; portfolio_id: number; date: string }[])
      : [];
  const extraSells = sellRows.filter((s) => !linkedSells.has(s.id));
  const ctx = loadContext(db, userId, rows, extraSells.map((s) => s.id));

  const entries: JournalEntry[] = rows.map((r) => toEntry(db, userId, ctx, r));
  for (const s of extraSells) {
    const outcome = outcomeFor(db, userId, ctx, s.id);
    if (!outcome) continue;
    const asset = ctx.assets.get(s.asset_id);
    const trade = ctx.trades.get(s.id);
    entries.push({
      key: `s:${s.id}`,
      id: null,
      portfolioId: s.portfolio_id,
      portfolioName: ctx.portfolioNames.get(s.portfolio_id) ?? '—',
      assetId: s.asset_id,
      symbol: asset?.symbol ?? '—',
      name: asset?.name ?? '',
      assetType: asset?.type ?? 'stock',
      currency: asset?.currency ?? '',
      transactionId: s.id,
      kind: 'sell',
      date: s.date,
      reason: '',
      targetPrice: null,
      stopLoss: null,
      horizonMonths: null,
      confidence: null,
      tags: [],
      reviewDate: null,
      reviewedAt: null,
      trade: trade ? { type: 'sell', quantity: trade.quantity, price: trade.price } : null,
      outcome
    });
  }
  entries.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : (b.id ?? 0) - (a.id ?? 0)));

  const dueReviews = entries.filter((e) => e.id !== null && e.reviewDate !== null && e.reviewDate <= today && e.reviewedAt === null).reverse();
  const tags = [...new Set(entries.flatMap((e) => e.tags))].sort((a, b) => a.localeCompare(b, 'ro'));
  const symbols = [...new Set(entries.map((e) => e.symbol))].sort();

  const search = (filters.search ?? '').trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (filters.symbol && e.symbol !== filters.symbol) return false;
    if (filters.tag && !e.tags.some((t) => t.toLowerCase() === String(filters.tag).toLowerCase())) return false;
    if (filters.from && e.date < filters.from) return false;
    if (filters.to && e.date > filters.to) return false;
    if (search) {
      const text = [e.symbol, e.name, e.reason, ...e.tags, e.outcome?.plan.reason ?? ''].join(' ').toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });
  return { entries: filtered, tags, symbols, dueReviews };
}

/* ------------------------------------------------------------ export */

const KIND_LABEL: Record<JournalKind, string> = { buy: 'Cumpărare', sell: 'Vânzare', note: 'Notă' };
const horizonText = (m: number | null): string => (m === null ? '' : m < 12 ? `${m} ${m === 1 ? 'lună' : 'luni'}` : `${m / 12} ${m === 12 ? 'an' : 'ani'}`);
const csvNum = (v: number | null): string => (v === null ? '' : String(Number(v.toFixed(6))).replace('.', ','));

export function journalCsv(list: JournalList): string {
  const rows: (string | number | null)[][] = [
    ['Data', 'Tip', 'Portofoliu', 'Simbol', 'Denumire', 'Motiv', 'Preț țintă', 'Stop-loss', 'Orizont', 'Încredere (1-5)', 'Etichete', 'Revizuire', 'Cantitate', 'Preț', 'Rezultat vânzare', 'Plan respectat', 'Comparație cu planul']
  ];
  for (const e of list.entries) {
    rows.push([
      e.date,
      KIND_LABEL[e.kind],
      e.portfolioName,
      e.symbol,
      e.name,
      e.reason,
      csvNum(e.targetPrice),
      csvNum(e.stopLoss),
      horizonText(e.horizonMonths),
      e.confidence ?? '',
      e.tags.join(', '),
      e.reviewDate ?? '',
      e.trade ? csvNum(e.trade.quantity) : '',
      e.trade ? csvNum(e.trade.price) : '',
      e.outcome?.gain != null ? csvNum(Number(e.outcome.gain.toFixed(2))) : '',
      e.outcome ? (e.outcome.respected ? 'da' : 'nu') : '',
      e.outcome ? e.outcome.checks.map((c) => c.text).join(' ') : ''
    ]);
  }
  return `﻿${toCsv(rows, ';')}`;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDay = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const fmtNum = (v: number): string => v.toLocaleString('ro-RO', { maximumFractionDigits: 4 });

/** Documentul HTML din care se face PDF-ul jurnalului (fără scripturi, fără resurse externe). */
export function journalHtml(list: JournalList, title: string, generatedAt: Date = new Date()): string {
  const items = list.entries
    .map((e) => {
      const plan = [
        e.targetPrice !== null ? `Țintă ${fmtNum(e.targetPrice)} ${e.currency}` : '',
        e.stopLoss !== null ? `Stop-loss ${fmtNum(e.stopLoss)} ${e.currency}` : '',
        e.horizonMonths !== null ? `Orizont ${horizonText(e.horizonMonths)}` : '',
        e.confidence !== null ? `Încredere ${e.confidence}/5` : ''
      ].filter(Boolean);
      const outcome = e.outcome
        ? `<div class="outcome ${e.outcome.respected ? 'ok' : 'warn'}"><b>Plan vs. rezultat</b> (planul din ${fmtDay(e.outcome.plan.date)}): ${
            e.outcome.gain !== null ? `rezultat ${fmtNum(Number(e.outcome.gain.toFixed(2)))} ${e.currency}${e.outcome.gainPct !== null ? ` (${(e.outcome.gainPct * 100).toFixed(1).replace('.', ',')}%)` : ''}. ` : ''
          }${e.outcome.checks.map((c) => esc(c.text)).join(' ')}</div>`
        : '';
      return `<div class="item">
        <div class="head"><span class="date">${fmtDay(e.date)}</span><span class="kind">${KIND_LABEL[e.kind]}</span><b>${esc(e.symbol)}</b> <span class="muted">${esc(e.name)} · ${esc(e.portfolioName)}</span>
        ${e.trade ? `<span class="muted">· ${fmtNum(e.trade.quantity)} × ${fmtNum(e.trade.price)} ${e.currency}</span>` : ''}</div>
        ${e.reason ? `<p>${esc(e.reason).replace(/\n/g, '<br>')}</p>` : ''}
        ${plan.length ? `<p class="plan">${plan.map(esc).join(' · ')}</p>` : ''}
        ${e.tags.length ? `<p class="tags">${e.tags.map((t) => `#${esc(t)}`).join(' ')}</p>` : ''}
        ${outcome}
      </div>`;
    })
    .join('');
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1d2433; font-size: 11px; margin: 0; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .muted { color: #5b6476; }
  .item { border-bottom: 1px solid #e3e6ec; padding: 8px 0; break-inside: avoid; }
  .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .date { font-variant-numeric: tabular-nums; color: #5b6476; min-width: 70px; }
  .kind { font-size: 9.5px; font-weight: 600; background: #eef1f6; border-radius: 4px; padding: 1px 6px; }
  p { margin: 4px 0 0 78px; }
  .plan { color: #3a4356; }
  .tags { color: #2f6fdf; }
  .outcome { margin: 6px 0 0 78px; padding: 6px 8px; border-radius: 6px; background: #f2f8f3; }
  .outcome.warn { background: #fff6e5; }
</style></head><body>
  <h1>${esc(title)}</h1>
  <p class="muted" style="margin-left:0">${list.entries.length} ${list.entries.length === 1 ? 'intrare' : 'intrări'} · generat la ${fmtDay(generatedAt.toISOString().slice(0, 10))}</p>
  ${items || '<p style="margin-left:0">Nicio intrare.</p>'}
</body></html>`;
}

