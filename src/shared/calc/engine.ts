/**
 * Motorul de calcul al pozițiilor și al soldurilor de cash.
 *
 * Primește tranzacțiile în ordine cronologică și ține, pentru fiecare
 * (portofoliu, activ, broker), cantitatea deținută, costul rămas, profitul
 * realizat și veniturile încasate, iar pentru fiecare (portofoliu, broker,
 * monedă) soldul de cash. Portofoliile sunt complet separate: o vânzare dintr-un
 * portofoliu consumă doar loturile cumpărate în el. Split-urile fără portofoliu
 * (evenimente ale companiei) se aplică în toate portofoliile. Este cod pur (fără bază de date, fără Electron), deci poate fi testat
 * izolat și folosit atât în procesul principal, cât și în teste.
 *
 * Toată aritmetica este zecimală exactă (vezi `decimal.ts`); numerele
 * JavaScript apar doar în rezultatele expuse (`PositionState`), pentru afișare.
 *
 * Convenții:
 *  - sumele unei poziții sunt în moneda activului; dacă motorul primește
 *    `fxAt`, ține în paralel costul și profitul realizat în moneda de bază, la
 *    cursul din ZIUA fiecărei tranzacții (nu la cursul de azi);
 *  - comisioanele intră în cost la cumpărare și scad încasările la vânzare;
 *  - `multiplier` transformă prețul în bani pe unitate: 1 pentru acțiuni, ETF-uri
 *    și crypto; (valoare nominală / 100) pentru obligațiuni, unde prețul este
 *    exprimat ca procent din nominal.
 */
import type { CostMethod, TransactionType } from '../types';
import { dec, decOrNull, Decimal, toNum, ZERO, type DecValue } from './decimal';

/** Toleranță la compararea cantităților (resturi de rotunjire din rapoartele brokerilor). */
export const EPS = 1e-9;
const EPS_DEC = new Decimal(EPS);

