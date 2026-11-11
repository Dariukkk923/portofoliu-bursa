/**
 * Graficele dashboard-ului (Recharts): evoluția valorii portofoliului și
 * alocările de tip donut.
 *
 * Culorile vin din variabilele CSS ale temei (--series-1 … --series-8), o
 * paletă categorială în ordine fixă, verificată pentru daltonism în ambele teme.
 * Fiecare felie are și etichetă cu valoare în legendă, deci identitatea nu
 * depinde doar de culoare.
 */
import { Area, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AllocationSlice, HistoryPoint } from '@shared/types';
import { compactNumber, date as fmtDate, money, percent, shortDate, signedMoney } from '../lib/format';
import { cx } from './ui';

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
              fill="var(--series-1)"
              fillOpacity={0.1}
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
  if (input.length === 0) return <p className="py-10 text-center text-[13px] text-ink-3">Nu există poziții deschise.</p>;
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
          <li key={s.key} className="flex items-center gap-2 text-[13px]">
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
