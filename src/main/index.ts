/**
 * Punctul de intrare al procesului principal Electron: deschide baza de date,
 * înregistrează handlerele IPC și creează fereastra aplicației.
 */
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type Db } from './db/database';
import { createElectronSecretBox } from './electronSecrets';
import { registerIpc } from './ipc';
import { setYahooClientFactory } from './prices/yahoo';
import { createNodeYahooClient } from './prices/yahooNode';

setYahooClientFactory(createNodeYahooClient);

// Folder de date alternativ (folosit de testele automate, ca să nu atingă datele reale).
if (process.env.PORTOFOLIU_DATA_DIR) {
  mkdirSync(process.env.PORTOFOLIU_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.PORTOFOLIU_DATA_DIR);
}

// Interfața este în română: câmpurile de dată și dialogurile de fișier folosesc formatul românesc (zz.ll.aaaa).
app.commandLine.appendSwitch('lang', 'ro');

let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'Portofoliu Bursa',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1120' : '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Interfața rulează izolat: fără Node, fără acces direct la fișiere sau la baza de date.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Linkurile externe se deschid în browserul sistemului, nu în aplicație.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  // În dezvoltare, electron-vite servește interfața cu reîncărcare la cald.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** Pe macOS scurtăturile Copiere/Lipire depind de meniu; pe celelalte sisteme meniul este ascuns. */
function setupMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
  );
}

// O singură instanță: două procese care scriu în aceeași bază de date s-ar încurca reciproc.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    mkdirSync(dataDir, { recursive: true });
    db = openDatabase(join(dataDir, 'portofoliu.db'));
    registerIpc({
      db,
      secrets: createElectronSecretBox(dataDir),
      dataDir,
      getWindow: () => mainWindow
    });
    setupMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    db?.close();
    db = null;
  });
}