/** Rotunjire la 10 zecimale pentru numerele JavaScript (folosită doar în afara motorului). */
export function roundQty(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/** Tipurile care mută doar bani (fără activ). */
export const CASH_TYPES: readonly TransactionType[] = ['deposit', 'withdrawal', 'fee', 'interest', 'adjustment'];
/** Tipurile care schimbă sumele depuse în cont (fluxuri externe, pentru randamentul TWR/XIRR). */
export const EXTERNAL_FLOW_TYPES: readonly TransactionType[] = ['deposit', 'withdrawal', 'adjustment'];
export const isCashType = (type: TransactionType): boolean => CASH_TYPES.includes(type);

/** Forma minimă a unei tranzacții de care are nevoie motorul. Valorile pot fi numere sau text zecimal. */
export interface LedgerTx {
  id: number;
  /** Null la tranzacțiile de cash fără activ (depuneri, retrageri, dobânzi, comisioane generale). */
  assetId: number | null;
  /** Null doar la split-urile care se aplică la toți brokerii. */
  brokerId: number | null;
  /** Portofoliul tranzacției; null (sau lipsă) la split-uri, care se aplică în toate portofoliile. */
  portfolioId?: number | null;
  type: TransactionType;
  date: string;
  quantity: DecValue;
  price: DecValue;
  fee: DecValue;
  grossAmount: DecValue;
  taxWithheld: DecValue;
  netAmount: DecValue;
  splitNumerator: DecValue | null;
  splitDenominator: DecValue | null;
  /** Moneda tranzacției (a activului sau a sumei de cash). Lipsește doar în testele vechi. */
  currency?: string | null;
  /**
   * Efectul real asupra cash-ului, cu semn (minus = bani ieșiți), în `cashCurrency`.
   * Îl dau rapoartele brokerilor (ex.: suma debitată în moneda contului); dacă lipsește,
   * se calculează din cantitate × preț ± comision, în moneda tranzacției.
   */
  cashAmount?: DecValue | null;
  cashCurrency?: string | null;
}

/** Un lot de cumpărare încă nevândut (folosit de metoda FIFO). */
export interface Lot {
  date: string;
  quantity: number;
  /** Cost pe unitate, cu tot cu partea de comision. */
  unitCost: number;
}

/** Valorile exacte ale unei poziții (Decimal), pentru calculele care continuă în afara motorului. */
export interface ExactPosition {
  quantity: Decimal;
  costBasis: Decimal;
  realizedPnl: Decimal;
  income: Decimal;
  totalBought: Decimal;
  /** Aceleași sume în moneda de bază, la cursul din ziua fiecărei tranzacții; null fără cursuri istorice. */
  costBasisBase: Decimal | null;
  realizedPnlBase: Decimal | null;
  incomeBase: Decimal | null;
  totalBoughtBase: Decimal | null;
}

export interface PositionState {
  assetId: number;
  brokerId: number;
  portfolioId: number | null;
  quantity: number;
  /** Costul unităților rămase, inclusiv comisioanele de cumpărare aferente. */
  costBasis: number;
  /** Profit realizat din vânzări (încasări nete − costul unităților vândute − comisioane separate). */
  realizedPnl: number;
  /** Dividende și cupoane nete încasate. */
  income: number;
  grossIncome: number;
  taxWithheld: number;
  /** Suma tuturor cumpărărilor, cu comisioane. */
  totalBought: number;
  /** Suma încasată din vânzări, după comisioane. */
  totalSold: number;
  fees: number;
  lots: Lot[];
  /** Moneda de bază, la cursurile istorice (null dacă motorul nu a primit cursuri). */
  costBasisBase: number | null;
  realizedPnlBase: number | null;
  incomeBase: number | null;
  totalBoughtBase: number | null;
  exact: ExactPosition;
}

/** Soldul de cash al unui broker într-o monedă. */
export interface CashBalance {
  brokerId: number;
  portfolioId: number | null;
  currency: string;
  amount: number;
  exact: Decimal;
  /**
   * True dacă brokerul are depuneri, retrageri sau ajustări înregistrate. Fără ele,
   * soldul ar fi doar −(cumpărări) + (vânzări), adică nu un cash real, și nu se adună la portofoliu.
   */
  tracked: boolean;
}

/** Sumele unui broker care nu țin de un anumit activ: dobânzi la cash și comisioane generale. */
export interface BrokerTotals {
  brokerId: number;
  portfolioId: number | null;
  /** Dobânzi nete − comisioane fără activ, pe monedă. */
  otherIncome: Map<string, Decimal>;
  /** La fel, în moneda de bază la cursurile istorice (null fără cursuri). */
  otherIncomeBase: Decimal | null;
}

/** O vânzare, cu costul unităților vândute (după metoda de cost) și rezultatul ei, pentru raportul fiscal. */
export interface SaleRecord {
  txId: number;
  assetId: number;
  brokerId: number;
  portfolioId: number | null;
  date: string;
  quantity: Decimal;
  /** Încasarea după comisionul de vânzare, costul unităților vândute (cu comisioanele de cumpărare) și diferența. */
  proceeds: Decimal;
  cost: Decimal;
  gain: Decimal;
  fee: Decimal;
  currency: string | null;
  /** Aceleași sume în moneda de bază: încasarea la cursul zilei vânzării, costul la cursul zilelor de cumpărare. */
  proceedsBase: Decimal | null;
  costBase: Decimal | null;
  gainBase: Decimal | null;
}

/** Aruncată când o vânzare depășește cantitatea deținută la acel broker în acel moment. */
export class OversellError extends Error {
  constructor(
    public readonly tx: LedgerTx,
    public readonly available: number
  ) {
    super(`Vânzare de ${String(tx.quantity)} unități la data ${tx.date}, dar la acest broker erau disponibile doar ${available}.`);
    this.name = 'OversellError';
  }
}

/** Cheia unui „cont”: brokerul dintr-un portofoliu (cash-ul și urmărirea lui sunt pe cont). */
export const accountKey = (portfolioId: number | null | undefined, brokerId: number): string => `${portfolioId ?? 0}:${brokerId}`;

/** Ordinea în aceeași zi: split, depunere, cumpărare, vânzare, venituri, comisioane, retrageri, ajustări. */
const TYPE_ORDER: Record<TransactionType, number> = {
  split: 0,
  deposit: 1,
  buy: 2,
  sell: 3,
  dividend: 4,
  coupon: 4,
  interest: 4,
  fee: 5,
  withdrawal: 6,
  adjustment: 7
};

export function compareTx(a: LedgerTx, b: LedgerTx): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const t = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  return t !== 0 ? t : a.id - b.id;
}

