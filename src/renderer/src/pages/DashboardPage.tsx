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
import { AllocationBlock, DashboardSkeleton, GainLine, InfoTip, KpiCard, Panel, PortfolioChart, PositionRow, ProjectionChart, ReturnBox, VsBenchmark, type AllocationPart } from '../components/dashboard';

/** Card cu o cifră principală și un rând de detalii (secțiunea „Detalii profit”). */
function Kpi({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="dash-card card-hover px-6 py-5">
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

  // Câștigul și procentul de sub valoare: aceleași cifre ca în graficul de evoluție, pentru perioada aleasă.
  // Procentul e randamentul banilor (are mereu semnul câștigului); TWR-ul apare separat, în card.
  const periodGain = rangePerf.data?.gain ?? (pp ? pp.gain : t.totalPnl);
  const periodPct = rangePerf.data?.moneyWeighted ?? (range === 'ALL' ? t.returnPct : null);
  const xirrAnnual = rangePerf.data?.xirr ?? null;
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
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-[1.75fr_1fr_1fr_1fr_1fr]">
        <div className="dash-card card-hover relative flex min-w-0 items-center gap-4 px-5 py-5 sm:col-span-2 lg:col-span-1">
          <span className="flex size-13 shrink-0 items-center justify-center self-start rounded-full bg-accent-soft text-accent ring-1 ring-brand/35 max-sm:size-11" aria-hidden>
            <Layers className="size-6.5" />
          </span>
          <div className="@container min-w-0 flex-1">
            <p className="text-md font-medium text-ink">Valoare portofoliu</p>
            <div className="tabular mt-1 text-[clamp(1.375rem,12.2cqi,2.375rem)] leading-tight font-extrabold tracking-tight whitespace-nowrap text-ink max-sm:text-[1.75rem]">
              <AnimatedNumber value={t.totalValue} format={(v) => money(v, base)} />
            </div>
            <div className="mt-1.5 flex flex-nowrap items-center gap-x-1 text-[clamp(0.75rem,7.1cqi,0.9375rem)] font-semibold whitespace-nowrap max-sm:text-body">
              <GainLine value={periodGain} pct={periodPct} currency={base} />
              <InfoTip className="max-sm:absolute max-sm:top-1 max-sm:right-1" label="Ce arată variația" text={`Câștigul sau pierderea în perioada aleasă (${range === 'ALL' ? 'de la început' : RANGE_LABEL[range]}): profit realizat plus variația celui nerealizat. Procentul este randamentul TWR al perioadei.`} />
            </div>
          </div>
        </div>
        <KpiCard
          label="Investit"
          icon={<Wallet />}
          value={invested === null ? <Skeleton className="h-8 w-28" /> : <AnimatedNumber value={invested} format={(v) => money(v, base)} />}
          detail="Total depus net (depuneri minus retrageri)"
        />
        <KpiCard
          label="Profit / Pierdere"
          icon={<TrendingUp />}
          value={
            profit === null ? (
              <Skeleton className="h-8 w-28" />
            ) : (
              <Pnl value={profit} arrow={false}>
                <AnimatedNumber value={profit} format={(v) => signedMoney(v, base)} />
              </Pnl>
            )
          }
          detail="Valoarea portofoliului minus suma investită"
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
              <Pnl value={rangePerf.data.twr} arrow={false}>
                {signedPercent(rangePerf.data.twr)}
              </Pnl>
            )
          }
          detail={range === 'ALL' ? 'Randamentul de la început' : `Randamentul în perioada ${RANGE_LABEL[range]}`}
        />
        <KpiCard
          label="Contribuții lunare"
          icon={<CalendarDays />}
          value={proj ? <AnimatedNumber value={proj.averageContribution} format={(v) => money(v, base)} /> : <Skeleton className="h-8 w-24" />}
          detail="Media lunară a banilor depuși, ultimele 12 luni"
        />
      </div>

      {/* Rândul 2: evoluția și top pozițiile */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        <Panel title="Evoluția portofoliului" action={<Segmented size="sm" value={range} onChange={setRange} options={periodOptions} />}>
          {history.error ? (
            <LoadError message={history.error} onRetry={history.reload} />
          ) : history.data && history.data.length > 1 ? (
            <>
              <PortfolioChart data={history.data} currency={base} />
            </>
          ) : history.loading ? (
            <Skeleton className="min-h-72 flex-1" />
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
                  className={cx('min-h-8 border-b-2 pb-1 whitespace-nowrap transition max-md:min-h-11', tab === k ? 'border-brand text-lg font-bold text-ink' : 'border-transparent text-md font-semibold text-ink-3 hover:text-ink')}
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
            <ul className="-mx-2 divide-y divide-line/70" role="tabpanel">
              {rows.map((p) => (
                <PositionRow key={p.key} p={p} currency={base} onOpen={() => onNavigate('positions')} />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Rândul 3: alocare, performanță, proiecție */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-[1.15fr_1.1fr_1.15fr]">
        <Panel title="Alocare portofoliu">
          <AllocationBlock parts={parts} total={t.totalValue} currency={base} />
        </Panel>

        <Panel
          title={
            <>
              Performanță
              <InfoTip label="Ce arată performanța" text="TWR: cât a crescut portofoliul, fără influența depunerilor. XIRR: randamentul anual al banilor tăi, ținând cont de când i-ai depus. Ambele pentru perioada aleasă la grafic." />
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <ReturnBox label="TWR" value={rangePerf.data?.twr ?? null} tip="Randamentul ponderat în timp: cât a crescut portofoliul, fără influența banilor depuși sau retrași." />
            {xirrAnnual !== null ? (
              <ReturnBox label="XIRR" value={xirrAnnual} tip="Randamentul pe an ținând cont de momentul și mărimea fiecărei depuneri. Arată cât ai câștigat tu, cu banii tăi." />
            ) : (
              <ReturnBox
                label="Banii tăi"
                value={rangePerf.data?.moneyWeighted ?? null}
                tip="Cât au câștigat banii tăi în perioada aleasă, ținând cont de când i-ai depus. Pe perioade sub un an nu se anualizează (XIRR ar exagera câteva procente în zeci)."
              />
            )}
          </div>
          <p className="mt-6 mb-4 text-lg font-bold text-ink">
            vs {rangeBench} <span className="font-semibold">({RANGE_LABEL[range]})</span>
          </p>
          {rangePerf.error ? <LoadError message={rangePerf.error} onRetry={rangePerf.reload} /> : rangePerf.data ? <VsBenchmark perf={rangePerf.data} /> : <Skeleton className="h-16" />}
        </Panel>

        <Panel
          title={
            <>
              Proiecție creștere portofoliu
              <InfoTip label="Cum se calculează proiecția" text="Estimare pornind de la valoarea de azi, randamentul tău anual și media depunerilor lunare. Nu este o garanție." />
            </>
          }
          className="md:max-xl:col-span-2"
        >
          {proj ? (
            <>
              <ProjectionChart points={points} currency={proj.currency} />
              <div className="mt-5 grid grid-cols-3 divide-x divide-line text-center">
                {PROJECTION_YEARS.map((y) => (
                  <div key={y} className="min-w-0 px-2">
                    <p className="text-md text-ink-2">{y} ani</p>
                    <p className="tabular mt-0.5 truncate text-lg font-bold text-ink">{money(points[y]?.value ?? 0, proj.currency, 0)}</p>
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
                <Pnl value={pp.gain}>
                  <AnimatedNumber value={pp.gain} format={(v) => signedMoney(v, base)} />
                </Pnl>
              }
              detail={
                Math.abs(pp.cashFx) >= 0.005 ? (
                  <span className="tabular">Realizat + variația celui nerealizat + curs pe cash ({signedMoney(pp.cashFx, base)})</span>
                ) : (
                  'Realizat în perioadă + variația celui nerealizat'
                )
              }
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
