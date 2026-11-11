/**
 * Formatarea numerelor, a sumelor și a datelor în stil românesc (1.234,56 RON, 11.11.2026).
 *
 * Rotunjirea se face aici, la afișare, zecimal și „jumătatea în sus”: 2,675 devine
 * 2,68 (rotunjirea binară a numerelor JavaScript ar da 2,67).
 */
import { Decimal } from '@shared/calc/decimal';

const LOCALE = 'ro-RO';

/** Rotunjire zecimală exactă la `digits` zecimale. */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const n = new Decimal(value).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP).toNumber();
  return Object.is(n, -0) ? 0 : n;
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Sumă cu simbolul monedei: 1.234,56 RON. */
export function money(value: number, currency: string, digits = 2): string {
  const key = `${currency}:${digits}`;
  let f = moneyFormatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(LOCALE, {
        style: 'currency',
        currency,
        currencyDisplay: 'code',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      });
    } catch {
      f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    moneyFormatters.set(key, f);
  }
  return f.format(roundTo(value, digits));
}

/** Sumă cu semn explicit: +1.234,56 RON / −321,00 RON. */
export function signedMoney(value: number, currency: string): string {
  const rounded = roundTo(value, 2);
  if (rounded === 0) return money(0, currency);
  return `${rounded > 0 ? '+' : '−'}${money(Math.abs(rounded), currency)}`;
}

/** Sumă prescurtată pentru axele graficelor: 12,5 mii / 1,2 mil. */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Preț: cel puțin 2 zecimale, mai multe pentru valorile mici (ex.: 0,621). */
export function price(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  const max = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: max }).format(roundTo(value, max));
}

/** Cantitate: până la 8 zecimale, fără zerouri inutile. */
export function quantity(value: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 8 }).format(roundTo(value, 8));
}

/** Procent dintr-o fracție: 0,1234 -> 12,34%. */
export function percent(fraction: number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return new Intl.NumberFormat(LOCALE, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(roundTo(fraction, digits + 2));
}

export function signedPercent(fraction: number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  const text = percent(Math.abs(fraction), digits);
  const rounded = roundTo(fraction, digits + 2);
  return rounded === 0 ? text : `${rounded > 0 ? '+' : '−'}${text}`;
}

/** AAAA-LL-ZZ -> ZZ.LL.AAAA */
export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** Dată scurtă pentru axa graficului: „12 mar.” sau „mar. 2024” pentru intervale lungi. */
export function shortDate(iso: string, withYear = false): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(LOCALE, withYear ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}

/** Moment ISO -> „11.11.2026, 15:04”. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return 'niciodată';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Clasa de culoare pentru o valoare de profit/pierdere. */
export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || Math.abs(value) < 0.005) return 'text-ink-2';
  return value > 0 ? 'text-gain' : 'text-loss';
}

/** O durată în luni, în cuvinte: „8 luni”, „1 an”, „7 ani și 4 luni”. */
export function monthsText(m: number): string {
  const luni = (n: number): string => `${n} ${n === 1 ? 'lună' : 'luni'}`;
  if (m < 12) return luni(m);
  const years = Math.floor(m / 12);
  const rest = m % 12;
  const ani = `${years} ${years === 1 ? 'an' : 'ani'}`;
  return rest ? `${ani} și ${luni(rest)}` : ani;
}
