/**
 * Logo-urile companiilor în interfață: cererile din toată pagina se adună într-un
 * singur apel către procesul principal (care le ține în cache local și le descarcă,
 * în fundal, pe cele lipsă). Când sosesc logo-uri noi, componentele se reafișează.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { AssetType } from '@shared/types';
import { api, onAppEvent } from '../api';

/** symbol -> data URL; null = încă nu există logo (se afișează inițialele). */
const cache = new Map<string, string | null>();
const types = new Map<string, AssetType>();
const asked = new Set<string>();
const queue = new Set<string>();
const listeners = new Set<() => void>();
let timer: number | null = null;
let listening = false;

const notify = (): void => listeners.forEach((l) => l());

function flush(): void {
  timer = null;
  const batch = [...queue];
  queue.clear();
  if (batch.length === 0) return;
  api.logos
    .get(batch.map((symbol) => ({ symbol, type: types.get(symbol) ?? 'stock' })))
    .then((result) => {
      for (const symbol of batch) cache.set(symbol, result[symbol] ?? null);
      notify();
    })
    .catch(() => {
      for (const symbol of batch) asked.delete(symbol); // reîncercăm la următoarea afișare
    });
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  onAppEvent((event) => {
    if (event.type !== 'logos:changed') return;
    for (const symbol of event.payload) {
      asked.delete(symbol);
      request(symbol, types.get(symbol) ?? 'stock');
    }
  });
}

function request(symbol: string, type: AssetType): void {
  ensureListening();
  types.set(symbol, type);
  if (asked.has(symbol)) return;
  asked.add(symbol);
  queue.add(symbol);
  if (timer === null) timer = window.setTimeout(flush, 30);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Logo-ul unui simbol (data URL) sau null cât timp nu există. `symbol` null = nu se cere nimic. */
export function useLogo(symbol: string | null, type: AssetType): string | null {
  useEffect(() => {
    if (symbol) request(symbol, type);
  }, [symbol, type]);
  return useSyncExternalStore(subscribe, () => (symbol ? (cache.get(symbol) ?? null) : null));
}

/** La schimbarea utilizatorului: fiecare cont are cache-ul lui de logo-uri. */
export function resetLogos(): void {
  cache.clear();
  asked.clear();
  queue.clear();
  notify();
}
