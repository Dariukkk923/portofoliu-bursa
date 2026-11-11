/**
 * Acuratețea calculelor: valori EXACTE (toBe, nu „aproximativ”) pentru vânzări
 * parțiale cu comisioane, crypto cu 8 zecimale, monede diferite cu cursuri
 * istorice, prețul de break-even și cazurile clasice de rotunjire (0.1 + 0.2).
 */
import { describe, expect, it } from 'vitest';
import { computePositions, Ledger, sortTransactions, summarize, valuePosition, type LedgerTx } from '@shared/calc';
import { dec, decText, roundMoney, roundQuantity, sum } from '@shared/calc/decimal';
import { money, quantity as fmtQuantity, signedMoney } from '../src/renderer/src/lib/format';
import { buy, sell } from './helpers';

const only = <T>(list: T[]): T => {
  expect(list).toHaveLength(1);
  return list[0];
};

describe('aritmetica zecimală', () => {
  it('0.1 + 0.2 este exact 0.3 (în cantități, costuri și totaluri)', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // numerele JavaScript obișnuite greșesc
    expect(dec(0.1).plus(0.2).toString()).toBe('0.3');

    const p = only(computePositions([buy('2024-01-10', 0.1, 1), buy('2024-01-11', 0.2, 1)], 'AVG'));
    expect(p.quantity).toBe(0.3);
    expect(p.costBasis).toBe(0.3);

    const totals = summarize([valuePosition({ quantity: 0.1, costBasis: 0.1, realizedPnl: 0, income: 0, totalBought: 0.1 }, 1, 1, 1),
      valuePosition({ quantity: 0.2, costBasis: 0.2, realizedPnl: 0, income: 0, totalBought: 0.2 }, 1, 1, 1)], 'RON');
    expect(totals.totalValue).toBe(0.3);
  });

  it('salvează sumele ca text zecimal fără notație exponențială și fără zgomot', () => {
    expect(decText(0.00000001)).toBe('0.00000001');
    expect(decText('1.0e-08')).toBe('0.00000001'); // formatul în care SQLite scrie valorile REAL mici
    expect(decText('10.0')).toBe('10');
    expect(decText(dec('206.5').minus('16.52'))).toBe('189.98'); // brut − impozit
    expect(0.3 - 0.1).not.toBe(0.2);
  });

  it('rotunjește doar la afișare: bani la 2 zecimale, cantități la 8 (jumătatea în sus)', () => {
    expect(roundMoney('2.675').toString()).toBe('2.68'); // (2.675).toFixed(2) dă „2.67”
    expect(roundMoney(1.005).toString()).toBe('1.01');
    expect(roundQuantity('0.123456785').toString()).toBe('0.12345679');
    const plain = (s: string): string => s.replace(/\s/g, ' '); // Intl pune un spațiu nedespărțitor înaintea monedei
    expect(plain(money(2.675, 'RON'))).toBe('2,68 RON');
    expect(plain(money(1234.565, 'RON'))).toBe('1.234,57 RON');
    expect(plain(signedMoney(-0.005, 'RON'))).toBe('−0,01 RON');
    expect(fmtQuantity(0.123456785)).toBe('0,12345679');
    expect(sum([0.1, 0.2, 0.3]).toString()).toBe('0.6');
  });
});

describe('vânzări parțiale cu comisioane', () => {
  // Lot 1: 10 × 10,10 + 0,70 comision = 101,70 (10,17/buc.)  Lot 2: 5 × 10,30 + 0,35 = 51,85 (10,37/buc.)
  const txs = [buy('2024-01-10', 10, 10.1, { fee: 0.7 }), buy('2024-02-10', 5, 10.3, { fee: 0.35 }), sell('2024-03-10', 12, 11, { fee: 0.84 })];

  it('FIFO: costul vândut vine din loturile cele mai vechi, comisionul de vânzare scade încasarea', () => {
    const p = only(computePositions(txs, 'FIFO'));
    expect(p.totalSold).toBe(131.16); // 12 × 11 − 0,84
    expect(p.realizedPnl).toBe(8.72); // 131,16 − (10 × 10,17 + 2 × 10,37)
    expect(p.quantity).toBe(3);
    expect(p.costBasis).toBe(31.11); // 3 × 10,37
    expect(p.fees).toBe(1.89);
    expect(p.lots).toEqual([{ date: '2024-02-10', quantity: 3, unitCost: 10.37 }]);
  });

  it('cost mediu: unitățile vândute ies la costul mediu, cu tot cu comisioanele de cumpărare', () => {
    const p = only(computePositions(txs, 'AVG'));
    expect(p.realizedPnl).toBe(8.32); // 131,16 − 153,55 × 12/15
    expect(p.costBasis).toBe(30.71);
    expect(p.totalBought).toBe(153.55);
  });

  it('o treime dintr-un cost de 300 este exact 100 (înmulțire înainte de împărțire)', () => {
    const p = only(computePositions([buy('2024-01-10', 3, 100), sell('2024-02-10', 1, 100)], 'AVG'));
    expect(p.costBasis).toBe(200);
    expect(p.realizedPnl).toBe(0);
  });
});

describe('crypto cu 8 zecimale', () => {
  it('cantitățile și costurile rămân exacte după cumpărări și vânzări', () => {
    const txs = [
      buy('2024-01-10', 0.02345678, 40000, { fee: 1 }),
      buy('2024-02-10', 0.1, 45000, { fee: 2 }),
      sell('2024-03-10', 0.02345678, 50000, { fee: 0.5 })
    ];
    expect(0.1 + 0.7).not.toBe(0.8); // cu numere JavaScript, sumele de cantități mici „alunecă”
    const p = only(computePositions(txs, 'FIFO'));
    expect(p.quantity).toBe(0.1);
    expect(p.costBasis).toBe(4502);
    expect(p.realizedPnl).toBe(233.0678); // 1172,339 − 939,2712
  });

  it('adună unitățile foarte mici fără pierderi', () => {
    const p = only(computePositions([buy('2024-01-10', 0.00000001, 1), buy('2024-01-10', 0.00000001, 1), buy('2024-01-10', 0.00000001, 1)], 'AVG'));
    expect(p.quantity).toBe(0.00000003);
  });
});

