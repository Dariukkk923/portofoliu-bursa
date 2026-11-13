/**
 * Înlocuiește în varianta web modulele doar pentru desktop (electron, node:fs, node:os, node:path),
 * importate de src/main/ipc.ts și backup.ts. Partea de desktop din ele nu se apelează niciodată în
 * browser; dacă totuși se apelează, eroarea spune clar de ce.
 */
const unavailable = (what: string) => (): never => {
  throw new Error(`${what} nu există în versiunea web.`);
};

export const existsSync = unavailable('Sistemul de fișiere');
export const mkdtempSync = unavailable('Sistemul de fișiere');
export const readFileSync = unavailable('Sistemul de fișiere');
export const rmSync = unavailable('Sistemul de fișiere');
export const writeFileSync = unavailable('Sistemul de fișiere');
export const copyFileSync = unavailable('Sistemul de fișiere');
export const tmpdir = unavailable('Sistemul de fișiere');
export const basename = unavailable('Sistemul de fișiere');
export const join = unavailable('Sistemul de fișiere');

export const app = {} as never;
export const BrowserWindow = {} as never;
export const dialog = {} as never;
export const ipcMain = {} as never;
export const Notification = {} as never;
export const shell = {} as never;