export function sortTransactions<T extends LedgerTx>(txs: T[]): T[] {
  return [...txs].sort(compareTx);
}

/** Factorul unui split: „4:1” înmulțește cantitatea cu 4; „1:10” o împarte la 10. */
export function splitFactorExact(tx: Pick<LedgerTx, 'splitNumerator' | 'splitDenominator'>): Decimal {
  const num = decOrNull(tx.splitNumerator) ?? dec(1);
  const den = decOrNull(tx.splitDenominator) ?? dec(1);
  if (!num.gt(0) || !den.gt(0)) throw new Error('Raport de split invalid.');
  return num.div(den);
}

export function splitFactor(tx: Pick<LedgerTx, 'splitNumerator' | 'splitDenominator'>): number {
  return toNum(splitFactorExact(tx));
}

/** Interpretează un raport scris de utilizator: „4:1”, „4/1”, „4 la 1” sau „4”. */
export function parseSplitRatio(text: string): { numerator: number; denominator: number } | null {
  const m = text
    .trim()
    .replace(',', '.')
    .match(/^(\d+(?:\.\d+)?)\s*(?:[:/]|la|for)?\s*(\d+(?:\.\d+)?)?$/i);
  if (!m) return null;
  const numerator = Number(m[1]);
  const denominator = m[2] === undefined ? 1 : Number(m[2]);
  if (!(numerator > 0) || !(denominator > 0)) return null;
  return { numerator, denominator };
}

export interface LedgerOptions {
  method: CostMethod;
  /** Multiplicatorul de preț al activului (vezi comentariul de la începutul fișierului). */
  multiplierOf?: (assetId: number) => DecValue;
  /**
   * strict = true: o vânzare peste cantitatea deținută aruncă OversellError.
   * strict = false: vânzarea este limitată la cantitatea disponibilă (util la
   * reconstrucția istoricului, unde nu vrem ca o eroare să oprească graficul).
   */
  strict?: boolean;
  /** Moneda unui activ (pentru tranzacțiile care nu își poartă moneda). */
  currencyOf?: (assetId: number) => string | null | undefined;
  /**
   * Cursul monedei date față de moneda de bază, la data dată. Cu el, motorul ține
   * costul și profitul realizat și în moneda de bază, la cursul din ziua tranzacției.
   * Null = curs necunoscut (poziția revine atunci la cursul de azi).
   */
  fxAt?: (currency: string, date: string) => DecValue | null;
}

interface ExactLot {
  date: string;
  quantity: Decimal;
  unitCost: Decimal;
  unitCostBase: Decimal | null;
}

interface Acc {
  assetId: number;
  brokerId: number;
  portfolioId: number | null;
  quantity: Decimal;
  costBasis: Decimal;
  costBase: Decimal | null;
  realized: Decimal;
  realizedBase: Decimal | null;
  income: Decimal;
  incomeBase: Decimal | null;
  grossIncome: Decimal;
  taxWithheld: Decimal;
  totalBought: Decimal;
  totalBoughtBase: Decimal | null;
  totalSold: Decimal;
  fees: Decimal;
  lots: ExactLot[];
}

/** Adună la o sumă în moneda de bază; un curs necunoscut „otrăvește” suma (devine null). */
const addBase = (total: Decimal | null, amount: Decimal | null): Decimal | null => (total === null || amount === null ? null : total.plus(amount));

