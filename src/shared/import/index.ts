/**
 * Importul din extrasele brokerilor: recunoașterea formatului după structura
 * fișierului (nu după nume) și cititorii dedicați. Ce nu este recunoscut se
 * importă prin maparea universală a coloanelor (`mapping.ts`).
 */
import type { StatementReader, Table } from './statement';
import { ibkrReader } from './readers/ibkr';
import { trading212Reader } from './readers/trading212';
import { revolutReader } from './readers/revolut';
import { xtbReader } from './readers/xtb';

export * from './statement';
export * from './values';
export * from './mapping';

/** Ordinea contează: formatele cu structura cea mai distinctivă întâi; XTB (cititor tolerant) la final. */
export const READERS: StatementReader[] = [ibkrReader, trading212Reader, revolutReader, xtbReader];

/** Cititorul dedicat pentru fișier, sau null dacă formatul nu este cunoscut. */
export function detectReader(tables: Table[], fileName: string): StatementReader | null {
  return READERS.find((r) => r.detect(tables, fileName)) ?? null;
}

/** Brokerii cu cititor dedicat (pentru textul de pe ecranul de import). */
export const SUPPORTED_BROKERS = READERS.map((r) => r.label);
