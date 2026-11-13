/**
 * Alertele: evaluarea condițiilor (pură, pe date primite) și regulile de livrare
 * (o dată / repetat, pauză, interval orar, amânare). Nu atinge baza de date și nu
 * citește ceasul: `now` și datele vin din exterior, deci tot ce e aici se testează cu date false.
 */
import type { AlertCondition, AlertKind, AlertRepeat, AlertState, HistoryRange } from './types';
import { daysBetween, addDays } from './dates';
import { requiredMonthlyContribution } from './calc/projection';

/* ------------------------------------------------------------ datele evaluării */

export interface QuoteSnap {
  price: number;
  currency: string;
  /** Variația de azi (fracție: 0,03 = +3%); null fără închidere anterioară. */
  changePct: number | null;
}

export interface PositionSnap {
  symbol: string;
  price: number | null;
  currency: string;
  baseCurrency: string;
  unrealizedBase: number;
  unrealizedBasePct: number | null;
  breakEvenPrice: number | null;
}

export interface DividendSnap {
  symbol: string;
  /** Data ex-dividend (null la dividendele înregistrate fără anunț). */
  exDate: string | null;
  payDate: string;
  received: boolean;
  amountPerShare: number | null;
  currency: string;
  quantity: number;
}

export interface GoalSnap {
  name: string;
  progress: number;
  targetAmount: number;
  targetDate: string | null;
  currentValue: number;
  monthly: number;
  annualReturn: number;
  currency: string;
}

/** Datele despre rezultatele companiei; vin dintr-o sursă înregistrată separat. */
export interface EarningsSnap {
  /** Următoarea publicare anunțată. */
  nextDate: string | null;
  /** Ultima publicare apărută. */
  lastPublishedDate: string | null;
}

/** Tot ce are nevoie evaluarea; implementarea reală (din baza de date) este în `main/services/alerts.ts`. */
export interface AlertData {
  today: string;
  quote(symbol: string): QuoteSnap | null;
  /** Cel mai mic preț țintă de cumpărare al simbolului din watchlist. */
  watchTarget(symbol: string): number | null;
  position(symbol: string, portfolioId: number | null): PositionSnap | null;
  portfolio(portfolioId: number | null): { baseCurrency: string; totalValue: number; totalPnl: number } | null;
  benchmark(portfolioId: number | null, range: HistoryRange): { name: string; portfolioReturn: number; benchmarkReturn: number } | null;
  dividends(portfolioId: number | null): DividendSnap[];
  concentration(portfolioId: number | null): { limit: number; positions: { symbol: string; weight: number }[] };
  goal(id: number): GoalSnap | null;
  /** Câte teze sunt de revizuit (una anume, sau toate). */
  journalDue(entryId: number | null): { count: number; symbols: string[] };
  /** Punct de extensie pentru alertele de rezultate; lipsește până când e înregistrată o sursă. */
  earnings?(symbol: string): EarningsSnap | null;
}

/* ---------------------------------------------------------------- evaluare */

export interface Evaluation {
  hit: boolean;
  title: string;
  body: string;
  /** Starea de păstrat după evaluare (de ex. „a fost sub break-even”). */
  state?: AlertState;
  /** Se adaugă la stare doar când alerta chiar se declanșează (de ex. evenimentele deja anunțate). */
  onFire?: AlertState;
}

const MISS: Evaluation = { hit: false, title: '', body: '' };
const hit = (title: string, body: string, extra: Partial<Evaluation> = {}): Evaluation => ({ hit: true, title, body, ...extra });

const num = (v: number, digits = 2): string => v.toLocaleString('ro-RO', { maximumFractionDigits: digits });
const pct = (fraction: number, digits = 1): string => `${num(fraction * 100, digits)}%`;
const amount = (v: number, currency: string): string => `${num(v)} ${currency}`;

