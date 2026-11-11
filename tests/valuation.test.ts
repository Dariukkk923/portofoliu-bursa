import { describe, expect, it } from 'vitest';
import {
  buildAllocation,
  combineValuations,
  computePositions,
  priceMultiplier,
  summarize,
  topMovers,
  valuePosition,
  type PositionState
} from '@shared/calc';
import { buy, income, sell } from './helpers';

const find = (positions: PositionState[], assetId: number, brokerId: number): PositionState =>
  positions.find((p) => p.assetId === assetId && p.brokerId === brokerId) as PositionState;

describe('evaluarea unei poziții', () => {
  it('calculează valoarea de piață și profitul nerealizat în bani și în procente', () => {
    const [p] = computePositions([buy('2024-01-10', 10, 100, { fee: 5 })], 'AVG');
    const v = valuePosition(p, 1, 120, 1);
    expect(v.avgPrice).toBeCloseTo(100.5, 8);
    expect(v.marketValue).toBeCloseTo(1200, 8);
    expect(v.unrealizedPnl).toBeCloseTo(195, 8);
    expect(v.unrealizedPct).toBeCloseTo(195 / 1005, 10);
  });

  it('pierderea nerealizată este negativă', () => {
    const [p] = computePositions([buy('2024-01-10', 4, 50)], 'FIFO');
    const v = valuePosition(p, 1, 40, 1);
    expect(v.unrealizedPnl).toBeCloseTo(-40, 8);
    expect(v.unrealizedPct).toBeCloseTo(-0.2, 10);
  });

  it('fără preț disponibil, poziția se evaluează la cost (profit nerealizat zero)', () => {
    const [p] = computePositions([buy('2024-01-10', 4, 50, { fee: 2 })], 'AVG');
    const v = valuePosition(p, 1, null, 4.5);
    expect(v.marketValue).toBeCloseTo(202, 8);
    expect(v.unrealizedPnl).toBe(0);
    expect(v.marketValueBase).toBeCloseTo(909, 8);
  });

  it('obligațiuni: prețul mediu și prețul curent sunt procente din nominal', () => {
    const multiplier = priceMultiplier({ type: 'bond', faceValue: 1000 });
    expect(multiplier).toBe(10);
    expect(priceMultiplier({ type: 'stock' })).toBe(1);
    const [p] = computePositions([buy('2024-01-15', 5, 98.5, { fee: 10 })], 'AVG', () => multiplier);
    const v = valuePosition(p, multiplier, 101.2, 1);
    expect(v.avgPrice).toBeCloseTo(98.7, 8); // 4935 / (5 * 10)
    expect(v.marketValue).toBeCloseTo(5060, 8);
    expect(v.unrealizedPnl).toBeCloseTo(125, 8);
  });
});

