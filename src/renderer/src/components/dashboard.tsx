/**
 * Piesele panoului principal: cardul cu cifră (KPI), graficul de evoluție, Top poziții, alocarea,
 * performanța față de indice, proiecția de creștere și scheletul de încărcare în forma lor.
 */
import { useId, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, Pie, PieChart, Cell, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronRight, Info } from 'lucide-react';
import type { HistoryPoint, PerformanceData, PositionView } from '@shared/types';
import { compactNumber, date as fmtDate, money, percent, signedMoney, signedPercent } from '../lib/format';
import { Pnl, Skeleton, cx } from './ui';
import { TickerLogo } from './TickerLogo';

/** Cardul panoului: același aspect ca `Card`, dar cu corpul care umple înălțimea (rânduri egale în grilă). */
export function Panel({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('dash-card flex min-w-0 flex-col', className)}>
      {(title || action) && (
        <header className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-6 pt-5">
          <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-6 pt-3">{children}</div>
    </section>
  );
}

/** Iconița „i” cu o explicație la hover, la focus sau la apăsare (pe telefon). */
export function InfoTip({ text, label, className }: { text: string; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={cx('relative inline-flex', className)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
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
        <span id={id} role="tooltip" className="animate-in absolute top-full left-1/2 z-30 mt-1 w-60 -translate-x-1/2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-xs leading-snug font-normal text-ink shadow-pop max-md:left-auto max-md:-translate-x-3/4">
          {text}
        </span>
      )}
    </span>
  );
}

