/** Dashboard-ul: valoarea portofoliului, evoluția, top pozițiile, alocarea, performanța, proiecția și detaliile de profit. */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, ChartNoAxesCombined, Layers, Percent, Plus, TrendingUp, Wallet } from 'lucide-react';
import { ASSET_TYPES } from '@shared/types';
import { PERIODS, RANGE_LABEL } from '@shared/labels';
import { futureValue } from '@shared/calc';
import { useStoredPeriod } from '../lib/period';
import { api } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, signedMoney, signedPercent } from '../lib/format';
import { AllocationDonut } from '../components/charts';
import { CashCards } from '../components/CashCards';
import { BenchmarkCard } from '../components/BenchmarkCard';
import { GoalsSummary } from './GoalsPage';
import { AnimatedNumber, Button, Card, EmptyState, LoadError, Notice, Pnl, Segmented, Skeleton, cx } from '../components/ui';
import type { PageId } from '../components/Layout';
import { AllocationBlock, DashboardSkeleton, InfoTip, KpiCard, Panel, PortfolioChart, PositionRow, ProjectionChart, ReturnBox, VsBenchmark, type AllocationPart } from '../components/dashboard';

/** Card cu o cifră principală și un rând de detalii (secțiunea „Detalii profit”). */
function Kpi({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="card-hover rounded-xl border border-line bg-surface px-5 py-4 shadow-card">
      <p className="text-body font-medium text-ink-2">{label}</p>
      <div className="tabular mt-1 text-kpi font-bold tracking-tight text-ink">{value}</div>
      {detail && <div className="mt-1 text-xs text-ink-2">{detail}</div>}
    </div>
  );
}

type PositionsTab = 'top' | 'gainers' | 'losers';
const TAB_LABEL: Record<PositionsTab, string> = { top: 'Top poziții', gainers: 'Câștigători', losers: 'Pierderi' };
const PROJECTION_YEARS = [5, 10, 20];