/** Condițiile care urmăresc un simbol (pentru lista de pe ecran). */
export const conditionSymbol = (c: AlertCondition): string | null => ('symbol' in c ? c.symbol : null);

/**
 * Evaluează o condiție pe datele primite. Punctul de extensie pentru alte tipuri de alerte:
 * un tip nou are nevoie de un `kind` în `AlertCondition` și de un `case` aici.
 */
export function evaluateCondition(c: AlertCondition, data: AlertData, portfolioId: number | null, state: AlertState = {}): Evaluation {
  switch (c.kind) {
    case 'price': {
      const q = data.quote(c.symbol);
      if (!q) return MISS;
      const reached = c.direction === 'above' ? q.price >= c.value : q.price <= c.value;
      return reached
        ? hit(`${c.symbol} a ajuns la ${amount(q.price, q.currency)}`, `Prețul este ${c.direction === 'above' ? 'peste' : 'sub'} ${amount(c.value, q.currency)}.`)
        : MISS;
    }
    case 'watchlist_target': {
      const q = data.quote(c.symbol);
      const target = data.watchTarget(c.symbol);
      if (!q || target === null || q.price > target) return MISS;
      return hit(`${c.symbol} a ajuns la ținta de cumpărare`, `Prețul ${amount(q.price, q.currency)} este la sau sub ținta ta de ${amount(target, q.currency)}.`);
    }
    case 'daily_move': {
      const q = data.quote(c.symbol);
      if (!q || q.changePct === null) return MISS;
      const limit = c.pct / 100;
      const reached = c.direction === 'up' ? q.changePct >= limit : q.changePct <= -limit;
      return reached
        ? hit(`${c.symbol} ${c.direction === 'up' ? 'a crescut' : 'a scăzut'} azi cu ${pct(Math.abs(q.changePct))}`, `Prețul actual: ${amount(q.price, q.currency)}.`)
        : MISS;
    }
    case 'position_pnl': {
      const p = data.position(c.symbol, portfolioId);
      if (!p) return MISS;
      const value = c.metric === 'pct' ? p.unrealizedBasePct : p.unrealizedBase;
      if (value === null) return MISS;
      const limit = c.metric === 'pct' ? c.value / 100 : c.value;
      const reached = c.direction === 'profit' ? value >= limit : value <= -limit;
      if (!reached) return MISS;
      const shown = c.metric === 'pct' ? pct(Math.abs(value)) : amount(Math.abs(value), p.baseCurrency);
      return hit(`${c.symbol}: ${c.direction === 'profit' ? 'profit' : 'pierdere'} de ${shown}`, `Rezultatul nerealizat al poziției: ${amount(p.unrealizedBase, p.baseCurrency)}.`);
    }
    case 'break_even': {
      const p = data.position(c.symbol, portfolioId);
      if (!p || p.price === null || p.breakEvenPrice === null) return MISS;
      // Alerta se „armează” cât timp poziția e pe minus; altfel ar suna imediat la o poziție deja pe plus.
      if (p.price < p.breakEvenPrice) return { ...MISS, state: { ...state, below: true } };
      if (!state.below) return MISS;
      return hit(`${c.symbol} a revenit la break-even`, `Prețul ${amount(p.price, p.currency)} a ajuns la ${amount(p.breakEvenPrice, p.currency)}, unde poziția iese pe zero.`, {
        state: { ...state, below: true },
        onFire: { below: false }
      });
    }
    case 'sell_target': {
      const q = data.quote(c.symbol);
      if (!q) return MISS;
      if (c.takeProfit !== null && q.price >= c.takeProfit) {
        return hit(`${c.symbol}: ținta de profit atinsă`, `Prețul ${amount(q.price, q.currency)} a ajuns la ținta de ${amount(c.takeProfit, q.currency)}.`);
      }
      if (c.stopLoss !== null && q.price <= c.stopLoss) {
        return hit(`${c.symbol}: stop-loss atins`, `Prețul ${amount(q.price, q.currency)} a ajuns la stop-loss-ul de ${amount(c.stopLoss, q.currency)}.`);
      }
      return MISS;
    }
    case 'portfolio': {
      const t = data.portfolio(portfolioId);
      if (!t) return MISS;
      const value = c.metric === 'value' ? t.totalValue : t.totalPnl;
      const reached = c.direction === 'above' ? value >= c.value : value <= c.value;
      const what = c.metric === 'value' ? 'valoarea totală' : 'profitul total';
      return reached
        ? hit(`Portofoliul: ${what} este ${c.direction === 'above' ? 'peste' : 'sub'} ${amount(c.value, t.baseCurrency)}`, `Acum: ${amount(value, t.baseCurrency)}.`)
        : MISS;
    }
    case 'benchmark_lag': {
      const b = data.benchmark(portfolioId, c.range);
      if (!b) return MISS;
      const lag = b.benchmarkReturn - b.portfolioReturn;
      return lag > c.lagPct / 100
        ? hit(`Ești în urma pieței cu ${pct(lag)}`, `Portofoliul: ${pct(b.portfolioReturn)}, ${b.name}: ${pct(b.benchmarkReturn)} (${RANGE_LABEL[c.range]}).`)
        : MISS;
    }
    case 'dividend': {
      const seen = new Set(state.seen ?? []);
      const today = data.today;
      const list = data.dividends(portfolioId).filter((d) => (c.symbol === null || d.symbol === c.symbol) && d.quantity > 0);
      if (c.event === 'ex_soon') {
        const soon = list.filter((d) => !d.received && d.exDate !== null && d.exDate >= today && d.exDate <= addDays(today, c.daysBefore) && !seen.has(`x:${d.symbol}:${d.exDate}`));
        if (soon.length === 0) return MISS;
        const first = soon[0];
        const days = daysBetween(today, first.exDate as string);
        return hit(
          `${first.symbol}: data ex-dividend ${days === 0 ? 'este azi' : days === 1 ? 'este mâine' : `în ${days} zile`}`,
          soon.length > 1 ? `Încă ${soon.length - 1} dividende se apropie.` : 'Ca să primești dividendul, trebuie să deții acțiunea înainte de această dată.',
          { onFire: { seen: soon.map((d) => `x:${d.symbol}:${d.exDate}`) } }
        );
      }
      const paid = list.filter((d) => d.received && d.payDate <= today && d.payDate >= addDays(today, -PAID_WINDOW_DAYS) && !seen.has(`p:${d.symbol}:${d.payDate}`));
      if (paid.length === 0) return MISS;
      const first = paid[0];
      return hit(`${first.symbol}: ai primit un dividend`, first.amountPerShare !== null ? `${amount(first.amountPerShare, first.currency)} pe acțiune.` : 'Dividendul a fost înregistrat.', {
        onFire: { seen: paid.map((d) => `p:${d.symbol}:${d.payDate}`) }
      });
    }
    case 'concentration': {
      const r = data.concentration(portfolioId);
      const limit = c.limitPct === null ? r.limit : c.limitPct / 100;
      const over = r.positions.filter((p) => (c.symbol === null || p.symbol === c.symbol) && p.weight > limit).sort((a, b) => b.weight - a.weight);
      if (over.length === 0) return MISS;
      return hit(
        `${over[0].symbol} are ${pct(over[0].weight)} din portofoliu`,
        `Pragul de concentrare este ${pct(limit, 0)}${over.length > 1 ? `; mai depășesc pragul: ${over.slice(1).map((p) => p.symbol).join(', ')}` : ''}.`
      );
    }
    case 'goal': {
      const g = data.goal(c.goalId);
      if (!g) return MISS;
      if (c.mode === 'progress') {
        const target = (c.pct ?? 100) / 100;
        return g.progress >= target ? hit(`Ai atins ${pct(g.progress, 0)} din obiectivul „${g.name}”`, `${amount(g.currentValue, g.currency)} din ${amount(g.targetAmount, g.currency)}.`) : MISS;
      }
      if (!g.targetDate || g.progress >= 1) return MISS;
      const months = daysBetween(data.today, g.targetDate) / 30.44;
      if (months <= 0) return hit(`Obiectivul „${g.name}”: data-țintă a trecut`, `Ai ${pct(g.progress, 0)} din suma-țintă.`);
      const need = requiredMonthlyContribution(g.currentValue, g.targetAmount, g.annualReturn, months);
      // O marjă de 1 unitate monetară: diferențele de rotunjire nu trebuie să sune ca o alertă.
      return need > g.monthly + 1
        ? hit(`Ești în urma ritmului pentru „${g.name}”`, `Ca să ajungi la data-țintă ai nevoie de aproximativ ${amount(need, g.currency)} pe lună; acum depui ${amount(g.monthly, g.currency)}.`)
        : MISS;
    }
    case 'journal_review': {
      const due = data.journalDue(c.entryId);
      if (due.count === 0) return MISS;
      return hit(due.count === 1 ? 'O teză din jurnal e de revizuit' : `${due.count} teze din jurnal sunt de revizuit`, due.symbols.length ? due.symbols.join(', ') : 'Deschide jurnalul și verifică-ți motivele.');
    }
    case 'earnings': {
      // Fără sursă de date, alerta nu se declanșează (ramura cu rezultatele aduce sursa).
      const e = data.earnings?.(c.symbol);
      if (!e) return MISS;
      const seen = new Set(state.seen ?? []);
      if (c.event === 'soon') {
        if (!e.nextDate || e.nextDate < data.today || e.nextDate > addDays(data.today, c.daysBefore) || seen.has(`s:${c.symbol}:${e.nextDate}`)) return MISS;
        const days = daysBetween(data.today, e.nextDate);
        return hit(`${c.symbol} își publică rezultatele ${days === 0 ? 'azi' : days === 1 ? 'mâine' : `în ${days} zile`}`, 'Poate urma o mișcare mare de preț.', { onFire: { seen: [`s:${c.symbol}:${e.nextDate}`] } });
      }
      if (!e.lastPublishedDate || e.lastPublishedDate < addDays(data.today, -PAID_WINDOW_DAYS) || seen.has(`p:${c.symbol}:${e.lastPublishedDate}`)) return MISS;
      return hit(`Au apărut rezultatele ${c.symbol}`, 'Compania și-a publicat rezultatele.', { onFire: { seen: [`p:${c.symbol}:${e.lastPublishedDate}`] } });
    }
    default: {
      const never: never = c;
      return never;
    }
  }
}

