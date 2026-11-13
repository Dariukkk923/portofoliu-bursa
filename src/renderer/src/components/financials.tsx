/**
 * Raportările financiare: calendarul raportărilor și detaliul unei companii (ultimele rezultate,
 * EPS real față de estimat, situațiile financiare pe trimestre și pe ani, linkuri către sursele oficiale).
 * Pe telefon totul este în carduri, fără tabele late.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { CalendarClock, ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { STATEMENT_FIELDS, type AssetType, type CompanyFinancials, type EarningsCalendarEntry, type FinancialStatementKind, type NewsFilter, type StatementPeriod } from '@shared/types';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, dateTime, signedPercent } from '../lib/format';
import { VERDICT_LABEL, VERDICT_TONE, bigMoney, inDays, perShare, periodLabel, yoy } from '../lib/research';
import { EpsChart, StatementChart } from './charts';
import { TickerLogo } from './TickerLogo';
import { Badge, Button, Card, EmptyState, ListSkeleton, LoadError, Notice, Pnl, Segmented } from './ui';

const SOURCE_LABEL = { yahoo: 'Yahoo Finance', polygon: 'Polygon', alphavantage: 'Alpha Vantage' } as const;
const KIND_LABEL: Record<FinancialStatementKind, string> = { income: 'Rezultate', balance: 'Bilanț', cashflow: 'Flux de numerar' };
/** Indicatorii desenați în grafic pentru fiecare tabel. */
const CHART_KEYS: Record<FinancialStatementKind, string[]> = {
  income: ['revenue', 'netIncome'],
  balance: ['totalAssets', 'totalLiabilities', 'equity'],
  cashflow: ['operating', 'investing', 'financing']
};

/* --------------------------------------------------------------- calendar */

