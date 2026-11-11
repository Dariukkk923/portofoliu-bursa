/**
 * Scriptul preload: singura punte dintre interfață (fără acces la Node) și
 * procesul principal. Expune doar două funcții: un apel generic de API și
 * abonarea la evenimente.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_CALL, IPC_EVENT, type AppEvent, type Bridge } from '@shared/api';

const bridge: Bridge = {
  call: (path, args) => ipcRenderer.invoke(IPC_CALL, path, args),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: AppEvent): void => listener(event);
    ipcRenderer.on(IPC_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT, handler);
  }
};

contextBridge.exposeInMainWorld('bridge', bridge);