/** Câte zile după plată/publicare mai merită anunțat evenimentul. */
const PAID_WINDOW_DAYS = 7;

const RANGE_LABEL: Record<HistoryRange, string> = { '1M': 'ultima lună', '3M': 'ultimele 3 luni', '6M': 'ultimele 6 luni', '1Y': 'ultimul an', ALL: 'de la început' };

/* ---------------------------------------------------------------- descriere */

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  price: 'Preț',
  watchlist_target: 'Țintă din watchlist',
  daily_move: 'Mișcare zilnică',
  position_pnl: 'Profit / pierdere poziție',
  break_even: 'Revenire la break-even',
  sell_target: 'Țintă de vânzare',
  portfolio: 'Portofoliu',
  benchmark_lag: 'Față de piață',
  dividend: 'Dividende',
  concentration: 'Concentrare',
  goal: 'Obiectiv',
  journal_review: 'Revizuire jurnal',
  earnings: 'Rezultate companie'
};

/** O propoziție scurtă care descrie condiția (pentru lista de alerte). */
export function describeCondition(c: AlertCondition, goalName?: string | null): string {
  switch (c.kind) {
    case 'price':
      return `${c.symbol} ${c.direction === 'above' ? 'peste' : 'sub'} ${num(c.value)}`;
    case 'watchlist_target':
      return `${c.symbol} ajunge la ținta de cumpărare`;
    case 'daily_move':
      return `${c.symbol} ${c.direction === 'up' ? 'crește' : 'scade'} azi cu mai mult de ${num(c.pct)}%`;
    case 'position_pnl':
      return `${c.symbol}: ${c.direction === 'profit' ? 'profit' : 'pierdere'} de ${num(c.value)}${c.metric === 'pct' ? '%' : ' (în moneda de bază)'}`;
    case 'break_even':
      return `${c.symbol} revine la break-even`;
    case 'sell_target':
      return `${c.symbol}: ${[c.takeProfit !== null ? `țintă ${num(c.takeProfit)}` : '', c.stopLoss !== null ? `stop-loss ${num(c.stopLoss)}` : ''].filter(Boolean).join(', ')}`;
    case 'portfolio':
      return `${c.metric === 'value' ? 'Valoarea totală' : 'Profitul total'} ${c.direction === 'above' ? 'peste' : 'sub'} ${num(c.value)}`;
    case 'benchmark_lag':
      return `În urma pieței cu mai mult de ${num(c.lagPct)}% (${RANGE_LABEL[c.range]})`;
    case 'dividend':
      return `${c.symbol ?? 'Orice poziție'}: ${c.event === 'ex_soon' ? `ex-dividend în ${c.daysBefore} zile` : 'dividend primit'}`;
    case 'concentration':
      return `${c.symbol ?? 'Orice poziție'} peste ${c.limitPct === null ? 'pragul din setări' : `${num(c.limitPct)}%`} din portofoliu`;
    case 'goal':
      return c.mode === 'progress' ? `„${goalName ?? 'Obiectiv'}”: ${num(c.pct ?? 100, 0)}% atins` : `„${goalName ?? 'Obiectiv'}”: în urma ritmului necesar`;
    case 'journal_review':
      return c.entryId === null ? 'O teză din jurnal e de revizuit' : 'Teza din jurnal e de revizuit';
    case 'earnings':
      return `${c.symbol}: ${c.event === 'soon' ? `rezultate în ${c.daysBefore} zile` : 'au apărut rezultatele'}`;
  }
}

