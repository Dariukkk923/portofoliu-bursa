/**
 * Alertele personalizate: creare și gestionare, evaluare după fiecare actualizare de prețuri
 * și istoricul declanșărilor (centrul de notificări).
 *
 * Condițiile se evaluează în `shared/alerts.ts`, pe datele din serviciile existente (portofoliu,
 * watchlist, dividende, obiective, jurnal): aici doar le adunăm, o singură dată pe evaluare și doar
 * pentru tipurile de care au nevoie alertele active. Totul este al utilizatorului (`user_id`).
 */
import {
  type AlertCenter,
  type AlertCondition,
  type AlertEventView,
  type AlertInput,
  type AlertRepeat,
  type AlertState,
  type AlertSymbol,
  type AlertView,
  type HistoryRange
} from '@shared/types';
import { todayIso } from '@shared/dates';
import {
  blockedBy,
  describeCondition,
  evaluateCondition,
  type AlertData,
  type DividendSnap,
  type EarningsSnap,
  type GoalSnap,
  type PositionSnap
} from '@shared/alerts';
import type { Db } from '../db/database';
import { assert } from './common';
import { listAssets, normalizeSymbol } from './assets';
import { getSettings } from './settings';
import { getPortfolio, resolveScope } from './portfolios';
import { getOverview, getPerformance } from './portfolio';
import { getDividendCalendar } from './dividends';
import { listGoals } from './goals';
import { journalDueCount, getJournalEntry } from './journal';
import { quoteOf } from './watchlist';
import { getCachedPrices, loadHistory } from '../prices/store';

/** Cel mult atâtea declanșări păstrate în istoric, per utilizator. */
const MAX_EVENTS = 200;
const MAX_NOTE = 300;
const RANGES: readonly HistoryRange[] = ['1M', '3M', '6M', '1Y', 'ALL'];

/* ------------------------------------------------------- sursa pentru rezultate */

export type EarningsSource = (symbol: string, today: string) => EarningsSnap | null;
let earningsSource: EarningsSource | null = null;

/**
 * Punct de extensie pentru alertele „Rezultatele companiei”: ramura care aduce datele despre
 * rezultate își înregistrează aici sursa. Până atunci, alertele de tip `earnings` nu se declanșează.
 */
export function registerEarningsSource(source: EarningsSource | null): void {
  earningsSource = source;
}

/* ------------------------------------------------------------------ validare */

type Row = Record<string, unknown>;

const positive = (v: unknown, label: string): number => {
  const n = Number(v);
  assert(Number.isFinite(n) && n > 0, `${label} trebuie să fie un număr mai mare decât zero.`);
  return n;
};
const positiveOrNull = (v: unknown, label: string): number | null => (v === null || v === undefined || v === '' ? null : positive(v, label));
const symbolOf = (v: unknown): string => {
  const s = normalizeSymbol(v);
  assert(s.length > 0 && s.length <= 30, 'Alege simbolul.');
  return s;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], label: string): T => {
  assert((allowed as readonly string[]).includes(String(v)), `${label} nu este valid.`);
  return v as T;
};

