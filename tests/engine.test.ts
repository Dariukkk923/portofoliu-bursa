import { describe, expect, it } from 'vitest';
import {
  computePositions,
  Ledger,
  OversellError,
  parseSplitRatio,
  sortTransactions,
  validateLedger,
  type PositionState
} from '@shared/calc';
import { buy, income, sell, split } from './helpers';

/** Poziția unică rezultată (testele de aici folosesc de regulă un singur activ și broker). */
function only(positions: PositionState[]): PositionState {
  expect(positions).toHaveLength(1);
  return positions[0];
}

describe('cumpărări multiple', () => {
  it('adună cantitățile și include comisioanele în cost (cost mediu ponderat)', () => {
    const p = only(
      computePositions([buy('2024-01-10', 10, 100, { fee: 5 }), buy('2024-02-10', 20, 130, { fee: 10 })], 'AVG')
    );
    expect(p.quantity).toBe(30);
    expect(p.costBasis).toBeCloseTo(3615, 8); // 10*100+5 + 20*130+10
    expect(p.costBasis / p.quantity).toBeCloseTo(120.5, 8);
    expect(p.totalBought).toBeCloseTo(3615, 8);
    expect(p.fees).toBe(15);
    expect(p.realizedPnl).toBe(0);
  });

  it('dă aceeași poziție deschisă indiferent de metodă, cât timp nu s-a vândut nimic', () => {
    const txs = [buy('2024-01-10', 3, 50), buy('2024-03-01', 7, 70, { fee: 2 })];
    const avg = only(computePositions(txs, 'AVG'));
    const fifo = only(computePositions(txs, 'FIFO'));
    expect(fifo.quantity).toBe(avg.quantity);
    expect(fifo.costBasis).toBeCloseTo(avg.costBasis, 8);
  });
});

describe('vânzări parțiale', () => {
  const txs = [
    buy('2024-01-10', 10, 100, { fee: 5 }),
    buy('2024-02-10', 20, 130, { fee: 10 }),
    sell('2024-03-10', 12, 150, { fee: 6 })
  ];

  it('cost mediu ponderat: unitățile vândute ies la prețul mediu', () => {
    const p = only(computePositions(txs, 'AVG'));
    expect(p.quantity).toBe(18);
    // cost scos = 3615 * 12/30 = 1446; încasări = 12*150 - 6 = 1794
    expect(p.realizedPnl).toBeCloseTo(348, 8);
    expect(p.costBasis).toBeCloseTo(2169, 8);
    expect(p.costBasis / p.quantity).toBeCloseTo(120.5, 8); // prețul mediu nu se schimbă la vânzare
    expect(p.totalSold).toBeCloseTo(1794, 8);
  });

  it('FIFO: se vând întâi cele mai vechi loturi', () => {
    const p = only(computePositions(txs, 'FIFO'));
    expect(p.quantity).toBe(18);
    // 10 buc. din lotul 1 (100.5/buc.) + 2 buc. din lotul 2 (130.5/buc.) = 1266
    expect(p.realizedPnl).toBeCloseTo(528, 8);
    expect(p.costBasis).toBeCloseTo(2349, 8);
    expect(p.lots).toHaveLength(1);
    expect(p.lots[0].quantity).toBe(18);
    expect(p.lots[0].unitCost).toBeCloseTo(130.5, 8);
  });

  it('vânzarea integrală închide poziția, iar o recumpărare pornește de la cost zero', () => {
    const p = only(
      computePositions(
        [buy('2024-01-01', 10, 100), sell('2024-02-01', 10, 90, { fee: 3 }), buy('2024-03-01', 4, 80)],
        'AVG'
      )
    );
    expect(p.quantity).toBe(4);
    expect(p.costBasis).toBeCloseTo(320, 8);
    expect(p.realizedPnl).toBeCloseTo(-103, 8); // 897 încasat - 1000 cost
  });

  it('pierderea la vânzare este negativă în ambele metode', () => {
    const list = [buy('2024-01-01', 5, 200), sell('2024-06-01', 2, 150)];
    expect(only(computePositions(list, 'AVG')).realizedPnl).toBeCloseTo(-100, 8);
    expect(only(computePositions(list, 'FIFO')).realizedPnl).toBeCloseTo(-100, 8);
  });
});

