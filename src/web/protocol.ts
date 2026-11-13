/** Mesajele dintre pagină (client.ts) și Web Worker-ul cu backendul (worker.ts). */
import type { AppEvent, IpcResult } from '@shared/api';

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

/** Starea dispozitivului, pentru bannerele și cardul din Setări. */
export interface WebConfig {
  proxyUrl: string | null;
  /** Ultimul backup salvat al contului curent (ms), sau null. */
  lastBackupAt: number | null;
  /** Contul curent are tranzacții (are ce pierde). */
  hasData: boolean;
  isDemo: boolean;
  /** Cererea de stocare persistentă a fost acceptată (null = încă nu se știe). */
  persisted: boolean | null;
}

export type ToWorker =
  | { kind: 'call'; id: number; path: string; args: unknown[]; file?: PickedFile | null }
  | { kind: 'flush' }
  | { kind: 'persisted'; value: boolean }
  /** Răspuns la `save`/`print`: s-a livrat fișierul sau s-a renunțat. */
  | { kind: 'delivered'; reqId: number; ok: boolean };

export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'fatal'; message: string }
  | { kind: 'result'; id: number; res: IpcResult<unknown> }
  | { kind: 'event'; event: AppEvent }
  | { kind: 'flushed' }
  | { kind: 'save'; reqId: number; name: string; mime: string; data: Uint8Array }
  | { kind: 'print'; reqId: number; name: string; html: string };