/** Cardul mic cu cifră principală: iconiță violet sus, eticheta, valoarea mare. Detaliul apare la hover. */
export function KpiCard({ label, icon, value, detail, className }: { label: string; icon: ReactNode; value: ReactNode; detail?: string; className?: string }) {
  return (
    <div title={detail} className={cx('dash-card card-hover relative flex min-w-0 flex-col justify-center px-5 py-5 2xl:px-6', className)}>
      <span className="mb-3 text-accent max-sm:absolute max-sm:top-5 max-sm:right-5 max-sm:mb-0 [&>svg]:size-7 [&>svg]:stroke-[2.2]" aria-hidden>
        {icon}
      </span>
      {/* Textul se potrivește lățimii cardului (container query), ca sumele lungi în RON să încapă. */}
      <div className="@container min-w-0">
        <p className="truncate text-[clamp(0.8125rem,9cqi,0.9375rem)] font-medium text-ink">{label}</p>
        <div className="tabular mt-1 text-[clamp(1rem,11.6cqi,1.625rem)] leading-snug font-bold tracking-tight whitespace-nowrap text-ink max-sm:text-2xl">{value}</div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- evoluție */

/** Eticheta lunii pe axă: „Ian”, „Feb” pe un an; „ian. 2025” pe perioade mai lungi; „12 nov.” pe perioade scurte. */
function axisDate(iso: string, spanDays: number): string {
  const d = new Date(`${iso}T00:00:00`);
  if (spanDays > 400) return d.toLocaleDateString('ro-RO', { month: 'short', year: 'numeric' });
  if (spanDays > 75) {
    const m = d.toLocaleDateString('ro-RO', { month: 'short' }).replace('.', '');
    return m.charAt(0).toUpperCase() + m.slice(1);
  }
  return d.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
}

function ChartTooltip({ active, payload, currency, first }: { active?: boolean; payload?: { payload: HistoryPoint }[]; currency: string; first: number }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const change = first > 0 ? p.value / first - 1 : null;
  return (
    <div className="rounded-xl border border-white/10 bg-surface-2/95 px-3.5 py-2.5 shadow-pop backdrop-blur">
      <p className="text-xs text-ink-2">{fmtDate(p.date)}</p>
      <p className="tabular mt-0.5 text-md font-bold text-ink">{money(p.value, currency)}</p>
      {change !== null && (
        <Pnl value={change} arrow={false} className="text-xs font-semibold">
          {signedPercent(change)}
        </Pnl>
      )}
      {p.invested > 0 && <p className="tabular mt-1 text-2xs text-ink-3">Investit: {money(p.invested, currency, 0)}</p>}
    </div>
  );
}

/** Punctul de la capătul liniei: un cerc plin cu un inel care pulsează. */
function EndDot({ cx: x, cy: y }: { cx?: number; cy?: number }) {
  if (x === undefined || y === undefined) return <g />;
  return (
    <g>
      <circle cx={x} cy={y} r={5} fill="var(--chart-line)" className="pulse-ring" />
      <circle cx={x} cy={y} r={5.5} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} className="glow-line" />
    </g>
  );
}

/** Pas „rotund” pentru axă (1, 2, 2,5 sau 5 × 10^n), ca etichetele să fie 60.000, 70.000… */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** Cel mult ~160 de puncte: linia arată netedă, iar prima și ultima zi rămân exacte. */
function thin(data: HistoryPoint[], max = 160): HistoryPoint[] {
  if (data.length <= max) return data;
  const every = Math.ceil(data.length / max);
  return data.filter((_, i) => i % every === 0 || i === data.length - 1);
}

/** Grafic de arie: linia verde luminoasă, degradeu spre transparent, grilă discretă, eticheta ultimei zile afișată. */
export function PortfolioChart({ data: raw, currency }: { data: HistoryPoint[]; currency: string }) {
  const gradient = useId();
  // Seria de randament începe cu ziua dinaintea primei tranzacții (valoare 0); pe grafic ar da o cădere falsă.
  const firstReal = raw.findIndex((d) => d.value > 0);
  const data = thin(firstReal > 0 ? raw.slice(firstReal) : raw);
  const spanDays = data.length > 1 ? (Date.parse(data[data.length - 1].date) - Date.parse(data[0].date)) / 86_400_000 : 0;
  const last = data[data.length - 1];
  const values = data.map((d) => d.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const step = niceStep((hi - lo || hi || 1) / 4);
  const yMin = Math.max(0, Math.floor(lo / step) * step);
  const yMax = Math.ceil(hi / step) * step + (hi % step === 0 ? step : 0);
  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) ticks.push(v);
  return (
    <div className="chart-reveal min-h-64 flex-1" role="img" aria-label="Graficul evoluției valorii portofoliului">
      <ResponsiveContainer width="100%" height="100%" minHeight={256}>
        <ComposedChart data={data} margin={{ top: 12, right: 14, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-line)" stopOpacity={0.5} />
              <stop offset="55%" stopColor="var(--chart-line)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--chart-line)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--line)" strokeOpacity={0.55} />
          <XAxis dataKey="date" tickFormatter={(d: string) => axisDate(d, spanDays)} tick={{ fill: 'var(--ink-2)', fontSize: 13 }} tickLine={false} axisLine={false} minTickGap={36} tickMargin={12} />
          <YAxis
            tickFormatter={(v: number) => (v >= 1_000_000 ? `${compactNumber(v)} ${currency}` : money(v, currency, 0))}
            tick={{ fill: 'var(--ink-2)', fontSize: 13 }}
            tickLine={false}
            axisLine={false}
            width={96}
            ticks={ticks}
            domain={[yMin, yMax]}
          />
          <Tooltip
            content={<ChartTooltip currency={currency} first={data[0]?.value ?? 0} />}
            cursor={{ stroke: 'var(--ink-3)', strokeDasharray: '4 4' }}
            defaultIndex={data.length - 1}
            isAnimationActive={false}
          />
          <Area type="monotone" dataKey="value" stroke="none" fill={`url(#${gradient})`} fillOpacity={1} isAnimationActive={false} activeDot={false} />
          <Line
            type="monotone"
            dataKey="value"
            name="Valoare"
            stroke="var(--chart-line)"
            strokeWidth={2.75}
            dot={false}
            className="glow-line"
            activeDot={{ r: 5, fill: 'var(--chart-line)', stroke: 'var(--surface)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
          {last && <ReferenceDot x={last.date} y={last.value} shape={<EndDot />} ifOverflow="visible" />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------- Top poziții */

export function PositionRow({ p, currency, onOpen }: { p: PositionView; currency: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="group flex min-h-15 w-full items-center gap-3.5 rounded-xl px-2 py-2 text-left transition hover:bg-surface-2/70 max-md:min-h-16">
        <TickerLogo symbol={p.symbol} type={p.assetType} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block text-md font-bold tracking-tight text-ink">{p.symbol}</span>
          <span className="block truncate text-body text-ink-2">{p.name || p.symbol}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="tabular block text-md font-bold text-ink">{money(p.marketValueBase, currency)}</span>
          <Pnl value={p.unrealizedBasePct} arrow={false} className="text-body font-semibold">
            {signedPercent(p.unrealizedBasePct)}
          </Pnl>
        </span>
        <ChevronRight className="size-5 shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
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
    <div className="flex flex-1 flex-wrap items-center justify-center gap-x-8 gap-y-5">
      <div className="chart-reveal relative size-48 shrink-0" role="img" aria-label={`Alocare: ${parts.map((p) => `${p.label} ${percent(p.value / sum, 1)}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={parts} dataKey="value" nameKey="label" innerRadius="68%" outerRadius="100%" startAngle={90} endAngle={-270} stroke="none" paddingAngle={0} isAnimationActive={false}>
              {parts.map((p) => (
                <Cell key={p.key} fill={p.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
          <span className="tabular text-lg leading-tight font-bold whitespace-nowrap text-ink">{money(total, currency, total >= 10_000 ? 0 : 2)}</span>
          <span className="mt-0.5 text-body text-ink-2">Total</span>
        </div>
      </div>
      <ul className="min-w-44 flex-1 space-y-3.5">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-3 text-md">
            <span className="size-3.5 shrink-0 rounded-full" style={{ background: p.color, boxShadow: `0 0 10px ${p.color}` }} aria-hidden />
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
    <div className="min-w-0 rounded-2xl border border-line bg-surface-2/60 px-4 py-3.5">
      <p className="flex items-center gap-0.5 text-md text-ink-2">
        {label}
        <InfoTip text={tip} label={`Ce înseamnă ${label}`} />
      </p>
      {value === null ? (
        <p className="text-kpi font-bold text-ink-3">—</p>
      ) : (
        <Pnl value={value} arrow={false} className="text-kpi font-bold tracking-tight">
          {signedPercent(value)}
        </Pnl>
      )}
    </div>
  );
}

function Bar({ label, value, fill, tone }: { label: string; value: number | null; /** Cât din bară se umple (0–1), pe aceeași scară pentru ambele bare. */ fill: number; tone: 'portfolio' | 'index' }) {
  const negative = value !== null && value < 0;
  return (
    <div className="grid grid-cols-[6.5rem_1fr_4.75rem] items-center gap-3 text-md max-sm:grid-cols-[5.5rem_1fr_4.5rem]">
      <span className="truncate text-ink">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
        <span
          className={cx('block h-full rounded-full transition-[width] duration-700', tone === 'index' ? 'bg-ink-2/80' : negative ? 'bg-loss' : 'bg-gain')}
          style={{
            width: `${value === null ? 0 : Math.max(2, Math.min(100, fill * 100))}%`,
            boxShadow: tone === 'portfolio' ? `0 0 12px var(--${negative ? 'loss' : 'gain'})` : undefined
          }}
        />
      </span>
      {tone === 'portfolio' ? (
        <Pnl value={value} arrow={false} className="justify-end font-semibold">
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
  const scaled = (v: number): number => (Math.abs(v) / top) * 0.9;
  return (
    <div className="space-y-4">
      <Bar label="Portofoliu" value={b.portfolioReturn} fill={scaled(b.portfolioReturn)} tone="portfolio" />
      <Bar label={name} value={b.return} fill={scaled(b.return)} tone="index" />
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
    <div className="chart-reveal h-36 w-full" role="img" aria-label="Proiecția valorii portofoliului pe 20 de ani">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 10, right: 2, bottom: 0, left: 2 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.6} />
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
          <Area type="monotone" dataKey="value" stroke="var(--series-1)" strokeWidth={3} className="glow-violet" fill={`url(#${gradient})`} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Rândul „+1.245,80 RON (+11,12 %)” de sub valoarea principală. */
export function GainLine({ value, pct, currency }: { value: number; pct: number | null; currency: string }) {
  return (
    <span className="inline-flex items-center gap-x-1.5 whitespace-nowrap">
      <Pnl value={value} arrow={false}>
        {signedMoney(value, currency)}
      </Pnl>
      {pct !== null && (
        <Pnl value={pct} arrow={false}>
          ({signedPercent(pct)})
        </Pnl>
      )}
    </span>
  );
}

/* ----------------------------------------------------------------- schelet */

/** Locul panoului până vin datele: aceleași rânduri și carduri ca în pagina reală. */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Se încarcă">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 min-[1400px]:grid-cols-[1.75fr_1fr_1fr_1fr_1fr]">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className={cx('h-36 rounded-[1.125rem]', i === 0 && 'sm:col-span-2 lg:col-span-4 min-[1400px]:col-span-1')} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        <Skeleton className="h-104 rounded-[1.125rem]" />
        <Skeleton className="h-104 rounded-[1.125rem]" />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-[1.15fr_1.1fr_1.15fr]">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-80 rounded-[1.125rem]" />
        ))}
      </div>
    </div>
  );
}