describe('portofoliu cu mai mulți brokeri și monede diferite', () => {
  // Activ 1: acțiune în USD la doi brokeri; activ 2: ETF în EUR; activ 3: obligațiune în RON.
  const txs = [
    buy('2024-01-10', 10, 150, { assetId: 1, brokerId: 1, fee: 1 }),
    buy('2024-02-10', 5, 170, { assetId: 1, brokerId: 2, fee: 1 }),
    sell('2024-03-10', 4, 200, { assetId: 1, brokerId: 1, fee: 1 }),
    income('dividend', '2024-05-15', 10, 1, { assetId: 1, brokerId: 1 }),
    buy('2024-01-20', 2, 100, { assetId: 2, brokerId: 1 }),
    buy('2024-04-01', 50, 100, { assetId: 3, brokerId: 2 }),
    income('coupon', '2025-04-01', 360, 0, { assetId: 3, brokerId: 2 })
  ];
  const positions = computePositions(txs, 'AVG');
  const USD_RON = 4.5;
  const EUR_RON = 5;

  const a1b1 = valuePosition(find(positions, 1, 1), 1, 210, USD_RON);
  const a1b2 = valuePosition(find(positions, 1, 2), 1, 210, USD_RON);
  const a2 = valuePosition(find(positions, 2, 1), 1, 110, EUR_RON);
  const a3 = valuePosition(find(positions, 3, 2), 1, 101.2, 1);

  it('evaluează fiecare poziție în moneda ei și o convertește în moneda de bază', () => {
    expect(a1b1.marketValue).toBeCloseTo(1260, 8);
    expect(a1b1.unrealizedPnl).toBeCloseTo(359.4, 8);
    expect(a1b1.marketValueBase).toBeCloseTo(5670, 8);
    expect(a1b2.unrealizedPnl).toBeCloseTo(199, 8);
    expect(a2.marketValueBase).toBeCloseTo(1100, 8);
    expect(a2.unrealizedBase).toBeCloseTo(100, 8);
    expect(a3.marketValueBase).toBeCloseTo(5060, 8);
  });

  it('agregă același activ de la brokeri diferiți', () => {
    const total = combineValuations([a1b1, a1b2], 1);
    expect(total.quantity).toBe(11);
    expect(total.costBasis).toBeCloseTo(1751.6, 8);
    expect(total.avgPrice).toBeCloseTo(1751.6 / 11, 8);
    expect(total.marketValue).toBeCloseTo(2310, 8);
    expect(total.unrealizedPnl).toBeCloseTo(558.4, 8);
    expect(total.unrealizedPct).toBeCloseTo(558.4 / 1751.6, 10);
    expect(total.realizedPnl).toBeCloseTo(198.6, 8);
    expect(total.income).toBeCloseTo(9, 8);
  });

  it('calculează totalurile: realizat și nerealizat separat, plus randamentul total', () => {
    const totals = summarize([a1b1, a1b2, a2, a3], 'RON');
    expect(totals.totalValue).toBeCloseTo(16555, 6);
    expect(totals.totalCost).toBeCloseTo(13882.2, 6);
    expect(totals.unrealized).toBeCloseTo(2672.8, 6);
    expect(totals.realizedSales).toBeCloseTo(893.7, 6);
    expect(totals.income).toBeCloseTo(400.5, 6); // 9 USD * 4.5 + 360 RON
    expect(totals.realized).toBeCloseTo(1294.2, 6);
    expect(totals.totalPnl).toBeCloseTo(3967, 6);
    expect(totals.totalInvested).toBeCloseTo(16584, 6);
    expect(totals.returnPct).toBeCloseTo(3967 / 16584, 10);
  });

  it('schimbarea monedei de bază schimbă doar cursurile, nu și calculul pe poziție', () => {
    // Aceleași poziții exprimate în EUR: USD->EUR = 0.9, RON->EUR = 0.2.
    const inEur = summarize(
      [
        valuePosition(find(positions, 1, 1), 1, 210, 0.9),
        valuePosition(find(positions, 1, 2), 1, 210, 0.9),
        valuePosition(find(positions, 2, 1), 1, 110, 1),
        valuePosition(find(positions, 3, 2), 1, 101.2, 0.2)
      ],
      'EUR'
    );
    expect(inEur.baseCurrency).toBe('EUR');
    expect(inEur.totalValue).toBeCloseTo(2310 * 0.9 + 220 + 5060 * 0.2, 6);
  });

  it('portofoliul gol nu produce împărțiri la zero', () => {
    const totals = summarize([], 'RON');
    expect(totals.totalValue).toBe(0);
    expect(totals.returnPct).toBeNull();
    expect(totals.unrealizedPct).toBeNull();
  });
});

describe('alocare și clasamente', () => {
  it('calculează procentele și grupează restul în „Altele”', () => {
    const slices = buildAllocation(
      [
        { key: 'a', label: 'A', value: 50 },
        { key: 'b', label: 'B', value: 30 },
        { key: 'c', label: 'C', value: 15 },
        { key: 'd', label: 'D', value: 5 },
        { key: 'a', label: 'A', value: 100 },
        { key: 'z', label: 'Z', value: 0 }
      ],
      3
    );
    expect(slices.map((s) => s.label)).toEqual(['A', 'B', 'Altele']);
    expect(slices[0].value).toBe(150);
    expect(slices[0].pct).toBeCloseTo(0.75, 10);
    expect(slices[2].value).toBe(20);
    expect(slices.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(1, 10);
  });

  it('alege primii câștigători și primele pierderi după randament', () => {
    const items = [
      { id: 'a', quantity: 1, unrealizedPct: 0.5 },
      { id: 'b', quantity: 1, unrealizedPct: -0.3 },
      { id: 'c', quantity: 1, unrealizedPct: 0.1 },
      { id: 'd', quantity: 1, unrealizedPct: -0.05 },
      { id: 'e', quantity: 0, unrealizedPct: 0.9 }, // poziție închisă: ignorată
      { id: 'f', quantity: 1, unrealizedPct: null }
    ];
    const { gainers, losers } = topMovers(items, 1);
    expect(gainers.map((x) => x.id)).toEqual(['a']);
    expect(losers.map((x) => x.id)).toEqual(['b']);
    const all = topMovers(items);
    expect(all.gainers.map((x) => x.id)).toEqual(['a', 'c']);
    expect(all.losers.map((x) => x.id)).toEqual(['b', 'd']);
  });
});