export class Ledger {
  private readonly positions = new Map<string, Acc>();
  private readonly cash = new Map<string, { brokerId: number; portfolioId: number | null; currency: string; amount: Decimal }>();
  private readonly trackedAccounts = new Set<string>();
  private readonly brokerTotals = new Map<string, BrokerTotals>();
  private readonly saleLog: SaleRecord[] = [];
  private readonly method: CostMethod;
  private readonly multiplierOf: (assetId: number) => DecValue;
  private readonly strict: boolean;
  private readonly currencyOf?: LedgerOptions['currencyOf'];
  private readonly fxAt?: LedgerOptions['fxAt'];

  constructor(options: LedgerOptions) {
    this.method = options.method;
    this.multiplierOf = options.multiplierOf ?? (() => 1);
    this.strict = options.strict ?? true;
    this.currencyOf = options.currencyOf;
    this.fxAt = options.fxAt;
  }

  /** Moneda în care este exprimată tranzacția. */
  private currencyOfTx(tx: LedgerTx): string | null {
    return tx.currency || (tx.assetId != null ? (this.currencyOf?.(tx.assetId) ?? null) : null);
  }

  /** Suma convertită în moneda de bază la cursul zilei; null dacă nu se poate (fără `fxAt` sau curs lipsă). */
  private toBase(amount: Decimal, currency: string | null, date: string): Decimal | null {
    if (!this.fxAt || !currency) return null;
    const rate = this.fxAt(currency, date);
    return rate === null || rate === undefined ? null : amount.times(dec(rate));
  }

  private position(assetId: number, brokerId: number, portfolioId: number | null | undefined): Acc {
    const key = `${portfolioId ?? 0}:${assetId}:${brokerId}`;
    let p = this.positions.get(key);
    if (!p) {
      const base = this.fxAt ? ZERO : null;
      p = {
        assetId,
        brokerId,
        portfolioId: portfolioId ?? null,
        quantity: ZERO,
        costBasis: ZERO,
        costBase: base,
        realized: ZERO,
        realizedBase: base,
        income: ZERO,
        incomeBase: base,
        grossIncome: ZERO,
        taxWithheld: ZERO,
        totalBought: ZERO,
        totalBoughtBase: base,
        totalSold: ZERO,
        fees: ZERO,
        lots: []
      };
      this.positions.set(key, p);
    }
    return p;
  }

  private moveCash(tx: LedgerTx, currency: string | null | undefined, amount: Decimal): void {
    const brokerId = tx.brokerId;
    if (brokerId == null || !currency || amount.isZero()) return;
    const key = `${accountKey(tx.portfolioId, brokerId)}:${currency}`;
    const entry = this.cash.get(key) ?? { brokerId, portfolioId: tx.portfolioId ?? null, currency, amount: ZERO };
    entry.amount = entry.amount.plus(amount);
    this.cash.set(key, entry);
  }

  /** Efectul asupra cash-ului: suma din raportul brokerului, dacă există, altfel cea calculată. */
  private cashEffect(tx: LedgerTx, computed: Decimal): void {
    const reported = decOrNull(tx.cashAmount);
    if (reported !== null && tx.cashCurrency) this.moveCash(tx, tx.cashCurrency, reported);
    else this.moveCash(tx, this.currencyOfTx(tx), computed);
  }

  private totalsOf(brokerId: number, portfolioId: number | null | undefined): BrokerTotals {
    const key = accountKey(portfolioId, brokerId);
    let t = this.brokerTotals.get(key);
    if (!t) {
      t = { brokerId, portfolioId: portfolioId ?? null, otherIncome: new Map(), otherIncomeBase: this.fxAt ? ZERO : null };
      this.brokerTotals.set(key, t);
    }
    return t;
  }

  /** Aplică o tranzacție. Tranzacțiile trebuie date în ordinea din `compareTx`. */
  apply(tx: LedgerTx): void {
    switch (tx.type) {
      case 'buy':
        return this.buy(tx);
      case 'sell':
        return this.sell(tx);
      case 'split':
        return this.split(tx);
      case 'dividend':
      case 'coupon':
        return this.incomeTx(tx);
      default:
        return this.cashTx(tx);
    }
  }

