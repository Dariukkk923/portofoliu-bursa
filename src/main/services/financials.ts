/**
 * Raportările financiare ale companiilor din portofoliu și din watchlist: calendarul raportărilor,
 * ultimele rezultate (față de estimări și față de anul trecut), situațiile financiare pe trimestre
 * și pe ani, linkurile către sursele oficiale. Datele stau în cache 12 ore; dacă reîmprospătarea
 * eșuează (de ex. fără internet), se arată ce există în cache.
 *
 * ETF-urile, obligațiunile și crypto nu raportează rezultate: pentru ele răspunsul este „nesuportat”,
 * nu o eroare.
 */
import type { EarningsSnap } from '@shared/alerts';
import type {
  AssetType,
  CompanyFinancials,
  EarningsCalendar,
  EarningsCalendarEntry,
  LatestReportDate,
  LatestResults,
  NewsFilter,
  ResearchSymbol,
  ResultsVerdict,
  StatementSet,
  UpcomingReport
} from '@shared/types';
import { todayIso } from '@shared/dates';
import type { Db } from '../db/database';
import { isNetworkError } from '../prices/provider';
import { changePct, emptySet, reportLinks, surprise, yearAgo, type CalendarData, type FinancialsData } from '../research/parsers';
import type { ResearchSources } from '../research/sources';
import { cacheGet, cachePut, isFresh } from './researchCache';
import { mapLimit, pickSymbols, researchSymbols } from './research';
import { normalizeSymbol } from './assets';
import { assert } from './common';

export const FIN_TTL_MS = 12 * 3_600_000;
export const CAL_TTL_MS = 12 * 3_600_000;
const MAX_CALENDAR = 40;
/** Sub acest prag, diferența dintre EPS real și estimat este „în linie”. */
const INLINE_BAND = 0.01;

const dayMs = 86_400_000;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / dayMs);

const UNSUPPORTED_REASON = 'ETF-urile, obligațiunile și crypto nu publică rezultate trimestriale, deci nu au raportări financiare.';

function blank(symbol: string, name: string, over: Partial<CompanyFinancials> = {}): CompanyFinancials {
  return {
    symbol,
    name,
    supported: true,
    reason: null,
    currency: null,
    next: null,
    latest: null,
    eps: [],
    statements: { quarterly: emptySet(), annual: emptySet() },
    links: reportLinks(symbol, 'stock', null, null),
    sources: [],
    fetchedAt: null,
    stale: false,
    offline: false,
    error: null,
    ...over
  };
}

/** Ultimul trimestru (sau an) cu venituri, comparat cu aceeași perioadă din anul trecut. */
export function computeLatest(statements: { quarterly: StatementSet; annual: StatementSet }, eps: FinancialsData['eps']): LatestResults | null {
  const withRevenue = (set: StatementSet) => set.income.filter((p) => p.values.revenue !== null || p.values.netIncome !== null);
  const quarterly = withRevenue(statements.quarterly);
  const series = quarterly.length > 0 ? quarterly : withRevenue(statements.annual);
  const last = series[series.length - 1];
  const lastEps = [...eps].reverse().find((q) => q.epsActual !== null);

  // Fără situații financiare, rămâne doar ultimul EPS raportat.
  const periodEnd = last?.end ?? lastEps?.periodEnd;
  if (!periodEnd) return null;
  const prior = last ? yearAgo(series, last.end) : null;

  const quarter = eps.find((q) => Math.abs(Date.parse(q.periodEnd) - Date.parse(periodEnd)) <= 10 * dayMs) ?? null;
  const epsActual = quarter?.epsActual ?? last?.values.eps ?? null;
  const epsEstimate = quarter?.epsEstimate ?? null;
  const epsPriorQuarter = yearAgo(eps.map((q) => ({ end: q.periodEnd, v: q.epsActual })), periodEnd)?.v ?? null;
  const epsPrior = prior?.values.eps ?? epsPriorQuarter;

  const s = surprise(epsActual, epsEstimate);
  const verdict: ResultsVerdict | null = s === null ? null : s > INLINE_BAND ? 'beat' : s < -INLINE_BAND ? 'miss' : 'inline';
  return {
    periodEnd,
    reportedDate: quarter?.reportedDate ?? null,
    revenue: last?.values.revenue ?? null,
    revenueChangePct: changePct(last?.values.revenue ?? null, prior?.values.revenue ?? null),
    netIncome: last?.values.netIncome ?? null,
    netIncomeChangePct: changePct(last?.values.netIncome ?? null, prior?.values.netIncome ?? null),
    epsActual,
    epsEstimate,
    epsChangePct: changePct(epsActual, epsPrior),
    verdict
  };
}

