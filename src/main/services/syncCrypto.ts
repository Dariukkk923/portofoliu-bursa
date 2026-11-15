/**
 * Criptarea sincronizării (Web Crypto: merge la fel în Electron și în Web Worker-ul din browser).
 *
 * Din parolă se derivă două chei (PBKDF2-SHA256, 512 biți, sarea = numele contului):
 *  - authKey (primii 32 de octeți, în hex) — singurul lucru trimis serverului, ca „parolă” a contului online;
 *  - encKey (ultimii 32 de octeți) — cheia AES-256-GCM cu care se criptează datele; nu părăsește dispozitivul.
 * Pachetul trimis: 0x01 || IV (12 octeți) || AES-GCM(gzip(date)). Serverul nu poate citi datele.
 */

export const SYNC_PBKDF2_ITERATIONS = 310_000;
const FORMAT_VERSION = 1;

export interface SyncKeys {
  /** Numele contului online (litere mici). */
  uname: string;
  /** 64 de caractere hex. */
  authKey: string;
  /** 32 de octeți. */
  encKey: Uint8Array;
}

const subtle = () => globalThis.crypto.subtle;
/** Copie cu un ArrayBuffer propriu (tipul cerut de Web Crypto și Blob, atât în Node cât și în browser). */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));

export const syncUsername = (username: string): string => String(username ?? '').trim().toLowerCase();

export async function deriveSyncKeys(username: string, password: string): Promise<SyncKeys> {
  const uname = syncUsername(username);
  const enc = new TextEncoder();
  const material = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle().deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('portofoliu-bursa-sync:v1:' + uname), iterations: SYNC_PBKDF2_ITERATIONS },
      material,
      512
    )
  );
  return { uname, authKey: hex(bits.slice(0, 32)), encKey: bits.slice(32, 64) };
}

/** Cheile ca text (pentru păstrarea criptată pe dispozitiv) și înapoi. */
export const keysToText = (k: SyncKeys): string => JSON.stringify({ u: k.uname, a: k.authKey, e: hex(k.encKey) });
export function keysFromText(text: string | null): SyncKeys | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as { u?: unknown; a?: unknown; e?: unknown };
    if (typeof o.u !== 'string' || typeof o.a !== 'string' || typeof o.e !== 'string' || !/^[0-9a-f]{64}$/.test(o.a) || !/^[0-9a-f]{64}$/.test(o.e)) return null;
    return { uname: o.u, authKey: o.a, encKey: unhex(o.e) };
  } catch {
    return null;
  }
}

/** Antetul de autentificare: `Sync base64(uname:authKey)`. */
export const syncAuthHeader = (k: SyncKeys): string => 'Sync ' + toBase64(new TextEncoder().encode(`${k.uname}:${k.authKey}`));

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([own(data)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const aesKey = (raw: Uint8Array, usage: 'encrypt' | 'decrypt') => subtle().importKey('raw', own(raw), { name: 'AES-GCM' }, false, [usage]);

export async function encryptSnapshot(encKey: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const packed = await transform(plain, new CompressionStream('gzip'));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, await aesKey(encKey, 'encrypt'), own(packed)));
  const out = new Uint8Array(1 + iv.length + sealed.length);
  out[0] = FORMAT_VERSION;
  out.set(iv, 1);
  out.set(sealed, 1 + iv.length);
  return out;
}

/** Datele decriptate; aruncă eroare dacă formatul nu se cunoaște sau cheia nu se potrivește. */
export async function decryptSnapshot(encKey: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 1 + 12 + 16 || blob[0] !== FORMAT_VERSION) throw new Error('format necunoscut');
  const iv = blob.slice(1, 13);
  const packed = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, await aesKey(encKey, 'decrypt'), own(blob.subarray(13))));
  return transform(packed, new DecompressionStream('gzip'));
}

/** Base64 standard, pe bucăți (datele pot avea mulți MB; `String.fromCharCode(...tot)` ar depăși stiva). */
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
