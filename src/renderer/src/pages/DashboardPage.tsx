/** Dashboard-ul: valoarea totală, profitul, evoluția, clasamentele și alocările. */
import { useState, type ReactNode } from 'react';
import { ChartNoAxesCombined, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import { ASSET_TYPES, type HistoryRange, type PositionView } from '@shared/types';
import { ASSET_TYPE_LABEL, RANGE_LABEL } from '@shared/labels';
import { api } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { money, signedMoney, signedPercent } from '../lib/format';
import { AllocationDonut, EvolutionChart } from '../components/charts';
import { CashCards } from '../components/CashCards';
import { BenchmarkCard } from '../components/BenchmarkCard';
import { GoalsSummary } from './GoalsPage';
import { AnimatedNumber, Button, Card, EmptyState, LoadError, Notice, PageSkeleton, Pnl, Segmented, Skeleton } from '../components/ui';
import type { PageId } from '../components/Layout';
import { TickerLogo } from '../components/TickerLogo';

const RANGES: HistoryRange[] = ['1M', '3M', '6M', '1Y', 'ALL'];

/** Card cu o cifră principală și un rând de detalii. */
function Kpi({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <div className="tabular mt-1 text-stat font-semibold text-ink">{value}</div>
      {detail && <div className="mt-1 text-xs text-ink-2">{detail}</div>}
    </div>
  );
}

/** Listă de poziții cu randamentul lor (folosită pentru câștigători și pierderi). */
function MoversList({ items, base, empty }: { items: PositionView[]; base: string; empty: string }) {
  if (items.length === 0) return <p className="py-6 text-center text-body text-ink-3">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((p) => (
        <li key={p.key} className="flex items-center gap-3 py-2">
          <TickerLogo symbol={p.symbol} type={p.assetType} size={28} />
          <div className="min-w-0 flex-1">
            <p className="text-body font-semibold text-ink">{p.symbol}</p>
            <p className="truncate text-xs text-ink-3">{p.name || ASSET_TYPE_LABEL[p.assetType]}</p>
          </div>
          <Pnl value={p.unrealizedBase} className="text-xs">
            {signedMoney(p.unrealizedBase, base)}
          </Pnl>
          <Pnl value={p.unrealizedBasePct} arrow className="w-22 justify-end text-body font-semibold">
            {signedPercent(p.unrealizedBasePct)}
          </Pnl>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { filter, dataVersion, brokers, bumpData } = useApp();
  const [range, setRange] = useState<HistoryRange>('1Y');
  const overview = useLoad(() => api.portfolio.overview(filter), [filter, dataVersion]);
  const history = useLoad(() => api.portfolio.history(range, filter), [range, filter, dataVersion]);
  const performance = useLoad(() => api.portfolio.performance('ALL', filter), [filter, dataVersion]);
  // Lista completă a activelor dă o ordine stabilă culorilor din graficul de alocare.
  const assets = useLoad(() => api.assets.list(), [dataVersion]);

  const o = overview.data;
  if (!o) {
    return overview.error ? <LoadError message={overview.error} onRetry={overview.reload} /> : <PageSkeleton />;
  }

  const t = o.totals;
  const base = t.baseCurrency;
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

  return (
    <>
      {o.missingPrices.length > 0 && (
        <Notice tone="warn">
          Fără preț de piață pentru <strong>{o.missingPrices.join(', ')}</strong> — pozițiile sunt evaluate la cost. Poți introduce un preț manual din pagina Portofoliu.
        </Notice>
      )}
      {o.approximateFx && <Notice tone="warn">Cursurile valutare nu au putut fi descărcate încă; conversia în {base} folosește cursuri aproximative până la prima actualizare.</Notice>}

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
                </Pnl>
                {' '}
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => onNavigate('positions')}>
                  Vezi pozițiile
                </button>
              </>
            )
          }
        />
      </div>

      <CashCards
        totals={t}
        balances={o.cashBalances}
        untracked={o.untrackedCashBrokers}
        performance={performance.data}
        assets={assets.data ?? []}
        onChanged={bumpData}
      />

      <BenchmarkCard filter={filter} dataVersion={dataVersion} />

      <GoalsSummary onOpen={() => onNavigate('goals')} />

      <Card
        title="Evoluția valorii portofoliului"
        action={<Segmented size="sm" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} />}
      >
        {history.data && history.data.length > 1 ? (
          <EvolutionChart data={history.data} currency={base} />
        ) : history.loading ? (
          <Skeleton className="h-72" />
        ) : (
          <p className="flex h-72 items-center justify-center text-body text-ink-3">Nu există suficiente date pentru grafic în intervalul ales.</p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-1.5"><TrendingUp className="size-4 text-gain" aria-hidden /> Top 5 câștigători</span>}>
          <MoversList items={o.topGainers} base={base} empty="Nicio poziție pe profit." />
        </Card>
        <Card title={<span className="flex items-center gap-1.5"><TrendingDown className="size-4 text-loss" aria-hidden /> Top 5 pierderi</span>}>
          <MoversList items={o.topLosers} base={base} empty="Nicio poziție pe pierdere." />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
