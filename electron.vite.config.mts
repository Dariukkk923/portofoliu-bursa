import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const dir = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  '@shared': dir('./src/shared'),
  '@main': dir('./src/main'),
  '@': dir('./src/renderer/src')
};

/**
 * Politica de securitate a conținutului se adaugă doar la build: în dezvoltare,
 * Vite are nevoie de scripturi inline pentru reîncărcarea la cald.
 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'";
const cspPlugin: Plugin = {
  name: 'portofoliu-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
};

// Trei bundle-uri: procesul principal (Node), scriptul preload și interfața (React).
// Dependențele din "dependencies" (better-sqlite3, bcryptjs, yahoo-finance2) rămân
// externe și sunt încărcate din node_modules la rulare.
export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss(), cspPlugin],
    // Interfața se încarcă de pe disc, deci un singur fișier JS mai mare nu este o problemă.
    build: { minify: true, chunkSizeWarningLimit: 1500 }
  }
});
