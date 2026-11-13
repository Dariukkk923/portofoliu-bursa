/**
 * Adaptorul sql.js (versiunea web): același API ca better-sqlite3 în partea folosită de servicii, aceleași
 * migrări și aceleași rezultate ale serviciilor ca pe desktop.
 */
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, schemaVersion, type Db } from '@main/db/database';
import { LATEST_SCHEMA_VERSION } from '@main/db/migrations';
import * as auth from '@main/services/auth';
import { createBroker } from '@main/services/brokers';
import { addPurchase, listTransactions } from '@main/services/transactions';
import { getOverview } from '@main/services/portfolio';
import { ensureDemoAccount } from '@main/services/demo';
import { getApiKey, getSettings, setApiKey, updateSettings } from '@main/services/settings';
import { createAesBox } from '@main/secrets';
import { saveQuote } from '@main/prices/store';
import { openSqlJs } from '../src/web/sqljs';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Fără câmpurile care depind de ceas (momentul creării etc.): cele două baze rulează la momente diferite. */
const stable = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (/(At|asOf)$|^created|^updated/i.test(k) ? undefined : x)));

const names = (db: Db): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe('adaptorul sql.js', () => {
  it('prepare().get/all/run cu parametri poziționali, în listă și numiți', () => {
    const { db } = openSqlJs(SQL);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b REAL, c BLOB)');
    const ins = db.prepare('INSERT INTO t (a, b, c) VALUES (?, ?, ?)');
    const r1 = ins.run('x', 1.5, null);
    const r2 = ins.run(['y', 2, new Uint8Array([1, 2, 3])]);
    expect(r1).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(r2.lastInsertRowid).toBe(2);
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(1)).toEqual({ id: 1, a: 'x', b: 1.5, c: null });
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(99)).toBeUndefined();
    expect((db.prepare('SELECT c FROM t WHERE id = 2').get() as { c: Uint8Array }).c).toEqual(new Uint8Array([1, 2, 3]));
    // numiți: cheile în plus se ignoră, ca în better-sqlite3
    expect(db.prepare('SELECT a FROM t WHERE id = @id AND b > :min').all({ id: 2, min: 1, extra: 'ignorat' })).toEqual([{ a: 'y' }]);
    expect(db.prepare('UPDATE t SET a = ? WHERE id = ?').run('z', 1).changes).toBe(1);
    expect(db.prepare('DELETE FROM t WHERE id = ?').run(42).changes).toBe(0);
  });

  it('valorile boolean și undefined devin 1/0 și NULL', () => {
    const { db } = openSqlJs(SQL);
    db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    db.prepare('INSERT INTO t VALUES (?, ?)').run(true, undefined);
    expect(db.prepare('SELECT * FROM t').get()).toEqual({ a: 1, b: null });
  });

  it('tranzacțiile se anulează la eroare, inclusiv cele imbricate', () => {
    const { db } = openSqlJs(SQL);
    db.exec('CREATE TABLE t (a INTEGER)');
    const add = (n: number): void => void db.prepare('INSERT INTO t VALUES (?)').run(n);
    const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    expect(() => db.transaction(() => { add(1); throw new Error('eșec'); })()).toThrow('eșec');
    expect(count()).toBe(0);
    db.transaction(() => {
      add(1);
      expect(() => db.transaction(() => { add(2); throw new Error('interior'); })()).toThrow('interior');
      add(3);
    })();
    expect(db.prepare('SELECT a FROM t ORDER BY a').all()).toEqual([{ a: 1 }, { a: 3 }]);
    expect(db.transaction((x: number) => x * 2)(21)).toBe(42);
  });

  it('pragma: user_version simplu și cheile străine se aplică', () => {
    const { db } = openSqlJs(SQL);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.pragma('user_version = 77');
    expect(db.pragma('user_version', { simple: true })).toBe(77);
  });

  it('salvarea în octeți și redeschiderea păstrează datele și cheile străine', () => {
    const { conn, db } = openSqlJs(SQL);
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('ion', 'h')").run();
    const bytes = conn.serialize();
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // export() resetează pragma-urile; adaptorul le pune la loc
    const again = openSqlJs(SQL, bytes);
    expect((again.db.prepare('SELECT username FROM users').get() as { username: string }).username).toBe('ion');
    expect(schemaVersion(again.db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('semnalează scrierile (pentru salvarea în IndexedDB)', () => {
    const { conn, db } = openSqlJs(SQL);
    let writes = 0;
    conn.onWrite = () => writes++;
    db.prepare('SELECT 1').get();
    expect(writes).toBe(0);
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('a', 'h')").run();
    expect(writes).toBeGreaterThan(0);
  });
});

describe('aceleași migrări și aceleași rezultate ca pe desktop', () => {
  it('schema este identică cu cea din better-sqlite3', () => {
    expect(names(openSqlJs(SQL).db)).toEqual(names(openDatabase(':memory:')));
  });

  it('conturi, brokeri, achiziții, listări cu filtre și portofoliu evaluat', async () => {
    const run = async (db: Db): Promise<unknown> => {
      const user = await auth.register(db, { username: 'maria', password: 'parola-maria' });
      const broker = createBroker(db, user.id, { name: 'XTB', baseCurrency: 'EUR' } as never);
      addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'AAPL', name: 'Apple', currency: 'USD' }, brokerId: broker.id, date: '2024-03-04', quantity: 5, price: 170, fee: 1 });
      addPurchase(db, user.id, { asset: { type: 'etf', symbol: 'VWCE.DE', currency: 'EUR' }, brokerId: broker.id, date: '2024-04-01', quantity: 2, price: 110, fee: 0 });
      saveQuote(db, user.id, { symbol: 'AAPL', price: 190, currency: 'USD', asOf: '2024-06-01T00:00:00Z', provider: 'yahoo' });
      expect(await auth.verifyLogin(db, 'MARIA', 'parola-maria')).toMatchObject({ id: user.id });
      return {
        overview: getOverview(db, user.id),
        all: listTransactions(db, user.id).map(({ id: _i, ...t }) => t),
        stocks: listTransactions(db, user.id, { assetType: 'stock' }).length,
        etfs: listTransactions(db, user.id, { assetType: 'etf', type: 'buy' }).length
      };
    };
    const web = await run(openSqlJs(SQL).db);
    const desktop = await run(openDatabase(':memory:'));
    expect(stable(web)).toEqual(stable(desktop));
    expect((web as { stocks: number }).stocks).toBe(1);
  });

  it('contul demo (portofolii, dividende, jurnal, obiective) dă aceeași evaluare', async () => {
    const web = openSqlJs(SQL).db;
    const desktop = openDatabase(':memory:');
    const [w, d] = await Promise.all([ensureDemoAccount(web), ensureDemoAccount(desktop)]);
    const ow = getOverview(web, w.id);
    expect(ow.positions.length).toBeGreaterThan(3);
    expect(stable(ow)).toEqual(stable(getOverview(desktop, d.id)));
  });

  it('cheile API: criptate cu o cutie sincronă, citite înapoi', async () => {
    const { db } = openSqlJs(SQL);
    const user = await auth.register(db, { username: 'ana', password: 'parola-ana-1' });
    const box = createAesBox(Buffer.alloc(32, 7));
    updateSettings(db, user.id, { baseCurrency: 'RON' });
    setApiKey(db, box, user.id, 'polygon', '  secret-123 ');
    expect(getApiKey(db, box, user.id, 'polygon')).toBe('secret-123');
    expect(getSettings(db, user.id).apiKeys.polygon.configured).toBe(true);
  });
});