  applyAll(txs: LedgerTx[]): this {
    for (const tx of txs) this.apply(tx);
    return this;
  }

  private buy(tx: LedgerTx): void {
    const quantity = dec(tx.quantity);
    if (tx.brokerId == null || tx.assetId == null || !quantity.gt(0)) return;
    const p = this.position(tx.assetId, tx.brokerId, tx.portfolioId);
    const fee = dec(tx.fee);
    const cost = quantity.times(dec(tx.price)).times(dec(this.multiplierOf(tx.assetId))).plus(fee);

    // Costul în moneda de bază: suma plătită efectiv (dacă brokerul o raportează), la cursul zilei.
    const reported = decOrNull(tx.cashAmount);
    const costBase =
      reported !== null && tx.cashCurrency ? this.toBase(reported.abs(), tx.cashCurrency, tx.date) : this.toBase(cost, this.currencyOfTx(tx), tx.date);

    p.quantity = p.quantity.plus(quantity);
    p.costBasis = p.costBasis.plus(cost);
    p.costBase = addBase(p.costBase, costBase);
    p.totalBought = p.totalBought.plus(cost);
    p.totalBoughtBase = addBase(p.totalBoughtBase, costBase);
    p.fees = p.fees.plus(fee);
    p.lots.push({ date: tx.date, quantity, unitCost: cost.div(quantity), unitCostBase: costBase === null ? null : costBase.div(quantity) });
    this.cashEffect(tx, cost.neg());
  }

  private sell(tx: LedgerTx): void {
    let qty = dec(tx.quantity);
    if (tx.brokerId == null || tx.assetId == null || !qty.gt(0)) return;
    const p = this.position(tx.assetId, tx.brokerId, tx.portfolioId);
    if (qty.gt(p.quantity.plus(EPS_DEC))) {
      if (this.strict) throw new OversellError(tx, toNum(p.quantity));
      qty = p.quantity;
      if (qty.lte(EPS_DEC)) return;
    } else if (qty.gt(p.quantity)) {
      qty = p.quantity; // diferență de rotunjire din raport: se vinde tot ce există
    }
    const fee = dec(tx.fee);
    // Comisionul se aplică integral, chiar dacă (în modul tolerant) cantitatea a fost limitată.
    const proceeds = qty.times(dec(tx.price)).times(dec(this.multiplierOf(tx.assetId))).minus(fee);
    const reported = decOrNull(tx.cashAmount);
    const proceedsBase =
      reported !== null && tx.cashCurrency ? this.toBase(reported, tx.cashCurrency, tx.date) : this.toBase(proceeds, this.currencyOfTx(tx), tx.date);

    let costOut = ZERO;
    let costOutBase: Decimal | null = p.costBase === null ? null : ZERO;
    if (this.method === 'FIFO') {
      // FIFO: se consumă întâi cele mai vechi loturi.
      let remaining = qty;
      while (remaining.gt(0) && p.lots.length > 0) {
        const lot = p.lots[0];
        const take = Decimal.min(lot.quantity, remaining);
        costOut = costOut.plus(take.times(lot.unitCost));
        costOutBase = lot.unitCostBase === null ? null : addBase(costOutBase, take.times(lot.unitCostBase));
        lot.quantity = lot.quantity.minus(take);
        remaining = remaining.minus(take);
        if (lot.quantity.lte(0)) p.lots.shift();
      }
    } else {
      // Cost mediu ponderat: unitățile vândute ies la prețul mediu al poziției.
      // Înmulțim înainte de a împărți, ca 1/3 din 300 să dea exact 100.
      costOut = p.costBasis.times(qty).div(p.quantity);
      costOutBase = p.costBase === null ? null : p.costBase.times(qty).div(p.quantity);
      const remainingShare = p.quantity.minus(qty);
      for (const lot of p.lots) lot.quantity = lot.quantity.times(remainingShare).div(p.quantity);
    }

    p.quantity = p.quantity.minus(qty);
    p.costBasis = p.costBasis.minus(costOut);
    p.costBase = p.costBase === null || costOutBase === null ? null : p.costBase.minus(costOutBase);
    p.realized = p.realized.plus(proceeds.minus(costOut));
    p.realizedBase = proceedsBase === null || costOutBase === null ? null : addBase(p.realizedBase, proceedsBase.minus(costOutBase));
    p.totalSold = p.totalSold.plus(proceeds);
    p.fees = p.fees.plus(fee);
    this.saleLog.push({
      txId: tx.id,
      assetId: tx.assetId,
      brokerId: tx.brokerId,
      portfolioId: tx.portfolioId ?? null,
      date: tx.date,
      quantity: qty,
      proceeds,
      cost: costOut,
      gain: proceeds.minus(costOut),
      fee,
      currency: this.currencyOfTx(tx),
      proceedsBase,
      costBase: costOutBase,
      gainBase: proceedsBase === null || costOutBase === null ? null : proceedsBase.minus(costOutBase)
    });

    if (p.quantity.lte(EPS_DEC)) {
      // Poziție închisă: curățăm resturile de rotunjire.
      p.quantity = ZERO;
      p.costBasis = ZERO;
      p.costBase = p.costBase === null ? null : ZERO;
      p.lots = [];
    }
    this.cashEffect(tx, proceeds);
  }

