/**
 * Backendul versiunii web, într-un Web Worker: aceleași servicii ca pe desktop (src/main), pe sql.js.
 * Baza se păstrează în IndexedDB (salvată cu întârziere după scrieri și la închiderea paginii).
 */
import { installBuffer } from './shims/buffer';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { IpcResult } from '@shared/api';
import { createBackend, type Backend } from '@main/ipc';
import { setProviderFetch } from '@main/prices/provider';
import { setYahooClientFactory } from '@main/prices/yahoo';
import { openSqlJs, type SqlJsConnection } from './sqljs';
import { openIdbKv, type Kv } from './kv';
import { WebSecretBox } from './keystore';
import { createWebPlatform } from './platform';
import { createRoutedFetch, normalizeProxyUrl, proxyConfig } from './net';
import { createWebYahooClient } from './yahooWeb';
import type { FromWorker, PickedFile, ToWorker, WebConfig } from './protocol';

installBuffer();

const post = (msg: FromWorker, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);

/** Salvarea în IndexedDB: la 1,5 s după ultima scriere, dar cel mult la 10 s de la prima. */
const SAVE_DELAY_MS = 1500;
const SAVE_MAX_WAIT_MS = 10_000;

let persisted: boolean | null = null;
let injectedFile: PickedFile | null = null;
let nextReq = 1;
const waiting = new Map<number, (ok: boolean) => void>();

async function boot(): Promise<{ backend: Backend; kv: Kv; conn: SqlJsConnection; flush: () => Promise<void> }> {
  const kv = openIdbKv();
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const bytes = (await kv.get<Uint8Array>('db')) ?? null;
  const { conn, db } = openSqlJs(SQL, bytes);

  let dirty = !bytes; // o bază nouă se salvează imediat după migrări
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstDirtyAt = 0;
  let saving: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    saving = saving.then(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await kv.set('db', conn.serialize());
      } catch (err) {
        dirty = true;
        console.error('[web] salvarea bazei a eșuat:', err);
      }
    });
    return saving;
  };
  conn.onWrite = () => {
    if (!dirty) firstDirtyAt = Date.now();
    dirty = true;
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(SAVE_DELAY_MS, firstDirtyAt + SAVE_MAX_WAIT_MS - Date.now()));
    timer = setTimeout(() => void flush(), wait);
  };
  if (dirty) await flush();

  proxyConfig.url = (await kv.get<string>('proxy-url')) ?? null;
  setProviderFetch(createRoutedFetch(() => proxyConfig.url));
  setYahooClientFactory(() => createWebYahooClient(() => proxyConfig.url));

  const request = (kind: 'save' | 'print', payload: { name: string; mime?: string; data?: Uint8Array; html?: string }): Promise<boolean> => {
    const reqId = nextReq++;
    return new Promise((resolve) => {
      waiting.set(reqId, resolve);
      if (kind === 'save') {
        const data = payload.data as Uint8Array;
        // Copie: octeții pot fi ai bazei și nu trebuie „mutați” din worker.
        const copy = data.slice();
        post({ kind: 'save', reqId, name: payload.name, mime: payload.mime ?? 'application/octet-stream', data: copy }, [copy.buffer]);
      } else {
        post({ kind: 'print', reqId, name: payload.name, html: payload.html ?? '' });
      }
    });
  };

  const secrets = new WebSecretBox();
  const platform = createWebPlatform({
    SQL,
    db,
    kv,
    secrets,
    request,
    takeFile: () => {
      const f = injectedFile;
      injectedFile = null;
      return f;
    },
    initialToken: (await kv.get<string>('session-token')) ?? null
  });
  const backend = createBackend({ db, secrets, platform, send: (event) => post({ kind: 'event', event }) });
  return { backend, kv, conn, flush };
}

const ready = boot();
ready.then(
  () => post({ kind: 'ready' }),
  (err) => post({ kind: 'fatal', message: String((err as Error)?.message ?? err) })
);

/** Apelurile care țin doar de dispozitiv (nu de contul din baza de date). */
async function webCall(path: string, args: unknown[], ctx: Awaited<typeof ready>): Promise<IpcResult<unknown>> {
  if (path === 'web.getConfig') {
    const cur = await ctx.backend.dispatch('auth.current', []);
    const user = cur.ok ? (cur.data as { id: number; isDemo: boolean } | null) : null;
    const cfg: WebConfig = { proxyUrl: proxyConfig.url, lastBackupAt: null, hasData: false, isDemo: !!user?.isDemo, persisted };
    if (user) {
      cfg.lastBackupAt = (await ctx.kv.get<number>(`last-backup:${user.id}`)) ?? null;
      const row = ctx.conn.query('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [user.id])[0];
      cfg.hasData = Number(row?.n ?? 0) > 0;
    }
    return { ok: true, data: cfg };
  }
  if (path === 'web.setProxy') {
    const raw = String(args[0] ?? '').trim();
    const url = raw ? normalizeProxyUrl(raw) : null;
    if (raw && !url) return { ok: false, error: 'Adresa proxy-ului trebuie să înceapă cu https://' };
    proxyConfig.url = url;
    await (url ? ctx.kv.set('proxy-url', url) : ctx.kv.del('proxy-url'));
    return { ok: true, data: url };
  }
  return { ok: false, error: 'Operațiune necunoscută.' };
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.kind === 'persisted') {
    persisted = msg.value;
    return;
  }
  if (msg.kind === 'delivered') {
    waiting.get(msg.reqId)?.(msg.ok);
    waiting.delete(msg.reqId);
    return;
  }
  let ctx: Awaited<typeof ready>;
  try {
    ctx = await ready;
  } catch {
    return;
  }
  if (msg.kind === 'flush') {
    await ctx.flush();
    post({ kind: 'flushed' });
    return;
  }
  if (msg.kind === 'call') {
    injectedFile = msg.file ?? null;
    const res = msg.path.startsWith('web.') ? await webCall(msg.path, msg.args, ctx) : await ctx.backend.dispatch(msg.path, msg.args);
    injectedFile = null;
    post({ kind: 'result', id: msg.id, res });
  }
};
