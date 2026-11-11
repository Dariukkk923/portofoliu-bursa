import Database from 'better-sqlite3';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations';

export type Db = Database.Database;

/**
 * Deschide (sau creează) baza de date SQLite și aplică migrările lipsă.
 * `file` poate fi „:memory:” în teste.
 */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Aplică, în ordine, toate migrările cu versiune mai mare decât cea a bazei. */
export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Baza de date are versiunea ${current}, mai nouă decât cea suportată de aplicație (${LATEST_SCHEMA_VERSION}). Actualizează aplicația.`
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // Fiecare migrare rulează într-o tranzacție: ori se aplică integral, ori deloc.
    db.transaction(() => {
      db.exec(m.sql);
      m.after?.(db);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}
