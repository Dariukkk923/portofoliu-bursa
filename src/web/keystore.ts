/**
 * Cheile API pe web: AES-GCM prin Web Crypto, cu o cheie derivată din parola utilizatorului (PBKDF2).
 *
 * Serviciile cer o „cutie de secrete” sincronă (`SecretBox`), dar Web Crypto este asincron. De aceea
 * cutia ține două tabele în memorie: criptările pregătite dinainte (`prime`) și textele deja
 * decriptate la deblocare (`unlock`). Cheia se derivă la autentificare; la „ține-mă minte” se păstrează
 * în IndexedDB ca CryptoKey nerecuperabilă (nu poate fi citită ca octeți), ca să nu ceară parola la fiecare deschidere.
 */
import type { SecretBox } from '@main/secrets';
import { AppError } from '@main/services/common';
import type { Kv } from './kv';

const PREFIX = 'wc1:';
/** Număr mare de iterații: derivarea se face o dată pe autentificare. */
export const PBKDF2_ITERATIONS = 600_000;

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function deriveKey(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealText(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  return `${PREFIX}${b64(iv)}.${b64(data)}`;
}

/** Textul decriptat, sau null dacă valoarea nu are formatul așteptat ori cheia nu se potrivește. */
export async function openText(key: CryptoKey, stored: string): Promise<string | null> {
  if (!stored.startsWith(PREFIX)) return null;
  try {
    const [iv, data] = stored.slice(PREFIX.length).split('.').map(unb64);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource));
  } catch {
    return null;
  }
}

/** Cheia utilizatorului: sarea (aleatoare, salvată o dată pe dispozitiv) + parola. */
export async function keyForPassword(kv: Kv, userId: number, password: string): Promise<CryptoKey> {
  let salt = await kv.get<Uint8Array>(`salt:${userId}`);
  if (!salt) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await kv.set(`salt:${userId}`, salt);
  }
  return deriveKey(password, salt);
}

export class WebSecretBox implements SecretBox {
  private key: CryptoKey | null = null;
  private sealed = new Map<string, string>();
  private opened = new Map<string, string>();

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Deblochează cu cheia dată și decriptează valorile deja salvate (ca `decrypt` să rămână sincron). */
  async unlock(key: CryptoKey | null, storedValues: string[]): Promise<void> {
    this.lock();
    this.key = key;
    if (!key) return;
    for (const stored of storedValues) {
      const plain = await openText(key, stored);
      if (plain !== null) this.opened.set(stored, plain);
    }
  }

  lock(): void {
    this.key = null;
    this.sealed.clear();
    this.opened.clear();
  }

  /** Criptează dinainte un text, ca `encrypt` să poată răspunde sincron. Întoarce valoarea criptată. */
  async prime(plain: string): Promise<string> {
    if (!this.key) throw new AppError('Cheile API se pot salva doar după autentificarea cu parola (nu și în contul demo).');
    const stored = await sealText(this.key, plain);
    this.sealed.set(plain, stored);
    this.opened.set(stored, plain);
    return stored;
  }

  encrypt(plain: string): string {
    const stored = this.sealed.get(plain);
    if (!stored) throw new AppError('Cheia de criptare nu este deblocată. Autentifică-te din nou cu parola.');
    return stored;
  }

  decrypt(stored: string): string | null {
    return this.opened.get(stored) ?? null;
  }
}
