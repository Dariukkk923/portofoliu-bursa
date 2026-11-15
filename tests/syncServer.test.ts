/**
 * Sincronizarea conturilor din proxy (proxy/src/index.js, /sync/*). Baza D1 este imitată cu sql.js, cu tabelele
 * reale din proxy/schema.sql și limita D1 de ~2 MB pe valoare, ca să se vadă că serverul taie copiile în bucăți.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://dariukkk923.github.io';
const D1_MAX_VALUE = 2_000_000;

type Result = { results: Record<string, unknown>[]; success: true; meta: { changes: number } };

/** Partea din API-ul D1 folosită de worker: prepare().bind().first()/all()/run() și batch() (tranzacție). */
class FakeStmt {
  constructor(
    private readonly d1: FakeD1,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}
  bind(...params: unknown[]): FakeStmt {
    return new FakeStmt(this.d1, this.sql, params);
  }
  exec(): Result {
    for (const p of this.params) {
      if (p === undefined) throw new Error('D1_TYPE_ERROR: undefined');
      if (typeof p === 'string' && Buffer.byteLength(p) > D1_MAX_VALUE) throw new Error('D1: valoare prea mare');
    }
    const st = this.d1.db.prepare(this.sql);
    try {
      st.bind(this.params as never);
      const results: Record<string, unknown>[] = [];
      while (st.step()) results.push(st.getAsObject() as Record<string, unknown>);
      return { results, success: true, meta: { changes: this.d1.db.getRowsModified() } };
    } finally {
      st.free();
    }
  }
  async first(): Promise<Record<string, unknown> | null> {
    return this.exec().results[0] ?? null;
  }
  async all(): Promise<Result> {
    return this.exec();
  }
  async run(): Promise<Result> {
    return this.exec();
  }
}

class FakeD1 {
  constructor(readonly db: Database) {}
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
  async batch(stmts: FakeStmt[]): Promise<Result[]> {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.exec());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

let SQL: SqlJsStatic;
let d1: FakeD1;
let env: { ALLOWED_ORIGIN: string; SYNC_DB: FakeD1 };
const schema = readFileSync(new URL('../proxy/schema.sql', import.meta.url), 'utf8');

beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(() => {
  const db = new SQL.Database();
  db.exec(schema);
  d1 = new FakeD1(db);
  env = { ALLOWED_ORIGIN: ORIGIN, SYNC_DB: d1 };
});
afterEach(() => {
  vi.useRealTimers();
});

async function worker(): Promise<{ fetch(req: Request, env: unknown): Promise<Response> }> {
  const path = '../proxy/src/index.js';
  return (await import(/* @vite-ignore */ path)).default;
}

const key = (seed: string): string => seed.repeat(64).slice(0, 64);
const authHeader = (user: string, authKey: string): string => `Sync ${Buffer.from(`${user}:${authKey}`, 'utf8').toString('base64')}`;

interface CallOpts {
  method?: string;
  body?: unknown;
  auth?: [string, string];
  origin?: string | null;
  headers?: Record<string, string>;
}
async function call(path: string, opts: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.auth) headers.authorization = authHeader(...opts.auth);
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return (await worker()).fetch(new Request(`https://proxy.example/${path}`, init), env);
}
const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