describe('monede diferite, cu cursurile din ziua tranzacției', () => {
  const rates: Record<string, number> = { '2024-01-10': 4.5, '2024-06-10': 4.6, '2024-09-10': 4.55 };
  const fxAt = (currency: string, date: string): number | null => (currency === 'RON' ? 1 : (rates[date] ?? null));
  const ledgerOf = (txs: LedgerTx[]) =>
    new Ledger({ method: 'AVG', currencyOf: () => 'USD', fxAt }).applyAll(sortTransactions(txs));
  const buys = [buy('2024-01-10', 10, 100), buy('2024-06-10', 10, 110)];

  it('costul în lei folosește cursul de la fiecare cumpărare; valoarea folosește cursul de azi', () => {
    const p = only(ledgerOf(buys).list());
    expect(p.costBasis).toBe(2100); // USD
    expect(p.costBasisBase).toBe(9560); // 1000 × 4,5 + 1100 × 4,6

    const v = valuePosition(p, 1, 120, 4.7); // azi: 120 USD, 4,7 lei/USD
    expect(v.marketValueBase).toBe(11280);
    expect(v.unrealizedBase).toBe(1720);
    expect(v.pricePnlBase).toBe(1410); // (2400 − 2100) USD × 4,7
    expect(v.fxPnlBase).toBe(310); // 2100 USD × 4,7 − 9560
    expect(v.pricePnlBase + v.fxPnlBase).toBe(v.unrealizedBase);
    expect(v.unrealizedPnl).toBe(300); // în USD, doar din preț
  });

  it('profitul realizat în lei: încasarea la cursul vânzării minus costul la cursurile cumpărărilor', () => {
    const p = only(ledgerOf([...buys, sell('2024-09-10', 5, 130, { fee: 1 })]).list());
    expect(p.realizedPnl).toBe(124); // USD: 649 − 2100 × 5/20
    expect(p.realizedPnlBase).toBe(562.95); // 649 × 4,55 − 9560 × 5/20
    expect(p.costBasisBase).toBe(7170);
  });

  it('dacă extrasul brokerului arată suma plătită efectiv în lei, costul în lei este exact acea sumă', () => {
    const txs = [buy('2024-01-10', 10, 100, { currency: 'USD', cashAmount: '-4512.3', cashCurrency: 'RON' })];
    const p = only(ledgerOf(txs).list());
    expect(p.costBasisBase).toBe(4512.3);
  });

  it('fără curs istoric, poziția revine la cursul de azi', () => {
    const p = only(ledgerOf([buy('2023-05-05', 10, 100)]).list());
    expect(p.costBasisBase).toBeNull();
    const v = valuePosition(p, 1, 120, 4.7);
    expect(v.costBasisBase).toBe(4700);
    expect(v.fxPnlBase).toBe(0);
  });
});

describe('pozițiile pe minus', () => {
  it('prețul de break-even include comisioanele', () => {
    const p = only(computePositions([buy('2024-01-10', 10, 50, { fee: 5 })], 'AVG'));
    const v = valuePosition(p, 1, 40, 1);
    expect(v.unrealizedBase).toBe(-105);
    expect(v.breakEvenPrice).toBe(50.5);
    expect(v.recoveryPct).toBe(0.2625); // 505 / 400 − 1
  });

  it('la −20% ai nevoie de +25% ca să recuperezi', () => {
    const v = valuePosition({ quantity: 10, costBasis: 500, realizedPnl: 0, income: 0, totalBought: 500 }, 1, 40, 1);
    expect(v.unrealizedBasePct).toBe(-0.2);
    expect(v.recoveryPct).toBe(0.25);
  });

  it('break-even în moneda activului, la cursul de azi, când costul s-a plătit la alt curs', () => {
    // 10 acțiuni cumpărate cu 4500 lei (100 USD la 4,5); azi cursul este 5: break-even = 4500 / (10 × 5) = 90 USD.
    const v = valuePosition({ quantity: 10, costBasis: 1000, costBasisBase: 4500, realizedPnl: 0, income: 0, totalBought: 1000 }, 1, 80, 5);
    expect(v.breakEvenPrice).toBe(90);
    expect(v.unrealizedBase).toBe(-500);
    expect(v.recoveryPct).toBe(0.125); // 90 / 80 − 1
  });

  it('totalurile separă câștigurile și pierderile nerealizate', () => {
    const winner = valuePosition({ quantity: 1, costBasis: 100, realizedPnl: 0, income: 0, totalBought: 100 }, 1, 130, 1);
    const loser1 = valuePosition({ quantity: 1, costBasis: 100, realizedPnl: 0, income: 0, totalBought: 100 }, 1, 80, 1);
    const loser2 = valuePosition({ quantity: 2, costBasis: 50, realizedPnl: 0, income: 0, totalBought: 50 }, 1, 20.1, 1);
    const t = summarize([winner, loser1, loser2], 'RON');
    expect(t.unrealizedGains).toBe(30);
    expect(t.gainingPositions).toBe(1);
    expect(t.unrealizedLosses).toBe(-29.8); // −20 + (40,2 − 50)
    expect(t.losingPositions).toBe(2);
    expect(t.unrealizedLossesPct).toBeCloseTo(-29.8 / 150, 12);
    expect(t.unrealized).toBe(0.2);
  });
});
