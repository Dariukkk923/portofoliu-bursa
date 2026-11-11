/**
 * Backup și restaurare.
 *
 * Backup-ul este un fișier SQLite de sine stătător, cu aceeași schemă ca baza
 * aplicației, care conține DOAR datele utilizatorului curent (brokeri, active,
 * tranzacții, setări și prețurile salvate). Nu conține parola și nici cheile
 * API (acestea sunt criptate cu o cheie legată de calculator și se reintroduc).
 *
 * Restaurarea înlocuiește datele utilizatorului curent cu cele din fișier, fără
 * să atingă datele altor utilizatori.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION } from '../db/migrations';
import { migrate, type Db } from '../db/database';
import { AppError, assert } from './common';

const APP_MARKER = 'portofoliu-bursa';
/** Tabelele cu datele utilizatorului, în ordinea în care pot fi inserate (respectă cheile străine). */
const USER_TABLES = ['brokers', 'assets', 'transactions', 'prices', 'price_history', 'history_sync'] as const;

type Row = Record<string, unknown>;

function insertRow(target: Db, table: string, row: Row): number {
  const cols = Object.keys(row);
  const info = target
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

/** Scrie backup-ul utilizatorului în `destPath` (suprascrie fișierul dacă există). */
export function createBackup(db: Db, userId: number, destPath: string): { transactions: number } {
  const user = db.prepare('SELECT id, username, email, is_demo, created_at FROM users WHERE id = ?').get(userId) as
    | Row
    | undefined;
  assert(user, 'Contul nu a fost găsit.');

  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(destPath + suffix, { force: true });
  const out = new Database(destPath);
  try {
    out.pragma('journal_mode = DELETE'); // un singur fișier, ușor de copiat
    out.pragma('foreign_keys = ON');
    migrate(out);
    let transactions = 0;
    out.transaction(() => {
      out.exec('CREATE TABLE backup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const meta = out.prepare('INSERT INTO backup_meta (key, value) VALUES (?, ?)');
      meta.run('app', APP_MARKER);
      meta.run('created_at', new Date().toISOString());
      meta.run('username', String(user.username));

      // Parola nu se exportă: restaurarea se face mereu în contul celui autentificat.
      insertRow(out, 'users', { ...user, password_hash: '' });
      const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) as Row | undefined;
      if (settings) insertRow(out, 'settings', { ...settings, last_price_update: null });

      for (const table of USER_TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId) as Row[];
        for (const row of rows) insertRow(out, table, row);
        if (table === 'transactions') transactions = rows.length;
      }
    })();
    return { transactions };
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
      const marker = src.prepare("SELECT value FROM backup_meta WHERE key = 'app'").get() as { value: string } | undefined;
      if (marker?.value !== APP_MARKER) throw new Error('marker');
    } catch {
      throw new AppError('Fișierul ales nu este un backup creat de această aplicație.');
    }
    const version = src.pragma('user_version', { simple: true }) as number;
    assert(
      version <= LATEST_SCHEMA_VERSION,
      'Backup-ul a fost creat cu o versiune mai nouă a aplicației. Actualizează aplicația și încearcă din nou.'
    );
    migrate(src);

    const source = src;
    const owner = source.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    assert(owner, 'Backup-ul nu conține date.');
    const read = (table: string): Row[] =>
      source.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(owner.id) as Row[];

    const counts = { brokers: 0, assets: 0, transactions: 0 };
    db.transaction(() => {
      // 1. Ștergem datele actuale ale utilizatorului (tranzacțiile întâi, din cauza cheilor străine).
      for (const table of ['transactions', 'assets', 'brokers', 'prices', 'price_history', 'history_sync']) {
        db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
      }

      // 2. Brokerii și activele primesc id-uri noi; păstrăm corespondența veche -> nouă.
      const brokerIds = new Map<number, number>();
      for (const { id, ...row } of read('brokers')) {
        brokerIds.set(id as number, insertRow(db, 'brokers', { ...row, user_id: userId }));
      }
      const assetIds = new Map<number, number>();
      for (const { id, ...row } of read('assets')) {
        assetIds.set(id as number, insertRow(db, 'assets', { ...row, user_id: userId }));
      }

      // 3. Tranzacțiile, cu referințele traduse la noile id-uri.
      for (const { id: _id, ...row } of read('transactions')) {
        const assetId = assetIds.get(row.asset_id as number);
        if (assetId === undefined) continue;
        insertRow(db, 'transactions', {
          ...row,
          user_id: userId,
          asset_id: assetId,
          broker_id: row.broker_id == null ? null : (brokerIds.get(row.broker_id as number) ?? null)
        });
        counts.transactions++;
      }

      // 4. Prețurile salvate (ca graficele să funcționeze și fără internet).
      for (const table of ['prices', 'price_history', 'history_sync']) {
        for (const row of read(table)) insertRow(db, table, { ...row, user_id: userId });
      }

      // 5. Preferințele (fără cheile API).
      const s = source.prepare('SELECT * FROM settings WHERE user_id = ?').get(owner.id) as Row | undefined;
      if (s) {
        db.prepare(
          `UPDATE settings SET base_currency = ?, cost_method = ?, theme = ?, primary_provider = ?,
             refresh_interval_min = ?, last_price_update = NULL WHERE user_id = ?`
        ).run(s.base_currency, s.cost_method, s.theme, s.primary_provider, s.refresh_interval_min, userId);
      }
      counts.brokers = brokerIds.size;
      counts.assets = assetIds.size;
    })();
    return counts;
  } finally {
    src?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
