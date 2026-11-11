/**
 * Clientul API al interfeței: `api.grup.metodă(...)` devine un mesaj IPC către
 * procesul principal. Tipurile vin din contractul comun (`shared/api.ts`), deci
 * un apel greșit este prins la compilare.
 */
import type { Api, AppEvent } from '@shared/api';

/** Eroare venită de la procesul principal, cu mesaj în română gata de afișat. */
export class ApiError extends Error {}

async function call(path: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.call(path, args);
  if (!res.ok) throw new ApiError(res.error);
  return res.data;
}

function group<K extends keyof Api>(name: K): Api[K] {
  return new Proxy({} as Api[K], {
    get:
      (_target, method) =>
      (...args: unknown[]) =>
        call(`${name}.${String(method)}`, args)
  });
}

export const api: Api = {
  auth: group('auth'),
  brokers: group('brokers'),
  portfolios: group('portfolios'),
  assets: group('assets'),
  portfolio: group('portfolio'),
  transactions: group('transactions'),
  settings: group('settings'),
  prices: group('prices'),
  imports: group('imports'),
  watchlists: group('watchlists'),
  logos: group('logos'),
  dividends: group('dividends'),
  tax: group('tax'),
  journal: group('journal'),
  simulator: group('simulator'),
  goals: group('goals'),
  backup: group('backup'),
  app: group('app')
};

export const onAppEvent = (listener: (event: AppEvent) => void): (() => void) => window.bridge.onEvent(listener);

/** Textul de afișat pentru o eroare oarecare. */
export const errorMessage = (err: unknown): string =>
  err instanceof ApiError ? err.message : 'A apărut o eroare neașteptată. Încearcă din nou.';
