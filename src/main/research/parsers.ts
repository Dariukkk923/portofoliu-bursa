/**
 * Transformă răspunsurile providerilor (Yahoo, Polygon, Alpha Vantage) în formatul aplicației.
 * Funcțiile sunt pure: nu fac cereri, deci se pot testa cu răspunsuri salvate.
 */
import { createHash } from 'node:crypto';
import type { AssetType, EarningsQuarter, NextReport, ReportLinks, ResearchSource, FinancialStatementKind, StatementSet } from '@shared/types';

type Any = any;

/** O știre așa cum o dă un provider, înainte de combinarea între provideri. */
export interface RawNews {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary: string | null;
  thumbUrl: string | null;
  symbols: string[];
  provider: ResearchSource;
}

/** Datele financiare ale unei companii, de la unul sau mai mulți provideri. */
export interface FinancialsData {
  name: string | null;
  currency: string | null;
  next: NextReport | null;
  eps: EarningsQuarter[];
  statements: { quarterly: StatementSet; annual: StatementSet };
  website: string | null;
  investors: string | null;
  sources: ResearchSource[];
}

/** Ce trebuie pentru calendar: următoarea raportare și data ultimei raportări. */
export interface CalendarData {
  next: NextReport | null;
  lastReportedDate: string | null;
  lastPeriodEnd: string | null;
}

