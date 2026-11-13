/** Formatări pentru știri și raportări financiare. */
import type { ResultsVerdict } from '@shared/types';
import { compactNumber, signedPercent } from './format';

const MONTHS = ['ian.', 'feb.', 'mar.', 'apr.', 'mai', 'iun.', 'iul.', 'aug.', 'sept.', 'oct.', 'nov.', 'dec.'];

/** „acum 5 minute”, „acum 3 ore”, „ieri”, altfel data. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'acum câteva secunde';
  if (min < 60) return min === 1 ? 'acum un minut' : `acum ${min} minute`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'acum o oră' : `acum ${h} ore`;
  const d = Math.round(h / 24);
  if (d === 1) return 'ieri';
  if (d < 7) return `acum ${d} zile`;
  return new Date(t).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Perioada unui raport după data de închidere: „sept. 2026” pentru trimestre, „2026” pentru ani. */
export function periodLabel(end: string, annual: boolean): string {
  const [y, m] = end.split('-');
  return annual ? y : `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** Sumă mare, prescurtată (1,2 mld.); moneda se adaugă dacă se știe. */
export function bigMoney(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined) return '—';
  return `${compactNumber(value)}${currency ? ` ${currency}` : ''}`;
}

/** Valoare pe acțiune (EPS): două zecimale, cu virgulă. */
export function perShare(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** Variația față de anul trecut: „+12,3% față de anul trecut”. */
export function yoy(change: number | null): string {
  return change === null ? 'fără comparație cu anul trecut' : `${signedPercent(change)} față de anul trecut`;
}

export const VERDICT_LABEL: Record<ResultsVerdict, string> = { beat: 'peste așteptări', miss: 'sub așteptări', inline: 'în linie cu așteptările' };
export const VERDICT_TONE: Record<ResultsVerdict, 'gain' | 'loss' | 'neutral'> = { beat: 'gain', miss: 'loss', inline: 'neutral' };

/** „în 3 zile”, „mâine”, „azi”. */
export function inDays(days: number | null): string {
  if (days === null) return 'dată necunoscută';
  if (days <= 0) return 'azi';
  return days === 1 ? 'mâine' : `în ${days} zile`;
}
