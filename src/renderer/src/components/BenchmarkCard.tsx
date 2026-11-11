/**
 * Panoul principal: randamentul portofoliului suprapus peste indicele de referință
 * (implicit S&P 500), ambele pornind de la 0%. Portofoliul folosește randamentul
 * ponderat în timp (TWR), deci depunerile și retragerile nu distorsionează comparația;
 * indicele este convertit în moneda portofoliului la cursul fiecărei zile.
 */
import { useState } from 'react';
import type { HistoryRange, PortfolioFilter } from '@shared/types';
import { RANGE_LABEL } from '@shared/labels';
import { api } from '../api';
import { useLoad } from '../context/AppContext';
import { date as fmtDate, signedPercent } from '../lib/format';
import { BenchmarkChart, type BenchmarkChartPoint } from './charts';
import { Card, LoadError, Segmented, Skeleton, cx } from './ui';

const RANGES: HistoryRange[] = ['1M', '3M', '6M', '1Y', 'ALL'];

export function BenchmarkCard({ filter, dataVersion }: { filter: PortfolioFilter; dataVersion: number }) {
  const [range, setRange] = useState<HistoryRange>('1Y');
  const perf = useLoad(() => api.portfolio.performance(range, filter), [range, filter, dataVersion]);
  const p = perf.data;
  const b = p?.benchmark ?? null;
  const name = b?.name.replace(/ \(prin ETF-ul .*\)$/, '') ?? 'S&P 500';

  // Ambele linii pornesc de la 0% în prima zi în care indicele are date.
  let data: BenchmarkChartPoint[] = [];
  if (p && p.points.length > 1) {
    const start = p.points.findIndex((pt) => pt.benchmark !== null);
    const from = start >= 0 ? start : 0;
    const base = 1 + p.points[from].twr;
    data = p.points.slice(from).map((pt) => ({ date: pt.date, portfolio: base > 0 ? (1 + pt.twr) / base - 1 : pt.twr, benchmark: pt.benchmark }));
  }
  const diff = b && b.return !== null && b.portfolioReturn !== null ? b.portfolioReturn - b.return : null;
  const startedLater = b?.from && p?.points[0] && b.from > p.points[0].date;

  return (
    <Card
      title={`Randamentul tău vs. ${name}`}
      action={<Segmented size="sm" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} />}
    >
      {perf.error ? (
        <LoadError message={perf.error} onRetry={perf.reload} />
      ) : !p ? (
        <Skeleton className="h-64" />
      ) : data.length < 2 ? (
        <p className="flex h-64 items-center justify-center text-body text-ink-3">Nu există suficiente date pentru comparație în intervalul ales.</p>
      ) : (
        <>
          {diff !== null ? (
            <p className={cx('mb-1 text-base font-semibold', diff >= 0 ? 'text-gain' : 'text-loss')}>
              {diff >= 0 ? `Ești cu ${signedPercent(diff, 1)} peste ${name}` : `Ești cu ${signedPercent(diff, 1)} sub ${name}`}
            </p>
          ) : (
            <p className="mb-1 text-body text-ink-3">Istoricul indicelui se descarcă la următoarea actualizare a prețurilor.</p>
          )}
          {b && b.return !== null && b.portfolioReturn !== null && (
            <p className="mb-3 text-xs text-ink-2">
              Portofoliul {signedPercent(b.portfolioReturn, 1)} · {name} {signedPercent(b.return, 1)}
              {b.currency !== p.baseCurrency && ` (în ${p.baseCurrency})`}
              {startedLater && ` · de la ${fmtDate(b.from)}, prima zi cu date pentru indice`}
            </p>
          )}
          <BenchmarkChart data={data} name={name} />
          <p className="mt-2 text-xs text-ink-3">
            Randamentul portofoliului este ponderat în timp: depunerile și retragerile nu îl influențează.
            {b && b.currency !== p.baseCurrency && ` Indicele este convertit în ${p.baseCurrency} la cursul fiecărei zile.`} Indicele nu include dividendele.
          </p>
        </>
      )}
    </Card>
  );
}
