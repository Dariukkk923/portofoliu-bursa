/**
 * Cheile API pe web: AES-GCM prin Web Crypto cu cheie derivată din parolă (PBKDF2), prin cutia sincronă
 * pe care o cer serviciile, și fluxul de deblocare al platformei web.
 */
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import * as auth from '@main/services/auth';
import { getApiKey, setApiKey } from '@main/services/settings';
import { deriveKey, keyForPassword, openText, sealText, WebSecretBox } from '../src/web/keystore';
import { memoryKv } from '../src/web/kv';
import { createWebPlatform } from '../src/web/platform';
import { openSqlJs } from '../src/web/sqljs';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const salt = new Uint8Array(16).fill(3);

describe('AES-GCM prin Web Crypto', () => {
  it('criptează și decriptează; alt text, alt rezultat (IV aleator)', async () => {
    const key = await deriveKey('parola-mea', salt, 1000);
    const a = await sealText(key, 'cheie-api-123');
    const b = await sealText(key, 'cheie-api-123');
    expect(a).toMatch(/^wc1:/);
    expect(a).not.toContain('cheie-api-123');
    expect(a).not.toBe(b);
    expect(await openText(key, a)).toBe('cheie-api-123');
  });

  it('cu altă parolă, altă sare sau text modificat nu se poate decripta', async () => {
    const key = await deriveKey('parola-mea', salt, 1000);
    const stored = await sealText(key, 'secret');
    expect(await openText(await deriveKey('alta-parola', salt, 1000), stored)).toBeNull();
    expect(await openText(await deriveKey('parola-mea', new Uint8Array(16).fill(4), 1000), stored)).toBeNull();
    expect(await openText(key, stored.slice(0, -3) + 'AAA')).toBeNull();
    expect(await openText(key, 'aes1:altceva')).toBeNull();
  });
});

describe('cutia de secrete sincronă', () => {
  it('serviciile de setări o pot folosi (criptare pregătită dinainte, decriptare la deblocare)', async () => {
    const { db } = openSqlJs(SQL);
    const user = await auth.register(db, { username: 'dan', password: 'parola-dan-12' });
    const box = new WebSecretBox();
    const key = await deriveKey('parola-dan-12', salt, 1000);
    await box.unlock(key, []);

    expect(() => setApiKey(db, box, user.id, 'polygon', 'abc')).toThrow(/nu este deblocată/); // fără pregătire, nu se poate cripta sincron
    await box.prime('abc');
    setApiKey(db, box, user.id, 'polygon', 'abc');
    const stored = (db.prepare('SELECT encrypted_key FROM api_keys').get() as { encrypted_key: string }).encrypted_key;
    expect(stored).toMatch(/^wc1:/);
    expect(getApiKey(db, box, user.id, 'polygon')).toBe('abc');

    // după o repornire: cutia nouă se deblochează cu cheia și citește valorile salvate
    const next = new WebSecretBox();
    expect(getApiKey(db, next, user.id, 'polygon')).toBeNull();
    await next.unlock(key, [stored]);
    expect(getApiKey(db, next, user.id, 'polygon')).toBe('abc');
    next.lock();
    expect(getApiKey(db, next, user.id, 'polygon')).toBeNull();
  });
});

describe('platforma web: deblocare, „ține-mă minte” și schimbarea parolei', () => {
  it('parola derivă cheia; „ține-mă minte” o păstrează ca CryptoKey nerecuperabilă; la ieșire dispare', async () => {
    const { db } = openSqlJs(SQL);
    const user = await auth.register(db, { username: 'eva', password: 'parola-eva-12' });
    const kv = memoryKv();
    const secrets = new WebSecretBox();
    const platform = createWebPlatform({ SQL, db, kv, secrets, request: async () => true, takeFile: () => null, initialToken: null });

    await platform.unlockSecrets!(user.id, 'parola-eva-12', true);
    expect(secrets.unlocked).toBe(true);
    const saved = await kv.get<CryptoKey>(`key:${user.id}`);
    expect(saved?.extractable).toBe(false);
    expect(await kv.get(`salt:${user.id}`)).toBeInstanceOf(Uint8Array);

    await platform.sealSecret!('cheia-mea');
    setApiKey(db, secrets, user.id, 'alphavantage', 'cheia-mea');

    // sesiune reluată fără parolă: cheia salvată deblochează cheile API
    const secrets2 = new WebSecretBox();
    const again = createWebPlatform({ SQL, db, kv, secrets: secrets2, request: async () => true, takeFile: () => null, initialToken: null });
    await again.unlockSecrets!(user.id, null, true);
    expect(getApiKey(db, secrets2, user.id, 'alphavantage')).toBe('cheia-mea');

    // schimbarea parolei: cheile API se recriptează cu cheia nouă
    await platform.changeSecretsPassword!(user.id, 'parola-eva-12', 'parola-noua-99');
    const reopened = new WebSecretBox();
    await reopened.unlock(await keyForPassword(kv, user.id, 'parola-noua-99'), [
      (db.prepare('SELECT encrypted_key FROM api_keys').get() as { encrypted_key: string }).encrypted_key
    ]);
    expect(getApiKey(db, reopened, user.id, 'alphavantage')).toBe('cheia-mea');

    platform.lockSecrets!();
    expect(secrets.unlocked).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(await kv.get(`key:${user.id}`)).toBeUndefined();
  });

  it('fără „ține-mă minte” cheia nu se salvează, iar fără cheie salvată cheile rămân blocate', async () => {
    const { db } = openSqlJs(SQL);
    const user = await auth.register(db, { username: 'fane', password: 'parola-fane-1' });
    const kv = memoryKv();
    const secrets = new WebSecretBox();
    const platform = createWebPlatform({ SQL, db, kv, secrets, request: async () => true, takeFile: () => null, initialToken: null });
    await platform.unlockSecrets!(user.id, 'parola-fane-1', false);
    expect(await kv.get(`key:${user.id}`)).toBeUndefined();
    await platform.unlockSecrets!(user.id, null, true);
    expect(secrets.unlocked).toBe(false);
    await expect(platform.sealSecret!('x')).rejects.toThrow(/după autentificarea cu parola/);
  });

  it('tokenul de sesiune se păstrează în depozit și se șterge la ieșire', async () => {
    const { db } = openSqlJs(SQL);
    const kv = memoryKv();
    const platform = createWebPlatform({ SQL, db, kv, secrets: new WebSecretBox(), request: async () => true, takeFile: () => null, initialToken: 'vechi' });
    expect(platform.readToken()).toBe('vechi');
    platform.writeToken('nou');
    await new Promise((r) => setTimeout(r, 0));
    expect(await kv.get('session-token')).toBe('nou');
    platform.writeToken(null);
    expect(platform.readToken()).toBeNull();
  });
});