  private split(tx: LedgerTx): void {
    const factor = splitFactorExact(tx);
    for (const p of this.positions.values()) {
      if (p.assetId !== tx.assetId) continue;
      if (tx.brokerId != null && p.brokerId !== tx.brokerId) continue;
      if (tx.portfolioId != null && p.portfolioId !== tx.portfolioId) continue;
      // Cantitatea se înmulțește, costul total rămâne neschimbat => prețul mediu se împarte.
      p.quantity = p.quantity.times(factor);
      for (const lot of p.lots) {
        lot.quantity = lot.quantity.times(factor);
        lot.unitCost = lot.unitCost.div(factor);
        lot.unitCostBase = lot.unitCostBase === null ? null : lot.unitCostBase.div(factor);
      }
    }
  }

  private incomeTx(tx: LedgerTx): void {
    if (tx.brokerId == null || tx.assetId == null) return;
    const p = this.position(tx.assetId, tx.brokerId, tx.portfolioId);
    const net = dec(tx.netAmount);
    p.income = p.income.plus(net);
    p.incomeBase = addBase(p.incomeBase, this.toBase(net, this.currencyOfTx(tx), tx.date));
    p.grossIncome = p.grossIncome.plus(dec(tx.grossAmount));
    p.taxWithheld = p.taxWithheld.plus(dec(tx.taxWithheld));
    this.cashEffect(tx, net);
  }

  /** Depuneri, retrageri, dobânzi, comisioane și ajustări de sold. */
  private cashTx(tx: LedgerTx): void {
    if (tx.brokerId == null) return;
    const amount = dec(tx.netAmount);
    const currency = this.currencyOfTx(tx);
    const account = accountKey(tx.portfolioId, tx.brokerId);
    switch (tx.type) {
      case 'deposit':
        this.trackedAccounts.add(account);
        return this.cashEffect(tx, amount.abs());
      case 'withdrawal':
        this.trackedAccounts.add(account);
        return this.cashEffect(tx, amount.abs().neg());
      case 'adjustment':
        this.trackedAccounts.add(account);
        return this.cashEffect(tx, amount);
      case 'interest':
      case 'fee': {
        const signed = tx.type === 'fee' ? amount.abs().neg() : amount;
        if (tx.type === 'fee' && tx.assetId != null) {
          // Comision legat de un activ (ex.: taxă de custodie): scade profitul realizat al poziției.
          const p = this.position(tx.assetId, tx.brokerId, tx.portfolioId);
          p.realized = p.realized.plus(signed);
          p.realizedBase = addBase(p.realizedBase, this.toBase(signed, currency, tx.date));
          p.fees = p.fees.plus(signed.abs());
        } else if (currency) {
          const t = this.totalsOf(tx.brokerId, tx.portfolioId);
          t.otherIncome.set(currency, (t.otherIncome.get(currency) ?? ZERO).plus(signed));
          t.otherIncomeBase = addBase(t.otherIncomeBase, this.toBase(signed, currency, tx.date));
        }
        return this.cashEffect(tx, signed);
      }
    }
  }