/** Când raportează fiecare companie din filtru; atingerea unui rând deschide detaliul companiei. */
export function EarningsCalendarView({ filter, onOpen, empty }: { filter: NewsFilter; onOpen: (e: EarningsCalendarEntry) => void; empty?: ReactNode }) {
  const forceNext = useRef(false);
  const cal = useLoad(() => {
    const force = forceNext.current;
    forceNext.current = false;
    return api.financials.calendar({ ...filter, force });
  }, [filter.symbol, filter.portfolioOnly]);
  const refresh = (): void => {
    forceNext.current = true;
    cal.reload();
  };

  const data = cal.data;
  if (!data) return cal.error ? <LoadError message={cal.error} onRetry={refresh} /> : <ListSkeleton rows={4} />;
  if (data.error) return <LoadError message={data.error} onRetry={refresh} />;
  if (data.entries.length === 0) {
    return <>{empty ?? <EmptyState icon={<CalendarClock className="size-5" />} title="Nicio companie de urmărit" text="Calendarul arată când raportează acțiunile din portofoliu și din watchlist. ETF-urile, obligațiunile și crypto nu raportează rezultate." />}</>;
  }

  return (
    <Card
      padded={false}
      title="Calendarul raportărilor"
      action={
        <Button size="sm" variant="ghost" onClick={refresh} loading={cal.loading} icon={<RefreshCw className="size-4" />}>
          Reîmprospătează
        </Button>
      }
    >
      {data.offline && (
        <div className="px-4 pb-2">
          <Notice tone="warn">Fără conexiune la internet. Se afișează datele salvate{data.fetchedAt ? ` (${dateTime(data.fetchedAt)})` : ''}.</Notice>
        </div>
      )}
      <ul className="divide-y divide-line">
        {data.entries.map((e) => (
          <li key={e.symbol}>
            <button type="button" onClick={() => onOpen(e)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-accent">
              <TickerLogo symbol={e.symbol} type={e.type} size={36} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-body font-semibold text-ink">
                  {e.symbol}
                  {e.held && <Badge tone="accent">În portofoliu</Badge>}
                </p>
                <p className="truncate text-xs text-ink-3">{e.name || 'Companie'}</p>
                {e.lastReportedDate && <p className="text-xs text-ink-3">Ultima raportare: {fmtDate(e.lastReportedDate)}</p>}
              </div>
              <div className="shrink-0 text-right">
                {e.date ? (
                  <>
                    <p className="tabular text-body font-semibold text-ink">{fmtDate(e.date)}</p>
                    <p className="mt-0.5 flex items-center justify-end gap-1.5 text-xs">
                      <Badge tone={e.daysUntil !== null && e.daysUntil <= 7 ? 'warn' : 'neutral'}>{inDays(e.daysUntil)}</Badge>
                      {e.estimated && <span className="text-ink-3">estimată</span>}
                    </p>
                    {e.epsEstimate !== null && <p className="tabular mt-0.5 text-xs text-ink-3">EPS estimat {perShare(e.epsEstimate)}</p>}
                  </>
                ) : (
                  <p className="text-xs text-ink-3">dată neanunțată</p>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------ detaliul companiei */

function Stat({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <p className="tabular mt-1 text-sm font-semibold text-ink">{value}</p>
      <div className="mt-1 text-xs text-ink-3">{children}</div>
    </div>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span>{yoy(null)}</span>;
  return (
    <Pnl value={value} arrow className="font-medium">
      {signedPercent(value)} <span className="font-normal text-ink-3">față de anul trecut</span>
    </Pnl>
  );
}

function PeriodCard({ period, kind, annual, currency }: { period: StatementPeriod; kind: FinancialStatementKind; annual: boolean; currency: string | null }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <p className="text-body font-semibold text-ink first-letter:uppercase">{periodLabel(period.end, annual)}</p>
      <dl className="mt-1.5 space-y-1">
        {STATEMENT_FIELDS[kind].map((f) => (
          <div key={f.key} className="flex items-baseline justify-between gap-3 text-body">
            <dt className="text-ink-2">{f.label}</dt>
            <dd className="tabular font-medium text-ink">{f.key === 'eps' ? perShare(period.values[f.key]) : bigMoney(period.values[f.key], currency)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Statements({ d }: { d: CompanyFinancials }) {
  const [annual, setAnnual] = useState(d.statements.quarterly.income.length === 0 && d.statements.annual.income.length > 0);
  const [kind, setKind] = useState<FinancialStatementKind>('income');
  const set = annual ? d.statements.annual : d.statements.quarterly;
  const periods = set[kind].slice(-8);
  const series = CHART_KEYS[kind].map((key) => ({ key, label: STATEMENT_FIELDS[kind].find((f) => f.key === key)?.label ?? key }));
  const chart = useMemo(() => periods.map((p) => ({ label: periodLabel(p.end, annual), ...p.values })), [periods, annual]);
  const currency = d.currency ?? '';

  return (
    <Card title="Situații financiare">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={annual ? 'annual' : 'quarterly'} onChange={(v) => setAnnual(v === 'annual')} options={[{ value: 'quarterly', label: 'Pe trimestre' }, { value: 'annual', label: 'Pe ani' }]} />
        <Segmented size="sm" value={kind} onChange={setKind} options={(Object.keys(KIND_LABEL) as FinancialStatementKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      </div>
      {periods.length === 0 ? (
        <p className="py-8 text-center text-body text-ink-3">Nu există date {annual ? 'anuale' : 'trimestriale'} pentru acest tabel.</p>
      ) : (
        <div className="mt-4 space-y-4">
          <StatementChart data={chart} series={series} currency={currency} />
          {/* Cele mai noi perioade întâi; pe telefon câte un card pe rând. */}
          <div className="grid gap-3 sm:grid-cols-2">
            {[...periods].reverse().map((p) => (
              <PeriodCard key={p.end} period={p} kind={kind} annual={annual} currency={d.currency} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function Links({ d }: { d: CompanyFinancials }) {
  const { notify } = useApp();
  const items = [
    { url: d.links.investors, label: 'Pagina de investitori' },
    { url: d.links.website, label: 'Site-ul companiei' },
    { url: d.links.bvb, label: 'Pagina la Bursa de Valori București' },
    { url: d.links.sec, label: 'Rapoarte oficiale la SEC' }
  ].filter((l): l is { url: string; label: string } => !!l.url);
  if (items.length === 0) return null;
  return (
    <Card title="Rapoarte oficiale">
      <div className="flex flex-wrap gap-2">
        {items.map((l) => (
          <Button key={l.label} icon={<ExternalLink className="size-4" />} onClick={() => api.news.open(l.url).catch((err) => notify('error', errorMessage(err)))}>
            {l.label}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-3">Linkurile se deschid în browserul sistemului. Rapoartele complete (PDF) sunt la sursa oficială.</p>
    </Card>
  );
}

/** Raportările unei companii. ETF-urile, obligațiunile și crypto nu au: se arată o stare goală, nu o eroare. */
export function FinancialsView({ symbol, type, onShowNews }: { symbol: string; type: AssetType; onShowNews?: () => void }) {
  const forceNext = useRef(false);
  const fin = useLoad(() => {
    const force = forceNext.current;
    forceNext.current = false;
    return api.financials.get(symbol, type, force);
  }, [symbol, type]);
  const refresh = (): void => {
    forceNext.current = true;
    fin.reload();
  };

  const d = fin.data;
  if (!d) return fin.error ? <LoadError message={fin.error} onRetry={refresh} /> : <ListSkeleton rows={5} />;
  if (d.error) return <LoadError message={d.error} onRetry={refresh} />;
  if (!d.supported) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={<FileText className="size-5" />}
          title="Fără raportări financiare"
          text={d.reason ?? 'Nu există raportări pentru acest simbol.'}
          action={onShowNews ? <Button onClick={onShowNews}>Vezi știrile</Button> : undefined}
        />
        <Links d={d} />
      </div>
    );
  }

  const latest = d.latest;
  return (
    <div className="space-y-4">
      {d.stale && (
        <Notice tone="warn">
          {d.offline ? 'Fără conexiune la internet.' : 'Nu am putut actualiza raportările.'} Se afișează datele salvate{d.fetchedAt ? ` (${dateTime(d.fetchedAt)})` : ''}.
        </Notice>
      )}

      <Card
        title="Următoarea raportare"
        action={
          <Button size="sm" variant="ghost" onClick={refresh} loading={fin.loading} icon={<RefreshCw className="size-4" />}>
            Reîmprospătează
          </Button>
        }
      >
        {d.next?.date ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="tabular text-sm font-semibold text-ink">{fmtDate(d.next.date)}</p>
            <Badge tone="accent">{inDays(Math.round((Date.parse(d.next.date) - Date.parse(todayIso())) / 86_400_000))}</Badge>
            <Badge>{d.next.estimated ? 'dată estimată' : 'dată confirmată'}</Badge>
            {d.next.epsEstimate !== null && <span className="text-body text-ink-2">EPS estimat: {perShare(d.next.epsEstimate)}</span>}
          </div>
        ) : (
          <p className="text-body text-ink-3">Compania nu a anunțat încă data următoarei raportări.</p>
        )}
      </Card>

      {latest ? (
        <Card title={`Ultimele rezultate (${periodLabel(latest.periodEnd, false)})`} action={latest.verdict ? <Badge tone={VERDICT_TONE[latest.verdict]}>{VERDICT_LABEL[latest.verdict]}</Badge> : undefined}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Venituri" value={bigMoney(latest.revenue, d.currency)}>
              <Change value={latest.revenueChangePct} />
            </Stat>
            <Stat label="Profit net" value={bigMoney(latest.netIncome, d.currency)}>
              <Change value={latest.netIncomeChangePct} />
            </Stat>
            <Stat label="EPS real" value={perShare(latest.epsActual)}>
              <p>{latest.epsEstimate !== null ? `estimat ${perShare(latest.epsEstimate)}` : 'fără estimare'}</p>
              <Change value={latest.epsChangePct} />
            </Stat>
          </div>
          {latest.reportedDate && <p className="mt-2 text-xs text-ink-3">Publicate la {fmtDate(latest.reportedDate)}.</p>}
        </Card>
      ) : (
        <Card title="Ultimele rezultate">
          <p className="text-body text-ink-3">Nu am găsit rezultate publicate pentru această companie.</p>
        </Card>
      )}

      {d.eps.some((q) => q.epsActual !== null) && (
        <Card title="EPS real față de estimat">
          <EpsChart data={d.eps.map((q) => ({ label: periodLabel(q.periodEnd, false), actual: q.epsActual, estimate: q.epsEstimate }))} />
        </Card>
      )}

      <Statements d={d} />
      <Links d={d} />
      {d.sources.length > 0 && <p className="text-xs text-ink-3">Surse: {d.sources.map((s) => SOURCE_LABEL[s]).join(', ')}. Datele se reîmprospătează la cel mult 12 ore.</p>}
    </div>
  );
}
