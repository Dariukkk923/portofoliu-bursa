/**
 * Calendarul de dividende al pozițiilor deținute: dividendele anunțate (de la providerii care le
 * oferă), cele introduse manual și cele estimate din istoric, plus cupoanele obligațiunilor; venitul
 * pe luni (încasat vs. estimat); randamentul din dividende al fiecărei poziții; și dividendele
 * plătite, dar neînregistrate, pe care aplicația propune să le înregistrezi ca tranzacții.
 */
import type {
  Asset,
  DividendCalendar,
  DividendCalendarEntry,
  DividendProposal,
  DividendStatus,
  DividendYieldRow,
  ManualDividendInput,
  PortfolioFilter
} from '@shared/types';
import { addDays, isIsoDate, todayIso } from '@shared/dates';
import {
  Ledger,
  couponDates,
  couponPerPayment,
  forwardAnnualDividend,
  inferSchedule,
  priceMultiplier,
  projectDividends,
  trailingDividends,
  type DividendPoint,
  type LedgerTx
} from '@shared/calc';
import { dec, toNum } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { assert } from './common';
import { listAssets } from './assets';
import { listBrokers } from './brokers';
import { resolveScope } from './portfolios';
import { allLedgerTxs, makeFxOn } from './portfolio';
import { fxSymbol, getCachedPrices, loadHistory, resolveFx, resolvePrice } from '../prices/store';
import type { ProviderDividend } from '../prices/provider';


interface EventRow {
  id: number;
  symbol: string;
  ex_date: string;
  pay_date: string | null;
  amount: string;
  currency: string | null;
  source: string;
  amount_estimated: number;
}

/** Cât de departe în trecut se propun dividendele plătite și neînregistrate. */
const PROPOSAL_WINDOW_DAYS = 90;
/** O tranzacție de dividend „aparține” unui dividend anunțat dacă e între ex-dividend − 7 zile și plată + 45 de zile. */
const MATCH_BEFORE_DAYS = 7;
const MATCH_AFTER_DAYS = 45;

/** Înlocuiește dividendele de la provider ale unui simbol (cele introduse manual rămân). */
export function saveDividendEvents(db: Db, userId: number, symbol: string, events: ProviderDividend[], provider: string | null): void {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO dividend_events (user_id, symbol, ex_date, pay_date, amount, currency, source, amount_estimated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    db.prepare("DELETE FROM dividend_events WHERE user_id = ? AND symbol = ? AND source <> 'manual'").run(userId, symbol);
    for (const e of events) {
      if (!isIsoDate(e.exDate) || !(e.amount > 0)) continue;
      insert.run(userId, symbol, e.exDate, e.payDate && isIsoDate(e.payDate) ? e.payDate : null, String(e.amount), e.currency, provider ?? 'api', e.amountEstimated ? 1 : 0);
    }
    db.prepare('INSERT OR REPLACE INTO dividend_sync (user_id, symbol, provider, fetched_at) VALUES (?, ?, ?, ?)').run(
      userId,
      symbol,
      provider,
      new Date().toISOString()
    );
  })();
}

/** Un dividend anunțat, introdus manual (ex.: din comunicatul companiei). */
export function addManualDividend(db: Db, userId: number, input: ManualDividendInput): void {
  const asset = listAssets(db, userId).find((a) => a.id === Number(input.assetId));
  assert(asset, 'Activul nu a fost găsit.');
  assert(asset.type === 'stock' || asset.type === 'etf', 'Dividendele se introduc doar pentru acțiuni și ETF-uri.');
  assert(isIsoDate(input.exDate), 'Data ex-dividend nu este validă.');
  const payDate = input.payDate ? String(input.payDate) : null;
  assert(payDate === null || isIsoDate(payDate), 'Data plății nu este validă.');
  assert(payDate === null || payDate >= input.exDate, 'Data plății nu poate fi înaintea datei ex-dividend.');
  const amount = Number(input.amount);
  assert(Number.isFinite(amount) && amount > 0, 'Suma pe acțiune trebuie să fie mai mare decât zero.');
  db.prepare(
    "INSERT OR REPLACE INTO dividend_events (user_id, symbol, ex_date, pay_date, amount, currency, source, amount_estimated) VALUES (?, ?, ?, ?, ?, ?, 'manual', 0)"
  ).run(userId, asset.symbol, input.exDate, payDate, String(amount), asset.currency);
}

