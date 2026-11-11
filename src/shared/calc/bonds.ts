/** Calcule specifice obligațiunilor (cupoane). Prețul curat nu include dobânda acumulată. */
import { addMonths } from '../dates';

export interface BondTerms {
  faceValue: number;
  /** Rata anuală a cuponului, în procente. */
  couponRate: number;
  /** Cupoane pe an: 1, 2, 4 sau 12. */
  couponFrequency: number;
  maturityDate: string;
}

/** Valoarea unui cupon pentru o singură obligațiune. */
export function couponPerPayment(terms: Pick<BondTerms, 'faceValue' | 'couponRate' | 'couponFrequency'>): number {
  const freq = terms.couponFrequency > 0 ? terms.couponFrequency : 1;
  return (terms.faceValue * terms.couponRate) / 100 / freq;
}

/** Venitul brut anual din cupoane pentru `quantity` obligațiuni. */
export function annualCouponIncome(quantity: number, terms: Pick<BondTerms, 'faceValue' | 'couponRate'>): number {
  return (quantity * terms.faceValue * terms.couponRate) / 100;
}

/**
 * Data următorului cupon: datele de cupon se numără înapoi de la scadență, la
 * intervale de 12 / frecvență luni. Întoarce null dacă obligațiunea a ajuns la scadență.
 */
export function nextCouponDate(terms: Pick<BondTerms, 'couponFrequency' | 'maturityDate'>, today: string): string | null {
  if (!terms.maturityDate || today > terms.maturityDate) return null;
  const freq = terms.couponFrequency > 0 ? terms.couponFrequency : 1;
  const stepMonths = Math.max(1, Math.round(12 / freq));
  let next = terms.maturityDate;
  for (let k = 1; k < 1200; k++) {
    const candidate = addMonths(terms.maturityDate, -k * stepMonths);
    if (candidate < today) break;
    next = candidate;
  }
  return next;
}

/** Transformă un preț exprimat ca procent din nominal în bani pe obligațiune. */
export function bondPriceToMoney(pricePct: number, faceValue: number): number {
  return (pricePct / 100) * faceValue;
}
