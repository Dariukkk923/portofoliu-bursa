/**
 * Motorul de calcul al pozițiilor.
 *
 * Primește tranzacțiile în ordine cronologică și ține, pentru fiecare pereche
 * (activ, broker), cantitatea deținută, costul rămas, profitul realizat și
 * veniturile încasate. Este cod pur (fără bază de date, fără Electron), deci
 * poate fi testat izolat și folosit atât în procesul principal, cât și în teste.
 *
 * Convenții:
 *  - toate sumele unei poziții sunt în moneda activului;
 *  - comisioanele intră în cost la cumpărare și scad încasările la vânzare;
 *  - `multiplier` transformă prețul în bani pe unitate: 1 pentru acțiuni, ETF-uri
 *    și crypto; (valoare nominală / 100) pentru obligațiuni, unde prețul este
 *    exprimat ca procent din nominal.
 */
import type { CostMethod, TransactionType } from '../types';

/** Toleranță pentru erorile de virgulă mobilă (cantități crypto cu multe zecimale). */
export const EPS = 1e-9;

/** Rotunjire la 10 zecimale: elimină „zgomotul” acumulat de adunări/scăderi repetate. */
export function roundQty(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/** Forma minimă a unei tranzacții de care are nevoie motorul. */
export interface LedgerTx {
  id: number;
  assetId: number;
  brokerId: number | null;
  type: TransactionType;
  date: string;
  quantity: number;
  price: number;
  fee: number;
  grossAmount: number;
  taxWithheld: number;
  netAmount: number;
  splitNumerator: number | null;
  splitDenominator: number | null;
}

/** Un lot de cumpărare încă nevândut (folosit de metoda FIFO). */
export interface Lot {
  date: string;
  quantity: number;
  /** Cost pe unitate, cu tot cu partea de comision. */
  unitCost: number;
}

export interface PositionState {
  assetId: number;
  brokerId: number;
  quantity: number;
  /** Costul unităților rămase, inclusiv comisioanele de cumpărare aferente. */
  costBasis: number;
  /** Profit realizat din vânzări (încasări nete − costul unităților vândute). */
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
}

/** Aruncată când o vânzare depășește cantitatea deținută la acel broker în acel moment. */
export class OversellError extends Error {
  constructor(
    public readonly tx: LedgerTx,
    public readonly available: number
  ) {
    super(
      `Vânzare de ${tx.quantity} unități la data ${tx.date}, dar la acest broker erau disponibile doar ${available}.`
    );
    this.name = 'OversellError';
  }
}

/** Ordinea în aceeași zi: split, cumpărare, vânzare, apoi dividende/cupoane. */
const TYPE_ORDER: Record<TransactionType, number> = { split: 0, buy: 1, sell: 2, dividend: 3, coupon: 3 };

export function compareTx(a: LedgerTx, b: LedgerTx): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const t = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  return t !== 0 ? t : a.id - b.id;
}

export function sortTransactions<T extends LedgerTx>(txs: T[]): T[] {
  return [...txs].sort(compareTx);
}

/** Factorul unui split: „4:1” înmulțește cantitatea cu 4; „1:10” o împarte la 10. */
export function splitFactor(tx: Pick<LedgerTx, 'splitNumerator' | 'splitDenominator'>): number {
  const num = tx.splitNumerator ?? 1;
  const den = tx.splitDenominator ?? 1;
  if (!(num > 0) || !(den > 0)) throw new Error('Raport de split invalid.');
  return num / den;
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
  multiplierOf?: (assetId: number) => number;
  /**
   * strict = true: o vânzare peste cantitatea deținută aruncă OversellError.
   * strict = false: vânzarea este limitată la cantitatea disponibilă (util la
   * reconstrucția istoricului, unde nu vrem ca o eroare să oprească graficul).
   */
  strict?: boolean;
}

export class Ledger {
  private readonly positions = new Map<string, PositionState>();
  private readonly method: CostMethod;
  private readonly multiplierOf: (assetId: number) => number;
  private readonly strict: boolean;

  constructor(options: LedgerOptions) {
    this.method = options.method;
    this.multiplierOf = options.multiplierOf ?? (() => 1);
    this.strict = options.strict ?? true;
  }

