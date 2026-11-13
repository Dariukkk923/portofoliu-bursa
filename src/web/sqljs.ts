/**
 * Adaptor „Db” peste sql.js (SQLite compilat în WebAssembly), cu aceeași formă ca better-sqlite3
 * în partea pe care o folosesc serviciile: prepare().get/all/run, exec, pragma, transaction.
 * Astfel serviciile din src/main rulează neschimbate în browser.
 */
import type { Database as SqlJsDatabase, SqlJsStatic, BindParams } from 'sql.js';
import type { Db } from '@main/db/database';
import { migrate } from '@main/db/database';

type Row = Record<string, unknown>;
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Valorile acceptate de better-sqlite3 -> valorile acceptate de sql.js. */
function toBindValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Date);

export class SqlJsConnection {
  private depth = 0;
  private savepoints = 0;
  /** Anunțat la fiecare scriere: de aici pornește salvarea (cu întârziere) în IndexedDB. */
  onWrite: (() => void) | null = null;

  constructor(private readonly sql: SqlJsDatabase) {
    this.sql.run('PRAGMA foreign_keys = ON');
  }

  /** Parametrii poziționali, în listă sau în matrice, sau cei numiți (obiect cu @nume / :nume / $nume în SQL). */
  private params(sqlText: string, args: unknown[]): BindParams | undefined {
    if (args.length === 0) return undefined;
    if (args.length === 1 && Array.isArray(args[0])) return args[0].map(toBindValue) as BindParams;
    if (args.length === 1 && isPlainObject(args[0])) {
      const named: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args[0])) {
        // sql.js refuză parametrii necunoscuți, better-sqlite3 îi ignoră: păstrăm doar cei din SQL.
        for (const prefix of ['@', ':', '$']) {
          if (sqlText.includes(prefix + key)) named[prefix + key] = toBindValue(value);
        }
      }
      return named as BindParams;
    }
    return args.map(toBindValue) as BindParams;
  }

  query(sqlText: string, args: unknown[] = []): Row[] {
    // Instrucțiunea se pregătește la fiecare execuție: export() de mai jos redeschide baza și invalidează cele păstrate.
    const st = this.sql.prepare(sqlText);
    try {
      const bound = this.params(sqlText, args);
      if (bound) st.bind(bound);
      const rows: Row[] = [];
      while (st.step()) rows.push(st.getAsObject() as Row);
      return rows;
    } finally {
      st.free();
    }
  }

  run(sqlText: string, args: unknown[] = []): RunResult {
    const st = this.sql.prepare(sqlText);
    try {
      const bound = this.params(sqlText, args);
      if (bound) st.bind(bound);
      while (st.step()) {
        /* instrucțiunea poate întoarce rânduri (RETURNING); le ignorăm */
      }
    } finally {
      st.free();
    }
    const changes = this.sql.getRowsModified();
    const id = this.sql.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0];
    this.onWrite?.();
    return { changes, lastInsertRowid: Number(id ?? 0) };
  }

  exec(sqlText: string): void {
    this.sql.exec(sqlText);
    this.onWrite?.();
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const rows = this.query(`PRAGMA ${source}`);
    if (options?.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const nested = this.depth > 0;
      const name = `sp${++this.savepoints}`;
      this.sql.run(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.sql.run(nested ? `RELEASE ${name}` : 'COMMIT');
        this.onWrite?.();
        return result;
      } catch (err) {
        this.depth--;
        if (nested) this.sql.run(`ROLLBACK TO ${name}; RELEASE ${name}`);
        else this.sql.run('ROLLBACK');
        throw err;
      }
    };
  }

  prepare(sqlText: string): {
    get(...args: unknown[]): Row | undefined;
    all(...args: unknown[]): Row[];
    run(...args: unknown[]): RunResult;
  } {
    return {
      get: (...args) => this.query(sqlText, args)[0],
      all: (...args) => this.query(sqlText, args),
      run: (...args) => this.run(sqlText, args)
    };
  }

  /** Conținutul bazei ca fișier SQLite (același format ca pe desktop). */
  serialize(): Uint8Array {
    const bytes = this.sql.export();
    // export() redeschide baza și resetează pragma-urile.
    this.sql.run('PRAGMA foreign_keys = ON');
    return bytes;
  }

  close(): void {
    this.sql.close();
  }
}

/** Baza ca `Db` pentru servicii (tipul better-sqlite3 este mai larg decât partea implementată aici). */
export const asDb = (conn: SqlJsConnection): Db => conn as unknown as Db;

/** Deschide o bază din octeți (sau una goală) și aplică migrările. */
export function openSqlJs(SQL: SqlJsStatic, bytes?: Uint8Array | null): { conn: SqlJsConnection; db: Db } {
  const conn = new SqlJsConnection(bytes ? new SQL.Database(bytes) : new SQL.Database());
  const db = asDb(conn);
  migrate(db);
  return { conn, db };
}
