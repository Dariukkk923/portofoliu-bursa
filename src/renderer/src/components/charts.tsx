/**
 * Graficele dashboard-ului (Recharts): evoluția valorii portofoliului, randamentul
 * comparat cu indicele de referință și alocările de tip donut.
 *
 * Culorile vin din variabilele CSS ale temei (--series-1 … --series-8), o
 * paletă categorială în ordine fixă, verificată pentru daltonism în ambele teme.
 * Fiecare felie are și etichetă cu valoare în legendă, deci identitatea nu
 * depinde doar de culoare.
 */
import { useId } from 'react';
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AllocationSlice, HistoryPoint } from '@shared/types';
import { compactNumber, date as fmtDate, money, percent, shortDate, signedMoney, signedPercent } from '../lib/format';
import { cx } from './ui';

/** Gradient discret sub linia principală: culoarea seriei sus, transparent jos. */
const fade = (id: string) => (
  <defs>
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
      <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
    </linearGradient>
  </defs>
);

const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
const OTHER_COLOR = 'var(--series-other)';
const OTHER_KEY = '__other__';

/**
 * Ordonează feliile și le asociază culori.
 *
 * Culoarea urmează entitatea, nu rangul: `order` este lista stabilă a tuturor
 * entităților (toate tipurile, toți brokerii, toate activele), iar fiecare
 * primește culoarea poziției sale din listă. Astfel un filtru sau o schimbare de
 * preț nu recolorează feliile rămase. Feliile se desenează în aceeași ordine, deci
 * culorile vecine pe inel sunt vecine și în paleta validată. „Altele” este gri.
 */
function arrange(slices: AllocationSlice[], order: string[]): { slices: AllocationSlice[]; colors: Map<string, string> } {
  const rank = (key: string): number => {
    const i = order.indexOf(key);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...slices].sort((a, b) => Number(a.key === OTHER_KEY) - Number(b.key === OTHER_KEY) || rank(a.key) - rank(b.key));
  const colors = new Map<string, string>();
  sorted.forEach((s, i) => {
    if (s.key === OTHER_KEY) return void colors.set(s.key, OTHER_COLOR);
    // Cu cel mult 8 entități, culoarea este fixă pe entitate; peste 8, pe poziția dintre feliile afișate.
    const slot = order.length <= SERIES.length && rank(s.key) < SERIES.length ? rank(s.key) : i;
    colors.set(s.key, SERIES[slot % SERIES.length]);
  });
  return { slices: sorted, colors };
}

const TOOLTIP_BOX = 'rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg';

/* ------------------------------------------------------------ evoluție */

interface EvolutionTooltipProps {
  active?: boolean;
  payload?: { payload: HistoryPoint }[];
  currency: string;
}

function EvolutionTooltip({ active, payload, currency }: EvolutionTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const diff = point.value - point.invested;
  return (
    <div className={TOOLTIP_BOX}>
      <p className="mb-1.5 font-semibold text-ink">{fmtDate(point.date)}</p>
      <dl className="tabular grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="h-0.5 w-3 rounded bg-(--series-1)" /> Valoare
        </dt>
        <dd className="text-right font-medium text-ink">{money(point.value, currency)}</dd>
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="h-0 w-3 border-t-2 border-dashed border-ink-3" /> Investit
        </dt>
        <dd className="text-right font-medium text-ink">{money(point.invested, currency)}</dd>
        <dt className="text-ink-2">Diferență</dt>
        <dd className={cx('text-right font-medium', diff >= 0 ? 'text-gain' : 'text-loss')}>{signedMoney(diff, currency)}</dd>
      </dl>
    </div>
  );
}

