/**
 * Depozit cheie-valoare în IndexedDB: aici stau octeții bazei de date, cheia de criptare
 * (CryptoKey nerecuperabilă), tokenul de sesiune și setările dispozitivului.
 */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const STORE = 'kv';

export function openIdbKv(name = 'portofoliu-bursa'): Kv {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (opened ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponibil.'));
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      // La scriere așteptăm încheierea tranzacției (datele sunt pe disc), nu doar cererea.
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('Scrierea în IndexedDB a eșuat.'));
      tx.onabort = () => reject(tx.error ?? new Error('Scrierea în IndexedDB a fost anulată.'));
    });
  };
  return {
    get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
    set: async (key, value) => void (await run('readwrite', (s) => s.put(value, key))),
    del: async (key) => void (await run('readwrite', (s) => s.delete(key)))
  };
}

/** În memorie: pentru teste (nu există IndexedDB în Node). */
export function memoryKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => void map.set(key, value),
    del: async (key) => void map.delete(key)
  };
}
