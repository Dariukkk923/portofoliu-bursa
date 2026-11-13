/**
 * Indicii de referință cu care se poate compara randamentul unui portofoliu.
 * Simbolurile sunt în formatul Yahoo Finance. Pentru indicii care nu au o serie
 * istorică publică (BET, MSCI World; indicele BET nu are date la Yahoo) se folosește un ETF care îi replică.
 */
export interface Benchmark {
  symbol: string;
  name: string;
  currency: string;
}

export const BENCHMARKS: Benchmark[] = [
  { symbol: '^GSPC', name: 'S&P 500', currency: 'USD' },
  { symbol: '^NDX', name: 'Nasdaq 100', currency: 'USD' },
  { symbol: 'URTH', name: 'MSCI World (prin ETF-ul URTH)', currency: 'USD' },
  { symbol: 'TVBETETF.RO', name: 'BET (prin ETF-ul TVBETETF)', currency: 'RON' },
  { symbol: '^FTSE', name: 'FTSE 100', currency: 'GBP' },
  { symbol: '^GDAXI', name: 'DAX', currency: 'EUR' },
  { symbol: '^FCHI', name: 'CAC 40', currency: 'EUR' },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50', currency: 'EUR' }
];

export const DEFAULT_BENCHMARK = '^GSPC';

export const benchmarkName = (symbol: string | null | undefined): string =>
  BENCHMARKS.find((b) => b.symbol === symbol)?.name ?? symbol ?? BENCHMARKS[0].name;