/* ------------------------------------------------------------------ utilitare */

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !/^none$/i.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** O dată (Date, secunde Unix, text ISO sau AAAALLZZ) ca AAAA-LL-ZZ. */
export function isoDay(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString().slice(0, 10);
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

/** Momentul complet (ISO) pentru ordonarea știrilor. */
function isoTime(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number' && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string') {
    const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v); // Alpha Vantage: 20240131T143000
    const t = Date.parse(compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** Doar adresele https; restul (javascript:, file:, http:) sunt respinse. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Cheia unei adrese: aceeași știre dată de doi provideri cu parametri diferiți se recunoaște. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export const newsId = (url: string): string => createHash('sha1').update(urlKey(url)).digest('hex').slice(0, 16);

/** Titlul fără diacritice, majuscule și semne: pentru a recunoaște același articol de la surse diferite. */
export function titleKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function emptySet(): StatementSet {
  return { income: [], balance: [], cashflow: [] };
}

const hasAny = (v: Record<string, number | null>): boolean => Object.values(v).some((x) => x !== null);

/* --------------------------------------------------------------------- știri */

export function parseYahooNews(res: Any): RawNews[] {
  const out: RawNews[] = [];
  for (const n of Array.isArray(res?.news) ? res.news : []) {
    const url = httpsUrl(n?.link);
    const at = isoTime(n?.providerPublishTime);
    const title = typeof n?.title === 'string' ? n.title.trim() : '';
    if (!url || !at || !title) continue;
    // Cea mai mică imagine (140×140 când există): se descarcă mult mai repede.
    const sizes: Any[] = Array.isArray(n?.thumbnail?.resolutions) ? n.thumbnail.resolutions.filter((r: Any) => httpsUrl(r?.url)) : [];
    sizes.sort((a, b) => (num(a.width) ?? 1e9) - (num(b.width) ?? 1e9));
    out.push({
      title,
      source: typeof n.publisher === 'string' && n.publisher ? n.publisher : 'Yahoo Finance',
      url,
      publishedAt: at,
      summary: null,
      thumbUrl: sizes[0]?.url ?? null,
      symbols: Array.isArray(n.relatedTickers) ? n.relatedTickers.filter((t: unknown) => typeof t === 'string') : [],
      provider: 'yahoo'
    });
  }
  return out;
}

export function parsePolygonNews(json: Any): RawNews[] {
  const out: RawNews[] = [];
  for (const n of Array.isArray(json?.results) ? json.results : []) {
    const url = httpsUrl(n?.article_url);
    const at = isoTime(n?.published_utc);
    const title = typeof n?.title === 'string' ? n.title.trim() : '';
    if (!url || !at || !title) continue;
    out.push({
      title,
      source: n.publisher?.name ?? 'Polygon',
      url,
      publishedAt: at,
      summary: typeof n.description === 'string' && n.description.trim() ? n.description.trim() : null,
      thumbUrl: httpsUrl(n.image_url),
      symbols: Array.isArray(n.tickers) ? n.tickers.filter((t: unknown) => typeof t === 'string') : [],
      provider: 'polygon'
    });
  }
  return out;
}

export function parseAlphaNews(json: Any): RawNews[] {
  const out: RawNews[] = [];
  for (const n of Array.isArray(json?.feed) ? json.feed : []) {
    const url = httpsUrl(n?.url);
    const at = isoTime(n?.time_published);
    const title = typeof n?.title === 'string' ? n.title.trim() : '';
    if (!url || !at || !title) continue;
    out.push({
      title,
      source: typeof n.source === 'string' && n.source ? n.source : 'Alpha Vantage',
      url,
      publishedAt: at,
      summary: typeof n.summary === 'string' && n.summary.trim() ? n.summary.trim() : null,
      thumbUrl: httpsUrl(n.banner_image),
      symbols: Array.isArray(n.ticker_sentiment) ? n.ticker_sentiment.map((t: Any) => String(t?.ticker ?? '')).filter(Boolean) : [],
      provider: 'alphavantage'
    });
  }
  return out;
}

/* --------------------------------------------------------- Yahoo: raportări */

/** Un tabel financiar Yahoo (fundamentalsTimeSeries, modulul „all”) ca perioade pe tipuri de situații. */
export function parseYahooStatements(rows: Any[]): StatementSet {
  const pick = (r: Any, ...keys: string[]): number | null => {
    for (const k of keys) {
      const v = num(r?.[k]);
      if (v !== null) return v;
    }
    return null;
  };
  const sets: StatementSet = emptySet();
  for (const r of rows ?? []) {
    const end = isoDay(r?.date);
    if (!end) continue;
    const income = {
      revenue: pick(r, 'totalRevenue', 'operatingRevenue'),
      grossProfit: pick(r, 'grossProfit'),
      operatingIncome: pick(r, 'operatingIncome', 'totalOperatingIncomeAsReported'),
      netIncome: pick(r, 'netIncome', 'netIncomeCommonStockholders'),
      eps: pick(r, 'dilutedEPS', 'basicEPS')
    };
    const balance = {
      totalAssets: pick(r, 'totalAssets'),
      totalLiabilities: pick(r, 'totalLiabilitiesNetMinorityInterest'),
      equity: pick(r, 'stockholdersEquity', 'commonStockEquity'),
      cash: pick(r, 'cashCashEquivalentsAndShortTermInvestments', 'cashAndCashEquivalents'),
      totalDebt: pick(r, 'totalDebt')
    };
    const cashflow = {
      operating: pick(r, 'operatingCashFlow', 'cashFlowFromContinuingOperatingActivities'),
      investing: pick(r, 'investingCashFlow'),
      financing: pick(r, 'financingCashFlow'),
      capex: pick(r, 'capitalExpenditure'),
      freeCashFlow: pick(r, 'freeCashFlow')
    };
    // Un rând doar cu EPS (trimestru incomplet la Yahoo) nu are ce arăta în grafic.
    if (income.revenue !== null || income.netIncome !== null) sets.income.push({ end, values: income });
    if (hasAny(balance)) sets.balance.push({ end, values: balance });
    if (hasAny(cashflow)) sets.cashflow.push({ end, values: cashflow });
  }
  for (const k of Object.keys(sets) as FinancialStatementKind[]) sets[k].sort((a, b) => a.end.localeCompare(b.end));
  return sets;
}

/** (real − estimat) / |estimat|; null dacă estimatul lipsește sau este zero. */
export function surprise(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null || estimate === 0) return null;
  return (actual - estimate) / Math.abs(estimate);
}

/** Rezumatul Yahoo (quoteSummary): data următoarei raportări, EPS real/estimat, moneda și site-ul. */
export function parseYahooSummary(qs: Any): Omit<FinancialsData, 'statements' | 'sources'> & { lastReportedDate: string | null; lastPeriodEnd: string | null } {
  const cal = qs?.calendarEvents?.earnings;
  const dates: string[] = (Array.isArray(cal?.earningsDate) ? cal.earningsDate : []).map(isoDay).filter((d: string | null): d is string => !!d).sort();
  const chart: Any[] = Array.isArray(qs?.earnings?.earningsChart?.quarterly) ? qs.earnings.earningsChart.quarterly : [];
  const history: Any[] = Array.isArray(qs?.earningsHistory?.history) ? qs.earningsHistory.history : [];

  const eps = new Map<string, EarningsQuarter>();
  for (const q of history) {
    const periodEnd = isoDay(q?.quarter);
    if (!periodEnd) continue;
    const epsActual = num(q.epsActual);
    const epsEstimate = num(q.epsEstimate);
    eps.set(periodEnd, { periodEnd, reportedDate: null, epsActual, epsEstimate, surprisePct: surprise(epsActual, epsEstimate) });
  }
  for (const q of chart) {
    const periodEnd = isoDay(q?.periodEndDate);
    if (!periodEnd) continue;
    const epsActual = num(q.actual);
    const epsEstimate = num(q.estimate);
    const old = eps.get(periodEnd);
    eps.set(periodEnd, {
      periodEnd,
      reportedDate: isoDay(q.reportedDate) ?? old?.reportedDate ?? null,
      epsActual: epsActual ?? old?.epsActual ?? null,
      epsEstimate: epsEstimate ?? old?.epsEstimate ?? null,
      surprisePct: surprise(epsActual ?? old?.epsActual ?? null, epsEstimate ?? old?.epsEstimate ?? null)
    });
  }
  const quarters = [...eps.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const last = [...quarters].reverse().find((q) => q.reportedDate);

  return {
    name: null,
    currency: typeof qs?.earnings?.financialCurrency === 'string' ? qs.earnings.financialCurrency : typeof qs?.financialData?.financialCurrency === 'string' ? qs.financialData.financialCurrency : null,
    next: dates.length
      ? {
          date: dates[0],
          estimated: !!cal?.isEarningsDateEstimate || dates.length > 1,
          epsEstimate: num(cal?.earningsAverage),
          revenueEstimate: num(cal?.revenueAverage)
        }
      : null,
    eps: quarters,
    website: httpsUrl(qs?.assetProfile?.website),
    investors: httpsUrl(qs?.assetProfile?.irWebsite),
    lastReportedDate: last?.reportedDate ?? null,
    lastPeriodEnd: last?.periodEnd ?? null
  };
}

/* ------------------------------------------------------ Polygon: raportări */

/** `/vX/reference/financials`: un tabel pe tipul de perioadă cerut (trimestrial sau anual). */
export function parsePolygonFinancials(json: Any): StatementSet {
  const sets = emptySet();
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const end = isoDay(r?.end_date);
    const f = r?.financials;
    if (!end || !f) continue;
    const v = (section: string, field: string): number | null => num(f?.[section]?.[field]?.value);
    const income = {
      revenue: v('income_statement', 'revenues'),
      grossProfit: v('income_statement', 'gross_profit'),
      operatingIncome: v('income_statement', 'operating_income_loss'),
      netIncome: v('income_statement', 'net_income_loss'),
      eps: v('income_statement', 'diluted_earnings_per_share')
    };
    const balance = {
      totalAssets: v('balance_sheet', 'assets'),
      totalLiabilities: v('balance_sheet', 'liabilities'),
      equity: v('balance_sheet', 'equity'),
      cash: null,
      totalDebt: null
    };
    const cashflow = {
      operating: v('cash_flow_statement', 'net_cash_flow_from_operating_activities'),
      investing: v('cash_flow_statement', 'net_cash_flow_from_investing_activities'),
      financing: v('cash_flow_statement', 'net_cash_flow_from_financing_activities'),
      capex: null,
      freeCashFlow: null
    };
    if (hasAny(income)) sets.income.push({ end, values: income });
    if (hasAny(balance)) sets.balance.push({ end, values: balance });
    if (hasAny(cashflow)) sets.cashflow.push({ end, values: cashflow });
  }
  for (const k of Object.keys(sets) as FinancialStatementKind[]) sets[k].sort((a, b) => a.end.localeCompare(b.end));
  return sets;
}

/* ------------------------------------------------- Alpha Vantage: raportări */

/** INCOME_STATEMENT, BALANCE_SHEET și CASH_FLOW: rapoartele trimestriale și anuale. */
export function parseAlphaStatements(income: Any, balance: Any, cash: Any): { quarterly: StatementSet; annual: StatementSet } {
  const build = (field: 'quarterlyReports' | 'annualReports'): StatementSet => {
    const sets = emptySet();
    const rows = (src: Any): Any[] => (Array.isArray(src?.[field]) ? src[field] : []);
    for (const r of rows(income)) {
      const end = isoDay(r?.fiscalDateEnding);
      const values = { revenue: num(r.totalRevenue), grossProfit: num(r.grossProfit), operatingIncome: num(r.operatingIncome), netIncome: num(r.netIncome), eps: null };
      if (end && hasAny(values)) sets.income.push({ end, values });
    }
    for (const r of rows(balance)) {
      const end = isoDay(r?.fiscalDateEnding);
      const values = {
        totalAssets: num(r.totalAssets),
        totalLiabilities: num(r.totalLiabilities),
        equity: num(r.totalShareholderEquity),
        cash: num(r.cashAndCashEquivalentsAtCarryingValue),
        totalDebt: num(r.shortLongTermDebtTotal)
      };
      if (end && hasAny(values)) sets.balance.push({ end, values });
    }
    for (const r of rows(cash)) {
      const end = isoDay(r?.fiscalDateEnding);
      const operating = num(r.operatingCashflow);
      const capexRaw = num(r.capitalExpenditures);
      // Alpha Vantage dă capex-ul pozitiv; în aplicație ieșirea de bani este negativă.
      const capex = capexRaw === null ? null : -Math.abs(capexRaw);
      const values = { operating, investing: num(r.cashflowFromInvestment), financing: num(r.cashflowFromFinancing), capex, freeCashFlow: operating !== null && capex !== null ? operating + capex : null };
      if (end && hasAny(values)) sets.cashflow.push({ end, values });
    }
    for (const k of Object.keys(sets) as FinancialStatementKind[]) sets[k].sort((a, b) => a.end.localeCompare(b.end));
    return sets;
  };
  return { quarterly: build('quarterlyReports'), annual: build('annualReports') };
}

/** EARNINGS: EPS real și estimat pe trimestre, cu data raportării. */
export function parseAlphaEarnings(json: Any): EarningsQuarter[] {
  const out: EarningsQuarter[] = [];
  for (const q of Array.isArray(json?.quarterlyEarnings) ? json.quarterlyEarnings : []) {
    const periodEnd = isoDay(q?.fiscalDateEnding);
    if (!periodEnd) continue;
    const epsActual = num(q.reportedEPS);
    const epsEstimate = num(q.estimatedEPS);
    out.push({ periodEnd, reportedDate: isoDay(q.reportedDate), epsActual, epsEstimate, surprisePct: surprise(epsActual, epsEstimate) });
  }
  return out.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/** EARNINGS_CALENDAR (CSV: symbol,name,reportDate,fiscalDateEnding,estimate,currency): cea mai apropiată dată de după `today`. */
export function parseAlphaCalendar(csv: string, symbol: string, today: string): NextReport | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^symbol,/i.test(lines[0])) return null;
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string): number => head.indexOf(name);
  let best: NextReport | null = null;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells[col('symbol')]?.trim().toUpperCase() !== symbol.split('.')[0].toUpperCase()) continue;
    const date = isoDay(cells[col('reportdate')]);
    if (!date || date < today) continue;
    if (!best || date < (best.date ?? '9999')) best = { date, estimated: true, epsEstimate: num(cells[col('estimate')]), revenueEstimate: null };
  }
  return best;
}

