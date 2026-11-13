/**
 * Transportul versiunii web: `window.bridge` (același contract ca preload-ul din Electron) trimite apelurile
 * către backendul din Web Worker. Tot aici sunt lucrurile care cer pagina: alegerea fișierelor,
 * descărcarea/partajarea exporturilor, tipărirea rapoartelor și salvarea bazei la închidere.
 */
import type { AppEvent, Bridge, IpcResult } from '@shared/api';
import type { FromWorker, PickedFile, ToWorker, WebConfig } from './protocol';

type Listener = (event: AppEvent) => void;

/** Alege un fișier cu `<input type=file>`. Trebuie apelat direct din gestul utilizatorului (iOS blochează altfel). */
export function pickFile(accept: string): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (file: PickedFile | null): void => {
      if (done) return;
      done = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return finish(null);
      void f.arrayBuffer().then((buf) => finish({ name: f.name, data: new Uint8Array(buf) }), () => finish(null));
    });
    input.addEventListener('cancel', () => finish(null));
    // Rezervă pentru browserele fără evenimentul „cancel”: la revenirea în pagină, fără fișier ales, renunțăm.
    window.addEventListener(
      'focus',
      () => setTimeout(() => !input.files?.length && finish(null), 1500),
      { once: true }
    );
    input.click();
  });
}

/** Trimite fișierul prin meniul de partajare (iOS) dacă se poate, altfel îl descarcă. Întoarce false dacă utilizatorul a renunțat. */
export async function deliverFile(name: string, mime: string, data: Uint8Array): Promise<boolean> {
  const file = new File([data as BlobPart], name, { type: mime });
  const nav = navigator as Navigator & { userActivation?: { isActive: boolean } };
  if (nav.canShare?.({ files: [file] }) && nav.userActivation?.isActive !== false) {
    try {
      await nav.share({ files: [file], title: name });
      return true;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false;
      // fără gest de utilizator sau fără suport: cădem pe descărcare
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** Deschide raportul într-o fereastră nouă și pornește tipărirea (de acolo: „Salvează ca PDF”). */
function printHtml(win: Window | null, name: string, html: string): boolean {
  if (!win) {
    // Fereastra nu s-a putut deschide (blocată): descărcăm documentul HTML.
    void deliverFile(name.replace(/\.pdf$/i, '.html'), 'text/html;charset=utf-8', new TextEncoder().encode(html));
    return true;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
  return true;
}

export interface WebClient {
  bridge: Bridge;
  config(): Promise<WebConfig>;
  setProxy(url: string): Promise<IpcResult<unknown>>;
  /** Pornește baza de date: true când backendul este gata. */
  ready: Promise<void>;
}

export function createWebClient(): WebClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const send = (msg: ToWorker): void => worker.postMessage(msg);
  const pending = new Map<number, (res: IpcResult<unknown>) => void>();
  const listeners = new Set<Listener>();
  let nextId = 1;
  let printWindow: Window | null = null;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (e: Error) => void = () => undefined;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    switch (msg.kind) {
      case 'ready':
        return resolveReady();
      case 'fatal':
        return rejectReady(new Error(msg.message));
      case 'result':
        pending.get(msg.id)?.(msg.res);
        pending.delete(msg.id);
        return;
      case 'event':
        for (const l of listeners) l(msg.event);
        return;
      case 'save':
        void deliverFile(msg.name, msg.mime, msg.data).then((ok) => send({ kind: 'delivered', reqId: msg.reqId, ok }));
        return;
      case 'print': {
        const win = printWindow;
        printWindow = null;
        send({ kind: 'delivered', reqId: msg.reqId, ok: printHtml(win, msg.name, msg.html) });
        return;
      }
    }
  };
  worker.onerror = (e) => rejectReady(new Error(e.message || 'Backendul nu a pornit.'));

  const call = async (path: string, args: unknown[], file?: PickedFile): Promise<IpcResult<unknown>> => {
    await ready;
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ kind: 'call', id, path, args, file });
    });
  };

  const bridge: Bridge = {
    call: (path, args) => {
      // Alegerea fișierului și fereastra de tipărire pornesc imediat, în gestul utilizatorului (altfel iOS le blochează).
      if (path === 'imports.open' || path === 'backup.restore') {
        return pickFile(path === 'imports.open' ? '.xlsx,.csv,.txt,.tsv' : '').then((file) =>
          file ? call(path, args, file) : ({ ok: true, data: { canceled: true } } as IpcResult<unknown>)
        );
      }
      if (path.endsWith('.exportPdf')) printWindow = window.open('', '_blank');
      return call(path, args);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };

  // Salvăm baza când pagina se ascunde sau se închide (iOS poate opri aplicația oricând din fundal).
  const flush = (): void => send({ kind: 'flush' });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  window.addEventListener('pagehide', flush);

  // Stocare persistentă: reduce riscul ca iOS/Safari să șteargă datele (cererea e ignorată dacă nu e suportată).
  void (async () => {
    try {
      const ok = (await navigator.storage?.persist?.()) ?? false;
      send({ kind: 'persisted', value: ok });
    } catch {
      send({ kind: 'persisted', value: false });
    }
  })();

  return {
    bridge,
    ready,
    config: async () => {
      const res = await bridge.call('web.getConfig', []);
      if (!res.ok) throw new Error(res.error);
      return res.data as WebConfig;
    },
    setProxy: (url) => bridge.call('web.setProxy', [url])
  };
}
