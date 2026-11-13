/**
 * Backup și restaurare pe desktop: fișiere SQLite pe disc.
 * Logica propriu-zisă (ce se salvează, cum se restaurează) este în backupCore.ts.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/database';
import { AppError, assert } from './common';
import { buildBackup, restoreFrom } from './backupCore';

/** Scrie backup-ul utilizatorului în `destPath` (suprascrie fișierul dacă există). */
export function createBackup(db: Db, userId: number, destPath: string): { transactions: number } {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(destPath + suffix, { force: true });
  const out = new Database(destPath);
  try {
    out.pragma('journal_mode = DELETE'); // un singur fișier, ușor de copiat
    out.pragma('foreign_keys = ON');
    return buildBackup(db, userId, out);
  } finally {
    out.close();
  }
}

/** Înlocuiește datele utilizatorului curent cu cele din fișierul de backup. */
export function restoreBackup(
  db: Db,
  userId: number,
  srcPath: string
): { brokers: number; assets: number; transactions: number } {
  assert(existsSync(srcPath), 'Fișierul de backup nu a fost găsit.');

  // Lucrăm pe o copie temporară: fișierul original nu este modificat, iar copia poate fi migrată la schema curentă.
  const tmpDir = mkdtempSync(join(tmpdir(), 'portofoliu-restore-'));
  const tmpFile = join(tmpDir, 'backup.db');
  copyFileSync(srcPath, tmpFile);

  let src: Db | null = null;
  try {
    try {
      src = new Database(tmpFile);
    } catch {
      throw new AppError('Fișierul ales nu este un backup creat de această aplicație.');
    }
    return restoreFrom(db, userId, src);
  } finally {
    src?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
