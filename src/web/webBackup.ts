/**
 * Backup pe web: aceiași octeți ca pe desktop (un fișier SQLite cu aceeași schemă), construiți în memorie.
 * Un backup făcut pe iPhone se restaurează pe desktop și invers.
 */
import type { SqlJsStatic } from 'sql.js';
import type { Db } from '@main/db/database';
import { AppError } from '@main/services/common';
import { buildBackup, restoreFrom } from '@main/services/backupCore';
import { asDb, SqlJsConnection } from './sqljs';

export function createWebBackup(SQL: SqlJsStatic, db: Db, userId: number): { data: Uint8Array; transactions: number } {
  const out = new SqlJsConnection(new SQL.Database());
  try {
    const { transactions } = buildBackup(db, userId, asDb(out));
    return { data: out.serialize(), transactions };
  } finally {
    out.close();
  }
}

export function restoreWebBackup(SQL: SqlJsStatic, db: Db, userId: number, data: Uint8Array): { brokers: number; assets: number; transactions: number } {
  let src: SqlJsConnection;
  try {
    src = new SqlJsConnection(new SQL.Database(data));
  } catch {
    throw new AppError('Fișierul ales nu este un backup creat de această aplicație.');
  }
  try {
    return restoreFrom(db, userId, asDb(src));
  } finally {
    src.close();
  }
}