describe('split-uri', () => {
  it('split 4:1 înmulțește cantitatea și împarte prețul mediu, fără să schimbe valoarea investită', () => {
    const p = only(computePositions([buy('2024-01-10', 10, 400, { fee: 8 }), split('2024-06-10', 4, 1)], 'AVG'));
    expect(p.quantity).toBe(40);
    expect(p.costBasis).toBeCloseTo(4008, 8);
    expect(p.totalBought).toBeCloseTo(4008, 8);
    expect(p.costBasis / p.quantity).toBeCloseTo(100.2, 8);
  });

  it('vânzarea de după split folosește costul ajustat (AVG și FIFO)', () => {
    const txs = [buy('2024-01-10', 10, 400), split('2024-06-10', 4, 1), sell('2024-07-01', 10, 120)];
    for (const method of ['AVG', 'FIFO'] as const) {
      const p = only(computePositions(txs, method));
      expect(p.quantity).toBe(30);
      expect(p.realizedPnl).toBeCloseTo(200, 8); // 10 * (120 - 100)
      expect(p.costBasis).toBeCloseTo(3000, 8);
    }
  });

  it('split invers 1:10 și split fracționar 3:2', () => {
    const reverse = only(computePositions([buy('2024-01-10', 250, 2), split('2024-02-01', 1, 10)], 'AVG'));
    expect(reverse.quantity).toBe(25);
    expect(reverse.costBasis).toBeCloseTo(500, 8);

    const fractional = only(computePositions([buy('2024-01-10', 10, 30), split('2024-02-01', 3, 2)], 'FIFO'));
    expect(fractional.quantity).toBe(15);
    expect(fractional.lots[0].unitCost).toBeCloseTo(20, 8);
  });

  it('cumpărarea din ziua split-ului se face la preț post-split (split-ul se aplică primul)', () => {
    // Cumpărarea are id mai mic decât split-ul, dar aceeași dată.
    const b1 = buy('2024-01-10', 10, 400);
    const b2 = buy('2024-06-10', 5, 100);
    const s = split('2024-06-10', 4, 1);
    const p = only(computePositions([b1, b2, s], 'AVG'));
    expect(p.quantity).toBe(45); // 10*4 + 5, nu (10+5)*4
    expect(p.costBasis).toBeCloseTo(4500, 8);
  });

  it('split fără broker se aplică la toți brokerii; cu broker, doar la acela', () => {
    const base = [buy('2024-01-10', 10, 100, { brokerId: 1 }), buy('2024-01-11', 6, 100, { brokerId: 2 })];
    const all = computePositions([...base, split('2024-03-01', 2, 1)], 'AVG');
    expect(all.find((p) => p.brokerId === 1)?.quantity).toBe(20);
    expect(all.find((p) => p.brokerId === 2)?.quantity).toBe(12);

    const one = computePositions([...base, split('2024-03-01', 2, 1, { brokerId: 2 })], 'AVG');
    expect(one.find((p) => p.brokerId === 1)?.quantity).toBe(10);
    expect(one.find((p) => p.brokerId === 2)?.quantity).toBe(12);
  });

  it('interpretează rapoartele scrise de utilizator', () => {
    expect(parseSplitRatio('4:1')).toEqual({ numerator: 4, denominator: 1 });
    expect(parseSplitRatio(' 1 / 10 ')).toEqual({ numerator: 1, denominator: 10 });
    expect(parseSplitRatio('3 la 2')).toEqual({ numerator: 3, denominator: 2 });
    expect(parseSplitRatio('10')).toEqual({ numerator: 10, denominator: 1 });
    expect(parseSplitRatio('0:1')).toBeNull();
    expect(parseSplitRatio('abc')).toBeNull();
  });
});

describe('dividende și cupoane', () => {
  it('dividendele nete se adună la venituri, separat de profitul din vânzări', () => {
    const p = only(
      computePositions(
        [
          buy('2024-01-10', 10, 100),
          income('dividend', '2024-05-01', 20, 2),
          income('dividend', '2024-11-01', 22, 2.2),
          sell('2024-12-01', 5, 110)
        ],
        'AVG'
      )
    );
    expect(p.income).toBeCloseTo(37.8, 8);
    expect(p.grossIncome).toBeCloseTo(42, 8);
    expect(p.taxWithheld).toBeCloseTo(4.2, 8);
    expect(p.realizedPnl).toBeCloseTo(50, 8);
    expect(p.costBasis).toBeCloseTo(500, 8); // dividendele nu ating costul
  });

  it('un dividend încasat după închiderea poziției rămâne înregistrat', () => {
    const p = only(
      computePositions(
        [buy('2024-01-10', 10, 100), sell('2024-02-01', 10, 100), income('dividend', '2024-03-01', 15, 1.5)],
        'FIFO'
      )
    );
    expect(p.quantity).toBe(0);
    expect(p.income).toBeCloseTo(13.5, 8);
  });

  it('obligațiuni: prețul este procent din nominal, iar cupoanele sunt venit', () => {
    // Nominal 1000 => multiplicator 10 (1% din nominal = 10 unități monetare).
    const multiplierOf = (): number => 10;
    const p = only(
      computePositions(
        [
          buy('2024-01-15', 5, 98.5, { fee: 10 }),
          income('coupon', '2024-07-15', 175, 0),
          income('coupon', '2025-01-15', 175, 17.5),
          sell('2025-02-01', 2, 101, { fee: 4 })
        ],
        'AVG',
        multiplierOf
      )
    );
    // cost = 5 * 98.5 * 10 + 10 = 4935; vânzare: 2 * 101 * 10 - 4 = 2016; cost scos = 4935 * 2/5 = 1974
    expect(p.quantity).toBe(3);
    expect(p.costBasis).toBeCloseTo(2961, 8);
    expect(p.realizedPnl).toBeCloseTo(42, 8);
    expect(p.income).toBeCloseTo(332.5, 8);
  });
});

