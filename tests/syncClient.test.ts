/**
 * Sincronizarea contului între dispozitive (partea din aplicație), cu un server fals în memorie care
 * respectă contractul /sync/*: derivarea cheilor, criptarea, pachetul fără cache-uri, amprenta datelor
 * și fluxurile din backend (login pe dispozitiv nou, trimitere, descărcare, conflict, parolă, demo, offline).
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, ipcMain: {}, Notification: class {}, shell: {} }));

import type { AppEvent } from '@shared/api';
import type { SyncStatus } from '@shared/sync';
import { desktopDeviceLabel, webDeviceLabel } from '@shared/sync';
import { openDatabase, type Db } from '@main/db/database';
import { createAesBox, type SecretBox } from '@main/secrets';
import { createBackend, type Backend, type Platform } from '@main/ipc';
import * as auth from '@main/services/auth';
import { createBackup, restoreBackup } from '@main/services/backup';
import { createBroker } from '@main/services/brokers';
import { addPurchase } from '@main/services/transactions';
import { setLastPriceUpdate } from '@main/services/settings';
import { saveHistory, saveQuote } from '@main/prices/store';
import { decryptSnapshot, deriveSyncKeys, encryptSnapshot, syncAuthHeader } from '@main/services/syncCrypto';
import { dataHash } from '@main/services/syncData';

const tmp = mkdtempSync(join(tmpdir(), 'pb-sync-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Prețurile nu au voie să plece în rețea în teste.
beforeAll(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fără rețea în teste')));
});
afterAll(() => vi.unstubAllGlobals());

// --- serverul fals ---------------------------------------------------------

interface Account {
  auth: string;
  version: number;
  updatedAt: number | null;
  device: string | null;
  data: string | null;
}

function fakeServer() {
  const accounts = new Map<string, Account>();
  const s = {
    accounts,
    online: true,
    requests: 0,
    lockedFor: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (!s.online) throw new TypeError('fetch failed');
      s.requests++;
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? 'GET';
      const reply = (status: number, body?: unknown): Response =>
        body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
      if (s.lockedFor) return reply(429, { error: 'locked', retryAfter: s.lockedFor });
      if (url.pathname === '/sync/register' && method === 'POST') {
        const name = String(body.username ?? '').toLowerCase();
        if (!/^[a-z0-9._-]{3,32}$/.test(name) || !/^[0-9a-f]{64}$/.test(String(body.authKey))) return reply(400, { error: 'invalid' });
        if (accounts.has(name)) return reply(409, { error: 'taken' });
        accounts.set(name, { auth: String(body.authKey), version: 0, updatedAt: null, device: null, data: null });
        return reply(201, {});
      }
      const header = new Headers(init?.headers).get('authorization') ?? '';
      const [name, key] = Buffer.from(header.replace(/^Sync /, ''), 'base64').toString('utf8').split(':');
      const acct = accounts.get(name);
      if (!acct || acct.auth !== key) return reply(401, { error: 'auth' });
      const head = { version: acct.version, updatedAt: acct.updatedAt, device: acct.device };
      if (url.pathname === '/sync/head' && method === 'GET') return reply(200, head);
      if (url.pathname === '/sync/snapshot' && method === 'GET') return acct.data ? reply(200, { ...head, data: acct.data }) : reply(204);
      if ((url.pathname === '/sync/snapshot' && method === 'PUT') || (url.pathname === '/sync/password' && method === 'POST')) {
        if (body.baseVersion !== acct.version) return reply(409, { error: 'conflict', ...head });
        if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data) || body.data.length % 4 !== 0) return reply(400, { error: 'invalid' });
        if (url.pathname === '/sync/password') acct.auth = String(body.newAuthKey);
        acct.version++;
        acct.updatedAt = Date.now();
        acct.device = String(body.device).slice(0, 64);
        acct.data = body.data;
        return reply(200, { version: acct.version, updatedAt: acct.updatedAt });
      }
      return reply(404, { error: 'not_found' });
    }) as typeof fetch
  };
  return s;
}

type Server = ReturnType<typeof fakeServer>;

// --- un „dispozitiv”: baza lui, backendul și evenimentele primite ------------------

function testPlatform(): Platform {
  let token: string | null = null;
  return {
    saveFile: async () => null,
    savePdf: async () => null,
    openFile: async () => null,
    notify() {},
    openExternal: async () => {},
    readToken: () => token,
    writeToken: (t) => {
      token = t;
    },
    createBackup(db, userId, options) {
      const file = join(tmp, `b-${randomBytes(6).toString('hex')}.db`);
      const { transactions } = createBackup(db, userId, file, options);
      const data = readFileSync(file);
      rmSync(file, { force: true });
      return { data, transactions };
    },
    restoreBackup(db, userId, data, options) {
      const file = join(tmp, `r-${randomBytes(6).toString('hex')}.db`);
      writeFileSync(file, data);
      try {
        return restoreBackup(db, userId, file, options);
      } finally {
        rmSync(file, { force: true });
      }
    },
    info: () => ({ version: 'test', platform: 'test', dataPath: '' })
  };
}

const devices: Backend[] = [];
afterEach(() => {
  for (const b of devices.splice(0)) b.dispose();
});

/** `shared` = aceeași bază, aceleași secrete și același token: aplicația repornită pe același dispozitiv. */
function device(server: Server, name: string, shared?: { db: Db; secrets: SecretBox; platform: Platform }) {
  const db = shared?.db ?? openDatabase(':memory:');
  const secrets = shared?.secrets ?? createAesBox(randomBytes(32));
  const platform = shared?.platform ?? testPlatform();
  const events: AppEvent[] = [];
  const backend = createBackend({
    db,
    secrets,
    platform,
    send: (e) => events.push(e),
    sync: { url: 'https://sync.test', device: name, fetch: server.fetch, intervalMs: 3_600_000, debounceMs: 20 }
  });
  devices.push(backend);
  const call = async <T = unknown>(path: string, ...args: unknown[]): Promise<T> => {
    const res = await backend.dispatch(path, args);
    if (!res.ok) throw new Error(res.error);
    return res.data as T;
  };
  return {
    db,
    shared: { db, secrets, platform },
    backend,
    events,
    call,
    sync: () => call<SyncStatus>('sync.now'),
    userId: async () => (await call<{ id: number }>('auth.current')).id,
    brokers: async () => (await call<{ name: string }[]>('brokers.list')).map((b) => b.name).sort()
  };
}

