import type { LedgerTx } from '@shared/calc';

let nextId = 1;

/** Construiește o tranzacție pentru teste, cu valori implicite pentru câmpurile nefolosite. */
export function tx(partial: Partial<LedgerTx> & Pick<LedgerTx, 'type' | 'date'>): LedgerTx {
  return {
    id: nextId++,
    assetId: 1,
    brokerId: 1,
    quantity: 0,
    price: 0,
    fee: 0,
    grossAmount: 0,
    taxWithheld: 0,
    netAmount: 0,
    splitNumerator: null,
    splitDenominator: null,
    ...partial
  };
}

export const buy = (date: string, quantity: number, price: number, extra: Partial<LedgerTx> = {}): LedgerTx =>
  tx({ type: 'buy', date, quantity, price, ...extra });

export const sell = (date: string, quantity: number, price: number, extra: Partial<LedgerTx> = {}): LedgerTx =>
  tx({ type: 'sell', date, quantity, price, ...extra });

export const split = (date: string, numerator: number, denominator: number, extra: Partial<LedgerTx> = {}): LedgerTx =>
  tx({ type: 'split', date, splitNumerator: numerator, splitDenominator: denominator, brokerId: null, ...extra });

export const income = (
  type: 'dividend' | 'coupon',
  date: string,
  gross: number,
  tax: number,
  extra: Partial<LedgerTx> = {}
): LedgerTx => tx({ type, date, grossAmount: gross, taxWithheld: tax, netAmount: gross - tax, ...extra });