  private position(assetId: number, brokerId: number): PositionState {
    const key = `${assetId}:${brokerId}`;
    let p = this.positions.get(key);
    if (!p) {
      p = {
        assetId,
        brokerId,
        quantity: 0,
        costBasis: 0,
        realizedPnl: 0,
        income: 0,
        grossIncome: 0,
        taxWithheld: 0,
        totalBought: 0,
        totalSold: 0,
        fees: 0,
        lots: []
      };
      this.positions.set(key, p);
    }
    return p;
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
    }
  }

  applyAll(txs: LedgerTx[]): this {
    for (const tx of txs) this.apply(tx);
    return this;
  }

  private buy(tx: LedgerTx): void {
    if (tx.brokerId == null || !(tx.quantity > 0)) return;
    const p = this.position(tx.assetId, tx.brokerId);
    const cost = tx.quantity * tx.price * this.multiplierOf(tx.assetId) + tx.fee;
    p.quantity = roundQty(p.quantity + tx.quantity);
    p.costBasis += cost;
    p.totalBought += cost;
    p.fees += tx.fee;
    p.lots.push({ date: tx.date, quantity: tx.quantity, unitCost: cost / tx.quantity });
  }

  private sell(tx: LedgerTx): void {
    if (tx.brokerId == null || !(tx.quantity > 0)) return;
    const p = this.position(tx.assetId, tx.brokerId);
    let qty = tx.quantity;
    if (qty > p.quantity + EPS) {
      if (this.strict) throw new OversellError(tx, p.quantity);
      qty = p.quantity;
      if (qty <= EPS) return;
    }
    // Comisionul se aplică integral, chiar dacă (în modul tolerant) cantitatea a fost limitată.
    const proceeds = qty * tx.price * this.multiplierOf(tx.assetId) - tx.fee;

    let costOut: number;
    if (this.method === 'FIFO') {
      // FIFO: se consumă întâi cele mai vechi loturi.
      costOut = 0;
      let remaining = qty;
      while (remaining > EPS && p.lots.length > 0) {
        const lot = p.lots[0];
        const take = Math.min(lot.quantity, remaining);
        costOut += take * lot.unitCost;
        lot.quantity = roundQty(lot.quantity - take);
        remaining = roundQty(remaining - take);
        if (lot.quantity <= EPS) p.lots.shift();
      }
    } else {
      // Cost mediu ponderat: unitățile vândute ies la prețul mediu al poziției.
      const fraction = Math.min(1, qty / p.quantity);
      costOut = p.costBasis * fraction;
      for (const lot of p.lots) lot.quantity = roundQty(lot.quantity * (1 - fraction));
    }

    p.quantity = roundQty(p.quantity - qty);
    p.costBasis -= costOut;
    p.realizedPnl += proceeds - costOut;
    p.totalSold += proceeds;
    p.fees += tx.fee;

    if (p.quantity <= EPS) {
      // Poziție închisă: curățăm resturile de rotunjire.
      p.quantity = 0;
      p.costBasis = 0;
      p.lots = [];
    }
  }

  private split(tx: LedgerTx): void {
    const factor = splitFactor(tx);
    for (const p of this.positions.values()) {
      if (p.assetId !== tx.assetId) continue;
      if (tx.brokerId != null && p.brokerId !== tx.brokerId) continue;
      // Cantitatea se înmulțește, costul total rămâne neschimbat => prețul mediu se împarte.
      p.quantity = roundQty(p.quantity * factor);
      for (const lot of p.lots) {
        lot.quantity = roundQty(lot.quantity * factor);
        lot.unitCost /= factor;
      }
    }
  }

  private incomeTx(tx: LedgerTx): void {
    if (tx.brokerId == null) return;
    const p = this.position(tx.assetId, tx.brokerId);
    p.income += tx.netAmount;
    p.grossIncome += tx.grossAmount;
    p.taxWithheld += tx.taxWithheld;
  }

  get(assetId: number, brokerId: number): PositionState | undefined {
    return this.positions.get(`${assetId}:${brokerId}`);
  }

  list(): PositionState[] {
    return [...this.positions.values()];
  }
}

/** Sortează tranzacțiile și întoarce starea finală a tuturor pozițiilor. */
export function computePositions(
  txs: LedgerTx[],
  method: CostMethod,
  multiplierOf?: (assetId: number) => number
): PositionState[] {
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
