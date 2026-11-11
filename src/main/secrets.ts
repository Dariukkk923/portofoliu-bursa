/**
 * Criptarea secretelor salvate local (cheile API și tokenul „ține-mă minte”).
 *
 * În aplicație se folosește `safeStorage` din Electron (DPAPI pe Windows,
 * Keychain pe macOS, libsecret pe Linux) — vezi `electronSecrets.ts`. Varianta
 * AES-256-GCM de aici este rezerva pentru sistemele fără depozit de chei și
 * este folosită și în teste, unde Electron nu este disponibil.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretBox {
  encrypt(plain: string): string;
  /** Întoarce null dacă valoarea nu poate fi decriptată (ex.: bază mutată pe alt calculator). */
  decrypt(stored: string): string | null;
}

const AES_PREFIX = 'aes1:';

/** Cutie AES-256-GCM cu o cheie de 32 de octeți. Format: aes1:<iv>.<tag>.<date>, în base64. */
export function createAesBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error('Cheia AES trebuie să aibă 32 de octeți.');
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return AES_PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
    },
    decrypt(stored) {
      if (!stored.startsWith(AES_PREFIX)) return null;
      try {
        const [iv, tag, data] = stored
          .slice(AES_PREFIX.length)
          .split('.')
          .map((s) => Buffer.from(s, 'base64'));
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    }
  };
}
