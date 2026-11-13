/** Punctul de intrare al versiunii web: pornește backendul din browser, apoi aceeași interfață ca pe desktop. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import '@fontsource-variable/inter';
import './web.css';
import { createWebClient } from './client';
import { registerServiceWorker } from './sw-register';
import { WebChrome } from './ui/WebChrome';
import { setWebClient } from './ui/webClient';

const client = createWebClient();
// Interfața vorbește cu `window.bridge` (ca în Electron); aici îl înlocuiește backendul din browser.
window.bridge = client.bridge;
setWebClient(client);

let applyUpdate: (() => void) | null = null;
const updateListeners = new Set<() => void>();
registerServiceWorker((apply) => {
  applyUpdate = apply;
  updateListeners.forEach((l) => l());
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
    <WebChrome
      subscribeUpdate={(l) => {
        updateListeners.add(l);
        return () => updateListeners.delete(l);
      }}
      getUpdate={() => applyUpdate}
    />
  </StrictMode>
);