const PASSWORD = 'parola-sigura-1';

// --- criptografia ------------------------------------------------------------

describe('cheile și criptarea', () => {
  it('derivarea este deterministă și se împarte în authKey (hex) + encKey', async () => {
    const a = await deriveSyncKeys('  Ana.Pop ', PASSWORD);
    const b = await deriveSyncKeys('ana.pop', PASSWORD);
    expect(a.uname).toBe('ana.pop');
    expect(a.authKey).toBe(b.authKey);
    expect(Buffer.from(a.encKey).equals(Buffer.from(b.encKey))).toBe(true);
    expect(a.authKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.encKey.length).toBe(32);
    // Exact ca în contract: PBKDF2-SHA256, 310000 iterații, 512 biți, sarea „portofoliu-bursa-sync:v1:<uname>”.
    const bits = pbkdf2Sync(PASSWORD, 'portofoliu-bursa-sync:v1:ana.pop', 310_000, 64, 'sha256');
    expect(a.authKey).toBe(bits.subarray(0, 32).toString('hex'));
    expect(Buffer.from(a.encKey).equals(bits.subarray(32))).toBe(true);
    expect((await deriveSyncKeys('ana.pop', PASSWORD + 'x')).authKey).not.toBe(a.authKey);
    expect(syncAuthHeader(a)).toBe('Sync ' + Buffer.from(`ana.pop:${a.authKey}`).toString('base64'));
  });

  it('criptare dus-întors; cheia greșită sau datele modificate sunt refuzate', async () => {
    const { encKey } = await deriveSyncKeys('ana', PASSWORD);
    const plain = new TextEncoder().encode('tranzacții '.repeat(5000));
    const blob = await encryptSnapshot(encKey, plain);
    expect(blob[0]).toBe(1);
    expect(blob.length).toBeLessThan(plain.length / 10); // comprimat înainte de criptare
    expect(Buffer.from(await decryptSnapshot(encKey, blob)).equals(Buffer.from(plain))).toBe(true);
    // IV aleator: două criptări ale acelorași date diferă.
    expect(Buffer.from(await encryptSnapshot(encKey, plain)).equals(Buffer.from(blob))).toBe(false);
    const other = await deriveSyncKeys('ana', 'alta-parola-1');
    await expect(decryptSnapshot(other.encKey, blob)).rejects.toThrow();
    const tampered = blob.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptSnapshot(encKey, tampered)).rejects.toThrow();
  });

  it('numele dispozitivului', () => {
    expect(desktopDeviceLabel('win32')).toBe('Windows · calculator');
    expect(desktopDeviceLabel('darwin')).toBe('Mac · calculator');
    expect(webDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone');
    expect(webDeviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('Android');
    expect(webDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Browser');
  });
});

// --- pachetul și amprenta -------------------------------------------------------

async function userWithData(db: Db, username = 'ana') {
  const user = await auth.register(db, { username, password: PASSWORD });
  const broker = createBroker(db, user.id, { name: 'XTB' });
  addPurchase(db, user.id, { asset: { type: 'stock', symbol: 'SNP.RO', currency: 'RON' }, brokerId: broker.id, date: '2024-01-02', quantity: 10, price: 50, fee: 0 });
  return user;
}

/** Ce scrie aplicația singură la o actualizare de prețuri (și la evaluarea alertelor). */
function simulatePriceRefresh(db: Db, userId: number): void {
  saveQuote(db, userId, { symbol: 'SNP.RO', price: 61, currency: 'RON', asOf: new Date().toISOString(), provider: 'yahoo' });
  saveHistory(db, userId, 'SNP.RO', [{ date: '2024-01-03', close: 51 }], true, 'yahoo');
  setLastPriceUpdate(db, userId, new Date().toISOString());
  db.prepare("UPDATE assets SET sector = 'Energie', country = 'RO', profile_source = 'api', profile_fetched_at = ? WHERE user_id = ?").run(new Date().toISOString(), userId);
  db.prepare("INSERT INTO dividend_events (user_id, symbol, ex_date, amount, source) VALUES (?, 'SNP.RO', '2024-06-01', '0.03', 'yahoo')").run(userId);
  db.prepare("INSERT INTO fx_official (user_id, currency, date, rate) VALUES (?, 'EUR', '2024-01-02', '4.97')").run(userId);
}

describe('pachetul de sincronizare și amprenta datelor', () => {
  it('pachetul nu conține cache-urile (prețuri, istoric, cursuri, dividende de la provideri), dar păstrează datele introduse', async () => {
    const db = openDatabase(':memory:');
    const user = await userWithData(db);
    simulatePriceRefresh(db, user.id);
    db.prepare("INSERT INTO dividend_events (user_id, symbol, ex_date, amount, source) VALUES (?, 'SNP.RO', '2024-07-01', '0.05', 'manual')").run(user.id);
    const count = (file: string, table: string, where = ''): number => {
      const d = new Database(file, { readonly: true });
      try {
        return (d.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
      } finally {
        d.close();
      }
    };
    const full = join(tmp, 'full.db');
    const lean = join(tmp, 'lean.db');
    createBackup(db, user.id, full);
    createBackup(db, user.id, lean, { sync: true });
    for (const table of ['prices', 'price_history', 'fx_official']) {
      expect(count(full, table)).toBeGreaterThan(0);
      expect(count(lean, table)).toBe(0);
    }
    expect(count(full, 'dividend_events')).toBe(2);
    expect(count(lean, 'dividend_events')).toBe(1);
    expect(count(lean, 'transactions')).toBe(1);
    expect(count(lean, 'sync_state')).toBe(0);

    // Restaurarea din sincronizare păstrează cache-urile locale ale dispozitivului.
    const other = openDatabase(':memory:');
    const u2 = await auth.register(other, { username: 'ana', password: PASSWORD });
    saveQuote(other, u2.id, { symbol: 'SNP.RO', price: 70, currency: 'RON', asOf: '2024-02-01T00:00:00Z', provider: 'yahoo' });
    expect(restoreBackup(other, u2.id, lean, { sync: true }).transactions).toBe(1);
    expect((other.prepare('SELECT price FROM prices WHERE user_id = ?').get(u2.id) as { price: number }).price).toBe(70);
  });

  it('actualizarea automată a prețurilor nu schimbă amprenta; o modificare a utilizatorului o schimbă', async () => {
    const db = openDatabase(':memory:');
    const user = await userWithData(db);
    db.prepare("INSERT INTO alerts (user_id, kind, condition, repeat_mode) VALUES (?, 'price', '{\"kind\":\"price\"}', 'once')").run(user.id);
    const before = dataHash(db, user.id);
    simulatePriceRefresh(db, user.id);
    // Alerta „o dată” a sunat: starea internă, contorul și oprirea automată nu contează.
    db.prepare("UPDATE alerts SET state = '{\"x\":1}', last_triggered_at = 'acum', trigger_count = 1, enabled = 0 WHERE user_id = ?").run(user.id);
    db.prepare("INSERT INTO alert_events (user_id, kind, title, created_at) VALUES (?, 'price', 'SNP.RO', 'acum')").run(user.id);
    db.prepare("UPDATE settings SET active_portfolio = 'all' WHERE user_id = ?").run(user.id);
    expect(dataHash(db, user.id)).toBe(before);

    db.prepare("UPDATE brokers SET notes = 'cont principal' WHERE user_id = ?").run(user.id);
    expect(dataHash(db, user.id)).not.toBe(before);
  });
});

// --- fluxurile din backend --------------------------------------------------------

describe('sincronizarea între dispozitive', () => {
  it('login pe un dispozitiv nou: contul se creează local cu aceeași parolă și primește datele', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'Ana', password: PASSWORD });
    await pc.call('brokers.create', { name: 'XTB' });
    expect((await pc.sync()).state).toBe('ok');
    expect(server.accounts.get('ana')?.version).toBeGreaterThanOrEqual(1);
    // Serverul nu vede datele în clar.
    expect(Buffer.from(server.accounts.get('ana')!.data!, 'base64').toString('latin1')).not.toContain('XTB');

    const phone = device(server, 'iPhone');
    await expect(phone.call('auth.login', { username: 'ana', password: 'parola-gresita', remember: false })).rejects.toThrow(/^Nume de utilizator sau parolă incorectă\.$/);
    await expect(phone.call('auth.login', { username: 'necunoscut', password: PASSWORD, remember: false })).rejects.toThrow(/^Nume de utilizator sau parolă incorectă\.$/);
    expect(phone.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });

    const user = await phone.call<{ username: string }>('auth.login', { username: 'ana', password: PASSWORD, remember: true });
    expect(user.username).toBe('ana');
    expect(await phone.brokers()).toEqual(['XTB']);
    const status = await phone.sync();
    expect(status.state).toBe('ok');
    expect(status.device).toBe('Windows · calculator');
    // Data viitoare parola se verifică local.
    await phone.call('auth.logout');
    await phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    expect(await phone.brokers()).toEqual(['XTB']);
  });

  it('fără internet, login-ul pe un dispozitiv nou spune că nu s-a putut verifica online', async () => {
    const server = fakeServer();
    server.online = false;
    const phone = device(server, 'iPhone');
    await expect(phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false })).rejects.toThrow(
      'Nume de utilizator sau parolă incorectă. (nu s-a putut verifica online)'
    );
  });

  it('o modificare locală se trimite singură; cealaltă parte o descarcă', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.sync();
    const phone = device(server, 'iPhone');
    await phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    await phone.sync();
    const v0 = server.accounts.get('ana')!.version;

    // Trimiterea automată, la scurt timp după modificare (fără „Sincronizează acum”).
    await pc.call('brokers.create', { name: 'Tradeville' });
    await vi.waitFor(() => expect(server.accounts.get('ana')!.version).toBe(v0 + 1), { timeout: 3000 });

    pc.events.length = 0;
    phone.events.length = 0;
    await phone.sync();
    expect(await phone.brokers()).toEqual(['Tradeville']);
    expect(phone.events.some((e) => e.type === 'data:changed')).toBe(true);
    // Fără schimbări locale nu se trimite nimic.
    await phone.sync();
    await pc.sync();
    expect(server.accounts.get('ana')!.version).toBe(v0 + 1);
  });

  it('prețurile actualizate nu pornesc o trimitere', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.call('brokers.create', { name: 'XTB' });
    await pc.sync();
    const version = server.accounts.get('ana')!.version;
    const id = await pc.userId();
    const broker = createBroker(pc.db, id, { name: 'BT Trade' });
    addPurchase(pc.db, id, { asset: { type: 'stock', symbol: 'TLV.RO', currency: 'RON' }, brokerId: broker.id, date: '2024-01-02', quantity: 1, price: 20, fee: 0 });
    await pc.sync();
    expect(server.accounts.get('ana')!.version).toBe(version + 1);
    simulatePriceRefresh(pc.db, id);
    await pc.sync();
    expect(server.accounts.get('ana')!.version).toBe(version + 1);
  });

  it('conflict: ambele dispozitive s-au schimbat; se poate păstra oricare variantă', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.sync();
    const phone = device(server, 'iPhone');
    await phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    await phone.sync();

    await pc.call('brokers.create', { name: 'De pe PC' });
    await phone.call('brokers.create', { name: 'De pe telefon' });
    expect((await pc.sync()).state).toBe('ok');
    const conflict = await phone.sync();
    expect(conflict.state).toBe('conflict');
    expect(conflict.device).toBe('Windows · calculator');
    expect(phone.events.some((e) => e.type === 'sync:status' && e.payload.state === 'conflict')).toBe(true);
    // Cât timp așteaptă alegerea, nu se trimite și nu se descarcă nimic.
    await phone.sync();
    expect(await phone.brokers()).toEqual(['De pe telefon']);

    // „Datele de pe Windows · calculator”: telefonul primește datele PC-ului.
    expect((await phone.call<SyncStatus>('sync.resolve', 'remote')).state).toBe('ok');
    expect(await phone.brokers()).toEqual(['De pe PC']);

    // Din nou conflict; de data asta „Datele de pe acest dispozitiv” (telefonul).
    await pc.call('brokers.create', { name: 'PC 2' });
    await phone.call('brokers.create', { name: 'Telefon 2' });
    await pc.sync();
    expect((await phone.sync()).state).toBe('conflict');
    expect((await phone.call<SyncStatus>('sync.resolve', 'local')).state).toBe('ok');
    expect((await pc.sync()).state).toBe('ok');
    expect(await pc.brokers()).toEqual(['De pe PC', 'Telefon 2']);
  });

  it('la prima legare, un cont local gol primește datele, iar unul cu date întreabă', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.call('brokers.create', { name: 'XTB' });
    await pc.sync();

    // Pe telefon există deja un cont local „ana” (creat înainte de sincronizare), gol.
    const phone = device(server, 'iPhone');
    await auth.register(phone.db, { username: 'ana', password: PASSWORD });
    await phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    expect((await phone.sync()).state).toBe('ok');
    expect(await phone.brokers()).toEqual(['XTB']);

    // Pe tabletă, contul local are deja date: utilizatorul alege.
    const tablet = device(server, 'Android');
    const local = await auth.register(tablet.db, { username: 'ana', password: PASSWORD });
    createBroker(tablet.db, local.id, { name: 'Local' });
    await tablet.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    expect((await tablet.sync()).state).toBe('conflict');
  });

  it('schimbarea parolei recriptează datele; celelalte dispozitive intră cu parola nouă', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.call('brokers.create', { name: 'XTB' });
    await pc.sync();
    const phone = device(server, 'iPhone');
    await phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    await phone.sync();

    const oldKeys = await deriveSyncKeys('ana', PASSWORD);
    const newKeys = await deriveSyncKeys('ana', 'parola-noua-22');
    await pc.call('auth.changePassword', PASSWORD, 'parola-noua-22');
    const acct = server.accounts.get('ana')!;
    expect(acct.auth).toBe(newKeys.authKey);
    // Pachetul de pe server se deschide doar cu cheia nouă.
    const blob = Buffer.from(acct.data!, 'base64');
    await expect(decryptSnapshot(oldKeys.encKey, blob)).rejects.toThrow();
    expect((await decryptSnapshot(newKeys.encKey, blob)).length).toBeGreaterThan(0);
    expect((await pc.sync()).state).toBe('ok');

    // Telefonul (încă cu parola veche) află că parola s-a schimbat și nu mai reîncearcă singur.
    const st = await phone.sync();
    expect(st.state).toBe('error');
    expect(st.message).toMatch(/Parola a fost schimbată pe celălalt dispozitiv/);
    // Pe telefon se intră cu parola nouă (confirmată de server); cea veche nu mai merge nici local.
    await phone.call('auth.logout');
    await phone.call('auth.login', { username: 'ana', password: 'parola-noua-22', remember: false });
    expect((await phone.sync()).state).toBe('ok');
    await phone.call('auth.logout');
    await expect(phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false })).rejects.toThrow(/incorectă/);

    // Un dispozitiv nou intră doar cu parola nouă.
    const tablet = device(server, 'Android');
    await tablet.call('auth.login', { username: 'ana', password: 'parola-noua-22', remember: false });
    expect(await tablet.brokers()).toEqual(['XTB']);
  });

  it('fără internet, parola nu se schimbă (ar rămâne diferită pe celălalt dispozitiv)', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.sync();
    server.online = false;
    await expect(pc.call('auth.changePassword', PASSWORD, 'parola-noua-22')).rejects.toThrow(/nevoie de internet/);
    await pc.call('auth.logout');
    await pc.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
  });

  it('contul demo nu se sincronizează niciodată', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.loginDemo');
    await pc.call('brokers.create', { name: 'Demo nou' });
    const st = await pc.sync();
    expect(st.state).toBe('off');
    expect(server.requests).toBe(0);
    expect(server.accounts.size).toBe(0);
  });

  it('offline: contul nou se creează local și se înregistrează online când revine internetul', async () => {
    const server = fakeServer();
    server.online = false;
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.call('brokers.create', { name: 'XTB' });
    expect((await pc.sync()).state).toBe('offline');
    expect(server.accounts.size).toBe(0);

    server.online = true;
    expect((await pc.sync()).state).toBe('ok');
    expect(server.accounts.get('ana')?.version).toBe(1);
    const phone = device(server, 'iPhone');
    await phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    expect(await phone.brokers()).toEqual(['XTB']);
  });

  it('un nume luat online: înregistrarea e refuzată; un cont local vechi cu același nume rămâne local', async () => {
    const server = fakeServer();
    const other = device(server, 'iPhone');
    await other.call('auth.register', { username: 'bob', password: 'parola-lui-bob' });
    await other.sync();

    const pc = device(server, 'Windows · calculator');
    await expect(pc.call('auth.register', { username: 'Bob', password: PASSWORD })).rejects.toThrow(
      'Numele este folosit deja. Dacă e contul tău de pe alt dispozitiv, folosește Autentificare.'
    );
    expect(pc.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });

    // Un cont local creat înainte de sincronizare, cu alt proprietar online.
    await auth.register(pc.db, { username: 'bob', password: PASSWORD });
    await pc.call('auth.login', { username: 'bob', password: PASSWORD, remember: false });
    await pc.call('brokers.create', { name: 'Al meu' });
    expect((await pc.sync()).state).toBe('name_taken');
    expect(await pc.brokers()).toEqual(['Al meu']);
    // Nu reîncearcă singur (fiecare încercare ar număra ca parolă greșită pe contul celuilalt).
    const before = server.requests;
    await pc.call('settings.get');
    await pc.call('brokers.create', { name: 'Încă unul' });
    await new Promise((r) => setTimeout(r, 80));
    expect(server.requests).toBe(before);
  });

  it('blocarea după prea multe încercări: mesaj cu minutele și fără reîncercări până expiră', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.sync();
    server.lockedFor = 900;
    await pc.call('brokers.create', { name: 'XTB' });
    const st = await pc.sync();
    expect(st.state).toBe('error');
    expect(st.message).toBe('Prea multe încercări, încearcă peste 15 minute.');
    const before = server.requests;
    await pc.sync();
    expect(server.requests).toBe(before);

    const phone = device(server, 'iPhone');
    await expect(phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false })).rejects.toThrow('Prea multe încercări, încearcă peste 15 minute.');
  });

  it('„ține-mă minte”: sesiunea reluată se sincronizează cu cheile salvate', async () => {
    const server = fakeServer();
    const pc = device(server, 'Windows · calculator');
    await pc.call('auth.register', { username: 'ana', password: PASSWORD });
    await pc.sync();
    await pc.call('auth.logout');
    await pc.call('auth.login', { username: 'ana', password: PASSWORD, remember: true });
    await pc.sync();
    pc.backend.dispose(); // aplicația se închide

    const phone = device(server, 'iPhone');
    await phone.call('auth.login', { username: 'ana', password: PASSWORD, remember: false });
    await phone.call('brokers.create', { name: 'De pe telefon' });
    await phone.sync();

    // Repornirea pe calculator: sesiunea se reia fără parolă, iar sincronizarea folosește cheile salvate (criptat).
    const restarted = device(server, 'Windows · calculator', pc.shared);
    expect(await restarted.call<{ username: string } | null>('auth.current')).toMatchObject({ username: 'ana' });
    expect((await restarted.sync()).state).toBe('ok');
    expect(await restarted.brokers()).toEqual(['De pe telefon']);
    const stored = String((pc.db.prepare('SELECT creds FROM sync_state').get() as { creds: string }).creds);
    expect(stored).not.toContain((await deriveSyncKeys('ana', PASSWORD)).authKey);
  });
});
