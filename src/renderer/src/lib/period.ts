/** Perioada aleasă pe panoul principal, ținută minte pentru fiecare utilizator (doar pe acest dispozitiv). */
import { useState } from 'react';
import type { HistoryRange } from '@shared/types';
import { PERIODS } from '@shared/labels';

export function useStoredPeriod(userId: number | undefined, fallback: HistoryRange = '1Y'): [HistoryRange, (r: HistoryRange) => void] {
  const key = `perioada:${userId ?? 0}`;
  const [range, setRange] = useState<HistoryRange>(() => {
    try {
      const v = localStorage.getItem(key) as HistoryRange | null;
      return v && PERIODS.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const change = (r: HistoryRange): void => {
    setRange(r);
    try {
      localStorage.setItem(key, r);
    } catch {
      // fără stocare locală: perioada rămâne doar până la închidere
    }
  };
  return [range, change];
}