  private snapshot(p: Acc): PositionState {
    const base = (v: Decimal | null): number | null => (v === null ? null : toNum(v));
    return {
      assetId: p.assetId,
      brokerId: p.brokerId,
      portfolioId: p.portfolioId,
      quantity: toNum(p.quantity),
      costBasis: toNum(p.costBasis),
      realizedPnl: toNum(p.realized),
      income: toNum(p.income),
      grossIncome: toNum(p.grossIncome),
      taxWithheld: toNum(p.taxWithheld),
      totalBought: toNum(p.totalBought),
      totalSold: toNum(p.totalSold),
      fees: toNum(p.fees),
      lots: p.lots.map((l) => ({ date: l.date, quantity: toNum(l.quantity), unitCost: toNum(l.unitCost) })),
      costBasisBase: base(p.costBase),
      realizedPnlBase: base(p.realizedBase),
      incomeBase: base(p.incomeBase),
      totalBoughtBase: base(p.totalBoughtBase),
      exact: {
        quantity: p.quantity,
        costBasis: p.costBasis,
        realizedPnl: p.realized,
        income: p.income,
        totalBought: p.totalBought,
        costBasisBase: p.costBase,
        realizedPnlBase: p.realizedBase,
        incomeBase: p.incomeBase,
        totalBoughtBase: p.totalBoughtBase
      }
    };
  }

  get(assetId: number, brokerId: number, portfolioId: number | null = null): PositionState | undefined {
    const p = this.positions.get(`${portfolioId ?? 0}:${assetId}:${brokerId}`);
    return p ? this.snapshot(p) : undefined;
  }

  list(): PositionState[] {
    return [...this.positions.values()].map((p) => this.snapshot(p));
  }

  /** Soldurile de cash pe portofoliu, broker și monedă. */
  cashBalances(): CashBalance[] {
    return [...this.cash.values()].map((c) => ({
      brokerId: c.brokerId,
      portfolioId: c.portfolioId,
      currency: c.currency,
      amount: toNum(c.amount),
      exact: c.amount,
      tracked: this.trackedAccounts.has(accountKey(c.portfolioId, c.brokerId))
    }));
  }

  /** Conturile (portofoliu + broker, vezi `accountKey`) la care se urmărește cash-ul: au depuneri, retrageri sau ajustări. */
  cashTrackedAccounts(): Set<string> {
    return new Set(this.trackedAccounts);
  }

  /** Toate vânzările aplicate, în ordine, cu costul și rezultatul fiecăreia. */
  sales(): SaleRecord[] {
    return [...this.saleLog];
  }

  /** Dobânzile la cash și comisioanele fără activ, pe portofoliu și broker. */
  otherIncome(): BrokerTotals[] {
    return [...this.brokerTotals.values()];
  }
}

/** Sortează tranzacțiile și întoarce starea finală a tuturor pozițiilor. */
export function computePositions(txs: LedgerTx[], method: CostMethod, multiplierOf?: (assetId: number) => DecValue): PositionState[] {
  return new Ledger({ method, multiplierOf }).applyAll(sortTransactions(txs)).list();
}

/**
 * Verifică dacă istoricul este coerent (nicio vânzare peste cantitatea deținută
 * la acel broker, la acea dată). Întoarce prima eroare găsită sau null.
 * Rezultatul nu depinde de metoda de cost, doar de cantități.
 */
export function validateLedger(txs: LedgerTx[]): OversellError | null {
  try {
    new Ledger({ method: 'AVG' }).applyAll(sortTransactions(txs));
    return null;
  } catch (err) {
    if (err instanceof OversellError) return err;
    throw err;
  }
}