/* ------------------------------------------------------------------ linkuri */

/** Linkurile către sursele oficiale ale rapoartelor, după simbol și tip. */
export function reportLinks(symbol: string, type: AssetType, website: string | null, investors: string | null): ReportLinks {
  const upper = symbol.toUpperCase();
  const isBvb = upper.endsWith('.RO');
  const ticker = upper.replace(/\.RO$/, '');
  const isUs = type === 'stock' && !/[.=^]/.test(upper);
  return {
    website,
    investors,
    bvb: isBvb ? `https://bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${encodeURIComponent(ticker)}` : null,
    sec: isUs ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(upper)}&type=10-&dateb=&owner=include&count=40` : null
  };
}

/* ------------------------------------------------------ rezultate calculate */

/** Perioada din același moment al anului precedent (±25 de zile), dacă există. */
export function yearAgo<T extends { end: string }>(list: T[], end: string): T | null {
  const target = Date.parse(end) - 365 * 86_400_000;
  let best: T | null = null;
  let bestGap = 26 * 86_400_000;
  for (const p of list) {
    const gap = Math.abs(Date.parse(p.end) - target);
    if (gap < bestGap) {
      best = p;
      bestGap = gap;
    }
  }
  return best;
}

export const changePct = (now: number | null, before: number | null): number | null => (now === null || before === null || before === 0 ? null : (now - before) / Math.abs(before));