export function deleteManualDividend(db: Db, userId: number, id: number): void {
  const info = db.prepare("DELETE FROM dividend_events WHERE id = ? AND user_id = ? AND source = 'manual'").run(id, userId);
  assert(info.changes === 1, 'Dividendul nu a fost găsit.');
}

/** „Nu l-am primit”: dividendul propus nu se mai propune. */
export function dismissDividend(db: Db, userId: number, assetId: number, exDate: string): void {
  assert(listAssets(db, userId).some((a) => a.id === Number(assetId)), 'Activul nu a fost găsit.');
  assert(isIsoDate(exDate), 'Data nu este validă.');
  db.prepare('INSERT OR IGNORE INTO dividend_dismissals (user_id, asset_id, ex_date) VALUES (?, ?, ?)').run(userId, Number(assetId), exDate);
}

interface KnownEvent extends DividendPoint {
  status: DividendStatus;
  manualId: number | null;
  payDateEstimated: boolean;
  coupon: boolean;
}

/** Dividendele cunoscute ale unui simbol: cele manuale le înlocuiesc pe cele de la provider din aceeași perioadă (±5 zile). */
function knownEvents(rows: EventRow[]): KnownEvent[] {
  const manual = rows.filter((r) => r.source === 'manual');
  const near = (a: string, b: string): boolean => Math.abs(Date.parse(a) - Date.parse(b)) <= 5 * 86_400_000;
  const out: KnownEvent[] = [];
  for (const r of rows) {
    if (r.source !== 'manual' && manual.some((m) => near(m.ex_date, r.ex_date))) continue;
    out.push({
      exDate: r.ex_date,
      payDate: r.pay_date,
      amount: Number(r.amount),
      status: r.source === 'manual' ? 'manual' : r.amount_estimated ? 'estimated' : 'announced',
      manualId: r.source === 'manual' ? r.id : null,
      payDateEstimated: false,
      coupon: false
    });
  }
  return out.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
}

interface Account {
  portfolioId: number;
  brokerId: number;
  quantity: number;
}