export function buildFinancials(symbol: string, name: string, type: AssetType, data: FinancialsData, fetchedAt: string, today: string = todayIso()): CompanyFinancials {
  // O dată din trecut înseamnă că raportarea a avut loc deja și sursa nu a trecut încă la următoarea.
  const next = data.next && data.next.date && data.next.date >= today ? data.next : null;
  return {
    symbol,
    name,
    supported: true,
    reason: null,
    currency: data.currency,
    next,
    latest: computeLatest(data.statements, data.eps),
    eps: data.eps.slice(-8),
    statements: data.statements,
    links: reportLinks(symbol, type, data.website, data.investors),
    sources: data.sources,
    fetchedAt,
    stale: false,
    offline: false,
    error: null
  };
}

/** Tipul și numele simbolului: din portofoliu/watchlist, altfel cele primite de la interfață. */
function identify(db: Db, userId: number, symbol: string, type: AssetType): ResearchSymbol {
  const known = researchSymbols(db, userId).find((s) => s.symbol === symbol);
  return known ?? { symbol, name: '', type, held: false };
}

export async function getFinancials(
  db: Db,
  userId: number,
  rawSymbol: string,
  type: AssetType,
  sources: ResearchSources,
  opts: { force?: boolean; now?: number } = {}
): Promise<CompanyFinancials> {
  const symbol = normalizeSymbol(rawSymbol);
  assert(/^[A-Z0-9.\-=^_/]{1,24}$/.test(symbol), 'Simbolul nu este valid.');
  const now = opts.now ?? Date.now();
  const who = identify(db, userId, symbol, type);
  if (who.type !== 'stock') return blank(symbol, who.name, { supported: false, links: reportLinks(symbol, who.type, null, null), reason: UNSUPPORTED_REASON });

  const cached = cacheGet<CompanyFinancials>(db, userId, 'fin', symbol);
  if (isFresh(cached, FIN_TTL_MS, now) && !opts.force) return { ...cached!.data, name: who.name || cached!.data.name, fetchedAt: cached!.fetchedAt };
  try {
    const data = await sources.financials(symbol, who.type);
    const fetchedAt = new Date(now).toISOString();
    const result = data
      ? buildFinancials(symbol, who.name, who.type, data, fetchedAt, new Date(now).toISOString().slice(0, 10))
      : blank(symbol, who.name, { supported: false, fetchedAt, reason: 'Nu am găsit raportări financiare pentru acest simbol.' });
    cachePut(db, userId, 'fin', symbol, result, new Date(now));
    return result;
  } catch (err) {
    const offline = isNetworkError(err);
    if (cached) return { ...cached.data, name: who.name || cached.data.name, fetchedAt: cached.fetchedAt, stale: true, offline };
    return blank(symbol, who.name, { offline, error: offline ? 'Fără conexiune la internet.' : 'Nu am putut încărca raportările. Încearcă din nou.' });
  }
}

/* --------------------------------------------------------------- calendar */

interface CalendarLoad {
  data: Map<string, CalendarData | null>;
  fetchedAt: string | null;
  offline: boolean;
  failed: number;
}

/** Datele de calendar ale simbolurilor: din cache când e proaspăt, altfel de la surse (cu rezervă pe cache vechi). */
async function loadCalendar(db: Db, userId: number, symbols: ResearchSymbol[], sources: ResearchSources, opts: { force?: boolean; now: number }): Promise<CalendarLoad> {
  const out: CalendarLoad = { data: new Map(), fetchedAt: null, offline: false, failed: 0 };
  let network = 0;
  await mapLimit(symbols, 4, async (s) => {
    const cached = cacheGet<CalendarData | null>(db, userId, 'cal', s.symbol);
    let fetchedAt: string | null = cached?.fetchedAt ?? null;
    let data: CalendarData | null = cached?.data ?? null;
    if (!isFresh(cached, CAL_TTL_MS, opts.now) || opts.force) {
      try {
        data = await sources.calendar(s.symbol, s.type);
        fetchedAt = new Date(opts.now).toISOString();
        cachePut(db, userId, 'cal', s.symbol, data, new Date(opts.now));
      } catch (err) {
        out.failed++;
        if (isNetworkError(err)) network++;
      }
    }
    out.data.set(s.symbol, data);
    if (fetchedAt && (!out.fetchedAt || fetchedAt < out.fetchedAt)) out.fetchedAt = fetchedAt;
  });
  out.offline = out.failed > 0 && network === out.failed;
  return out;
}

