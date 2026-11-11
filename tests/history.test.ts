import { describe, expect, it } from 'vitest';
import {
  annualCouponIncome,
  bondPriceToMoney,
  buildDateRange,
  buildValueSeries,
  couponPerPayment,
  nextCouponDate,
  type HistoricalPrice
} from '@shared/calc';
import { addMonths, isIsoDate, parseDateLoose } from '@shared/dates';
import { buy, split } from './helpers';

/** Întoarce ultimul preț cunoscut la data cerută sau înainte. */
function lastKnown(history: [string, number][], date: string): number | null {
  let found: number | null = null;
  for (const [d, price] of history) if (d <= date) found = price;
  return found;
}

describe('evoluția valorii portofoliului', () => {
  const transactions = [buy('2024-01-10', 2, 100), split('2024-06-10', 10, 1), buy('2024-07-01', 5, 12)];
  const assets = new Map([[1, { currency: 'USD', multiplier: 1 }]]);
  const dates = ['2024-01-05', '2024-01-10', '2024-03-01', '2024-06-10', '2024-07-01'];
  const fxOn = (_currency: string, date: string): number => (date < '2024-04-01' ? 4.5 : 4.6);

  it('ajustează cantitatea la split-urile ulterioare când prețurile istorice sunt ajustate', () => {
    // Prețuri ajustate la split (cum le dă Yahoo): 100 USD înainte de split apare ca 10 USD.
    const adjusted: [string, number][] = [
      ['2024-01-10', 10],
      ['2024-03-01', 11],
      ['2024-06-10', 12],
      ['2024-07-01', 12.5]
    ];
    const priceOn = (_id: number, date: string): HistoricalPrice | null => {
      const price = lastKnown(adjusted, date);
      return price == null ? null : { price, splitAdjusted: true };
    };
    const series = buildValueSeries({ transactions, assets, method: 'AVG', dates, priceOn, fxOn });

    expect(series.map((p) => p.date)).toEqual(dates);
    expect(series[0]).toMatchObject({ value: 0, invested: 0 }); // înainte de prima cumpărare
    expect(series[1].value).toBeCloseTo(900, 8); // 2 buc. * 10 (factor split) * 10 USD * 4.5
    expect(series[1].invested).toBeCloseTo(900, 8);
    expect(series[2].value).toBeCloseTo(990, 8);
    expect(series[3].value).toBeCloseTo(1104, 8); // după split: 20 buc. * 12 USD * 4.6
    // Suma investită rămâne la cursul din ziua cumpărării (200 USD * 4.5), nu se reevaluează la cursul nou.
    expect(series[3].invested).toBe(900);
    expect(series[4].value).toBeCloseTo(1437.5, 8); // 25 buc. * 12.5 USD * 4.6
    expect(series[4].invested).toBe(1176); // 900 + 5 * 12 USD * 4.6
  });

  it('nu ajustează cantitatea când prețurile istorice sunt cele reale de la acea dată', () => {
    const raw: [string, number][] = [
      ['2024-01-10', 100],
      ['2024-06-10', 12]
    ];
    const priceOn = (_id: number, date: string): HistoricalPrice | null => {
      const price = lastKnown(raw, date);
      return price == null ? null : { price, splitAdjusted: false };
    };
    const series = buildValueSeries({ transactions, assets, method: 'AVG', dates, priceOn, fxOn });
    expect(series[1].value).toBeCloseTo(900, 8); // 2 buc. * 100 USD * 4.5
    expect(series[3].value).toBeCloseTo(1104, 8);
  });

  it('fără prețuri istorice, pozițiile se iau la cost', () => {
    const series = buildValueSeries({ transactions, assets, method: 'FIFO', dates, priceOn: () => null, fxOn });
    expect(series[1].value).toBeCloseTo(900, 8);
    expect(series[4].value).toBeCloseTo(series[4].invested, 8);
  });
});

describe('intervalul de date al graficului', () => {
  it('întoarce toate zilele când sunt puține', () => {
    const dates = buildDateRange('2024-01-01', '2024-01-10');
    expect(dates).toHaveLength(10);
    expect(dates[0]).toBe('2024-01-01');
    expect(dates[9]).toBe('2024-01-10');
  });

  it('rărește punctele, dar păstrează mereu ultima zi', () => {
    expect(buildDateRange('2024-01-01', '2024-01-10', 5)).toEqual([
      '2024-01-02',
      '2024-01-04',
      '2024-01-06',
      '2024-01-08',
      '2024-01-10'
    ]);
    const long = buildDateRange('2015-01-01', '2024-12-31', 400);
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long[long.length - 1]).toBe('2024-12-31');
  });
});

describe('obligațiuni', () => {
  const terms = { faceValue: 1000, couponRate: 7, couponFrequency: 2, maturityDate: '2027-07-15' };

  it('calculează cuponul pe plată și venitul anual', () => {
    expect(couponPerPayment(terms)).toBeCloseTo(35, 10);
    expect(annualCouponIncome(5, terms)).toBeCloseTo(350, 10);
    expect(bondPriceToMoney(98.5, 1000)).toBeCloseTo(985, 10);
  });

  it('găsește data următorului cupon numărând înapoi de la scadență', () => {
    expect(nextCouponDate(terms, '2025-03-01')).toBe('2025-07-15');
    expect(nextCouponDate(terms, '2025-07-15')).toBe('2025-07-15');
    expect(nextCouponDate(terms, '2025-07-16')).toBe('2026-01-15');
    expect(nextCouponDate({ ...terms, couponFrequency: 1 }, '2025-07-16')).toBe('2026-07-15');
    expect(nextCouponDate(terms, '2027-07-16')).toBeNull(); // după scadență
  });
});

describe('date calendaristice', () => {
  it('validează și interpretează formatele uzuale', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2023-02-29')).toBe(false);
    expect(parseDateLoose('15.03.2024')).toBe('2024-03-15');
    expect(parseDateLoose('5/3/2024')).toBe('2024-03-05');
    expect(parseDateLoose('2024-13-01')).toBeNull();
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-03-15', -6)).toBe('2023-09-15');
  });
});
