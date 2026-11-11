/**
 * Obiectivele financiare: suma-țintă (opțional cu dată), ce valoare se urmărește (un portofoliu
 * sau toate, opțional un broker sau un tip de activ) și datele proiecției. Datele de intrare vin
 * automat din aplicație (valoarea actuală, contribuția lunară medie, randamentul și volatilitatea
 * personale sau ale indicelui de referință), iar utilizatorul le poate înlocui.
 * Proiecția Monte Carlo se face în interfață (calcul rapid, ca sliderele să răspundă imediat).
 */
import { ASSET_TYPES, type AssetType, type Goal, type GoalInput, type GoalInputs, type GoalSource, type GoalView, type PortfolioFilter } from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { benchmarkName } from '@shared/benchmarks';
import { isIsoDate, daysBetween, todayIso } from '@shared/dates';
import { annualizedVolatility, averageMonthlyContribution, cagr, monthEnds, monthlyVolatility } from '@shared/calc';
import type { Db } from '../db/database';
import { assert } from './common';
import { getBroker } from './brokers';
import { getPortfolio } from './portfolios';
import { benchmarkFor, externalFlows, getOverview, getPerformance } from './portfolio';
import { loadHistory } from '../prices/store';

/** De când se ia istoricul indicelui pentru randamentul „pe termen lung” (include crizele din 2000 și 2008). */
export const LONG_HISTORY_FROM = '2000-01-01';
/** Când nu există date deloc: un randament și o volatilitate prudente. */
const FALLBACK_RETURN = 0.06;
const FALLBACK_VOLATILITY = 0.15;
const SOURCES: GoalSource[] = ['auto', 'personal', 'benchmark', 'manual'];

type Row = Record<string, any>;

function rowToGoal(r: Row): Goal {
  return {
    id: r.id,
    name: r.name,
    targetAmount: Number(r.target_amount),
    targetDate: r.target_date ?? null,
    portfolioId: r.portfolio_id ?? null,
    brokerId: r.broker_id ?? null,
    assetType: r.asset_type ?? null,
    monthlyContribution: r.monthly_contribution == null ? null : Number(r.monthly_contribution),
    returnSource: r.return_source,
    manualReturn: r.manual_return ?? null,
    volatilitySource: r.volatility_source,
    manualVolatility: r.manual_volatility ?? null,
    inflation: Number(r.inflation)
  };
}

function clean(db: Db, userId: number, input: GoalInput, today: string): Required<GoalInput> {
  const name = String(input.name ?? '').trim();
  assert(name.length >= 1 && name.length <= 60, 'Numele obiectivului trebuie să aibă între 1 și 60 de caractere.');
  const targetAmount = Number(input.targetAmount);
  assert(Number.isFinite(targetAmount) && targetAmount > 0 && targetAmount < 1e12, 'Suma-țintă trebuie să fie mai mare decât zero.');
  const targetDate = input.targetDate ? String(input.targetDate) : null;
  assert(targetDate === null || (isIsoDate(targetDate) && targetDate > today), 'Data-țintă trebuie să fie în viitor.');
  const portfolioId = input.portfolioId == null ? null : Number(input.portfolioId);
  if (portfolioId !== null) assert(getPortfolio(db, userId, portfolioId), 'Portofoliul nu a fost găsit.');
  const brokerId = input.brokerId == null ? null : Number(input.brokerId);
  if (brokerId !== null) assert(getBroker(db, userId, brokerId), 'Brokerul nu a fost găsit.');
  const assetType = (input.assetType ?? null) as AssetType | null;
  assert(assetType === null || ASSET_TYPES.includes(assetType), 'Tipul de activ nu este valid.');
  const monthly = input.monthlyContribution == null ? null : Number(input.monthlyContribution);
  assert(monthly === null || (Number.isFinite(monthly) && monthly >= 0), 'Contribuția lunară nu poate fi negativă.');
  const returnSource = (input.returnSource ?? 'auto') as GoalSource;
  const volatilitySource = (input.volatilitySource ?? 'auto') as GoalSource;
  assert(SOURCES.includes(returnSource) && SOURCES.includes(volatilitySource), 'Sursa datelor nu este validă.');
  const manualReturn = input.manualReturn == null ? null : Number(input.manualReturn);
  assert(returnSource !== 'manual' || (manualReturn !== null && manualReturn > -0.5 && manualReturn < 0.5), 'Randamentul anual trebuie să fie între −50% și 50%.');
  const manualVolatility = input.manualVolatility == null ? null : Number(input.manualVolatility);
  assert(volatilitySource !== 'manual' || (manualVolatility !== null && manualVolatility >= 0 && manualVolatility < 1.5), 'Volatilitatea trebuie să fie între 0% și 150%.');
  const inflation = input.inflation == null ? 0.04 : Number(input.inflation);
  assert(Number.isFinite(inflation) && inflation > -0.05 && inflation < 0.5, 'Inflația trebuie să fie între −5% și 50%.');
  return { name, targetAmount, targetDate, portfolioId, brokerId, assetType, monthlyContribution: monthly, returnSource, manualReturn, volatilitySource, manualVolatility, inflation };
}