export function EvolutionChart({ data, currency }: { data: HistoryPoint[]; currency: string }) {
  const gradient = useId();
  const spanDays = data.length > 1 ? (Date.parse(data[data.length - 1].date) - Date.parse(data[0].date)) / 86_400_000 : 0;
  const longRange = spanDays > 300;
  return (
    <div>
      {/* Legendă: două serii, deci identitatea este scrisă, nu doar colorată. */}
      <div className="mb-2 flex items-center gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-(--series-1)" /> Valoarea portofoliului
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-ink-3" /> Suma investită (cost)
        </span>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {fade(gradient)}
            <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="0" />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => shortDate(d, longRange)}
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
              minTickGap={48}
              tickMargin={8}
            />
            <YAxis
              tickFormatter={(v: number) => compactNumber(v)}
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
              domain={[(min: number) => Math.max(0, Math.floor(min * 0.96)), (max: number) => Math.ceil(max * 1.02)]}
            />
            <Tooltip content={<EvolutionTooltip currency={currency} />} cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }} isAnimationActive={false} />
            <Area
              type="monotone"
              dataKey="value"
              name="Valoare"
              stroke="var(--series-1)"
              strokeWidth={2}
              fill={`url(#${gradient})`}
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Line type="monotone" dataKey="invested" name="Investit" stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ------------------------------------------- randament vs. indice de referință */

export interface BenchmarkChartPoint {
  date: string;
  /** Randamentul ponderat în timp al portofoliului și al indicelui, de la începutul comparației. */
  portfolio: number;
  benchmark: number | null;
}

interface BenchmarkTooltipProps {
  active?: boolean;
  payload?: { payload: BenchmarkChartPoint }[];
  name: string;
}

