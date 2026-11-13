/**
 * Piesele panoului principal: cardul cu cifră (KPI), graficul de evoluție, Top poziții, alocarea,
 * performanța față de indice, proiecția de creștere și scheletul de încărcare în forma lor.
 */
import { useId, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, Pie, PieChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronRight, Info } from 'lucide-react';
import type { HistoryPoint, PerformanceData, PositionView } from '@shared/types';
import { compactNumber, date as fmtDate, money, percent, shortDate, signedPercent } from '../lib/format';
import { Pnl, Skeleton, cx } from './ui';
import { TickerLogo } from './TickerLogo';

/** Cardul panoului: același aspect ca `Card`, dar cu corpul care umple înălțimea (rânduri egale în grilă). */
export function Panel({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('flex min-w-0 flex-col rounded-xl border border-line bg-surface shadow-card', className)}>
      {(title || action) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 pt-4">
          <h2 className="flex items-center gap-2 text-md font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-5 pt-2">{children}</div>
    </section>
  );
}

/** Iconița „i” cu o explicație la hover, la focus sau la apăsare (pe telefon). */
export function InfoTip({ text, label, className }: { text: string; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={cx("relative inline-flex", className)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="inline-flex size-6 items-center justify-center rounded-full text-ink-3 transition hover:text-ink max-md:size-11"
      >
        <Info className="size-4" aria-hidden />
      </button>
      {open && (
        <span id={id} role="tooltip" className="animate-in absolute top-full left-1/2 z-30 mt-1 w-56 -translate-x-1/2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-xs leading-snug font-normal text-ink shadow-pop max-md:left-auto max-md:-translate-x-3/4">
          {text}
        </span>
      )}
    </span>
  );
}

/** Cardul mic cu cifră principală: iconiță violet, etichetă discretă, valoare mare. */
export function KpiCard({ label, icon, value, detail, className }: { label: string; icon: ReactNode; value: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <div className={cx('card-hover relative flex min-w-0 flex-col justify-center rounded-xl border border-line bg-surface px-5 py-4 shadow-card', className)}>
      <span className="mb-2 text-accent max-sm:absolute max-sm:top-4 max-sm:right-4 max-sm:mb-0 [&>svg]:size-6" aria-hidden>
        {icon}
      </span>
      <p className="text-body font-medium text-ink-2">{label}</p>
      <div className="tabular mt-0.5 text-kpi font-bold tracking-tight text-ink">{value}</div>
      {detail && <div className="mt-0.5 text-xs text-ink-3">{detail}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- evoluție */

function ChartTooltip({ active, payload, currency, first }: { active?: boolean; payload?: { payload: HistoryPoint }[]; currency: string; first: number }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const change = first > 0 ? p.value / first - 1 : null;
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 shadow-pop">
      <p className="text-xs text-ink-2">{fmtDate(p.date)}</p>
      <p className="tabular mt-0.5 text-md font-bold text-ink">{money(p.value, currency)}</p>
      {change !== null && (
        <Pnl value={change} className="text-xs font-semibold">
          {signedPercent(change)}
        </Pnl>
      )}
    </div>
  );
}

/** Grafic de arie: linia verde luminoasă, degradeu spre transparent, grilă discretă, linia investită punctată. */
export function PortfolioChart({ data, currency }: { data: HistoryPoint[]; currency: string }) {
  const gradient = useId();
  const spanDays = data.length > 1 ? (Date.parse(data[data.length - 1].date) - Date.parse(data[0].date)) / 86_400_000 : 0;
  return (
    <div className="chart-reveal min-h-52 flex-1" role="img" aria-label="Graficul evoluției valorii portofoliului">
      <ResponsiveContainer width="100%" height="100%" minHeight={208}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-line)" stopOpacity={0.38} />
              <stop offset="100%" stopColor="var(--chart-line)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--line)" strokeOpacity={0.7} />
          <XAxis dataKey="date" tickFormatter={(d: string) => shortDate(d, spanDays > 300)} tick={{ fill: 'var(--ink-3)', fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={48} tickMargin={10} />
          <YAxis tickFormatter={(v: number) => compactNumber(v)} tick={{ fill: 'var(--ink-3)', fontSize: 12 }} tickLine={false} axisLine={false} width={52} domain={[(min: number) => Math.max(0, Math.floor(min * 0.96)), (max: number) => Math.ceil(max * 1.02)]} />
          <Tooltip content={<ChartTooltip currency={currency} first={data[0]?.value ?? 0} />} cursor={{ stroke: 'var(--ink-3)', strokeDasharray: '4 4' }} isAnimationActive={false} />
          <Area type="monotone" dataKey="value" stroke="none" fill={`url(#${gradient})`} fillOpacity={1} isAnimationActive={false} activeDot={false} />
          <Line type="monotone" dataKey="invested" name="Investit" stroke="var(--ink-3)" strokeOpacity={0.7} strokeWidth={1.25} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} />
          <Line
            type="monotone"
            dataKey="value"
            name="Valoare"
            stroke="var(--chart-line)"
            strokeWidth={2.5}
            dot={false}
            className="glow-line"
            activeDot={{ r: 5, fill: 'var(--chart-line)', stroke: 'var(--surface)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------- Top poziții */

export function PositionRow({ p, currency, onOpen }: { p: PositionView; currency: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="group flex min-h-13 w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-surface-2 max-md:min-h-16">
        <TickerLogo symbol={p.symbol} type={p.assetType} size={38} />
        <span className="min-w-0 flex-1">
          <span className="block text-md font-bold text-ink">{p.symbol}</span>
          <span className="block truncate text-xs text-ink-3">{p.name || p.symbol}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="tabular block text-body font-bold text-ink">{money(p.marketValueBase, currency)}</span>
          <Pnl value={p.unrealizedBasePct} className="text-xs font-semibold">
            {signedPercent(p.unrealizedBasePct)}
          </Pnl>
        </span>
        <ChevronRight className="size-4 shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ alocare */

export interface AllocationPart {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function AllocationBlock({ parts, total, currency }: { parts: AllocationPart[]; total: number; currency: string }) {
  const sum = parts.reduce((s, p) => s + p.value, 0);
  if (sum <= 0) return <p className="py-10 text-center text-body text-ink-3">Nu există active de afișat.</p>;
  return (
    <div className="flex flex-1 flex-wrap items-center justify-center gap-x-8 gap-y-4">
      <div className="chart-reveal relative size-40 shrink-0" role="img" aria-label={`Alocare: ${parts.map((p) => `${p.label} ${percent(p.value / sum, 1)}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={parts} dataKey="value" nameKey="label" innerRadius="66%" outerRadius="100%" startAngle={90} endAngle={-270} stroke="var(--surface)" strokeWidth={3} paddingAngle={1} cornerRadius={4} isAnimationActive={false}>
              {parts.map((p) => (
                <Cell key={p.key} fill={p.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <span className="tabular text-md font-bold text-ink">{money(total, currency, 0)}</span>
          <span className="text-xs text-ink-3">Total</span>
        </div>
      </div>
      <ul className="min-w-40 flex-1 space-y-2.5">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2.5 text-body">
            <span className="size-3 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink">{p.label}</span>
            <span className="tabular shrink-0 font-semibold text-ink">{percent(p.value / sum, 1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------- performanță */

/** Cutia cu un randament (TWR sau XIRR) și explicația lui. */
export function ReturnBox({ label, value, tip }: { label: string; value: number | null; tip: string }) {
  return (
    <div className="card-hover min-w-0 rounded-xl border border-line bg-surface-2 px-4 py-3">
      <p className="flex items-center gap-0.5 text-body text-ink-2">
        {label}
        <InfoTip text={tip} label={`Ce înseamnă ${label}`} />
      </p>
      {value === null ? (
        <p className="text-kpi font-bold text-ink-3">—</p>
      ) : (
        <Pnl value={value} className="text-kpi font-bold tracking-tight">
          {signedPercent(value)}
        </Pnl>
      )}
    </div>
  );
}

function Bar({ label, value, tone }: { label: string; value: number | null; tone: 'portfolio' | 'index' }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-3 text-body max-sm:grid-cols-[5rem_1fr_4.5rem]">
      <span className="truncate text-ink">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
        <span
          className={cx('block h-full rounded-full transition-[width] duration-700', tone === 'index' ? 'bg-ink-3' : value !== null && value < 0 ? 'bg-loss' : 'bg-gain')}
          style={{ width: `${value === null ? 0 : Math.max(2, Math.min(100, Math.abs(value) * 100))}%` }}
        />
      </span>
      {tone === 'portfolio' ? (
        <Pnl value={value} className="justify-end font-semibold">
          {signedPercent(value)}
        </Pnl>
      ) : (
        <span className="tabular text-right font-semibold text-ink-2">{value === null ? '—' : signedPercent(value)}</span>
      )}
    </div>
  );
}

/** Barele portofoliu vs. indice: aceeași scară pentru amândouă, ca lungimile să se poată compara. */
export function VsBenchmark({ perf }: { perf: PerformanceData | null }) {
  const b = perf?.benchmark ?? null;
  const name = b?.name.replace(/ \(prin ETF-ul .*\)$/, '') ?? 'S&P 500';
  if (!b || b.return === null || b.portfolioReturn === null) {
    return <p className="text-body text-ink-3">Istoricul indicelui se descarcă la următoarea actualizare a prețurilor.</p>;
  }
  // Scara: cea mai mare valoare ocupă ~90% din bară.
  const top = Math.max(Math.abs(b.portfolioReturn), Math.abs(b.return), 0.0001);
  const scaled = (v: number): number => (v / top) * 0.9;
  return (
    <div className="space-y-3">
      <Bar label="Portofoliu" value={scaled(b.portfolioReturn)} tone="portfolio" />
      <Bar label={name} value={scaled(b.return)} tone="index" />
      <span className="sr-only">
        Portofoliu {signedPercent(b.portfolioReturn)}, {name} {signedPercent(b.return)}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- proiecție */

export interface ProjectionPoint {
  year: number;
  value: number;
}

export function ProjectionChart({ points, currency }: { points: ProjectionPoint[]; currency: string }) {
  const gradient = useId();
  return (
    <div className="chart-reveal h-28 w-full" role="img" aria-label="Proiecția valorii portofoliului pe 20 de ani">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.55} />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis dataKey="year" hide />
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Tooltip
            isAnimationActive={false}
            cursor={{ stroke: 'var(--ink-3)', strokeDasharray: '4 4' }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as ProjectionPoint | undefined;
              if (!active || !p) return null;
              return (
                <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs shadow-pop">
                  <p className="text-ink-2">{p.year === 0 ? 'Azi' : `Peste ${p.year} ani`}</p>
                  <p className="tabular font-bold text-ink">{money(p.value, currency, 0)}</p>
                </div>
              );
            }}
          />
          <Area type="monotone" dataKey="value" stroke="var(--series-1)" strokeWidth={2.5} fill={`url(#${gradient})`} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ----------------------------------------------------------------- schelet */

/** Locul panoului până vin datele: aceleași rânduri și carduri ca în pagina reală. */
export function DashboardSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Se încarcă">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr_1fr]">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className={cx('h-32 rounded-xl', i === 0 && 'sm:col-span-2 lg:col-span-1')} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-72 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