const stocksOf = (list: ResearchSymbol[]): ResearchSymbol[] => list.filter((s) => s.type === 'stock').slice(0, MAX_CALENDAR);

/** Când raportează fiecare companie (acțiunile din filtru); cele fără dată cunoscută la final. */
export async function getEarningsCalendar(db: Db, userId: number, filter: NewsFilter, sources: ResearchSources, now: number = Date.now()): Promise<EarningsCalendar> {
  const symbols = stocksOf(pickSymbols(db, userId, filter ?? {}));
  const today = new Date(now).toISOString().slice(0, 10);
  const load = await loadCalendar(db, userId, symbols, sources, { force: filter?.force, now });
  const entries: EarningsCalendarEntry[] = symbols.map((s) => {
    const d = load.data.get(s.symbol) ?? null;
    const date = d?.next?.date && d.next.date >= today ? d.next.date : null;
    return {
      symbol: s.symbol,
      name: s.name,
      type: s.type,
      held: s.held,
      date,
      daysUntil: date ? daysBetween(today, date) : null,
      estimated: date ? !!d?.next?.estimated : false,
      epsEstimate: date ? (d?.next?.epsEstimate ?? null) : null,
      lastReportedDate: d?.lastReportedDate ?? null
    };
  });
  entries.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.symbol.localeCompare(b.symbol));
  const nothing = load.failed > 0 && entries.every((e) => e.date === null && e.lastReportedDate === null);
  return {
    entries,
    fetchedAt: load.fetchedAt,
    offline: load.offline,
    error: nothing ? (load.offline ? 'Fără conexiune la internet.' : 'Nu am putut încărca calendarul. Încearcă din nou.') : null
  };
}

/* -------------------------------------------------- funcții pentru alerte */

/**
 * Raportările următoare ale companiilor deținute, în următoarele `withinDays` zile (implicit 30),
 * cele mai apropiate întâi. Pentru alerte de tipul „Compania X raportează în 3 zile”.
 */
export async function upcomingReports(db: Db, userId: number, sources: ResearchSources, opts: { withinDays?: number; now?: number; force?: boolean } = {}): Promise<UpcomingReport[]> {
  const now = opts.now ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const withinDays = opts.withinDays ?? 30;
  const symbols = stocksOf(researchSymbols(db, userId).filter((s) => s.held));
  const load = await loadCalendar(db, userId, symbols, sources, { force: opts.force, now });
  const out: UpcomingReport[] = [];
  for (const s of symbols) {
    const next = load.data.get(s.symbol)?.next;
    if (!next?.date || next.date < today) continue;
    const daysUntil = daysBetween(today, next.date);
    if (daysUntil > withinDays) continue;
    out.push({ symbol: s.symbol, name: s.name, date: next.date, daysUntil, estimated: next.estimated, epsEstimate: next.epsEstimate });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

/**
 * Data ultimei raportări publicate pentru fiecare companie deținută (null = nu se știe).
 * Pentru alerte de tipul „Rezultatele pentru X au apărut”: alerta pornește când data se schimbă.
 */
export async function latestReportDates(db: Db, userId: number, sources: ResearchSources, opts: { now?: number; force?: boolean } = {}): Promise<LatestReportDate[]> {
  const now = opts.now ?? Date.now();
  const symbols = stocksOf(researchSymbols(db, userId).filter((s) => s.held));
  const load = await loadCalendar(db, userId, symbols, sources, { force: opts.force, now });
  return symbols.map((s) => {
    const d = load.data.get(s.symbol);
    return { symbol: s.symbol, name: s.name, reportedDate: d?.lastReportedDate ?? null, periodEnd: d?.lastPeriodEnd ?? null };
  });
}

/** Datele pentru alertele de rezultate: următoarea publicare și ultima apărută, per simbol. */
export function earningsSnapshots(upcoming: UpcomingReport[], latest: LatestReportDate[]): Map<string, EarningsSnap> {
  const map = new Map<string, EarningsSnap>();
  for (const l of latest) map.set(l.symbol, { nextDate: null, lastPublishedDate: l.reportedDate });
  for (const u of upcoming) map.set(u.symbol, { nextDate: u.date, lastPublishedDate: map.get(u.symbol)?.lastPublishedDate ?? null });
  return map;
}
