/**
 * Sincronizarea pe telefon (sql.js): pachetul fără cache-uri se construiește și se restaurează în memorie,
 * iar amprenta datelor se calculează la fel ca pe desktop.
 */
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/database';
import * as auth from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { createBackup } from '@main/services/backup';
import { saveQuote } from '@main/prices/store';
import { dataHash } from '@main/services/syncData';
import { decryptSnapshot, deriveSyncKeys, encryptSnapshot } from '@main/services/syncCrypto';
import { openSqlJs } from '../src/web/sqljs';
import { createWebBackup, restoreWebBackup } from '../src/web/webBackup';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('sincronizarea în browser (sql.js)', () => {
  it('desktop -> telefon: pachetul criptat de pe calculator se restaurează în browser; cache-urile telefonului rămân', async () => {
    const desktop = openDatabase(':memory:');
    const pcUser = await auth.register(desktop, { username: 'ana', password: 'parola-sigura-1' });
    createBroker(desktop, pcUser.id, { name: 'XTB' });
    saveQuote(desktop, pcUser.id, { symbol: 'SNP.RO', price: 60, currency: 'RON', asOf: '2024-01-10T15:00:00Z', provider: 'yahoo' });
    const dir = mkdtempSync(join(tmpdir(), 'pb-websync-'));
    const file = join(dir, 's.db');
    createBackup(desktop, pcUser.id, file, { sync: true });
    const { encKey } = await deriveSyncKeys('ana', 'parola-sigura-1');
    const blob = await encryptSnapshot(encKey, readFileSync(file));
    rmSync(dir, { recursive: true, force: true });

    const { db } = openSqlJs(SQL);
    const phoneUser = await auth.register(db, { username: 'ana', password: 'parola-sigura-1' });
    saveQuote(db, phoneUser.id, { symbol: 'TLV.RO', price: 20, currency: 'RON', asOf: '2024-01-10T15:00:00Z', provider: 'yahoo' });
    restoreWebBackup(SQL, db, phoneUser.id, await decryptSnapshot(encKey, blob), { sync: true });
    expect((db.prepare('SELECT name FROM brokers WHERE user_id = ?').all(phoneUser.id) as { name: string }[]).map((b) => b.name)).toEqual(['XTB']);
    expect((db.prepare('SELECT symbol FROM prices WHERE user_id = ?').all(phoneUser.id) as { symbol: string }[]).map((p) => p.symbol)).toEqual(['TLV.RO']);

    // Pachetul făcut în browser nu conține prețuri, iar amprenta e stabilă la o actualizare de prețuri.
    const lean = createWebBackup(SQL, db, phoneUser.id, { sync: true }).data;
    const check = new SQL.Database(lean);
    expect(check.exec('SELECT COUNT(*) FROM prices')[0].values[0][0]).toBe(0);
    check.close();
    const h = dataHash(db, phoneUser.id);
    saveQuote(db, phoneUser.id, { symbol: 'TLV.RO', price: 21, currency: 'RON', asOf: '2024-01-11T15:00:00Z', provider: 'yahoo' });
    expect(dataHash(db, phoneUser.id)).toBe(h);
  });
});