export function createGoal(db: Db, userId: number, input: GoalInput, today: string = todayIso()): Goal {
  const g = clean(db, userId, input, today);
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM goals WHERE user_id = ?').get(userId) as { n: number };
  const info = db
    .prepare(
      `INSERT INTO goals (user_id, portfolio_id, broker_id, asset_type, name, target_amount, target_date, monthly_contribution,
         return_source, manual_return, volatility_source, manual_volatility, inflation, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      g.portfolioId,
      g.brokerId,
      g.assetType,
      g.name,
      String(g.targetAmount),
      g.targetDate,
      g.monthlyContribution === null ? null : String(g.monthlyContribution),
      g.returnSource,
      g.manualReturn,
      g.volatilitySource,
      g.manualVolatility,
      g.inflation,
      order.n
    );
  return getGoal(db, userId, Number(info.lastInsertRowid));
}

export function updateGoal(db: Db, userId: number, id: number, input: GoalInput, today: string = todayIso()): Goal {
  getGoal(db, userId, id);
  const g = clean(db, userId, input, today);
  db.prepare(
    `UPDATE goals SET portfolio_id = ?, broker_id = ?, asset_type = ?, name = ?, target_amount = ?, target_date = ?, monthly_contribution = ?,
       return_source = ?, manual_return = ?, volatility_source = ?, manual_volatility = ?, inflation = ? WHERE id = ? AND user_id = ?`
  ).run(
    g.portfolioId,
    g.brokerId,
    g.assetType,
    g.name,
    String(g.targetAmount),
    g.targetDate,
    g.monthlyContribution === null ? null : String(g.monthlyContribution),
    g.returnSource,
    g.manualReturn,
    g.volatilitySource,
    g.manualVolatility,
    g.inflation,
    id,
    userId
  );
  return getGoal(db, userId, id);
}

export function deleteGoal(db: Db, userId: number, id: number): void {
  const info = db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(id, userId);
  assert(info.changes === 1, 'Obiectivul nu a fost găsit.');
}

export function getGoal(db: Db, userId: number, id: number): Goal {
  const r = db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
  assert(r, 'Obiectivul nu a fost găsit.');
  return rowToGoal(r);
}

export function listGoalRows(db: Db, userId: number): Goal[] {
  return (db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY sort_order, id').all(userId) as Row[]).map(rowToGoal);
}

/** Indicii de referință ai obiectivelor (pentru descărcarea istoricului lung înainte de calcul). */
export function goalBenchmarks(db: Db, userId: number): string[] {
  return [...new Set(listGoalRows(db, userId).map((g) => benchmarkFor(db, userId, { portfolioId: g.portfolioId })))];
}

const filterOf = (g: Goal): PortfolioFilter => ({ portfolioId: g.portfolioId, brokerId: g.brokerId, assetType: g.assetType });

/** Datele din aplicație pentru proiecția unui obiectiv. */
export function goalInputs(db: Db, userId: number, g: Goal, today: string = todayIso()): GoalInputs {
  const filter = filterOf(g);
  const overview = getOverview(db, userId, filter, today);
  const { flows } = externalFlows(db, userId, filter, today);
  const perf = getPerformance(db, userId, 'ALL', filter, today);
  const points = perf.points;
  const years = points.length > 1 ? daysBetween(points[0].date, points[points.length - 1].date) / 365.25 : 0;
  const symbol = benchmarkFor(db, userId, { portfolioId: g.portfolioId });
  const rows = (loadHistory(db, userId, [symbol]).get(symbol) ?? []).filter((r) => r.date >= LONG_HISTORY_FROM).map((r) => ({ date: r.date, close: r.close }));
  // Istoricul valorii (active + cash urmărit), la sfârșitul fiecărei luni: aceeași bază ca valoarea actuală.
  const history = monthEnds(points.map((p) => ({ date: p.date, close: p.value }))).map((p) => ({ date: p.date, value: p.close }));
  return {
    currency: overview.totals.baseCurrency,
    currentValue: overview.totals.totalValue,
    averageContribution: averageMonthlyContribution(flows, today, 12),
    personal: {
      annualReturn: years >= 1 ? perf.twrAnnualized : null,
      volatility: annualizedVolatility(points.map((p) => ({ date: p.date, twr: p.twr }))),
      years
    },
    benchmark: { symbol, name: benchmarkName(symbol), annualReturn: cagr(rows), volatility: monthlyVolatility(rows), from: rows[0]?.date ?? null },
    history
  };
}

/** Valorile efective: sursa aleasă; „automat” = personal dacă istoricul are cel puțin 2 ani, altfel indicele. */
export function effectiveInputs(g: Goal, inputs: GoalInputs): GoalView['effective'] & { shortHistory: boolean } {
  const shortHistory = inputs.personal.years < 2 || inputs.personal.annualReturn === null;
  const pick = (
    source: GoalSource,
    manual: number | null,
    personal: number | null,
    bench: number | null,
    fallback: number
  ): { value: number; from: 'personal' | 'benchmark' | 'manual' } => {
    if (source === 'manual' && manual !== null) return { value: manual, from: 'manual' };
    const wantPersonal = source === 'personal' || (source === 'auto' && !shortHistory);
    if (wantPersonal && personal !== null) return { value: personal, from: 'personal' };
    if (bench !== null) return { value: bench, from: 'benchmark' };
    if (personal !== null) return { value: personal, from: 'personal' };
    return { value: fallback, from: 'manual' };
  };
  const r = pick(g.returnSource, g.manualReturn, inputs.personal.annualReturn, inputs.benchmark.annualReturn, FALLBACK_RETURN);
  const v = pick(g.volatilitySource, g.manualVolatility, inputs.personal.volatility, inputs.benchmark.volatility, FALLBACK_VOLATILITY);
  return {
    monthly: g.monthlyContribution ?? Math.max(0, inputs.averageContribution),
    annualReturn: r.value,
    volatility: v.value,
    returnFrom: r.from,
    volatilityFrom: v.from,
    shortHistory
  };
}

function scopeLabel(db: Db, userId: number, g: Goal): string {
  const parts = [g.portfolioId ? (getPortfolio(db, userId, g.portfolioId)?.name ?? 'Portofoliu șters') : 'Toate portofoliile'];
  if (g.brokerId) parts.push(getBroker(db, userId, g.brokerId)?.name ?? 'broker șters');
  if (g.assetType) parts.push(ASSET_TYPE_LABEL_PLURAL[g.assetType]);
  return parts.join(' · ');
}

/** Obiectivele cu datele proiecției (în moneda portofoliului urmărit). */
export function listGoals(db: Db, userId: number, today: string = todayIso()): GoalView[] {
  return listGoalRows(db, userId).map((g) => {
    const inputs = goalInputs(db, userId, g, today);
    const { shortHistory, ...effective } = effectiveInputs(g, inputs);
    return {
      ...g,
      scopeLabel: scopeLabel(db, userId, g),
      inputs,
      effective,
      shortHistory,
      progress: g.targetAmount > 0 ? Math.min(1, Math.max(0, inputs.currentValue / g.targetAmount)) : 0
    };
  });
}
