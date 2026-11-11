/**
 * Grafic mic (sparkline) al închiderilor zilnice: o singură linie subțire, verde
 * dacă prețul a crescut în perioadă, roșu dacă a scăzut. Valorile exacte apar
 * în textul pentru cititoarele de ecran și la trecerea cu mouse-ul.
 */
import { useId } from 'react';
import { percent } from '../lib/format';

export function Sparkline({ points, width = 96, height = 28, label }: { points: { date: string; close: number }[]; width?: number; height?: number; label: string }) {
  const gradient = useId();
  if (points.length < 2) return <span className="inline-block text-xs text-ink-3" style={{ width }}>—</span>;
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pad = 2;
  const x = (i: number): number => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (v: number): number => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(' ');
  const change = closes[closes.length - 1] / closes[0] - 1;
  const color = change >= 0 ? 'var(--gain)' : 'var(--loss)';
  const text = `${label}: ${change >= 0 ? '+' : ''}${percent(change)} (${points[0].date} – ${points[points.length - 1].date})`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={text} className="shrink-0 overflow-visible">
      <title>{text}</title>
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`${x(0)},${height} ${line} ${x(points.length - 1)},${height}`} fill={`url(#${gradient})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