describe('crypto cu zecimale', () => {
  it('păstrează cantitățile fracționare cu 8 zecimale', () => {
    const p = only(
      computePositions(
        [buy('2024-01-10', 0.12345678, 40000, { fee: 1.5 }), buy('2024-01-11', 0.00000022, 41000)],
        'AVG'
      )
    );
    expect(p.quantity).toBe(0.123457);
    expect(p.costBasis).toBeCloseTo(0.12345678 * 40000 + 1.5 + 0.00000022 * 41000, 6);
  });

  it('vânzările repetate nu lasă resturi de virgulă mobilă (0.1 + 0.2 ≠ 0.3)', () => {
    for (const method of ['AVG', 'FIFO'] as const) {
      const p = only(
        computePositions(
          [
            buy('2024-01-01', 0.3, 30000),
            sell('2024-02-01', 0.1, 35000),
            sell('2024-02-02', 0.1, 35000),
            sell('2024-02-03', 0.1, 35000)
          ],
          method
        )
      );
      expect(p.quantity).toBe(0);
      expect(p.costBasis).toBe(0);
      expect(p.realizedPnl).toBeCloseTo(1500, 6);
    }
  });

  it('acceptă vânzarea exactă a unei cantități obținute din mai multe cumpărări mici', () => {
    const txs = [
      buy('2024-01-01', 0.1, 100),
      buy('2024-01-02', 0.2, 100),
      buy('2024-01-03', 0.00000001, 100),
      sell('2024-01-04', 0.30000001, 120)
    ];
    expect(validateLedger(txs)).toBeNull();
    expect(only(computePositions(txs, 'FIFO')).quantity).toBe(0);
  });
});

describe('mai mulți brokeri', () => {
  it('același activ la brokeri diferiți formează poziții separate', () => {
    const positions = computePositions(
      [
        buy('2024-01-10', 10, 150, { brokerId: 1, fee: 1 }),
        buy('2024-02-10', 5, 170, { brokerId: 2, fee: 1 }),
        sell('2024-03-10', 4, 200, { brokerId: 1, fee: 1 })
      ],
      'AVG'
    );
    expect(positions).toHaveLength(2);
    const b1 = positions.find((p) => p.brokerId === 1) as PositionState;
    const b2 = positions.find((p) => p.brokerId === 2) as PositionState;
    expect(b1.quantity).toBe(6);
    expect(b1.costBasis).toBeCloseTo(900.6, 8);
    expect(b1.realizedPnl).toBeCloseTo(198.6, 8);
    expect(b2.quantity).toBe(5);
    expect(b2.costBasis).toBeCloseTo(851, 8);
    expect(b2.realizedPnl).toBe(0);
  });

  it('nu poți vinde la un broker mai mult decât deții acolo, chiar dacă totalul ar ajunge', () => {
    const txs = [
      buy('2024-01-10', 10, 150, { brokerId: 1 }),
      buy('2024-02-10', 5, 170, { brokerId: 2 }),
      sell('2024-03-10', 8, 200, { brokerId: 2 })
    ];
    const err = validateLedger(txs);
    expect(err).toBeInstanceOf(OversellError);
    expect(err?.available).toBe(5);
    expect(() => computePositions(txs, 'AVG')).toThrow(OversellError);
  });
});

describe('validare cronologică', () => {
  it('respinge o vânzare făcută înaintea cumpărării', () => {
    const err = validateLedger([sell('2024-01-05', 1, 100), buy('2024-01-10', 5, 100)]);
    expect(err).toBeInstanceOf(OversellError);
    expect(err?.available).toBe(0);
  });

  it('acceptă cumpărare și vânzare în aceeași zi, indiferent de ordinea introducerii', () => {
    const s = sell('2024-01-10', 5, 110); // introdusă prima (id mai mic)
    const b = buy('2024-01-10', 5, 100);
    expect(validateLedger([s, b])).toBeNull();
    expect(sortTransactions([s, b]).map((t) => t.type)).toEqual(['buy', 'sell']);
  });

  it('ține cont de split la validare', () => {
    const txs = [buy('2024-01-10', 2, 900), split('2024-06-10', 10, 1), sell('2024-07-01', 15, 120)];
    expect(validateLedger(txs)).toBeNull();
    expect(validateLedger([...txs, sell('2024-07-02', 6, 120)])).toBeInstanceOf(OversellError);
  });

  it('modul tolerant limitează vânzarea la cantitatea disponibilă în loc să arunce eroare', () => {
    const ledger = new Ledger({ method: 'AVG', strict: false });
    ledger.applyAll([buy('2024-01-10', 3, 100), sell('2024-02-01', 5, 100)]);
    expect(ledger.get(1, 1)?.quantity).toBe(0);
    expect(ledger.get(1, 1)?.realizedPnl).toBeCloseTo(0, 8);
  });
});