const register = (username: string, authKey: string): Promise<Response> => call('sync/register', { method: 'POST', body: { username, authKey } });
const put = (auth: [string, string], baseVersion: number, data: string, device = 'Windows · PC'): Promise<Response> =>
  call('sync/snapshot', { method: 'PUT', auth, body: { baseVersion, device, data } });

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('sincronizare: cont', () => {
  it('înregistrare: 201, nume luat → 409, date invalide → 400; numele se păstrează cu litere mici', async () => {
    const res = await register('  Ana.Pop ', key('a'));
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({});
    expect(res.headers.get('cache-control')).toBe('no-store');
    const taken = await register('ana.pop', key('b'));
    expect(taken.status).toBe(409);
    expect(await json(taken)).toEqual({ error: 'taken' });
    for (const body of [
      { username: 'ab', authKey: key('a') },
      { username: 'x'.repeat(33), authKey: key('a') },
      { username: 'ana pop', authKey: key('a') },
      { username: 'ana:pop', authKey: key('a') },
      { username: 'ana', authKey: 'z'.repeat(64) },
      { username: 'ana', authKey: key('a').slice(1) },
      { username: 'ana' }
    ]) {
      const r = await call('sync/register', { method: 'POST', body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await json(r)).toEqual({ error: 'invalid' });
    }
    expect((await call('sync/register', { method: 'POST', body: '{nu e json' })).status).toBe(400);
    // Serverul nu păstrează cheia, doar sha256 al ei.
    const row = d1.db.exec("SELECT username, key_hash FROM sync_users")[0].values[0];
    expect(row[0]).toBe('ana.pop');
    expect(row[1]).not.toBe(key('a'));
    expect(row[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('autentificare greșită sau utilizator necunoscut → 401 {error:"auth"}', async () => {
    await register('ana', key('a'));
    for (const auth of [['ana', key('b')], ['nimeni', key('a')]] as [string, string][]) {
      const r = await call('sync/head', { auth });
      expect(r.status).toBe(401);
      expect(await json(r)).toEqual({ error: 'auth' });
    }
    expect((await call('sync/head')).status).toBe(401);
    expect((await call('sync/head', { headers: { authorization: 'Sync ###' } })).status).toBe(401);
    expect((await call('sync/head', { headers: { authorization: 'Basic abc' } })).status).toBe(401);
    // Numele din antet se normalizează la fel ca la înregistrare.
    expect((await call('sync/head', { auth: ['ANA', key('a')] })).status).toBe(200);
  });

  it('blocare după 10 greșeli la rând (429, 15 minute); o reușită golește contorul', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    await register('ana', key('a'));
    const bad = (): Promise<Response> => call('sync/head', { auth: ['ana', key('b')] });
    const good = (): Promise<Response> => call('sync/head', { auth: ['ana', key('a')] });

    for (let i = 0; i < 9; i++) expect((await bad()).status).toBe(401);
    expect((await good()).status).toBe(200); // golește contorul
    for (let i = 0; i < 9; i++) expect((await bad()).status).toBe(401);
    expect((await good()).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await bad()).status).toBe(401);

    const locked = await good();
    expect(locked.status).toBe(429);
    expect(await json(locked)).toEqual({ error: 'locked', retryAfter: 900 });
    expect(locked.headers.get('retry-after')).toBe('900');
    expect((await bad()).status).toBe(429);

    vi.setSystemTime(new Date('2026-11-15T10:14:00Z'));
    expect(await json(await good())).toEqual({ error: 'locked', retryAfter: 60 });
    vi.setSystemTime(new Date('2026-11-15T10:15:01Z'));
    expect((await good()).status).toBe(200);
    // După deblocare contorul pornește de la zero.
    for (let i = 0; i < 9; i++) expect((await bad()).status).toBe(401);
    expect((await good()).status).toBe(200);
  });

  it('ștergerea contului elimină contul și copia; numele devine liber', async () => {
    await register('ana', key('a'));
    expect((await put(['ana', key('a')], 0, b64(randomBytes(3_200_000)))).status).toBe(200);
    const del = await call('sync/account', { method: 'DELETE', auth: ['ana', key('a')] });
    expect(del.status).toBe(200);
    expect(await json(del)).toEqual({});
    expect((await call('sync/head', { auth: ['ana', key('a')] })).status).toBe(401);
    expect(d1.db.exec('SELECT COUNT(*) FROM sync_chunks')[0].values[0][0]).toBe(0);
    expect(d1.db.exec('SELECT COUNT(*) FROM sync_users')[0].values[0][0]).toBe(0);
    expect((await register('ana', key('c'))).status).toBe(201);
    expect((await call('sync/snapshot', { auth: ['ana', key('c')] })).status).toBe(204);
    expect((await call('sync/account', { method: 'DELETE', auth: ['ana', key('a')] })).status).toBe(401);
  });
});

describe('sincronizare: copia criptată', () => {
  const auth: [string, string] = ['ana', key('a')];
  beforeEach(async () => {
    await register('ana', key('a'));
  });

  it('head și snapshot înainte și după prima scriere; versiunea crește cu 1', async () => {
    expect(await json(await call('sync/head', { auth }))).toEqual({ version: 0, updatedAt: null, device: null });
    expect((await call('sync/snapshot', { auth })).status).toBe(204);

    const first = await put(auth, 0, 'AQIDBA==', 'iPhone · Safari');
    expect(first.status).toBe(200);
    const w1 = await json(first);
    expect(w1.version).toBe(1);
    expect(typeof w1.updatedAt).toBe('number');
    expect(await json(await call('sync/head', { auth }))).toEqual({ version: 1, updatedAt: w1.updatedAt, device: 'iPhone · Safari' });

    const snap = await call('sync/snapshot', { auth });
    expect(snap.status).toBe(200);
    expect(snap.headers.get('content-type')).toContain('application/json');
    expect(await json(snap)).toEqual({ version: 1, updatedAt: w1.updatedAt, device: 'iPhone · Safari', data: 'AQIDBA==' });

    const second = await json(await put(auth, 1, 'BQYH', 'x'.repeat(100)));
    expect(second.version).toBe(2);
    const s2 = await json(await call('sync/snapshot', { auth }));
    expect(s2).toMatchObject({ version: 2, data: 'BQYH', device: 'x'.repeat(64) });
    // Rămân doar bucățile copiei curente.
    expect(d1.db.exec('SELECT COUNT(*) FROM sync_chunks')[0].values[0][0]).toBe(1);
  });

  it('baseVersion vechi → 409 cu versiunea curentă; nimic nu se schimbă', async () => {
    const w1 = await json(await put(auth, 0, 'AAAA', 'PC'));
    const stale = await put(auth, 0, 'BBBB', 'Telefon');
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ error: 'conflict', version: 1, updatedAt: w1.updatedAt, device: 'PC' });
    expect((await put(auth, 5, 'BBBB')).status).toBe(409);
    expect(await json(await call('sync/snapshot', { auth }))).toMatchObject({ version: 1, data: 'AAAA' });
  });

  it('două scrieri simultane pe aceeași versiune: doar una câștigă, copia rămâne întreagă', async () => {
    const a = b64(randomBytes(2_500_000));
    const b = b64(randomBytes(2_500_000));
    const [ra, rb] = await Promise.all([put(auth, 0, a, 'A'), put(auth, 0, b, 'B')]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const snap = await json(await call('sync/snapshot', { auth }));
    expect(snap.version).toBe(1);
    expect(snap.data).toBe(ra.status === 200 ? a : b);
    expect(snap.device).toBe(ra.status === 200 ? 'A' : 'B');
    // Bucățile scrierii pierdute au fost șterse.
    expect(d1.db.exec('SELECT COUNT(DISTINCT gen) FROM sync_chunks')[0].values[0][0]).toBe(1);
  });

  it('compare-and-swap: altă scriere care termină chiar înainte de comutare face ca prima să primească 409', async () => {
    const batch = d1.batch.bind(d1);
    let raced = false;
    d1.batch = async (stmts) => {
      if (!raced) {
        raced = true;
        expect((await put(auth, 0, 'BBBB', 'B')).status).toBe(200); // câștigă cursa
      }
      return batch(stmts);
    };
    const lost = await put(auth, 0, b64(randomBytes(3_000_000)), 'A');
    expect(lost.status).toBe(409);
    expect(await json(lost)).toMatchObject({ error: 'conflict', version: 1, device: 'B' });
    expect(await json(await call('sync/snapshot', { auth }))).toMatchObject({ version: 1, data: 'BBBB', device: 'B' });
    expect(d1.db.exec('SELECT COUNT(*) FROM sync_chunks')[0].values[0][0]).toBe(1);
  });

  it('copie > 2 MB: se taie în bucăți sub limita D1 și se citește înapoi identic', async () => {
    const bytes = randomBytes(5_000_001);
    const data = b64(bytes);
    const res = await put(auth, 0, data);
    expect(res.status).toBe(200);
    const parts = d1.db.exec('SELECT idx, length(data) FROM sync_chunks ORDER BY idx')[0].values;
    expect(parts.length).toBeGreaterThan(3);
    for (const [, len] of parts) expect(len as number).toBeLessThanOrEqual(D1_MAX_VALUE);
    const snap = await json(await call('sync/snapshot', { auth }));
    expect(Buffer.from(snap.data as string, 'base64').equals(bytes)).toBe(true);

    // O copie mai mică după una mare: bucățile vechi dispar.
    expect((await put(auth, 1, 'AAAA')).status).toBe(200);
    expect(d1.db.exec('SELECT COUNT(*) FROM sync_chunks')[0].values[0][0]).toBe(1);
  });

  it('peste 20 MB → 413 {error:"too_large"}; base64 stricat → 400', async () => {
    const limit = 20 * 1024 * 1024;
    const over = 'A'.repeat(((limit + 1) / 3) * 4); // limit + 1 octeți
    const big = await put(auth, 0, over);
    expect(big.status).toBe(413);
    expect(await json(big)).toEqual({ error: 'too_large' });
    expect((await call('sync/snapshot', { method: 'PUT', auth, body: '{}', headers: { 'content-length': String(40 * 1024 * 1024) } })).status).toBe(413);
    expect((await put(auth, 0, 'A'.repeat(((limit - 2) / 3) * 4) + 'AA==')).status).toBe(200); // exact limita

    for (const data of ['', 'abc', 'ab$=', '====', 'AA=A']) expect((await put(auth, 1, data)).status, data).toBe(400);
    expect((await call('sync/snapshot', { method: 'PUT', auth, body: { device: 'x', data: 'AAAA' } })).status).toBe(400);
    expect((await call('sync/snapshot', { method: 'PUT', auth, body: '[' })).status).toBe(400);
  });

  it('schimbarea parolei: cheia veche nu mai merge, cea nouă da, copia este înlocuită', async () => {
    await put(auth, 0, 'AAAA');
    const newKey = key('c');
    const stale = await call('sync/password', { method: 'POST', auth, body: { newAuthKey: newKey, baseVersion: 0, device: 'PC', data: 'CCCC' } });
    expect(stale.status).toBe(409);
    expect((await call('sync/password', { method: 'POST', auth, body: { newAuthKey: 'xyz', baseVersion: 1, device: 'PC', data: 'CCCC' } })).status).toBe(400);
    expect((await call('sync/head', { auth })).status).toBe(200); // nimic schimbat

    const res = await call('sync/password', { method: 'POST', auth, body: { newAuthKey: newKey, baseVersion: 1, device: 'PC', data: 'CCCC' } });
    expect(res.status).toBe(200);
    expect((await json(res)).version).toBe(2);
    expect((await call('sync/head', { auth })).status).toBe(401);
    expect(await json(await call('sync/snapshot', { auth: ['ana', newKey] }))).toMatchObject({ version: 2, data: 'CCCC', device: 'PC' });
  });

  it('rute necunoscute → 404 JSON; fără SYNC_DB → 503', async () => {
    expect((await call('sync/altceva', { auth })).status).toBe(404);
    expect((await call('sync/head', { method: 'POST', auth })).status).toBe(404);
    const none = await (await worker()).fetch(new Request('https://p.example/sync/head'), { ALLOWED_ORIGIN: ORIGIN });
    expect(none.status).toBe(503);
  });
});

describe('sincronizare: origini și CORS', () => {
  it('preflight din aplicație: 204 cu PUT/POST/DELETE și antetele authorization, content-type', async () => {
    const res = await call('sync/snapshot', {
      method: 'OPTIONS',
      origin: ORIGIN,
      headers: { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-type' }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const methods = res.headers.get('access-control-allow-methods') ?? '';
    for (const m of ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS']) expect(methods).toContain(m);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/content-type/);
  });

  it('cererile din aplicație primesc antete CORS; cele fără Origin (desktop) merg fără CORS', async () => {
    const fromApp = await call('sync/register', { method: 'POST', origin: ORIGIN, body: { username: 'web', authKey: key('a') } });
    expect(fromApp.status).toBe(201);
    expect(fromApp.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const desktop = await call('sync/register', { method: 'POST', body: { username: 'desktop', authKey: key('a') } });
    expect(desktop.status).toBe(201);
    expect(desktop.headers.get('access-control-allow-origin')).toBeNull();
    expect(desktop.headers.get('cache-control')).toBe('no-store');
  });

  it('altă origine → 403 și nu atinge baza; rutele de prețuri rămân doar pentru aplicație', async () => {
    const evil = await call('sync/register', { method: 'POST', origin: 'https://alt-site.ro', body: { username: 'rau', authKey: key('a') } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect((await call('sync/snapshot', { method: 'OPTIONS', origin: 'https://alt-site.ro' })).status).toBe(403);
    expect(d1.db.exec('SELECT COUNT(*) FROM sync_users')[0].values[0][0]).toBe(0);
    // Fără Origin: /sync merge, dar prețurile tot 403.
    expect((await call('yahoo/search?q=apple')).status).toBe(403);
  });

  it('nu loghează nimic', async () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    await register('ana', key('a'));
    await put(['ana', key('a')], 0, 'AAAA');
    await call('sync/head', { auth: ['ana', key('b')] });
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
