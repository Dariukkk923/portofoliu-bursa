/**
 * Previzualizarea unui simbol (căutarea globală, adăugarea în watchlist, formularul de cumpărare și pagina
 * companiei): logo, nume, ultimul preț, variația pe perioadă și graficul cu 1L / 3L / 6L / YTD / 1A / Tot.
 * Istoricul vine din `prices.symbolHistory` (ținut doar în memorie de procesul principal).
 */
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info } from 'lucide-react';
import type { AssetType, SymbolHistory, SymbolHistoryRange } from '@shared/types';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { date as fmtDate, money, price as fmtPlain, signedPercent } from '../lib/format';
import { Pnl, Segmented, Skeleton, cx } from './ui';
import { TickerLogo } from './TickerLogo';

/** Un instrument oarecare (poate să nu fie deținut): ce trebuie pentru grafic și pentru pagina companiei. */
export interface CompanyRef {
  symbol: string;
  type: AssetType;
  name?: string | null;
  currency?: string | null;
  exchange?: string | null;
}

/** Deschide pagina companiei (dată de spațiul de lucru; lipsă = fără butonul „Info”). */
export const OpenCompanyContext = createContext<((ref: CompanyRef) => void) | null>(null);
export const useOpenCompany = (): ((ref: CompanyRef) => void) | null => useContext(OpenCompanyContext);

export const RANGE_OPTIONS: { value: SymbolHistoryRange; label: string }[] = [
  { value: '1M', label: '1L' },
  { value: '3M', label: '3L' },
  { value: '6M', label: '6L' },
  { value: 'YTD', label: 'YTD' },
  { value: '1Y', label: '1A' },
  { value: 'ALL', label: 'Tot' }
];

export const RANGE_TEXT: Record<SymbolHistoryRange, string> = {
  '1M': 'în ultima lună',
  '3M': 'în ultimele 3 luni',
  '6M': 'în ultimele 6 luni',
  YTD: 'de la începutul anului',
  '1Y': 'în ultimul an',
  ALL: 'în tot istoricul'
};

export const NO_HISTORY = 'Istoricul prețului nu este disponibil acum.';

