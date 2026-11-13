/**
 * Backup pe web: aceiași octeți ca pe desktop. Un backup făcut în browser se restaurează pe desktop și invers.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/database';
import * as auth from '@main/services/auth';
import { createBackup, restoreBackup } from '@main/services/backup';
import { ensureDemoAccount } from '@main/services/demo';
import { getOverview } from '@main/services/portfolio';
import { listTransactions } from '@main/services/transactions';
import { openSqlJs } from '../src/web/sqljs';
import { createWebBackup, restoreWebBackup } from '../src/web/webBackup';

let SQL: SqlJsStatic;
const tmp = mkdtempSync(join(tmpdir(), 'pb-webbackup-'));
beforeAll(async () => {
  SQL = await initSqlJs();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('backup web', () => {
  it('dus-întors în browser: datele contului ajung neschimbate într-un cont nou', async () => {
    const { db } = openSqlJs(SQL);
    const demo = await ensureDemoAccount(db);
    const { data, transactions } = createWebBackup(SQL, db, demo.id);
    expect(transactions).toBeGreaterThan(5);
    expect(new TextDecoder().decode(data.slice(0, 15))).toBe('SQLite format 3');

    const other = openSqlJs(SQL).db;
    const user = await auth.register(other, { username: 'nou', password: 'parola-noua-1' });
    expect(restoreWebBackup(SQL, other, user.id, data).transactions).toBe(transactions);
    expect(listTransactions(other, user.id)).toHaveLength(transactions);
    const a = getOverview(db, demo.id);
    const b = getOverview(other, user.id);
    expect(b.positions.map((p) => [p.symbol, p.quantity, p.price])).toEqual(a.positions.map((p) => [p.symbol, p.quantity, p.price]));
  });

  it('web -> desktop: fișierul creat în browser se restaurează cu codul de pe desktop', async () => {
    const { db } = openSqlJs(SQL);
    const demo = await ensureDemoAccount(db);
    const { data, transactions } = createWebBackup(SQL, db, demo.id);
    const file = join(tmp, 'din-browser.db');
    writeFileSync(file, data);

    const desktop = openDatabase(':memory:');
    const user = await auth.register(desktop, { username: 'desktop', password: 'parola-desk-1' });
    expect(restoreBackup(desktop, user.id, file).transactions).toBe(transactions);
    expect(getOverview(desktop, user.id).positions.length).toBe(getOverview(db, demo.id).positions.length);
  });

  it('desktop -> web: fișierul creat pe desktop se restaurează în browser', async () => {
    const desktop = openDatabase(':memory:');
    const demo = await ensureDemoAccount(desktop);
    const file = join(tmp, 'de-pe-desktop.db');
    const { transactions } = createBackup(desktop, demo.id, file);

    const { db } = openSqlJs(SQL);
    const user = await auth.register(db, { username: 'web', password: 'parola-web-12' });
    expect(restoreWebBackup(SQL, db, user.id, readFileSync(file)).transactions).toBe(transactions);
    expect(getOverview(db, user.id).positions.length).toBe(getOverview(desktop, demo.id).positions.length);

  });

  it('refuză fișierele care nu sunt backup-uri ale aplicației (text oarecare, SQLite străin)', async () => {
    const { db } = openSqlJs(SQL);
    const user = await auth.register(db, { username: 'xxx', password: 'parola-x-1234' });
    expect(() => restoreWebBackup(SQL, db, user.id, new TextEncoder().encode('acesta nu este un fișier SQLite'))).toThrow(/nu este un backup/);
    const foreign = new SQL.Database();
    foreign.run('CREATE TABLE altceva (a INTEGER)');
    expect(() => restoreWebBackup(SQL, db, user.id, foreign.export())).toThrow(/nu este un backup/);
  });

  it('backup-ul nu conține parola', async () => {
    const { db } = openSqlJs(SQL);
    const user = await auth.register(db, { username: 'yyy', password: 'parola-yy-1234' });
    const { data } = createWebBackup(SQL, db, user.id);
    const copy = new SQL.Database(data);
    expect(copy.exec('SELECT password_hash FROM users')[0].values[0][0]).toBe('');
  });
});
