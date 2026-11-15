/**
 * Cererile către serverul de sincronizare (rutele /sync/* din proxy). `fetch` se primește din afară:
 * pe desktop este cel din Node (fără antet Origin), pe web cel al worker-ului, iar în teste un server fals.
 */
import { fromBase64, syncAuthHeader, toBase64, type SyncKeys } from './syncCrypto';

const TIMEOUT_MS = 30_000;

/** Serverul nu a putut fi contactat (fără internet, timeout). Erorile 5xx vin ca SyncHttpError (temporare). */
export class SyncOfflineError extends Error {}

/** Răspuns de eroare de la server: 401 auth, 409 taken/conflict, 413 too_large, 429 locked… */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>
  ) {
    super(`sync ${status} ${code}`);
  }
}

export interface SyncHead {
  version: number;
  updatedAt: number | null;
  device: string | null;
}

export interface SyncSnapshot extends SyncHead {
  data: Uint8Array;
}

export interface SyncApi {
  register(keys: SyncKeys): Promise<void>;
  head(keys: SyncKeys): Promise<SyncHead>;
  /** null = contul există, dar nu are încă date. */
  snapshot(keys: SyncKeys): Promise<SyncSnapshot | null>;
  put(keys: SyncKeys, baseVersion: number, device: string, data: Uint8Array): Promise<{ version: number; updatedAt: number }>;
  password(keys: SyncKeys, newAuthKey: string, baseVersion: number, device: string, data: Uint8Array): Promise<{ version: number; updatedAt: number }>;
}

const head = (o: Record<string, unknown>): SyncHead => ({
  version: Number(o.version ?? 0) || 0,
  updatedAt: o.updatedAt == null ? null : Number(o.updatedAt),
  device: o.device == null ? null : String(o.device)
});

export function createSyncApi(baseUrl: string, fetchImpl: typeof fetch): SyncApi {
  const base = baseUrl.replace(/\/+$/, '');

  const call = async (method: string, path: string, keys: SyncKeys | null, body?: unknown): Promise<Record<string, unknown> | null> => {
    const headers: Record<string, string> = {};
    if (keys) headers.authorization = syncAuthHeader(keys);
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      throw new SyncOfflineError((err as Error)?.message ?? 'rețea');
    }
    if (res.status === 204) return null;
    let json: Record<string, unknown> = {};
    try {
      json = ((await res.json()) as Record<string, unknown>) ?? {};
    } catch {
      // corp gol sau nevalid
    }
    if (!res.ok) {
      // Blocarea după prea multe încercări: câte secunde mai durează (din corp sau din antetul retry-after).
      if (res.status === 429 && json.retryAfter == null) json.retryAfter = Number(res.headers.get('retry-after')) || 900;
      throw new SyncHttpError(res.status, String(json.error ?? ''), json);
    }
    return json;
  };

  const saved = (o: Record<string, unknown> | null): { version: number; updatedAt: number } => ({
    version: Number(o?.version ?? 0),
    updatedAt: Number(o?.updatedAt ?? Date.now())
  });

  return {
    async register(keys) {
      await call('POST', '/sync/register', null, { username: keys.uname, authKey: keys.authKey });
    },
    async head(keys) {
      return head((await call('GET', '/sync/head', keys)) ?? {});
    },
    async snapshot(keys) {
      const o = await call('GET', '/sync/snapshot', keys);
      if (!o || typeof o.data !== 'string') return null;
      return { ...head(o), data: fromBase64(o.data) };
    },
    async put(keys, baseVersion, device, data) {
      return saved(await call('PUT', '/sync/snapshot', keys, { baseVersion, device, data: toBase64(data) }));
    },
    async password(keys, newAuthKey, baseVersion, device, data) {
      return saved(await call('POST', '/sync/password', keys, { newAuthKey, baseVersion, device, data: toBase64(data) }));
    }
  };
}

/** Secundele de blocare la 429 (prea multe încercări greșite), altfel null. */
export const lockedFor = (err: unknown): number | null =>
  err instanceof SyncHttpError && err.status === 429 ? Math.max(1, Number(err.body.retryAfter) || 900) : null;

/** Conflictul de versiune (409 la PUT / password): versiunea și dispozitivul de pe server. */
export const conflictOf = (err: unknown): SyncHead | null =>
  err instanceof SyncHttpError && err.status === 409 && err.code === 'conflict' ? head(err.body) : null;