function BenchmarkTooltip({ active, payload, name }: BenchmarkTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const diff = point.benchmark === null ? null : point.portfolio - point.benchmark;
  return (
    <div className={TOOLTIP_BOX}>
      <p className="mb-1.5 font-semibold text-ink">{fmtDate(point.date)}</p>
      <dl className="tabular grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="h-0.5 w-3 rounded bg-(--series-1)" /> Portofoliul
        </dt>
        <dd className="text-right font-medium text-ink">{signedPercent(point.portfolio)}</dd>
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="h-0 w-3 border-t-2 border-dashed border-(--series-2)" /> {name}
        </dt>
        <dd className="text-right font-medium text-ink">{signedPercent(point.benchmark)}</dd>
        {diff !== null && (
          <>
            <dt className="text-ink-2">Diferență</dt>
            <dd className={cx('text-right font-medium', diff >= 0 ? 'text-gain' : 'text-loss')}>{signedPercent(diff)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** Două linii care pornesc de la 0%: randamentul portofoliului și al indicelui de referință pe aceeași perioadă. */
export function BenchmarkChart({ data, name }: { data: BenchmarkChartPoint[]; name: string }) {
  const spanDays = data.length > 1 ? (Date.parse(data[data.length - 1].date) - Date.parse(data[0].date)) / 86_400_000 : 0;
  const longRange = spanDays > 300;
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-(--series-1)" /> Portofoliul tău
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-(--series-2)" /> {name}
        </span>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="0" />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => shortDate(d, longRange)}
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
              minTickGap={48}
              tickMargin={8}
            />
            <YAxis tickFormatter={(v: number) => percent(v, 0)} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
            <ReferenceLine y={0} stroke="var(--ink-3)" strokeWidth={1} />
            <Tooltip content={<BenchmarkTooltip name={name} />} cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="portfolio"
              name="Portofoliul"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="benchmark"
              name={name}
              stroke="var(--series-2)"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              connectNulls
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- donut */

interface DonutTooltipProps {
  active?: boolean;
  payload?: { payload: AllocationSlice }[];
  currency: string;
}

function DonutTooltip({ active, payload, currency }: DonutTooltipProps) {
  const slice = payload?.[0]?.payload;
  if (!active || !slice) return null;
  return (
    <div className={TOOLTIP_BOX}>
      <p className="font-semibold text-ink">{slice.label}</p>
      <p className="tabular text-ink-2">
        {money(slice.value, currency)} · {percent(slice.pct, 1)}
      </p>
    </div>
  );
}

export function AllocationDonut({ slices: input, currency, order }: { slices: AllocationSlice[]; currency: string; /** Cheile tuturor entităților, în ordine stabilă. */ order: string[] }) {
  if (input.length === 0) return <p className="py-10 text-center text-body text-ink-3">Nu există poziții deschise.</p>;
  const { slices, colors } = arrange(input, order);
  return (
    <div className="flex items-center gap-4">
      <div className="size-36 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              startAngle={90}
              endAngle={-270}
              // conturul în culoarea suprafeței lasă un spațiu de 2px între felii
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.key} fill={colors.get(s.key)} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip currency={currency} />} isAnimationActive={false} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* Legenda ține loc și de tabel: etichetă, procent și valoare pentru fiecare felie. */}
      <ul className="min-w-0 flex-1 space-y-1.5">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-body">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: colors.get(s.key) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink" title={s.label}>
              {s.label}
            </span>
            <span className="tabular shrink-0 font-medium text-ink">{percent(s.pct, 1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------- venit pasiv pe luni */

export interface IncomeMonth {
  month: number;
  received: number;
  estimated: number;
}

const MONTHS_SHORT = ['ian.', 'feb.', 'mar.', 'apr.', 'mai', 'iun.', 'iul.', 'aug.', 'sept.', 'oct.', 'nov.', 'dec.'];
const MONTHS_LONG = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
export const monthName = (m: number): string => MONTHS_LONG[m - 1] ?? '';

function IncomeTooltip({ active, payload, currency, year }: { active?: boolean; payload?: { payload: IncomeMonth }[]; currency: string; year: number }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className={TOOLTIP_BOX}>
      <p className="mb-1.5 font-semibold text-ink first-letter:uppercase">
        {monthName(p.month)} {year}
      </p>
      <dl className="tabular grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="size-2.5 rounded-sm bg-(--series-1)" /> Încasat
        </dt>
        <dd className="text-right font-medium text-ink">{money(p.received, currency)}</dd>
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="income-hatch size-2.5 rounded-sm" /> Estimat
        </dt>
        <dd className="text-right font-medium text-ink">{money(p.estimated, currency)}</dd>
        <dt className="text-ink-2">Total</dt>
        <dd className="text-right font-semibold text-ink">{money(p.received + p.estimated, currency)}</dd>
      </dl>
    </div>
  );
}

/** Venitul din dividende și cupoane pe luni: încasat (plin) și estimat (hașurat), stivuite. */
export function IncomeChart({ data, currency, year }: { data: IncomeMonth[]; currency: string; year: number }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-(--series-1)" /> Încasat
        </span>
        <span className="flex items-center gap-1.5">
          <span className="income-hatch size-2.5 rounded-sm" /> Estimat (anunțat sau după istoric)
        </span>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
            <defs>
              <pattern id="income-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--series-1)" fillOpacity={0.18} />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-1)" strokeWidth={2.5} />
              </pattern>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="month" tickFormatter={(m: number) => MONTHS_SHORT[m - 1]} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--line)' }} tickMargin={8} />
            <YAxis tickFormatter={(v: number) => compactNumber(v)} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
            <Tooltip content={<IncomeTooltip currency={currency} year={year} />} cursor={{ fill: 'var(--surface-2)' }} isAnimationActive={false} />
            <Bar dataKey="received" stackId="income" fill="var(--series-1)" stroke="var(--surface)" strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="estimated" stackId="income" fill="url(#income-hatch)" stroke="var(--surface)" strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ simulator */

export interface SimChartPoint {
  date: string;
  value: number;
  invested: number;
  actual: number | null;
}

function SimTooltip({ active, payload, currency, name }: { active?: boolean; payload?: { payload: SimChartPoint }[]; currency: string; name: string }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className={TOOLTIP_BOX}>
      <p className="mb-1.5 font-semibold text-ink">{fmtDate(p.date)}</p>
      <dl className="tabular grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="h-0.5 w-3 rounded bg-(--series-1)" /> {name}
        </dt>
        <dd className="text-right font-medium text-ink">{money(p.value, currency)}</dd>
        {p.actual !== null && (
          <>
            <dt className="flex items-center gap-1.5 text-ink-2">
              <span className="h-0.5 w-3 rounded bg-(--series-2)" /> Portofoliul tău real
            </dt>
            <dd className="text-right font-medium text-ink">{money(p.actual, currency)}</dd>
          </>
        )}
        <dt className="flex items-center gap-1.5 text-ink-2">
          <span className="h-0 w-3 border-t-2 border-dashed border-ink-3" /> Investit net
        </dt>
        <dd className="text-right font-medium text-ink">{money(p.invested, currency)}</dd>
      </dl>
    </div>
  );
}

/** Valoarea simulată (și, la comparația cu piața, cea reală) față de suma investită. */
export function SimulationChart({ data, currency, name }: { data: SimChartPoint[]; currency: string; name: string }) {
  const gradient = useId();
  const spanDays = data.length > 1 ? (Date.parse(data[data.length - 1].date) - Date.parse(data[0].date)) / 86_400_000 : 0;
  const hasActual = data.some((p) => p.actual !== null);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-(--series-1)" /> {name}
        </span>
        {hasActual && (
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded bg-(--series-2)" /> Portofoliul tău real
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-ink-3" /> Investit net
        </span>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" tickFormatter={(d: string) => shortDate(d, spanDays > 300)} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--line)' }} minTickGap={48} tickMargin={8} />
            <YAxis tickFormatter={(v: number) => compactNumber(v)} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
            <Tooltip content={<SimTooltip currency={currency} name={name} />} cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }} isAnimationActive={false} />
            {fade(gradient)}
            <Area type="monotone" dataKey="value" stroke="var(--series-1)" strokeWidth={2} fill={`url(#${gradient})`} fillOpacity={1} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
            {hasActual && <Line type="monotone" dataKey="actual" stroke="var(--series-2)" strokeWidth={2} dot={false} connectNulls activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />}
            <Line type="stepAfter" dataKey="invested" stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- proiecția obiectivului */

export interface FanPoint {
  date: string;
  /** Istoricul real (până azi). */
  history: number | null;
  /** Proiecția: mediana și banda pesimist (10%) – optimist (90%). */
  median: number | null;
  band: [number, number] | null;
}

function FanTooltip({ active, payload, currency }: { active?: boolean; payload?: { payload: FanPoint }[]; currency: string }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className={TOOLTIP_BOX}>
      <p className="mb-1.5 font-semibold text-ink">{fmtDate(p.date)}</p>
      <dl className="tabular grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        {p.history !== null && (
          <>
            <dt className="text-ink-2">Valoarea reală</dt>
            <dd className="text-right font-medium text-ink">{money(p.history, currency)}</dd>
          </>
        )}
        {p.band && p.median !== null && (
          <>
            <dt className="text-ink-2">Optimist (90%)</dt>
            <dd className="text-right font-medium text-ink">{money(p.band[1], currency)}</dd>
            <dt className="text-ink-2">Realist (mediana)</dt>
            <dd className="text-right font-semibold text-ink">{money(p.median, currency)}</dd>
            <dt className="text-ink-2">Pesimist (10%)</dt>
            <dd className="text-right font-medium text-ink">{money(p.band[0], currency)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** Graficul tip evantai: istoricul real, apoi proiecția (banda pesimist–optimist și mediana) și linia obiectivului. */
export function GoalFanChart({ data, currency, target }: { data: FanPoint[]; currency: string; target: number }) {
  // O singură etichetă pe an (primul punct din fiecare an), cel mult ~10 pe axă.
  const yearStarts = data.filter((p, i) => i === 0 || p.date.slice(0, 4) !== data[i - 1].date.slice(0, 4)).map((p) => p.date);
  const every = Math.max(1, Math.ceil(yearStarts.length / 10));
  const ticks = yearStarts.filter((_, i) => i % every === 0);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-(--series-2)" /> Valoarea reală
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-(--series-1)" /> Scenariu realist (mediana)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-(--series-1) opacity-25" /> Între pesimist (10%) și optimist (90%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-gain" /> Obiectivul
        </span>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" ticks={ticks} interval={0} tickFormatter={(d: string) => d.slice(0, 4)} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'var(--line)' }} tickMargin={8} />
            <YAxis tickFormatter={(v: number) => compactNumber(v)} tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
            <Tooltip content={<FanTooltip currency={currency} />} cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }} isAnimationActive={false} />
            <Area type="monotone" dataKey="band" stroke="none" fill="var(--series-1)" fillOpacity={0.24} isAnimationActive={false} activeDot={false} />
            <Line type="monotone" dataKey="median" stroke="var(--series-1)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="history" stroke="var(--series-2)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
            <ReferenceLine y={target} stroke="var(--gain)" strokeDasharray="6 4" strokeWidth={1.5} ifOverflow="extendDomain" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
