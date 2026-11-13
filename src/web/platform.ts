/**
 * Partea specifică browserului a backendului: fișiere (descărcare / partajare / selectare), sesiune salvată,
 * backup în memorie și cheile API criptate cu Web Crypto. Rulează în Web Worker; ce ține de pagină
 * (descărcări, tipărire) se cere prin mesaje.
 */
import type { SqlJsStatic } from 'sql.js';
import type { Db } from '@main/db/database';
import type { Platform } from '@main/ipc';
import { createWebBackup, restoreWebBackup } from './webBackup';
import { keyForPassword, WebSecretBox } from './keystore';
import type { Kv } from './kv';
import type { PickedFile } from './protocol';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

const MIME: Record<string, string> = {
  csv: 'text/csv;charset=utf-8',
  pdf: 'application/pdf',
  db: 'application/octet-stream'
};

export interface WebPlatformOptions {
  SQL: SqlJsStatic;
  db: Db;
  kv: Kv;
  secrets: WebSecretBox;
  /** Trimite o cerere către pagină și așteaptă dacă a fost livrată (false = utilizatorul a renunțat). */
  request(kind: 'save' | 'print', payload: { name: string; mime?: string; data?: Uint8Array; html?: string }): Promise<boolean>;
  /** Fișierul ales de utilizator în pagină, pentru apelul curent (se consumă o dată). */
  takeFile(): PickedFile | null;
  /** Tokenul „ține-mă minte”, citit la pornire. */
  initialToken: string | null;
}

export function createWebPlatform(o: WebPlatformOptions): Platform {
  let token = o.initialToken;
  let secretsUser: number | null = null;
  let backupUser: number | null = null;

  const storedKeys = (userId: number): string[] =>
    (o.db.prepare('SELECT encrypted_key FROM api_keys WHERE user_id = ?').all(userId) as { encrypted_key: string }[]).map((r) => r.encrypted_key);

  return {
    async saveFile(_title, defaultName, _filters, data) {
      const ext = defaultName.split('.').pop() ?? '';
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const ok = await o.request('save', { name: defaultName, mime: MIME[ext] ?? 'application/octet-stream', data: bytes });
      return ok ? defaultName : null;
    },
    async savePdf(_title, defaultName, html) {
      const ok = await o.request('print', { name: defaultName, html });
      return ok ? defaultName : null;
    },
    async openFile() {
      return o.takeFile();
    },
    // Pe web alertele apar în aplicație (clopoțelul), prin evenimentul „alerts:triggered”.
    notify() {},
    openExternal: async () => {},
    readToken: () => token,
    writeToken(next) {
      token = next;
      void (next === null ? o.kv.del('session-token') : o.kv.set('session-token', next));
    },
    createBackup(db, userId) {
      backupUser = userId;
      return createWebBackup(o.SQL, db, userId);
    },
    restoreBackup: (db, userId, data) => restoreWebBackup(o.SQL, db, userId, data),
    onBackupSaved() {
      if (backupUser !== null) void o.kv.set(`last-backup:${backupUser}`, Date.now());
    },
    info: () => ({ version: APP_VERSION, platform: 'web', dataPath: 'în browser (IndexedDB)' }),

    async unlockSecrets(userId, password, remember) {
      secretsUser = userId;
      let key: CryptoKey | null = null;
      if (password !== null) {
        key = await keyForPassword(o.kv, userId, password);
        if (remember) await o.kv.set(`key:${userId}`, key);
      } else {
        key = (await o.kv.get<CryptoKey>(`key:${userId}`)) ?? null;
      }
      await o.secrets.unlock(key, storedKeys(userId));
    },
    lockSecrets() {
      o.secrets.lock();
      if (secretsUser !== null) void o.kv.del(`key:${secretsUser}`);
      secretsUser = null;
    },
    async sealSecret(plain) {
      await o.secrets.prime(plain);
    },
    async changeSecretsPassword(userId, oldPassword, newPassword) {
      // Cheile API se recriptează cu cheia derivată din parola nouă (aceeași sare).
      const rows = o.db.prepare('SELECT provider, encrypted_key FROM api_keys WHERE user_id = ?').all(userId) as { provider: string; encrypted_key: string }[];
      const plains = rows.map((r) => ({ provider: r.provider, plain: o.secrets.decrypt(r.encrypted_key) }));
      const key = await keyForPassword(o.kv, userId, newPassword);
      await o.secrets.unlock(key, []);
      for (const { provider, plain } of plains) {
        const stored = plain === null ? null : await o.secrets.prime(plain);
        if (stored) o.db.prepare('UPDATE api_keys SET encrypted_key = ? WHERE user_id = ? AND provider = ?').run(stored, userId, provider);
        else o.db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?').run(userId, provider);
      }
      if (await o.kv.get(`key:${userId}`)) await o.kv.set(`key:${userId}`, key);
      void oldPassword;
    }
  };
}