/** True pe ecranele înguste (telefon, sub pragul `md` din Tailwind). */
export function useNarrow(): boolean {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

/** Prețul în moneda lui, cu mai multe zecimale pentru valorile mici (crypto, penny stocks). */
export function fmtPrice(value: number, currency: string | null | undefined): string {
  const digits = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6;
  return currency ? money(value, currency, digits) : fmtPlain(value);
}

/**
 * Istoricul pentru perioada aleasă. La schimbarea simbolului cererea pleacă după `debounceMs`
 * (mutarea cu săgețile prin rezultate nu trimite câte o cerere pe rând); răspunsurile vechi se ignoră.
 * La schimbarea perioadei pentru același simbol, graficul vechi rămâne până vine cel nou.
 */
export function useSymbolHistory(ref: CompanyRef, range: SymbolHistoryRange, debounceMs = 0): { data: SymbolHistory | null; loading: boolean } {
  const { settings } = useApp();
  const base = settings?.baseCurrency ?? null;
  const symKey = `${ref.type}:${ref.symbol.toUpperCase()}|${base}`;
  const key = `${symKey}|${range}`;
  const [state, setState] = useState<{ key: string; data: SymbolHistory | null } | null>(null);
  const lastSymbol = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    const sameSymbol = lastSymbol.current === symKey;
    lastSymbol.current = symKey;
    const timer = window.setTimeout(
      () => {
        api.prices
          .symbolHistory({ symbol: ref.symbol, type: ref.type, currency: ref.currency ?? null }, range, base)
          .then((data) => live && setState({ key, data }))
          .catch(() => live && setState({ key, data: null }));
      },
      sameSymbol ? 0 : debounceMs
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const fresh = state?.key === key;
  const sameSymbol = !!state && state.key.startsWith(`${symKey}|`);
  return { data: fresh || sameSymbol ? state!.data : null, loading: !fresh };
}

/** Eticheta axei: anii la „Tot” și pe perioade lungi, lunile peste ~2,5 luni, altfel ziua. */
function axisLabel(iso: string, range: SymbolHistoryRange, spanDays: number): string {
  const d = new Date(`${iso}T00:00:00`);
  if (range === 'ALL' || spanDays > 400) return String(d.getFullYear());
  if (spanDays > 75) {
    const m = d.toLocaleDateString('ro-RO', { month: 'short' }).replace('.', '');
    return m.charAt(0).toUpperCase() + m.slice(1);
  }
  return d.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
}

function PriceTooltip({ active, payload, currency }: { active?: boolean; payload?: { payload: { date: string; close: number } }[]; currency: string | null }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-surface-2/95 px-3 py-2 shadow-pop backdrop-blur">
      <p className="text-xs text-ink-2">{fmtDate(p.date)}</p>
      <p className="tabular mt-0.5 text-body font-bold text-ink">{fmtPrice(p.close, currency)}</p>
    </div>
  );
}

/** Graficul de arie al prețului: verde luminos, roșu când perioada e pe minus; 2–3 etichete pe axă. */
export function PriceChart({ points, currency, range, height }: { points: { date: string; close: number }[]; currency: string | null; range: SymbolHistoryRange; height: number }) {
  const gradient = useId().replace(/:/g, '');
  const up = points[points.length - 1].close >= points[0].close;
  const n = points.length;
  const spanDays = (Date.parse(points[n - 1].date) - Date.parse(points[0].date)) / 86_400_000;
  const ticks = n >= 6 ? [...new Set([Math.round(n * 0.12), Math.round(n * 0.5), Math.round(n * 0.88)].map((i) => points[i].date))] : [points[0].date];
  const labels = ticks.map((t) => axisLabel(t, range, spanDays));
  const shown = ticks.filter((_, i) => labels.indexOf(labels[i]) === i);
  const values = points.map((p) => p.close);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || hi * 0.02 || 1) * 0.08;
  return (
    <div
      className="chart-reveal w-full"
      // Pe minus, linia (și strălucirea ei) iau culoarea pierderii.
      style={up ? { height } : { height, ['--chart-line' as string]: 'var(--loss)' }}
      role="img"
      aria-label={`Graficul prețului ${RANGE_TEXT[range]}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 6, bottom: 0, left: 6 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-line)" stopOpacity={0.45} />
              <stop offset="60%" stopColor="var(--chart-line)" stopOpacity={0.12} />
              <stop offset="100%" stopColor="var(--chart-line)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" ticks={shown} interval={0} tickFormatter={(d: string) => axisLabel(d, range, spanDays)} tick={{ fill: 'var(--ink-3)', fontSize: 12 }} tickLine={false} axisLine={false} tickMargin={8} height={24} />
          <YAxis hide domain={[lo - pad, hi + pad]} />
          <Tooltip content={<PriceTooltip currency={currency} />} cursor={{ stroke: 'var(--ink-3)', strokeDasharray: '4 4' }} isAnimationActive={false} />
          <Area type="monotone" dataKey="close" stroke="none" fill={`url(#${gradient})`} fillOpacity={1} isAnimationActive={false} activeDot={false} />
          <Line
            type="monotone"
            dataKey="close"
            stroke="var(--chart-line)"
            strokeWidth={2.25}
            dot={false}
            className="glow-line"
            activeDot={{ r: 4, fill: 'var(--chart-line)', stroke: 'var(--surface)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Graficul cu perioadele (chips) și starea lui: schelet la încărcare, mesaj scurt când nu sunt date. */
export function ChartBlock({ data, loading, range, onRange, height }: { data: SymbolHistory | null; loading: boolean; range: SymbolHistoryRange; onRange: (r: SymbolHistoryRange) => void; height: number }) {
  const points = data?.points ?? [];
  return (
    <div className="space-y-2.5">
      <Segmented size="sm" value={range} onChange={onRange} options={RANGE_OPTIONS} />
      {points.length >= 2 ? (
        <div className={cx('transition-opacity', loading && 'opacity-60')}>
          <PriceChart points={points} currency={data?.currency ?? null} range={range} height={height} />
        </div>
      ) : loading ? (
        <div className="skeleton w-full rounded-xl" style={{ height }} aria-hidden />
      ) : (
        <p className="flex items-center justify-center rounded-xl border border-dashed border-line px-4 text-center text-body text-ink-3" style={{ height }}>
          {NO_HISTORY}
        </p>
      )}
    </div>
  );
}

/** Butonul „Info” (contur violet): deschide pagina companiei. */
export function InfoPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-accent/60 px-2.5 text-xs font-semibold text-accent transition hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent max-md:h-9 max-md:px-3"
    >
      <Info className="size-3.5" aria-hidden /> Info
    </button>
  );
}

/**
 * Previzualizarea completă: antetul (logo, simbol, nume · bursă · monedă, „Info”), prețul și variația pe
 * perioadă, rândul mic „în ultimele 6 luni · 1 cotație = X RON”, perioadele și graficul.
 * `beforeInfo` închide ce trebuie (căutarea, formularul) înainte de deschiderea paginii companiei.
 */
export function SymbolPreview({ item, compact = false, debounceMs = 0, beforeInfo, className }: { item: CompanyRef; compact?: boolean; debounceMs?: number; beforeInfo?: () => void; className?: string }) {
  const openCompany = useOpenCompany();
  const [range, setRange] = useState<SymbolHistoryRange>('6M');
  const { data, loading } = useSymbolHistory(item, range, debounceMs);
  const currency = data?.currency ?? item.currency ?? null;
  const last = data?.last ?? null;
  const details = [item.name, item.exchange, currency].filter(Boolean).join(' · ');
  const chartHeight = compact ? 120 : 190;

  return (
    <div className={cx('min-w-0 space-y-3', className)}>
      <div className="flex items-center gap-3">
        <TickerLogo symbol={item.symbol} type={item.type} size={compact ? 32 : 40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-md font-bold tracking-tight text-ink">{item.symbol.toUpperCase()}</p>
          {details && <p className="truncate text-xs text-ink-3">{details}</p>}
        </div>
        {openCompany && (
          <InfoPill
            onClick={() => {
              beforeInfo?.();
              openCompany({ ...item, currency });
            }}
          />
        )}
      </div>

      {last !== null ? (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <span className={cx('tabular font-bold tracking-tight text-ink', compact ? 'text-xl' : 'text-2xl')}>{fmtPrice(last, currency)}</span>
            {data?.change !== null && data?.change !== undefined && (
              <Pnl value={data.change} className="text-body font-semibold">
                {signedPercent(data.change)}
              </Pnl>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-3">
            {RANGE_TEXT[range]}
            {data?.fx && <> · 1 cotație = {money(last * data.fx.rate, data.fx.currency)}</>}
          </p>
        </div>
      ) : loading ? (
        <div className="space-y-1.5" aria-hidden>
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      ) : null}

      <ChartBlock data={data} loading={loading} range={range} onRange={setRange} height={chartHeight} />
    </div>
  );
}