/** Verifică și normalizează condiția primită din interfață (nu avem încredere în forma ei). */
export function cleanCondition(raw: AlertCondition): AlertCondition {
  const c = raw as AlertCondition & Record<string, unknown>;
  switch (c?.kind) {
    case 'price':
      return { kind: 'price', symbol: symbolOf(c.symbol), direction: oneOf(c.direction, ['above', 'below'], 'Direcția'), value: positive(c.value, 'Prețul') };
    case 'watchlist_target':
      return { kind: 'watchlist_target', symbol: symbolOf(c.symbol) };
    case 'daily_move':
      return { kind: 'daily_move', symbol: symbolOf(c.symbol), direction: oneOf(c.direction, ['up', 'down'], 'Direcția'), pct: positive(c.pct, 'Variația') };
    case 'position_pnl':
      return {
        kind: 'position_pnl',
        symbol: symbolOf(c.symbol),
        metric: oneOf(c.metric, ['pct', 'amount'], 'Tipul pragului'),
        direction: oneOf(c.direction, ['profit', 'loss'], 'Direcția'),
        value: positive(c.value, 'Pragul')
      };
    case 'break_even':
      return { kind: 'break_even', symbol: symbolOf(c.symbol) };
    case 'sell_target': {
      const takeProfit = positiveOrNull(c.takeProfit, 'Ținta de profit');
      const stopLoss = positiveOrNull(c.stopLoss, 'Stop-loss-ul');
      assert(takeProfit !== null || stopLoss !== null, 'Completează ținta de profit sau stop-loss-ul.');
      if (takeProfit !== null && stopLoss !== null) assert(stopLoss < takeProfit, 'Stop-loss-ul trebuie să fie sub ținta de profit.');
      return { kind: 'sell_target', symbol: symbolOf(c.symbol), takeProfit, stopLoss };
    }
    case 'portfolio': {
      const metric = oneOf(c.metric, ['value', 'profit'], 'Valoarea urmărită');
      const value = Number(c.value);
      assert(Number.isFinite(value) && (metric === 'profit' || value > 0), 'Pragul nu este valid.');
      return { kind: 'portfolio', metric, direction: oneOf(c.direction, ['above', 'below'], 'Direcția'), value };
    }
    case 'benchmark_lag':
      return { kind: 'benchmark_lag', range: oneOf(c.range, RANGES, 'Perioada') as HistoryRange, lagPct: positive(c.lagPct, 'Diferența') };
    case 'dividend': {
      const days = Math.trunc(Number(c.daysBefore ?? 3));
      assert(days >= 0 && days <= 60, 'Numărul de zile nu este valid.');
      return { kind: 'dividend', symbol: c.symbol ? symbolOf(c.symbol) : null, event: oneOf(c.event, ['ex_soon', 'paid'], 'Evenimentul'), daysBefore: days };
    }
    case 'concentration': {
      const limitPct = positiveOrNull(c.limitPct, 'Pragul');
      assert(limitPct === null || limitPct <= 100, 'Pragul nu poate depăși 100%.');
      return { kind: 'concentration', symbol: c.symbol ? symbolOf(c.symbol) : null, limitPct };
    }
    case 'goal': {
      const mode = oneOf(c.mode, ['progress', 'behind'], 'Tipul alertei');
      const pct = mode === 'progress' ? positive(c.pct ?? 100, 'Procentul') : null;
      assert(pct === null || pct <= 100, 'Procentul nu poate depăși 100.');
      const goalId = Math.trunc(Number(c.goalId));
      assert(Number.isInteger(goalId) && goalId > 0, 'Alege obiectivul.');
      return { kind: 'goal', goalId, mode, pct };
    }
    case 'journal_review': {
      const entryId = c.entryId == null ? null : Math.trunc(Number(c.entryId));
      assert(entryId === null || entryId > 0, 'Intrarea din jurnal nu este validă.');
      return { kind: 'journal_review', entryId };
    }
    case 'earnings': {
      const days = Math.trunc(Number(c.daysBefore ?? 3));
      assert(days >= 0 && days <= 30, 'Numărul de zile nu este valid.');
      return { kind: 'earnings', symbol: symbolOf(c.symbol), event: oneOf(c.event, ['soon', 'published'], 'Evenimentul'), daysBefore: days };
    }
    default:
      throw new Error('Tipul de alertă nu este valid.');
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Clean {
  portfolioId: number | null;
  condition: AlertCondition;
  enabled: boolean;
  repeat: AlertRepeat;
  minPauseMin: number;
  windowStart: string | null;
  windowEnd: string | null;
  sound: boolean;
  note: string | null;
}

function clean(db: Db, userId: number, input: AlertInput): Clean {
  const condition = cleanCondition(input.condition);
  let portfolioId: number | null = null;
  if (input.portfolioId != null) {
    assert(getPortfolio(db, userId, Number(input.portfolioId)), 'Portofoliul nu a fost găsit.');
    portfolioId = Number(input.portfolioId);
  }
  const repeat = input.repeat === 'repeat' ? 'repeat' : 'once';
  const pause = Math.trunc(Number(input.minPauseMin ?? 1440));
  assert(Number.isFinite(pause) && pause >= 1 && pause <= 60 * 24 * 30, 'Pauza dintre alerte nu este validă.');
  const start = input.windowStart || null;
  const end = input.windowEnd || null;
  assert((start === null) === (end === null), 'Completează și începutul, și sfârșitul intervalului orar.');
  assert((start === null || HHMM.test(start)) && (end === null || HHMM.test(end)), 'Intervalul orar nu este valid (ex.: 09:00–18:00).');
  const note = String(input.note ?? '').trim();
  assert(note.length <= MAX_NOTE, `Nota poate avea cel mult ${MAX_NOTE} de caractere.`);
  return {
    portfolioId,
    condition,
    enabled: input.enabled !== false,
    repeat,
    minPauseMin: pause,
    windowStart: start,
    windowEnd: end,
    sound: input.sound !== false,
    note: note || null
  };
}

/* ------------------------------------------------------------------ gestionare */

interface AlertRow {
  id: number;
  portfolio_id: number | null;
  kind: string;
  condition: string;
  enabled: number;
  repeat_mode: AlertRepeat;
  min_pause_min: number;
  window_start: string | null;
  window_end: string | null;
  sound: number;
  snoozed_until: string | null;
  note: string | null;
  state: string;
  last_triggered_at: string | null;
  trigger_count: number;
  created_at: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toView(r: AlertRow, portfolioNames: Map<number, string>, goalNames: Map<number, string>): AlertView {
  const condition = parseJson<AlertCondition | null>(r.condition, null) as AlertCondition;
  return {
    id: r.id,
    portfolioId: r.portfolio_id,
    portfolioName: r.portfolio_id == null ? null : (portfolioNames.get(r.portfolio_id) ?? null),
    kind: condition.kind,
    condition,
    summary: describeCondition(condition, condition.kind === 'goal' ? goalNames.get(condition.goalId) : null),
    enabled: r.enabled === 1,
    repeat: r.repeat_mode,
    minPauseMin: r.min_pause_min,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    sound: r.sound === 1,
    snoozedUntil: r.snoozed_until,
    note: r.note,
    lastTriggeredAt: r.last_triggered_at,
    triggerCount: r.trigger_count,
    createdAt: r.created_at
  };
}

function views(db: Db, userId: number, rows: AlertRow[]): AlertView[] {
  const portfolioNames = new Map((db.prepare('SELECT id, name FROM portfolios WHERE user_id = ?').all(userId) as { id: number; name: string }[]).map((p) => [p.id, p.name]));
  const goalNames = new Map((db.prepare('SELECT id, name FROM goals WHERE user_id = ?').all(userId) as { id: number; name: string }[]).map((g) => [g.id, g.name]));
  return rows.map((r) => toView(r, portfolioNames, goalNames));
}

function getRow(db: Db, userId: number, id: number): AlertRow {
  const row = db.prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?').get(id, userId) as AlertRow | undefined;
  assert(row, 'Alerta nu a fost găsită.');
  return row;
}

/**
 * Alertele utilizatorului. Cu un portofoliu ales: ale lui și cele fără portofoliu; fără: cele ale
 * portofoliilor active și cele fără portofoliu (la fel ca jurnalul).
 */
export function listAlerts(db: Db, userId: number, portfolioId: number | null = null): AlertView[] {
  const ids = [...resolveScope(db, userId, portfolioId).ids];
  const rows = db
    .prepare(`SELECT * FROM alerts WHERE user_id = ? AND (portfolio_id IS NULL${ids.length ? ` OR portfolio_id IN (${ids.map(() => '?').join(',')})` : ''}) ORDER BY id DESC`)
    .all(userId, ...ids) as AlertRow[];
  return views(db, userId, rows);
}

export function getAlert(db: Db, userId: number, id: number): AlertView {
  return views(db, userId, [getRow(db, userId, id)])[0];
}

export function createAlert(db: Db, userId: number, input: AlertInput): AlertView {
  const c = clean(db, userId, input);
  const info = db
    .prepare(
      `INSERT INTO alerts (user_id, portfolio_id, kind, condition, enabled, repeat_mode, min_pause_min, window_start, window_end, sound, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, c.portfolioId, c.condition.kind, JSON.stringify(c.condition), c.enabled ? 1 : 0, c.repeat, c.minPauseMin, c.windowStart, c.windowEnd, c.sound ? 1 : 0, c.note);
  return getAlert(db, userId, Number(info.lastInsertRowid));
}

/** Modificarea condiției sau a opțiunilor o „resetează”: poate suna din nou, iar amânarea se anulează. */
export function updateAlert(db: Db, userId: number, id: number, input: AlertInput): AlertView {
  getRow(db, userId, id);
  const c = clean(db, userId, input);
  db.prepare(
    `UPDATE alerts SET portfolio_id = ?, kind = ?, condition = ?, enabled = ?, repeat_mode = ?, min_pause_min = ?, window_start = ?, window_end = ?, sound = ?, note = ?,
       state = '{}', snoozed_until = NULL, last_triggered_at = NULL, trigger_count = 0
     WHERE id = ? AND user_id = ?`
  ).run(c.portfolioId, c.condition.kind, JSON.stringify(c.condition), c.enabled ? 1 : 0, c.repeat, c.minPauseMin, c.windowStart, c.windowEnd, c.sound ? 1 : 0, c.note, id, userId);
  return getAlert(db, userId, id);
}

/** Pornirea unei alerte care a sunat deja („o dată”) o rearmează. */
export function setAlertEnabled(db: Db, userId: number, id: number, enabled: boolean): AlertView {
  getRow(db, userId, id);
  if (enabled) {
    db.prepare("UPDATE alerts SET enabled = 1, trigger_count = 0, state = '{}' WHERE id = ? AND user_id = ?").run(id, userId);
  } else {
    db.prepare('UPDATE alerts SET enabled = 0 WHERE id = ? AND user_id = ?').run(id, userId);
  }
  return getAlert(db, userId, id);
}

/** Amână alerta cu `minutes` minute; `null` anulează amânarea. */
export function snoozeAlert(db: Db, userId: number, id: number, minutes: number | null, now: Date = new Date()): AlertView {
  getRow(db, userId, id);
  let until: string | null = null;
  if (minutes !== null) {
    const m = Math.trunc(Number(minutes));
    assert(Number.isFinite(m) && m >= 1 && m <= 60 * 24 * 30, 'Durata amânării nu este validă.');
    until = new Date(now.getTime() + m * 60_000).toISOString();
  }
  db.prepare('UPDATE alerts SET snoozed_until = ? WHERE id = ? AND user_id = ?').run(until, id, userId);
  return getAlert(db, userId, id);
}

export function deleteAlert(db: Db, userId: number, id: number): void {
  const info = db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?').run(id, userId);
  assert(info.changes === 1, 'Alerta nu a fost găsită.');
}

/** Dintr-o intrare din jurnal: alertă pe ținta de profit și stop-loss ale planului (o apăsare). */
export function createAlertFromJournal(db: Db, userId: number, entryId: number): AlertView {
  const entry = getJournalEntry(db, userId, Number(entryId));
  assert(entry.targetPrice !== null || entry.stopLoss !== null, 'Intrarea nu are preț țintă sau stop-loss.');
  const note = entry.reason.trim().slice(0, MAX_NOTE);
  return createAlert(db, userId, {
    portfolioId: entry.portfolioId,
    condition: { kind: 'sell_target', symbol: entry.symbol, takeProfit: entry.targetPrice, stopLoss: entry.stopLoss },
    repeat: 'once',
    note: note || null
  });
}

/** Simbolurile din care se poate alege: pozițiile din portofoliu și instrumentele din watchlist. */
export function listAlertSymbols(db: Db, userId: number): AlertSymbol[] {
  const out = new Map<string, AlertSymbol>();
  for (const a of listAssets(db, userId)) out.set(a.symbol, { symbol: a.symbol, name: a.name, currency: a.currency, held: true });
  for (const w of db.prepare('SELECT symbol, name, currency FROM watchlist_items WHERE user_id = ?').all(userId) as { symbol: string; name: string; currency: string }[]) {
    if (!out.has(w.symbol)) out.set(w.symbol, { symbol: w.symbol, name: w.name, currency: w.currency, held: false });
  }
  return [...out.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/* ------------------------------------------------------------ centrul de notificări */

const toEvent = (r: Row): AlertEventView => ({
  id: r.id as number,
  alertId: (r.alert_id as number | null) ?? null,
  kind: r.kind as AlertEventView['kind'],
  title: r.title as string,
  body: r.body as string,
  note: (r.note as string | null) ?? null,
  createdAt: r.created_at as string,
  readAt: (r.read_at as string | null) ?? null
});

export function listAlertEvents(db: Db, userId: number, limit = 50): AlertCenter {
  const rows = db.prepare('SELECT * FROM alert_events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, Math.min(Math.max(1, Math.trunc(limit)), MAX_EVENTS)) as Row[];
  const unread = (db.prepare('SELECT COUNT(*) AS n FROM alert_events WHERE user_id = ? AND read_at IS NULL').get(userId) as { n: number }).n;
  return { events: rows.map(toEvent), unread };
}

/** Marchează ca citite notificările date (sau toate, cu `null`). */
export function markAlertEventsRead(db: Db, userId: number, ids: number[] | null, now: Date = new Date()): void {
  const at = now.toISOString();
  if (ids === null) {
    db.prepare('UPDATE alert_events SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId);
    return;
  }
  const mark = db.prepare('UPDATE alert_events SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
  for (const id of ids) mark.run(at, Number(id), userId);
}

export function clearAlertEvents(db: Db, userId: number): void {
  db.prepare('DELETE FROM alert_events WHERE user_id = ?').run(userId);
}

/* ------------------------------------------------------------------ evaluare */

/** Datele pentru evaluare, citite din serviciile existente; fiecare bucată se calculează doar dacă e cerută. */
export function buildAlertData(db: Db, userId: number, today: string): AlertData {
  const memo = new Map<string, unknown>();
  const once = <T>(key: string, make: () => T): T => {
    if (!memo.has(key)) memo.set(key, make());
    return memo.get(key) as T;
  };
  const pf = (id: number | null): number | null => id;
  const overview = (portfolioId: number | null) => once(`ov:${portfolioId}`, () => getOverview(db, userId, { portfolioId: pf(portfolioId) }, today));
  const assetsBySymbol = once('assets', () => new Map(listAssets(db, userId).map((a) => [a.symbol, a])));
  const watchCurrency = once('watchcur', () => new Map((db.prepare('SELECT symbol, currency FROM watchlist_items WHERE user_id = ?').all(userId) as { symbol: string; currency: string }[]).map((w) => [w.symbol, w.currency])));

  return {
    today,
    quote(symbol) {
      const cache = once('cache', () => getCachedPrices(db, userId));
      const q = quoteOf(symbol, assetsBySymbol.get(symbol), cache, loadHistory(db, userId, [symbol]).get(symbol) ?? [], today);
      if (q.price === null) return null;
      return { price: q.price, changePct: q.changePct, currency: assetsBySymbol.get(symbol)?.currency ?? watchCurrency.get(symbol) ?? '' };
    },
    watchTarget(symbol) {
      const r = db.prepare('SELECT MIN(CAST(target_price AS REAL)) AS t FROM watchlist_items WHERE user_id = ? AND symbol = ? AND target_price IS NOT NULL').get(userId, symbol) as { t: number | null };
      return r.t;
    },
    position(symbol, portfolioId): PositionSnap | null {
      const o = overview(portfolioId);
      const p = o.aggregated.find((x) => x.symbol === symbol);
      if (!p) return null;
      return {
        symbol,
        price: p.price,
        currency: p.currency,
        baseCurrency: o.totals.baseCurrency,
        unrealizedBase: p.unrealizedBase,
        unrealizedBasePct: p.unrealizedBasePct,
        breakEvenPrice: p.breakEvenPrice
      };
    },
    portfolio(portfolioId) {
      const t = overview(portfolioId).totals;
      return { baseCurrency: t.baseCurrency, totalValue: t.totalValue, totalPnl: t.totalPnl };
    },
    benchmark(portfolioId, range) {
      const perf = once(`perf:${portfolioId}:${range}`, () => getPerformance(db, userId, range, { portfolioId: pf(portfolioId) }, today));
      const b = perf.benchmark;
      const mine = b?.portfolioReturn ?? perf.twr;
      if (!b || b.return === null || mine === null) return null;
      return { name: b.name, portfolioReturn: mine, benchmarkReturn: b.return };
    },
    dividends(portfolioId) {
      const year = Number(today.slice(0, 4));
      // Spre finalul anului, ex-dividendele din ianuarie sunt în calendarul anului următor.
      const years = today.slice(5, 7) >= '11' ? [year, year + 1] : [year];
      const out: DividendSnap[] = [];
      for (const y of years) {
        for (const e of once(`div:${portfolioId}:${y}`, () => getDividendCalendar(db, userId, y, { portfolioId: pf(portfolioId) }, today)).entries) {
          out.push({ symbol: e.symbol, exDate: e.exDate, payDate: e.payDate, received: e.status === 'received', amountPerShare: e.amountPerShare, currency: e.currency, quantity: e.quantity });
        }
      }
      return out;
    },
    concentration(portfolioId) {
      const o = overview(portfolioId);
      const open = o.aggregated.filter((p) => p.quantity > 0 && p.marketValueBase > 0);
      const total = open.reduce((s, p) => s + p.marketValueBase, 0);
      // Aceeași pondere ca în ecranul Risc: valoarea poziției / valoarea activelor deținute.
      return { limit: getSettings(db, userId).concentrationLimit, positions: open.map((p) => ({ symbol: p.symbol, weight: total > 0 ? p.marketValueBase / total : 0 })) };
    },
    goal(id): GoalSnap | null {
      const g = once('goals', () => listGoals(db, userId, today)).find((x) => x.id === id);
      if (!g) return null;
      return { name: g.name, progress: g.progress, targetAmount: g.targetAmount, targetDate: g.targetDate, currentValue: g.inputs.currentValue, monthly: g.effective.monthly, annualReturn: g.effective.annualReturn, currency: g.inputs.currency };
    },
    journalDue(entryId) {
      if (entryId === null) {
        const count = journalDueCount(db, userId, today);
        return { count, symbols: [] };
      }
      const r = db.prepare('SELECT asset_id FROM journal_entries WHERE id = ? AND user_id = ? AND review_date <= ? AND reviewed_at IS NULL').get(entryId, userId, today) as { asset_id: number } | undefined;
      const symbol = r ? [...assetsBySymbol.values()].find((a) => a.id === r.asset_id)?.symbol : undefined;
      return { count: r ? 1 : 0, symbols: symbol ? [symbol] : [] };
    },
    earnings: earningsSource ? (symbol) => earningsSource?.(symbol, today) ?? null : undefined
  };
}

export interface FiredAlert {
  event: AlertEventView;
  sound: boolean;
}

/**
 * Evaluează alertele active ale utilizatorului și înregistrează declanșările. `now` este injectat
 * (testele nu depind de ceas); `data` poate fi înlocuit cu date false.
 */
export function evaluateAlerts(db: Db, userId: number, now: Date = new Date(), data?: AlertData): FiredAlert[] {
  const rows = db.prepare('SELECT * FROM alerts WHERE user_id = ? AND enabled = 1 ORDER BY id').all(userId) as AlertRow[];
  if (rows.length === 0) return [];
  const archived = new Set((db.prepare('SELECT id FROM portfolios WHERE user_id = ? AND archived = 1').all(userId) as { id: number }[]).map((p) => p.id));
  const source = data ?? buildAlertData(db, userId, todayIso(now));
  const fired: FiredAlert[] = [];

  for (const r of rows) {
    if (r.portfolio_id !== null && archived.has(r.portfolio_id)) continue;
    const condition = parseJson<AlertCondition | null>(r.condition, null);
    if (!condition) continue;
    // O alertă care nu are voie să sune acum nu se evaluează: starea ei rămâne neschimbată.
    const block = blockedBy(
      {
        enabled: true,
        repeat: r.repeat_mode,
        minPauseMin: r.min_pause_min,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        snoozedUntil: r.snoozed_until,
        lastTriggeredAt: r.last_triggered_at,
        triggerCount: r.trigger_count
      },
      now
    );
    if (block) continue;

    let state = parseJson<AlertState>(r.state, {});
    let result;
    try {
      result = evaluateCondition(condition, source, r.portfolio_id, state);
    } catch (err) {
      // O alertă cu date lipsă nu trebuie să le blocheze pe celelalte.
      console.error(`[alerte] alerta ${r.id} nu a putut fi evaluată:`, err);
      continue;
    }
    if (result.state) state = result.state;
    if (!result.hit) {
      if (result.state) db.prepare('UPDATE alerts SET state = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(state), r.id, userId);
      continue;
    }
    if (result.onFire) {
      state = { ...state, ...result.onFire, seen: [...new Set([...(state.seen ?? []), ...(result.onFire.seen ?? [])])].slice(-200) };
    }
    const at = now.toISOString();
    const info = db
      .prepare('INSERT INTO alert_events (user_id, alert_id, kind, title, body, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, r.id, condition.kind, result.title, result.body, r.note, at);
    // „O dată”: după declanșare alerta se oprește (se poate reporni din listă).
    db.prepare('UPDATE alerts SET state = ?, last_triggered_at = ?, trigger_count = trigger_count + 1, enabled = ? WHERE id = ? AND user_id = ?').run(
      JSON.stringify(state),
      at,
      r.repeat_mode === 'once' ? 0 : 1,
      r.id,
      userId
    );
    fired.push({
      event: { id: Number(info.lastInsertRowid), alertId: r.id, kind: condition.kind, title: result.title, body: result.body, note: r.note, createdAt: at, readAt: null },
      sound: r.sound === 1
    });
  }

  if (fired.length > 0) {
    db.prepare('DELETE FROM alert_events WHERE user_id = ? AND id NOT IN (SELECT id FROM alert_events WHERE user_id = ? ORDER BY id DESC LIMIT ?)').run(userId, userId, MAX_EVENTS);
  }
  return fired;
}
