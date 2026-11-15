/**
 * Sincronizarea contului între calculator și telefon: adresa serverului, starea afișată în interfață
 * și numele dispozitivului („ultima modificare de pe …”).
 */

/** Serverul de sincronizare (același Cloudflare Worker ca proxy-ul de prețuri). */
export const SYNC_URL = 'https://portofoliu-proxy.portofoliu-bursa.workers.dev';

/**
 * - off: contul nu se sincronizează (demo, nume cu caractere nepermise, fără date de acces);
 * - ok: totul e la zi; syncing: în curs; offline: fără internet (se reîncearcă singur);
 * - conflict: datele s-au schimbat pe ambele dispozitive și utilizatorul alege ce păstrăm;
 * - name_taken: numele este folosit online de alt cont (sau cu altă parolă);
 * - error: altă problemă (detaliile în `message`).
 */
export type SyncState = 'off' | 'ok' | 'syncing' | 'offline' | 'conflict' | 'name_taken' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** Ultima sincronizare reușită (ms), sau null. */
  lastSyncAt: number | null;
  /** Dispozitivul de pe care vine ultima modificare de pe server (la conflict: cel cu datele diferite). */
  device: string | null;
  /** Explicația, pe scurt, pentru stările „off” și „error”. */
  message?: string | null;
}

export type SyncChoice = 'local' | 'remote';

/** Numele de utilizator acceptat de server (ca în aplicație, dar fără diacritice). */
export const SYNC_USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

/** Desktop: „Windows · calculator”, „Mac · calculator”, „Linux · calculator”. */
export function desktopDeviceLabel(platform: string): string {
  const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Mac' : platform === 'linux' ? 'Linux' : platform;
  return `${os} · calculator`;
}

/** Web: „iPhone”, „Android” sau „Browser”, după user agent. */
export function webDeviceLabel(userAgent: string): string {
  if (/iPhone|iPod/i.test(userAgent)) return 'iPhone';
  if (/Android/i.test(userAgent)) return 'Android';
  return 'Browser';
}
