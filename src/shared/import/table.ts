/** Căutarea antetului și a coloanelor într-un tabel, după denumiri normalizate („No. of shares” -> „no.ofshares”). */
import { normalizeKey } from '../csv';
import type { Cell, Table } from './statement';
import { cellText } from './values';

export const headerKey = (cell: Cell | undefined): string => normalizeKey(cellText(cell));

/** Indicele primului rând (din primele `scan`) care conține toate denumirile cerute; -1 dacă nu există. */
export function findHeaderRow(table: Table, required: string[], scan = 30): number {
  for (let i = 0; i < Math.min(table.rows.length, scan); i++) {
    const keys = new Set(table.rows[i].map(headerKey));
    if (required.every((k) => keys.has(k))) return i;
  }
  return -1;
}

/** Prima foaie (sau CSV-ul) care are un antet cu denumirile cerute. */
export function findTable(tables: Table[], required: string[]): { table: Table; header: number } | null {
  for (const table of tables) {
    const header = findHeaderRow(table, required);
    if (header >= 0) return { table, header };
  }
  return null;
}

export class Columns {
  readonly keys: string[];
  constructor(header: Cell[]) {
    this.keys = header.map(headerKey);
  }
  /** Coloana cu una dintre denumiri (în ordinea preferinței); -1 dacă lipsește. */
  find(...names: string[]): number {
    for (const name of names) {
      const i = this.keys.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  }
  /** Coloana a cărei denumire începe cu prefixul dat. */
  startsWith(prefix: string): number {
    return this.keys.findIndex((k) => k.startsWith(prefix));
  }
  cell(row: Cell[], index: number): Cell {
    return index < 0 ? null : (row[index] ?? null);
  }
  text(row: Cell[], index: number): string {
    return cellText(this.cell(row, index));
  }
}