export function getDividendCalendar(db: Db, userId: number, year: number, filter: PortfolioFilter = {}, today: string = todayIso()): DividendCalendar {
  const y = Math.trunc(Number(year)) || Number(today.slice(0, 4));
  const scope = resolveScope(db, userId, filter.portfolioId);
  const base = scope.baseCurrency;
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const brokers = new Map(listBrokers(db, userId).map((b) => [b.id, b.name]));
  const cache = getCachedPrices(db, userId);
  const txs = allLedgerTxs(db, userId).filter(scope.includes).filter((t) => !filter.brokerId || t.brokerId == null || t.brokerId === filter.brokerId);
  const yearStart = `${y}-01-01`;
  const yearEnd = `${y}-12-31`;
  const windowStart = [yearStart, addDays(today, -PROPOSAL_WINDOW_DAYS)].sort()[0];
  const windowEnd = [yearEnd, addDays(today, 365)].sort()[1];

  // Activele care au trecut prin portofoliu (acțiuni, ETF-uri și obligațiuni).
  const touched = new Set<number>();
  for (const t of txs) if (t.type === 'buy' && t.assetId != null) touched.add(t.assetId);
  const relevant = [...touched].map((id) => assets.get(id)).filter((a): a is Asset => !!a && a.type !== 'crypto');

  const rows = relevant.length
    ? (db
        .prepare(`SELECT * FROM dividend_events WHERE user_id = ? AND symbol IN (${relevant.map(() => '?').join(',')}) ORDER BY ex_date`)
        .all(userId, ...relevant.map((a) => a.symbol)) as EventRow[])
    : [];
  const bySymbol = new Map<string, EventRow[]>();
  for (const r of rows) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
  const dismissed = new Set(
    (db.prepare('SELECT asset_id, ex_date FROM dividend_dismissals WHERE user_id = ?').all(userId) as { asset_id: number; ex_date: string }[]).map(
      (d) => `${d.asset_id}:${d.ex_date}`
    )
  );

  // Toate dividendele (cunoscute + estimate) și cupoanele, pe activ.
  const eventsOf = new Map<number, KnownEvent[]>();
  const knownOf = new Map<number, KnownEvent[]>();
  for (const asset of relevant) {
    if (asset.type === 'bond') {
      if (!asset.maturityDate || !asset.faceValue || !asset.couponRate || !asset.couponFrequency) continue;
      const per = couponPerPayment({ faceValue: asset.faceValue, couponRate: asset.couponRate, couponFrequency: asset.couponFrequency });
      eventsOf.set(
        asset.id,
        couponDates(asset.maturityDate, asset.couponFrequency, addDays(windowStart, -60), windowEnd).map((d) => ({
          exDate: d,
          payDate: d,
          amount: per,
          status: 'announced' as DividendStatus,
          manualId: null,
          payDateEstimated: false,
          coupon: true
        }))
      );
      continue;
    }
    const known = knownEvents(bySymbol.get(asset.symbol) ?? []);
    knownOf.set(asset.id, known);
    const projected = projectDividends(known, today, windowEnd).map<KnownEvent>((p) => ({
      ...p,
      status: 'estimated',
      manualId: null,
      coupon: false
    }));
    const schedule = inferSchedule(known, today);
    const lag = schedule.payLagDays ?? 14;
    // Doar dividendele din perioada afișată (cu o marjă, pentru plățile care trec dintr-un an în altul).
    const shown = (e: KnownEvent): boolean => e.exDate >= addDays(windowStart, -60) && e.exDate <= windowEnd;
    eventsOf.set(
      asset.id,
      [...known.map((k) => (k.payDate ? k : { ...k, payDate: addDays(k.exDate, lag), payDateEstimated: true })), ...projected].filter(shown)
    );
  }

  // Cantitatea deținută în ziua dinaintea datei ex-dividend, pe cont (portofoliu + broker): o singură trecere prin tranzacții.
  const accountsAt = new Map<string, Account[]>();
  const ledger = new Ledger({
    method: 'AVG',
    multiplierOf: (id) => {
      const a = assets.get(id);
      return a ? priceMultiplier(a) : 1;
    },
    strict: false
  });
  const checkpoints: { assetId: number; exDate: string }[] = [];
  for (const [assetId, list] of eventsOf) for (const e of list) checkpoints.push({ assetId, exDate: e.exDate });
  checkpoints.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  let i = 0;
  for (const cp of checkpoints) {
    const cut = cp.exDate <= today ? cp.exDate : addDays(today, 1);
    while (i < txs.length && txs[i].date < cut) ledger.apply(txs[i++]);
    const key = `${cp.assetId}:${cp.exDate}`;
    if (accountsAt.has(key)) continue;
    accountsAt.set(
      key,
      ledger
        .list()
        .filter((p) => p.assetId === cp.assetId && p.quantity > 0 && p.portfolioId != null)
        .map((p) => ({ portfolioId: p.portfolioId as number, brokerId: p.brokerId, quantity: p.quantity }))
    );
  }
  while (i < txs.length) ledger.apply(txs[i++]);
  const now = ledger.list();

  // Cursuri: cel din ziua plății pentru ce s-a încasat, cel de azi pentru estimări.
  const currencies = [...new Set(relevant.map((a) => a.currency).filter((c) => c !== base))];
  const fxOn = makeFxOn(base, loadHistory(db, userId, currencies.map((c) => fxSymbol(c, base))), cache, today);
  const fxNow = (c: string): number => resolveFx(cache, c, base).rate;

  // Tranzacțiile de dividend/cupon, pe activ, ca să fie potrivite cu dividendele anunțate.
  const incomeTxs = txs.filter((t) => (t.type === 'dividend' || t.type === 'coupon') && t.assetId != null && t.portfolioId != null);
  const used = new Set<number>();
  const grossOf = (t: LedgerTx): number => {
    const g = toNum(dec(t.grossAmount));
    return g !== 0 ? g : toNum(dec(t.netAmount).plus(dec(t.taxWithheld)));
  };

  // Ponderea impozitului reținut la dividendele anterioare ale fiecărui activ (pentru propuneri).
  const taxRatio = new Map<number, number>();
  for (const t of incomeTxs) {
    const g = grossOf(t);
    if (g > 0) taxRatio.set(t.assetId as number, toNum(dec(t.taxWithheld)) / g);
  }

  const entries: DividendCalendarEntry[] = [];
  const proposals: DividendProposal[] = [];
  for (const asset of relevant) {
    for (const e of eventsOf.get(asset.id) ?? []) {
      const accounts = accountsAt.get(`${asset.id}:${e.exDate}`) ?? [];
      const quantity = accounts.reduce((s, a) => s + a.quantity, 0);
      if (!(quantity > 0)) continue;
      const payDate = e.payDate as string;
      // Încasările care corespund acestui dividend (pe același activ, în fereastra de timp).
      const from = addDays(e.exDate, -MATCH_BEFORE_DAYS);
      const to = addDays(payDate, MATCH_AFTER_DAYS);
      // Cel mult o încasare pe cont (prima din fereastră), ca la plățile lunare să nu se ia și luna următoare.
      const byAccount = new Map<string, LedgerTx>();
      for (const t of incomeTxs) {
        if (t.assetId !== asset.id || used.has(t.id) || t.date < from || t.date > to) continue;
        const k = `${t.portfolioId}:${t.brokerId}`;
        if (!byAccount.has(k)) byAccount.set(k, t);
      }
      const matched = [...byAccount.values()];
      for (const t of matched) used.add(t.id);
      const paidAccounts = new Set(byAccount.keys());
      const paidQty = accounts.filter((a) => paidAccounts.has(`${a.portfolioId}:${a.brokerId}`)).reduce((s, a) => s + a.quantity, 0);

      if (matched.length > 0) {
        const gross = matched.reduce((s, t) => s + grossOf(t), 0);
        entries.push({
          key: `${asset.id}:${e.exDate}:r`,
          assetId: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          assetType: asset.type,
          exDate: e.exDate,
          payDate: matched[matched.length - 1].date,
          payDateEstimated: false,
          amountPerShare: e.amount,
          currency: asset.currency,
          quantity: paidQty > 0 ? paidQty : quantity,
          gross,
          net: matched.reduce((s, t) => s + toNum(dec(t.netAmount)), 0),
          grossBase: matched.reduce((s, t) => s + grossOf(t) * Number(fxOn(asset.currency, t.date)), 0),
          status: 'received',
          coupon: e.coupon,
          manualId: e.manualId
        });
      }
      // Conturile care încă nu au încasat dividendul.
      const unpaid = accounts.filter((a) => !paidAccounts.has(`${a.portfolioId}:${a.brokerId}`));
      if (unpaid.length === 0) continue;
      // Un dividend vechi, neînregistrat, nu se mai arată (probabil nu a fost încasat sau e înregistrat altfel).
      if (payDate < addDays(today, -PROPOSAL_WINDOW_DAYS)) continue;
      const unpaidQty = unpaid.reduce((s, a) => s + a.quantity, 0);
      const gross = toNum(dec(unpaidQty).times(dec(e.amount)));
      {
        entries.push({
          key: `${asset.id}:${e.exDate}:e`,
          assetId: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          assetType: asset.type,
          exDate: e.exDate,
          payDate,
          payDateEstimated: e.payDateEstimated,
          amountPerShare: e.amount,
          currency: asset.currency,
          quantity: unpaidQty,
          gross,
          net: null,
          grossBase: gross * fxNow(asset.currency),
          status: e.status,
          coupon: e.coupon,
          manualId: e.manualId
        });
      }
      if (payDate <= today && !dismissed.has(`${asset.id}:${e.exDate}`)) {
        for (const a of unpaid) {
          const g = toNum(dec(a.quantity).times(dec(e.amount)));
          proposals.push({
            key: `${asset.id}:${e.exDate}:${a.portfolioId}:${a.brokerId}`,
            assetId: asset.id,
            symbol: asset.symbol,
            name: asset.name,
            portfolioId: a.portfolioId,
            portfolioName: scope.byId.get(a.portfolioId)?.name ?? '—',
            brokerId: a.brokerId,
            brokerName: brokers.get(a.brokerId) ?? '—',
            exDate: e.exDate,
            payDate,
            quantity: a.quantity,
            amountPerShare: e.amount,
            currency: asset.currency,
            gross: Number(g.toFixed(2)),
            tax: Number((g * (taxRatio.get(asset.id) ?? 0)).toFixed(2)),
            status: e.status,
            coupon: e.coupon
          });
        }
      }
    }
  }
  // Încasările fără un dividend anunțat corespunzător apar și ele, la data tranzacției.
  for (const t of incomeTxs) {
    if (used.has(t.id)) continue;
    const asset = assets.get(t.assetId as number);
    if (!asset) continue;
    const gross = grossOf(t);
    entries.push({
      key: `tx:${t.id}`,
      assetId: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      assetType: asset.type,
      exDate: null,
      payDate: t.date,
      payDateEstimated: false,
      amountPerShare: null,
      currency: asset.currency,
      quantity: 0,
      gross,
      net: toNum(dec(t.netAmount)),
      grossBase: gross * Number(fxOn(asset.currency, t.date)),
      status: 'received',
      coupon: t.type === 'coupon',
      manualId: null
    });
  }
  entries.sort((a, b) => (a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : a.symbol.localeCompare(b.symbol)));

  const inYear = entries.filter((e) => e.payDate >= yearStart && e.payDate <= yearEnd);
  const months = Array.from({ length: 12 }, (_, k) => ({ month: k + 1, received: 0, estimated: 0 }));
  for (const e of inYear) {
    const m = months[Number(e.payDate.slice(5, 7)) - 1];
    if (e.status === 'received') m.received += e.grossBase;
    else m.estimated += e.grossBase;
  }
  const next12Months = entries
    .filter((e) => e.status !== 'received' && e.payDate > today && e.payDate <= addDays(today, 365))
    .reduce((s, e) => s + e.grossBase, 0);

  // Randamentul din dividende al pozițiilor deținute acum (acțiuni și ETF-uri).
  const held = new Map<number, { quantity: number; cost: number }>();
  for (const p of now) {
    if (p.quantity <= 0) continue;
    const h = held.get(p.assetId) ?? { quantity: 0, cost: 0 };
    h.quantity += p.quantity;
    h.cost += p.costBasis;
    held.set(p.assetId, h);
  }
  const yields: DividendYieldRow[] = [];
  const withoutData: string[] = [];
  for (const [assetId, h] of held) {
    const asset = assets.get(assetId);
    if (!asset || (asset.type !== 'stock' && asset.type !== 'etf')) continue;
    const known = knownOf.get(assetId) ?? [];
    let trailing = trailingDividends(known, today);
    let forward = forwardAnnualDividend(known, today);
    if (known.length === 0) {
      // Fără date de la provider: din dividendele încasate în ultimele 12 luni.
      const received = incomeTxs.filter((t) => t.assetId === assetId && t.date > addDays(today, -365)).reduce((s, t) => s + grossOf(t), 0);
      trailing = h.quantity > 0 ? received / h.quantity : 0;
      forward = trailing;
      if (received === 0) {
        withoutData.push(asset.symbol);
        continue;
      }
    }
    if (trailing === 0 && forward === 0) continue;
    const price = resolvePrice(asset, cache)?.price ?? null;
    const avgCost = h.quantity > 0 ? h.cost / h.quantity : null;
    yields.push({
      assetId,
      symbol: asset.symbol,
      name: asset.name,
      assetType: asset.type,
      currency: asset.currency,
      quantity: h.quantity,
      trailingPerShare: trailing,
      frequency: inferSchedule(known, today).frequency,
      yield: price && price > 0 ? trailing / price : null,
      yieldOnCost: avgCost && avgCost > 0 ? trailing / avgCost : null,
      annualIncomeBase: forward * h.quantity * fxNow(asset.currency)
    });
  }
  yields.sort((a, b) => b.annualIncomeBase - a.annualIncomeBase);

  const years = new Set<number>([Number(today.slice(0, 4)), y]);
  for (const t of incomeTxs) years.add(Number(t.date.slice(0, 4)));

  return {
    year: y,
    baseCurrency: base,
    months,
    receivedTotal: months.reduce((s, m) => s + m.received, 0),
    estimatedTotal: months.reduce((s, m) => s + m.estimated, 0),
    next12Months,
    entries: inYear,
    proposals: proposals.sort((a, b) => (a.payDate < b.payDate ? 1 : -1)),
    yields,
    withoutData: withoutData.sort(),
    years: [...years].sort((a, b) => b - a)
  };
}
