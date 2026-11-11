/**
 * Raportul anual pentru taxe: pe broker și pe monedă, câștigurile și pierderile realizate din
 * vânzări, dividendele, cupoanele și dobânzile (brut, impozit reținut, net) și comisioanele plătite.
 *
 * Toate sumele au și echivalentul în lei, la cursul din ziua fiecărei tranzacții: cursul BNR dacă
 * a putut fi descărcat, altfel cursul din aplicație. Costul unităților vândute se convertește la
 * cursul din zilele de cumpărare, încasarea la cursul din ziua vânzării.
 *
 * Aplicația nu calculează impozitul de plată: raportul doar totalizează cifrele.
 */
import type {
  Asset,
  Broker,
  BrokerResidence,
  FxSource,
  TaxDetailRow,
  TaxGroupTotals,
  TaxReport,
  TaxSection
} from '@shared/types';
import { TRANSACTION_TYPE_LABEL } from '@shared/labels';
import { FX_SOURCE_LABEL, RESIDENCE_LABEL, RESIDENCE_SECTION_LABEL, TAX_DISCLAIMER } from '@shared/tax';
import { addDays, todayIso } from '@shared/dates';
import { toCsv } from '@shared/csv';
import { Ledger, priceMultiplier, type LedgerTx, type SaleRecord } from '@shared/calc';
import { dec, toNum, ZERO, type Decimal } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { assert } from './common';
import { listAssets } from './assets';
import { listBrokers } from './brokers';
import { listPortfolios } from './portfolios';
import { getSettings } from './settings';
import { allLedgerTxs } from './portfolio';
import { bnrRateOn, ensureBnrYears, loadBnrRates, type Fetcher } from './bnr';
import { fxSymbol, getCachedPrices, lastOnOrBefore, loadHistory, resolveFx } from '../prices/store';

const RON = 'RON';
const REPORT_TYPES = new Set(['buy', 'sell', 'dividend', 'coupon', 'interest', 'fee']);

interface Scope {
  portfolioId: number | null;
  portfolioName: string | null;
  names: Map<number, string>;
  txs: LedgerTx[];
}

/** Tranzacțiile raportului: toate portofoliile (inclusiv cele arhivate — impozitul privește persoana) sau unul singur. */
function scopeOf(db: Db, userId: number, portfolioId: number | null): Scope {
  const portfolios = listPortfolios(db, userId);
  const names = new Map(portfolios.map((p) => [p.id, p.name]));
  let selected: number | null = null;
  if (portfolioId != null) {
    assert(names.has(portfolioId), 'Portofoliul nu a fost găsit.');
    selected = portfolioId;
  }
  const txs = allLedgerTxs(db, userId).filter((t) => t.portfolioId == null || selected === null || t.portfolioId === selected);
  return { portfolioId: selected, portfolioName: selected === null ? null : (names.get(selected) ?? null), names, txs };
}

function currenciesOf(txs: LedgerTx[], assets: Map<number, Asset>): string[] {
  const out = new Set<string>();
  for (const t of txs) {
    const asset = t.assetId != null ? assets.get(t.assetId) : undefined;
    for (const c of [asset?.currency, t.currency, t.cashCurrency]) if (c && c !== RON) out.add(c);
  }
  return [...out];
}

/**
 * Pregătește raportul: descarcă întâi cursurile BNR care lipsesc (pentru anii de la prima tranzacție
 * până la anul ales, ca și costul unităților cumpărate mai demult să fie la cursul oficial).
 */
export async function prepareTaxReport(db: Db, userId: number, year: number, portfolioId: number | null, fetcher?: Fetcher): Promise<TaxReport> {
  const y = Math.trunc(Number(year));
  assert(y >= 1990 && y <= 2100, 'Anul ales nu este valid.');
  const scope = scopeOf(db, userId, portfolioId);
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const inScope = scope.txs.filter((t) => t.date <= `${y}-12-31`);
  let notice: string | null = null;
  if (inScope.length > 0 && currenciesOf(inScope, assets).length > 0) {
    const first = Number(inScope[0].date.slice(0, 4));
    const years: number[] = [];
    for (let k = first; k <= y; k++) years.push(k);
    notice = await ensureBnrYears(db, userId, years, fetcher);
  }
  return getTaxReport(db, userId, y, portfolioId, todayIso(), notice);
}

