/**
 * Aritmetică zecimală exactă pentru toate calculele cu bani și cantități.
 *
 * Numerele JavaScript (virgulă mobilă binară) nu pot reprezenta exact valori
 * precum 0,1: 0.1 + 0.2 dă 0.30000000000000004. Aici folosim decimal.js, cu 40
 * de cifre semnificative, iar rotunjirea se face DOAR la afișare (2 zecimale
 * pentru bani, până la 8 pentru cantități).
 *
 * Un număr JavaScript primit ca intrare (ex.: din formular) este interpretat
 * după reprezentarea lui zecimală cea mai scurtă: 0.1 devine exact „0.1”.
 */
import DecimalJs from 'decimal.js';

/** Constructorul folosit în aplicație: 40 de cifre, rotunjire „half up”, fără notație exponențială. */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40
});
export type Decimal = DecimalJs;
/** Orice valoare care poate deveni un Decimal: număr, text („12.5”) sau Decimal. */
export type DecValue = DecimalJs.Value;

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

/** Valoarea ca Decimal; null, undefined și textul gol devin 0. */
export function dec(value: DecValue | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return ZERO;
  if (typeof value === 'number' && !Number.isFinite(value)) return ZERO;
  return new Decimal(value);
}

/** Valoarea ca Decimal sau null (pentru câmpurile opționale). */
export function decOrNull(value: DecValue | null | undefined): Decimal | null {
  return value === null || value === undefined || value === '' ? null : dec(value);
}

/** Conversia finală în număr JavaScript, pentru afișare și transport (fără rotunjire suplimentară). */
export const toNum = (value: Decimal): number => {
  const n = value.toNumber();
  return Object.is(n, -0) ? 0 : n;
};

/** Textul exact al valorii, pentru salvarea în baza de date: „0.1”, „12345.12345678”. */
export const decText = (value: DecValue): string => dec(value).toString();

/** Suma unei liste de valori. */
export function sum(values: Iterable<DecValue>): Decimal {
  let total = ZERO;
  for (const v of values) total = total.plus(dec(v));
  return total;
}

/** Rotunjire pentru afișare: bani la 2 zecimale, cantități la cel mult 8. */
export const roundMoney = (value: DecValue): Decimal => dec(value).toDecimalPlaces(2, DecimalJs.ROUND_HALF_UP);
export const roundQuantity = (value: DecValue): Decimal => dec(value).toDecimalPlaces(8, DecimalJs.ROUND_HALF_UP);