export function DashboardPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { filter, dataVersion, brokers, bumpData, user } = useApp();
  // O singură perioadă pentru grafic, profitul pe perioadă și comparația cu indicele; se ține minte.
  const [range, setRange] = useStoredPeriod(user?.id);
  const [tab, setTab] = useState<PositionsTab>('top');
  const overview = useLoad(() => api.portfolio.overview(filter), [filter, dataVersion]);
  const period = useLoad(() => api.portfolio.periodProfit(range, filter), [range, filter, dataVersion]);
  const history = useLoad(() => api.portfolio.history(range, filter), [range, filter, dataVersion]);
  const performance = useLoad(() => api.portfolio.performance('ALL', filter), [filter, dataVersion]);
  const rangePerf = useLoad(() => api.portfolio.performance(range, filter), [range, filter, dataVersion]);
  const projection = useLoad(() => api.portfolio.projection(filter), [filter, dataVersion]);
  // Lista completă a activelor dă o ordine stabilă culorilor din graficul de alocare.
  const assets = useLoad(() => api.assets.list(), [dataVersion]);

  const o = overview.data;
  const proj = projection.data;
  const points = useMemo(() => {
    if (!proj) return [];
    const monthly = Math.max(0, proj.averageContribution);
    return Array.from({ length: 21 }, (_, year) => ({ year, value: futureValue(proj.currentValue, monthly, proj.annualReturn, year * 12) }));
  }, [proj]);

  if (!o) {
    return overview.error ? <LoadError message={overview.error} onRetry={overview.reload} /> : <DashboardSkeleton />;
  }

  const t = o.totals;
  const base = t.baseCurrency;
  const pp = range !== 'ALL' ? period.data : null;
  const hasData = o.positions.length > 0 || o.closed.length > 0;
  const filtered = !!(filter.brokerId || filter.assetType);

  if (!hasData) {
    return (
      <Card>
        <EmptyState
          icon={<ChartNoAxesCombined className="size-5" />}
          title={filtered ? 'Nicio poziție pentru filtrul ales' : 'Portofoliul este gol'}
          text={
            filtered
              ? 'Schimbă filtrul de broker sau de tip de activ din bara de sus.'
              : 'Adaugă primul activ (acțiune, ETF, obligațiune sau crypto) și aici vor apărea valoarea portofoliului, profitul și graficele.'
          }
          action={
            !filtered && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => onNavigate('positions')}>
                Adaugă primul activ
              </Button>
            )
          }
        />
      </Card>
    );
  }

  const periodGain = pp ? pp.realized + pp.unrealizedChange : t.totalPnl;
  const periodPct = rangePerf.data?.twr ?? (range === 'ALL' ? t.returnPct : null);
  const invested = performance.data?.allTime.netContributions ?? null;
  const profit = invested === null ? null : t.totalValue - invested;

  // Alocarea: tipurile de active, plus cash-ul; obligațiunile și crypto intră la „Alte active”.
  const byType = (key: string): number => o.allocationByType.find((s) => s.key === key)?.value ?? 0;
  const parts: AllocationPart[] = [
    { key: 'etf', label: 'ETF-uri', value: byType('etf'), color: 'var(--series-1)' },
    { key: 'stock', label: 'Acțiuni', value: byType('stock'), color: 'var(--series-2)' },
    { key: 'cash', label: 'Cash', value: Math.max(0, t.cash), color: 'var(--series-3)' },
    { key: 'other', label: 'Alte active', value: byType('bond') + byType('crypto'), color: 'var(--series-4)' }
  ].filter((p) => p.value > 0);

  const rows = tab === 'top' ? [...o.aggregated].sort((a, b) => b.marketValueBase - a.marketValueBase).slice(0, 5) : tab === 'gainers' ? o.topGainers : o.topLosers;
  const periodOptions = PERIODS.map((r) => ({ value: r, label: RANGE_LABEL[r] }));
  const rangeBench = rangePerf.data?.benchmark?.name.replace(/ \(prin ETF-ul .*\)$/, '') ?? 'S&P 500';

  return (
    <>
      {o.missingPrices.length > 0 && (
        <Notice tone="warn">
          Fără preț de piață pentru <strong>{o.missingPrices.join(', ')}</strong> — pozițiile sunt evaluate la cost. Poți introduce un preț manual din pagina Portofoliu.
        </Notice>
      )}
      {o.approximateFx && <Notice tone="warn">Cursurile valutare nu au putut fi descărcate încă; conversia în {base} folosește cursuri aproximative până la prima actualizare.</Notice>}

      {/* Rândul 1: cifrele principale */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr_1fr]">
        <div className="card-hover flex min-w-0 items-center gap-4 rounded-xl border border-line bg-surface px-5 py-4 shadow-card sm:col-span-2 lg:col-span-1">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent ring-1 ring-brand/30 max-sm:size-10" aria-hidden>
            <Layers className="size-6" />
          </span>
          <div className="min-w-0">
            <p className="text-body font-medium text-ink-2">Valoare portofoliu</p>
            <div className="tabular text-kpi-hero font-bold tracking-tight text-ink">
              <AnimatedNumber value={t.totalValue} format={(v) => money(v, base)} />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 text-body font-semibold">
              <Pnl value={periodGain}>
                <AnimatedNumber value={periodGain} format={(v) => signedMoney(v, base)} />
              </Pnl>
              {periodPct !== null && <Pnl value={periodPct}>({signedPercent(periodPct)})</Pnl>}
              <InfoTip label="Ce arată variația" text={`Câștigul sau pierderea în perioada aleasă (${range === 'ALL' ? 'de la început' : RANGE_LABEL[range]}): profit realizat plus variația celui nerealizat. Procentul este randamentul TWR al perioadei.`} />
            </div>
          </div>
        </div>
        <KpiCard
          label="Investit"
          icon={<Wallet />}
          value={invested === null ? <Skeleton className="h-8 w-28" /> : <AnimatedNumber value={invested} format={(v) => money(v, base)} />}
          detail="Total depus net"
        />
        <KpiCard
          label="Profit / Pierdere"
          icon={<TrendingUp />}
          value={
            profit === null ? (
              <Skeleton className="h-8 w-28" />
            ) : (
              <Pnl value={profit}>
                <AnimatedNumber value={profit} format={(v) => signedMoney(v, base)} />
              </Pnl>
            )
          }
          detail="Valoare − investit"
        />
        <KpiCard
          label="Randament (TWR)"
          icon={<Percent />}
          value={
            rangePerf.data === null ? (
              <Skeleton className="h-8 w-24" />
            ) : rangePerf.data.twr === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <Pnl value={rangePerf.data.twr}>{signedPercent(rangePerf.data.twr)}</Pnl>
            )
          }
          detail={range === 'ALL' ? 'De la început' : `Perioada ${RANGE_LABEL[range]}`}
        />
        <KpiCard
          label="Contribuții lunare"
          icon={<CalendarDays />}
          value={proj ? <AnimatedNumber value={proj.averageContribution} format={(v) => money(v, base)} /> : <Skeleton className="h-8 w-24" />}
          detail="Medie, ultimele 12 luni"
        />
      </div>

      {/* Rândul 2: evoluția și top pozițiile */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
        <Panel
          title={
            <>
              Evoluția portofoliului
              <span className="hidden text-xs font-normal text-ink-3 2xl:inline">linia punctată = suma investită</span>
            </>
          }
          action={<Segmented size="sm" value={range} onChange={setRange} options={periodOptions} />}>
          {history.error ? (
            <LoadError message={history.error} onRetry={history.reload} />
          ) : history.data && history.data.length > 1 ? (
            <>
              <PortfolioChart data={history.data} currency={base} />
            </>
          ) : history.loading ? (
            <Skeleton className="min-h-64 flex-1" />
          ) : (
            <EmptyState icon={<ChartNoAxesCombined className="size-5" />} title="Prea puține date pentru grafic" text="Încearcă o perioadă mai lungă sau actualizează prețurile." />
          )}
        </Panel>

        <Panel
          title={
            <div role="tablist" aria-label="Poziții" className="flex flex-wrap gap-x-4 gap-y-1">
              {(Object.keys(TAB_LABEL) as PositionsTab[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cx('min-h-8 border-b-2 pb-1 text-md font-semibold whitespace-nowrap transition max-md:min-h-11', tab === k ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink')}
                >
                  {TAB_LABEL[k]}
                </button>
              ))}
            </div>
          }
          action={
            <button type="button" onClick={() => onNavigate('positions')} className="inline-flex min-h-8 items-center gap-1 text-body font-semibold text-accent hover:underline max-md:min-h-11">
              Vezi tot <ArrowRight className="size-4" aria-hidden />
            </button>
          }
        >
          {rows.length === 0 ? (
            <p className="flex flex-1 items-center justify-center py-8 text-center text-body text-ink-3">{tab === 'losers' ? 'Nicio poziție pe pierdere.' : 'Nicio poziție de afișat.'}</p>
          ) : (
            <ul className="divide-y divide-line/60" role="tabpanel">
              {rows.map((p) => (
                <PositionRow key={p.key} p={p} currency={base} onOpen={() => onNavigate('positions')} />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Rândul 3: alocare, performanță, proiecție */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Alocare portofoliu">
          <AllocationBlock parts={parts} total={t.totalValue} currency={base} />
        </Panel>

        <Panel title={<>Performanță</>}>
          <div className="grid grid-cols-2 gap-3">
            <ReturnBox label="TWR" value={rangePerf.data?.twr ?? null} tip="Randamentul ponderat în timp: cât a crescut portofoliul, fără influența banilor depuși sau retrași." />
            <ReturnBox label="XIRR" value={rangePerf.data?.xirr ?? null} tip="Randamentul anual ținând cont de momentul și mărimea fiecărei depuneri. Arată cât ai câștigat tu, cu banii tăi." />
          </div>
          <p className="mt-5 mb-3 text-md font-semibold text-ink">vs {rangeBench} (perioada aleasă)</p>
          {rangePerf.error ? <LoadError message={rangePerf.error} onRetry={rangePerf.reload} /> : rangePerf.data ? <VsBenchmark perf={rangePerf.data} /> : <Skeleton className="h-16" />}
        </Panel>

        <Panel title="Proiecție creștere portofoliu" className="md:max-xl:col-span-2">
          {proj ? (
            <>
              <ProjectionChart points={points} currency={proj.currency} />
              <div className="mt-4 grid grid-cols-3 divide-x divide-line text-center">
                {PROJECTION_YEARS.map((y) => (
                  <div key={y} className="min-w-0 px-2">
                    <p className="text-body text-ink-2">{y} ani</p>
                    <p className="tabular truncate text-md font-bold text-ink">{money(points[y]?.value ?? 0, proj.currency, 0)}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 flex flex-wrap items-center justify-between gap-x-3 text-xs text-ink-3">
                <span>
                  Estimare: {signedPercent(proj.annualReturn, 1)} pe an, {money(Math.max(0, proj.averageContribution), proj.currency, 0)} pe lună.
                </span>
                <button type="button" onClick={() => onNavigate('goals')} className="inline-flex min-h-8 items-center gap-1 text-body font-semibold text-accent hover:underline max-md:min-h-11">
                  Vezi obiectivele <ArrowRight className="size-4" aria-hidden />
                </button>
              </p>
            </>
          ) : projection.error ? (
            <LoadError message={projection.error} onRetry={projection.reload} />
          ) : (
            <Skeleton className="min-h-48 flex-1" />
          )}
        </Panel>
      </div>

      {/* Detaliile care existau deja, cu aceeași perioadă */}
      <div className="flex flex-wrap items-end justify-between gap-3 pt-3">
        <div>
          <h2 className="text-lg font-bold text-ink">Detalii profit</h2>
          <p className="text-body text-ink-2">
            {range === 'ALL' ? 'Profitul de la început' : `Profitul în perioada aleasă (${RANGE_LABEL[range]}${pp ? `, de la ${fmtDate(pp.from)}` : ''})`}
          </p>
        </div>
        <Segmented size="sm" value={range} onChange={setRange} options={periodOptions} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Valoarea totală a portofoliului"
          value={<AnimatedNumber value={t.totalValue} format={(v) => money(v, base)} />}
          detail={
            <>
              {Math.abs(t.cash) >= 0.005 && (
                <span className="tabular">
                  Active {money(t.holdingsValue, base)} · Cash {money(t.cash, base)} ·{' '}
                </span>
              )}
              Cost: <span className="tabular">{money(t.totalCost, base)}</span>
            </>
          }
        />
        {pp ? (
          <>
            <Kpi
              label={`Profit total · ${RANGE_LABEL[range]}`}
              value={
                <Pnl value={pp.realized + pp.unrealizedChange}>
                  <AnimatedNumber value={pp.realized + pp.unrealizedChange} format={(v) => signedMoney(v, base)} />
                </Pnl>
              }
              detail="Realizat în perioadă + variația celui nerealizat"
            />
            <Kpi
              label={`Profit nerealizat · ${RANGE_LABEL[range]}`}
              value={
                <Pnl value={pp.unrealizedChange}>
                  <AnimatedNumber value={pp.unrealizedChange} format={(v) => signedMoney(v, base)} />
                </Pnl>
              }
              detail={
                <span className="tabular">
                  De la {signedMoney(pp.unrealizedStart, base)} la {signedMoney(pp.unrealizedEnd, base)}
                </span>
              }
            />
            <Kpi
              label={`Profit realizat · ${RANGE_LABEL[range]}`}
              value={
                <Pnl value={pp.realized}>
                  <AnimatedNumber value={pp.realized} format={(v) => signedMoney(v, base)} />
                </Pnl>
              }
              detail={
                <span className="tabular">
                  Vânzări {signedMoney(pp.realizedSales, base)} · Dividende și cupoane {signedMoney(pp.income, base)}
                </span>
              }
            />
          </>
        ) : (
          <>
            <Kpi
              label="Profit total (realizat + nerealizat)"
              value={
                <Pnl value={t.totalPnl}>
                  <AnimatedNumber value={t.totalPnl} format={(v) => signedMoney(v, base)} />
                </Pnl>
              }
              detail={
                <>
                  Randament total:{' '}
                  <Pnl value={t.returnPct} arrow className="font-semibold">
                    {signedPercent(t.returnPct)}
                  </Pnl>
                </>
              }
            />
            <Kpi
              label="Profit nerealizat (poziții deschise)"
              value={
                <Pnl value={t.unrealized}>
                  <AnimatedNumber value={t.unrealized} format={(v) => signedMoney(v, base)} />
                </Pnl>
              }
              detail={
                <>
                  <Pnl value={t.unrealizedPct} arrow className="font-semibold">
                    {signedPercent(t.unrealizedPct)}
                  </Pnl>
                  {Math.abs(t.fxPnl) >= 0.005 && (
                    <span className="tabular" title="Partea datorată prețurilor și partea datorată cursurilor valutare">
                      {' '}
                      · din preț {signedMoney(t.pricePnl, base)} · din curs {signedMoney(t.fxPnl, base)}
                    </span>
                  )}
                </>
              }
            />
            <Kpi
              label="Profit realizat"
              value={
                <Pnl value={t.realized}>
                  <AnimatedNumber value={t.realized} format={(v) => signedMoney(v, base)} />
                </Pnl>
              }
              detail={
                <span className="tabular">
                  Vânzări {signedMoney(t.realizedSales, base)} · Dividende și cupoane {signedMoney(t.income, base)}
                </span>
              }
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Kpi
          label="Pe plus (câștiguri nerealizate)"
          value={<Pnl value={t.unrealizedGains}>{signedMoney(t.unrealizedGains, base)}</Pnl>}
          detail={
            <>
              {t.gainingPositions === 1 ? '1 poziție' : `${t.gainingPositions} poziții`} pe plus
              {t.unrealizedGainsPct !== null && (
                <>
                  {' '}·{' '}
                  <Pnl value={t.unrealizedGainsPct} arrow className="font-semibold">
                    {signedPercent(t.unrealizedGainsPct)}
                  </Pnl>
                </>
              )}
            </>
          }
        />
        <Kpi
          label="Pe minus (pierderi nerealizate)"
          value={<Pnl value={t.unrealizedLosses}>{signedMoney(t.unrealizedLosses, base)}</Pnl>}
          detail={
            t.losingPositions === 0 ? (
              'Nicio poziție pe minus'
            ) : (
              <>
                {t.losingPositions === 1 ? '1 poziție' : `${t.losingPositions} poziții`} pe minus ·{' '}
                <Pnl value={t.unrealizedLossesPct} arrow className="font-semibold">
                  {signedPercent(t.unrealizedLossesPct)}
                </Pnl>{' '}
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => onNavigate('positions')}>
                  Vezi pozițiile
                </button>
              </>
            )
          }
        />
      </div>

      <CashCards totals={t} balances={o.cashBalances} untracked={o.untrackedCashBrokers} performance={performance.data} assets={assets.data ?? []} onChanged={bumpData} />

      <BenchmarkCard filter={filter} dataVersion={dataVersion} range={range} onRange={setRange} />

      <GoalsSummary onOpen={() => onNavigate('goals')} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card title="Alocare pe tip de activ">
          <AllocationDonut slices={o.allocationByType} currency={base} order={ASSET_TYPES} />
        </Card>
        <Card title="Alocare pe broker">
          <AllocationDonut slices={o.allocationByBroker} currency={base} order={brokers.map((b) => b.id).sort((a, b) => a - b).map(String)} />
        </Card>
        <Card title="Alocare pe activ">
          <AllocationDonut slices={o.allocationByAsset} currency={base} order={(assets.data ?? []).map((a) => a.id).sort((a, b) => a - b).map(String)} />
        </Card>
      </div>
    </>
  );
}