type Money3 = { gross: Decimal; tax: Decimal; net: Decimal; grossRon: Decimal; taxRon: Decimal; netRon: Decimal };
const money3 = (): Money3 => ({ gross: ZERO, tax: ZERO, net: ZERO, grossRon: ZERO, taxRon: ZERO, netRon: ZERO });
const num3 = (m: Money3): TaxGroupTotals['dividends'] => ({
  gross: toNum(m.gross),
  tax: toNum(m.tax),
  net: toNum(m.net),
  grossRon: toNum(m.grossRon),
  taxRon: toNum(m.taxRon),
  netRon: toNum(m.netRon)
});

interface GroupAcc {
  brokerId: number;
  brokerName: string;
  residence: BrokerResidence;
  currency: string;
  sales: number;
  proceeds: Decimal;
  cost: Decimal;
  gains: Decimal;
  losses: Decimal;
  proceedsRon: Decimal;
  costRon: Decimal;
  gainsRon: Decimal;
  lossesRon: Decimal;
  dividends: Money3;
  coupons: Money3;
  interest: Money3;
  fees: Decimal;
  feesRon: Decimal;
}

/** Raportul pentru anul dat (cursurile BNR trebuie să fie deja descărcate, vezi `prepareTaxReport`). */
export function getTaxReport(db: Db, userId: number, year: number, portfolioId: number | null, today: string = todayIso(), bnrNotice: string | null = null): TaxReport {
  const settings = getSettings(db, userId);
  const scope = scopeOf(db, userId, portfolioId);
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const brokers = new Map<number, Broker>(listBrokers(db, userId).map((b) => [b.id, b]));
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const upToYearEnd = scope.txs.filter((t) => t.date <= yearEnd);

  // Cursul în lei la o dată: BNR, altfel istoricul din aplicație, altfel cursul de azi.
  const currencies = currenciesOf(upToYearEnd, assets);
  const bnr = loadBnrRates(db, userId, currencies);
  const fxHistory = loadHistory(db, userId, currencies.map((c) => fxSymbol(c, RON)));
  const cache = getCachedPrices(db, userId);
  const memo = new Map<string, { rate: Decimal; source: FxSource; date: string | null }>();
  const rateInfo = (currency: string | null | undefined, date: string): { rate: Decimal; source: FxSource; date: string | null } => {
    if (!currency || currency === RON) return { rate: dec(1), source: 'ron', date: null };
    const key = `${currency}:${date}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let info: { rate: Decimal; source: FxSource; date: string | null };
    const official = bnrRateOn(bnr.get(currency), date);
    if (official) info = { rate: dec(official.rate), source: 'bnr', date: official.date };
    else {
      const rows = fxHistory.get(fxSymbol(currency, RON));
      const row = lastOnOrBefore(rows, date);
      if (row && row.date >= addDays(date, -10)) info = { rate: dec(row.close), source: 'app', date: row.date };
      else info = { rate: dec(resolveFx(cache, currency, RON).rate), source: 'current', date: today };
    }
    memo.set(key, info);
    return info;
  };

  const currencyOfTx = (t: LedgerTx): string => t.currency || (t.assetId != null ? assets.get(t.assetId)?.currency : null) || RON;
  const ledger = new Ledger({
    method: settings.costMethod,
    multiplierOf: (id) => {
      const a = assets.get(id);
      return a ? priceMultiplier(a) : 1;
    },
    currencyOf: (id) => assets.get(id)?.currency,
    fxAt: (currency, date) => rateInfo(currency, date).rate,
    strict: false
  }).applyAll(upToYearEnd);
  const sales = new Map<number, SaleRecord>(ledger.sales().filter((s) => s.date >= yearStart).map((s) => [s.txId, s]));

  const groups = new Map<string, GroupAcc>();
  const groupOf = (brokerId: number, currency: string): GroupAcc => {
    const key = `${brokerId}:${currency}`;
    let g = groups.get(key);
    if (!g) {
      const b = brokers.get(brokerId);
      g = {
        brokerId,
        brokerName: b?.name ?? '—',
        residence: b?.residence ?? 'foreign',
        currency,
        sales: 0,
        proceeds: ZERO,
        cost: ZERO,
        gains: ZERO,
        losses: ZERO,
        proceedsRon: ZERO,
        costRon: ZERO,
        gainsRon: ZERO,
        lossesRon: ZERO,
        dividends: money3(),
        coupons: money3(),
        interest: money3(),
        fees: ZERO,
        feesRon: ZERO
      };
      groups.set(key, g);
    }
    return g;
  };

  const fxSources: Record<FxSource, number> = { ron: 0, bnr: 0, app: 0, current: 0 };
  const details: TaxDetailRow[] = [];

  for (const t of upToYearEnd) {
    if (t.date < yearStart || !REPORT_TYPES.has(t.type) || t.brokerId == null) continue;
    const fee = dec(t.fee).abs();
    if (t.type === 'buy' && fee.isZero()) continue; // o cumpărare fără comision nu are nimic de raportat
    const asset = t.assetId != null ? assets.get(t.assetId) : undefined;
    const currency = currencyOfTx(t);
    const fx = rateInfo(currency, t.date);
    const g = groupOf(t.brokerId, currency);
    const row: TaxDetailRow = {
      id: t.id,
      date: t.date,
      type: t.type,
      brokerName: g.brokerName,
      residence: g.residence,
      portfolioName: t.portfolioId != null ? (scope.names.get(t.portfolioId) ?? null) : null,
      symbol: asset?.symbol ?? null,
      name: asset?.name ?? null,
      currency,
      quantity: t.type === 'buy' || t.type === 'sell' ? toNum(dec(t.quantity)) : null,
      price: t.type === 'buy' || t.type === 'sell' ? toNum(dec(t.price)) : null,
      proceeds: null,
      cost: null,
      gain: null,
      gross: null,
      tax: null,
      net: null,
      fee: 0,
      fxRate: toNum(fx.rate),
      fxSource: fx.source,
      fxDate: fx.date,
      proceedsRon: null,
      costRon: null,
      gainRon: null,
      grossRon: null,
      taxRon: null,
      netRon: null,
      feeRon: 0
    };

    if (t.type === 'buy' || t.type === 'sell') {
      row.fee = toNum(fee);
      row.feeRon = toNum(fee.times(fx.rate));
      g.fees = g.fees.plus(fee);
      g.feesRon = g.feesRon.plus(fee.times(fx.rate));
    }
    if (t.type === 'sell') {
      const s = sales.get(t.id);
      if (!s) continue; // vânzare ignorată de motor (nimic de vândut la acea dată)
      const proceedsRon = s.proceedsBase ?? s.proceeds.times(fx.rate);
      const costRon = s.costBase ?? s.cost.times(fx.rate);
      const gainRon = proceedsRon.minus(costRon);
      Object.assign(row, {
        quantity: toNum(s.quantity),
        proceeds: toNum(s.proceeds),
        cost: toNum(s.cost),
        gain: toNum(s.gain),
        proceedsRon: toNum(proceedsRon),
        costRon: toNum(costRon),
        gainRon: toNum(gainRon)
      });
      g.sales++;
      g.proceeds = g.proceeds.plus(s.proceeds);
      g.cost = g.cost.plus(s.cost);
      if (s.gain.gte(0)) g.gains = g.gains.plus(s.gain);
      else g.losses = g.losses.plus(s.gain);
      g.proceedsRon = g.proceedsRon.plus(proceedsRon);
      g.costRon = g.costRon.plus(costRon);
      if (gainRon.gte(0)) g.gainsRon = g.gainsRon.plus(gainRon);
      else g.lossesRon = g.lossesRon.plus(gainRon);
    } else if (t.type === 'dividend' || t.type === 'coupon' || t.type === 'interest') {
      const net = dec(t.netAmount);
      const tax = dec(t.taxWithheld).abs();
      const grossRaw = dec(t.grossAmount);
      const gross = grossRaw.isZero() ? net.plus(tax) : grossRaw;
      const target = t.type === 'dividend' ? g.dividends : t.type === 'coupon' ? g.coupons : g.interest;
      target.gross = target.gross.plus(gross);
      target.tax = target.tax.plus(tax);
      target.net = target.net.plus(net);
      target.grossRon = target.grossRon.plus(gross.times(fx.rate));
      target.taxRon = target.taxRon.plus(tax.times(fx.rate));
      target.netRon = target.netRon.plus(net.times(fx.rate));
      Object.assign(row, {
        gross: toNum(gross),
        tax: toNum(tax),
        net: toNum(net),
        grossRon: toNum(gross.times(fx.rate)),
        taxRon: toNum(tax.times(fx.rate)),
        netRon: toNum(net.times(fx.rate))
      });
    } else if (t.type === 'fee') {
      const amount = dec(t.netAmount).abs();
      row.fee = toNum(amount);
      row.feeRon = toNum(amount.times(fx.rate));
      g.fees = g.fees.plus(amount);
      g.feesRon = g.feesRon.plus(amount.times(fx.rate));
    }
    fxSources[fx.source]++;
    details.push(row);
  }

  const sections: TaxSection[] = [];
  for (const residence of ['ro', 'foreign'] as BrokerResidence[]) {
    const list = [...groups.values()]
      .filter((g) => g.residence === residence)
      .sort((a, b) => a.brokerName.localeCompare(b.brokerName, 'ro') || a.currency.localeCompare(b.currency));
    if (list.length === 0) continue;
    const sumOf = (pick: (g: GroupAcc) => Decimal): number => toNum(list.reduce((s, g) => s.plus(pick(g)), ZERO));
    sections.push({
      residence,
      groups: list.map((g) => ({
        brokerId: g.brokerId,
        brokerName: g.brokerName,
        residence: g.residence,
        currency: g.currency,
        sales: g.sales,
        proceeds: toNum(g.proceeds),
        cost: toNum(g.cost),
        gains: toNum(g.gains),
        losses: toNum(g.losses),
        net: toNum(g.gains.plus(g.losses)),
        proceedsRon: toNum(g.proceedsRon),
        costRon: toNum(g.costRon),
        gainsRon: toNum(g.gainsRon),
        lossesRon: toNum(g.lossesRon),
        netRon: toNum(g.gainsRon.plus(g.lossesRon)),
        dividends: num3(g.dividends),
        coupons: num3(g.coupons),
        interest: num3(g.interest),
        fees: toNum(g.fees),
        feesRon: toNum(g.feesRon)
      })),
      totalRon: {
        gains: sumOf((g) => g.gainsRon),
        losses: sumOf((g) => g.lossesRon),
        net: sumOf((g) => g.gainsRon.plus(g.lossesRon)),
        dividendsGross: sumOf((g) => g.dividends.grossRon),
        dividendsTax: sumOf((g) => g.dividends.taxRon),
        dividendsNet: sumOf((g) => g.dividends.netRon),
        couponsGross: sumOf((g) => g.coupons.grossRon),
        couponsTax: sumOf((g) => g.coupons.taxRon),
        couponsNet: sumOf((g) => g.coupons.netRon),
        interestGross: sumOf((g) => g.interest.grossRon),
        interestTax: sumOf((g) => g.interest.taxRon),
        interestNet: sumOf((g) => g.interest.netRon),
        fees: sumOf((g) => g.feesRon)
      }
    });
  }

  const years = new Set<number>([Number(today.slice(0, 4))]);
  for (const t of scope.txs) if (REPORT_TYPES.has(t.type)) years.add(Number(t.date.slice(0, 4)));

  return {
    year,
    portfolioId: scope.portfolioId,
    portfolioName: scope.portfolioName,
    years: [...years].sort((a, b) => b - a),
    sections,
    details,
    fxSources,
    bnrNotice,
    costMethod: settings.costMethod
  };
}

/* ------------------------------------------------------------------ export */

/** Număr în format românesc pentru CSV (virgulă zecimală, fără separator de mii). */
const csvNum = (v: number | null, digits = 2): string => (v === null ? '' : v.toFixed(digits).replace('.', ','));
const csvQty = (v: number | null): string => (v === null ? '' : String(Number(v.toFixed(8))).replace('.', ','));

/** CSV cu detalierea fiecărei tranzacții (separator „;”, virgulă zecimală, ca să se deschidă corect în Excel în română). */
export function taxReportCsv(report: TaxReport): string {
  const header = [
    'Data',
    'Tip',
    'Broker',
    'Tip broker',
    'Portofoliu',
    'Simbol',
    'Denumire',
    'Monedă',
    'Cantitate',
    'Preț',
    'Încasare',
    'Cost',
    'Profit/pierdere',
    'Brut',
    'Impozit reținut',
    'Net',
    'Comision',
    'Curs (lei)',
    'Sursa cursului',
    'Data cursului',
    'Încasare (RON)',
    'Cost (RON)',
    'Profit/pierdere (RON)',
    'Brut (RON)',
    'Impozit reținut (RON)',
    'Net (RON)',
    'Comision (RON)'
  ];
  const rows: (string | number | null)[][] = [header];
  for (const d of report.details) {
    rows.push([
      d.date,
      TRANSACTION_TYPE_LABEL[d.type],
      d.brokerName,
      RESIDENCE_LABEL[d.residence],
      d.portfolioName ?? '',
      d.symbol ?? '',
      d.name ?? '',
      d.currency,
      csvQty(d.quantity),
      d.price === null ? '' : csvQty(d.price),
      csvNum(d.proceeds),
      csvNum(d.cost),
      csvNum(d.gain),
      csvNum(d.gross),
      csvNum(d.tax),
      csvNum(d.net),
      d.fee ? csvNum(d.fee) : '',
      csvNum(d.fxRate, 4),
      FX_SOURCE_LABEL[d.fxSource],
      d.fxDate ?? '',
      csvNum(d.proceedsRon),
      csvNum(d.costRon),
      csvNum(d.gainRon),
      csvNum(d.grossRon),
      csvNum(d.taxRon),
      csvNum(d.netRon),
      d.feeRon ? csvNum(d.feeRon) : ''
    ]);
  }
  rows.push([]);
  rows.push(['Notă', TAX_DISCLAIMER]);
  // BOM: Excel recunoaște astfel diacriticele (UTF-8).
  return `﻿${toCsv(rows, ';')}`;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v: number | null, digits = 2): string =>
  v === null ? '—' : v.toLocaleString('ro-RO', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtDate = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Documentul HTML din care se face PDF-ul (tipărit de Electron, fără scripturi și fără resurse externe). */
export function taxReportHtml(report: TaxReport, generatedAt: Date = new Date()): string {
  const scope = report.portfolioName ? `Portofoliul „${esc(report.portfolioName)}”` : 'Toate portofoliile (inclusiv cele arhivate)';
  const money3Rows = (label: string, m: TaxGroupTotals['dividends'], currency: string): string =>
    m.gross === 0 && m.tax === 0 && m.net === 0
      ? ''
      : `<tr><td>${label}</td><td class="r">${fmt(m.gross)} ${currency}</td><td class="r">${fmt(m.tax)} ${currency}</td><td class="r">${fmt(m.net)} ${currency}</td><td class="r">${fmt(m.grossRon)}</td><td class="r">${fmt(m.taxRon)}</td><td class="r">${fmt(m.netRon)}</td></tr>`;

  const sectionHtml = report.sections
    .map((s) => {
      const groups = s.groups
        .map((g) => {
          const income = [money3Rows('Dividende', g.dividends, g.currency), money3Rows('Cupoane', g.coupons, g.currency), money3Rows('Dobânzi', g.interest, g.currency)].join('');
          return `
          <h3>${esc(g.brokerName)} · ${g.currency}</h3>
          ${
            g.sales > 0
              ? `<table><thead><tr><th>Vânzări</th><th class="r">Încasări</th><th class="r">Cost</th><th class="r">Câștiguri</th><th class="r">Pierderi</th><th class="r">Rezultat net</th></tr></thead><tbody>
              <tr><td>${g.sales} ${g.sales === 1 ? 'vânzare' : 'vânzări'} (${g.currency})</td><td class="r">${fmt(g.proceeds)}</td><td class="r">${fmt(g.cost)}</td><td class="r">${fmt(g.gains)}</td><td class="r">${fmt(g.losses)}</td><td class="r b">${fmt(g.net)}</td></tr>
              <tr><td>În lei (RON)</td><td class="r">${fmt(g.proceedsRon)}</td><td class="r">${fmt(g.costRon)}</td><td class="r">${fmt(g.gainsRon)}</td><td class="r">${fmt(g.lossesRon)}</td><td class="r b">${fmt(g.netRon)}</td></tr>
              </tbody></table>`
              : ''
          }
          ${
            income
              ? `<table><thead><tr><th>Venituri</th><th class="r">Brut</th><th class="r">Impozit reținut</th><th class="r">Net</th><th class="r">Brut (RON)</th><th class="r">Impozit (RON)</th><th class="r">Net (RON)</th></tr></thead><tbody>${income}</tbody></table>`
              : ''
          }
          ${g.fees > 0 ? `<p class="small">Comisioane plătite: ${fmt(g.fees)} ${g.currency} (${fmt(g.feesRon)} RON).</p>` : ''}`;
        })
        .join('');
      const t = s.totalRon;
      return `
      <section>
        <h2>${RESIDENCE_SECTION_LABEL[s.residence]}</h2>
        ${groups}
        <table class="total"><tbody>
          <tr><td>Total ${RESIDENCE_SECTION_LABEL[s.residence].toLowerCase()}, în lei</td><td class="r">Câștiguri ${fmt(t.gains)}</td><td class="r">Pierderi ${fmt(t.losses)}</td><td class="r b">Net ${fmt(t.net)}</td></tr>
          <tr><td></td><td class="r">Dividende brut ${fmt(t.dividendsGross)}</td><td class="r">Impozit ${fmt(t.dividendsTax)}</td><td class="r">Net ${fmt(t.dividendsNet)}</td></tr>
          ${t.couponsGross ? `<tr><td></td><td class="r">Cupoane brut ${fmt(t.couponsGross)}</td><td class="r">Impozit ${fmt(t.couponsTax)}</td><td class="r">Net ${fmt(t.couponsNet)}</td></tr>` : ''}
          ${t.interestGross ? `<tr><td></td><td class="r">Dobânzi brut ${fmt(t.interestGross)}</td><td class="r">Impozit ${fmt(t.interestTax)}</td><td class="r">Net ${fmt(t.interestNet)}</td></tr>` : ''}
          <tr><td></td><td class="r">Comisioane ${fmt(t.fees)}</td><td></td><td></td></tr>
        </tbody></table>
      </section>`;
    })
    .join('');

  const detailRows = report.details
    .map(
      (d) => `<tr>
        <td>${fmtDate(d.date)}</td><td>${TRANSACTION_TYPE_LABEL[d.type]}</td><td>${esc(d.brokerName)}</td><td>${esc(d.symbol ?? '—')}</td><td>${d.currency}</td>
        <td class="r">${d.quantity === null ? '' : esc(csvQty(d.quantity))}</td>
        <td class="r">${d.proceeds !== null ? fmt(d.proceeds) : d.gross !== null ? fmt(d.gross) : ''}</td>
        <td class="r">${d.cost !== null ? fmt(d.cost) : d.tax !== null ? fmt(d.tax) : ''}</td>
        <td class="r">${d.gain !== null ? fmt(d.gain) : d.net !== null ? fmt(d.net) : ''}</td>
        <td class="r">${d.fee ? fmt(d.fee) : ''}</td>
        <td class="r">${d.fxSource === 'ron' ? '' : fmt(d.fxRate, 4)}</td><td>${d.fxSource === 'ron' ? '' : FX_SOURCE_LABEL[d.fxSource]}</td>
        <td class="r">${d.gainRon !== null ? fmt(d.gainRon) : d.netRon !== null ? fmt(d.netRon) : d.feeRon ? fmt(-d.feeRon) : ''}</td>
      </tr>`
    )
    .join('');

  const sources = (Object.entries(report.fxSources) as [FxSource, number][])
    .filter(([k, v]) => v > 0 && k !== 'ron')
    .map(([k, v]) => `${FX_SOURCE_LABEL[k]}: ${v}`)
    .join(' · ');

  return `<!doctype html>
<html lang="ro"><head><meta charset="utf-8"><title>Raport fiscal ${report.year}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1d2433; font-size: 10.5px; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1.5px solid #1d2433; }
  h3 { font-size: 12px; margin: 12px 0 4px; }
  .muted { color: #5b6476; }
  .note { border: 1px solid #c9a227; background: #fff8e1; padding: 8px 10px; border-radius: 6px; margin: 10px 0; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 6px; }
  th, td { padding: 3px 6px; border-bottom: 1px solid #e3e6ec; text-align: left; vertical-align: top; }
  th { font-size: 9.5px; color: #5b6476; font-weight: 600; background: #f5f6f8; }
  .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .b { font-weight: 700; }
  .small { font-size: 9.5px; color: #5b6476; margin: 2px 0 8px; }
  .total td { border-bottom: none; background: #f5f6f8; font-weight: 600; }
  .details td, .details th { font-size: 8.5px; padding: 2px 4px; }
  section { break-inside: auto; }
  tr { break-inside: avoid; }
</style></head>
<body>
  <h1>Raport fiscal ${report.year}</h1>
  <p class="muted">${scope} · Metoda de cost: ${report.costMethod === 'FIFO' ? 'FIFO (primele cumpărate, primele vândute)' : 'cost mediu ponderat'} · Generat la ${fmtDate(generatedAt.toISOString().slice(0, 10))}</p>
  <div class="note">${TAX_DISCLAIMER}</div>
  <p class="small">Sumele în lei sunt la cursul din ziua fiecărei tranzacții (${sources || 'toate sumele sunt în lei'}). Costul unităților vândute este la cursul din zilele de cumpărare. Comisioanele de cumpărare și vânzare sunt deja incluse în cost și în încasări.</p>
  ${report.bnrNotice ? `<p class="small">${esc(report.bnrNotice)}</p>` : ''}
  ${sectionHtml || '<p>Nu există vânzări, venituri sau comisioane în acest an.</p>'}
  ${
    report.details.length > 0
      ? `<h2>Detalierea tranzacțiilor (${report.details.length})</h2>
  <table class="details"><thead><tr><th>Data</th><th>Tip</th><th>Broker</th><th>Simbol</th><th>Monedă</th><th class="r">Cantitate</th><th class="r">Încasare / Brut</th><th class="r">Cost / Impozit</th><th class="r">Profit / Net</th><th class="r">Comision</th><th class="r">Curs</th><th>Sursa</th><th class="r">Rezultat (RON)</th></tr></thead><tbody>${detailRows}</tbody></table>`
      : ''
  }
</body></html>`;
}