/* -------------------------------------------------------------- reguli de livrare */

export interface AlertRules {
  enabled: boolean;
  repeat: AlertRepeat;
  minPauseMin: number;
  windowStart: string | null;
  windowEnd: string | null;
  /** Momentul (ISO) până la care alerta e amânată. */
  snoozedUntil: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
}

export type BlockReason = 'disabled' | 'done' | 'snoozed' | 'outside_window' | 'pause';

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Ora locală e în intervalul permis? Intervalul poate trece de miezul nopții (22:00–06:00). */
export function inTimeWindow(start: string | null, end: string | null, now: Date): boolean {
  if (!start || !end) return true;
  const s = toMinutes(start);
  const e = toMinutes(end);
  const m = now.getHours() * 60 + now.getMinutes();
  if (s === e) return true;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** De ce nu are voie alerta să sune acum (null = poate suna). */
export function blockedBy(rules: AlertRules, now: Date): BlockReason | null {
  if (!rules.enabled) return 'disabled';
  if (rules.repeat === 'once' && rules.triggerCount > 0) return 'done';
  if (rules.snoozedUntil && Date.parse(rules.snoozedUntil) > now.getTime()) return 'snoozed';
  if (!inTimeWindow(rules.windowStart, rules.windowEnd, now)) return 'outside_window';
  if (rules.repeat === 'repeat' && rules.lastTriggeredAt && now.getTime() - Date.parse(rules.lastTriggeredAt) < rules.minPauseMin * 60_000) return 'pause';
  return null;
}
