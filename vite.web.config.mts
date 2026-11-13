import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const dir = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(dir('./package.json'), 'utf8')) as { version: string };

/** Același cod ca pe desktop: aliasurile arată spre aceleași foldere, iar modulele doar-pentru-desktop sunt înlocuite. */
const shims = dir('./src/web/shims');
const alias = [
  { find: /^electron$/, replacement: `${shims}/node-stubs.ts` },
  { find: /^node:(fs|os|path)$/, replacement: `${shims}/node-stubs.ts` },
  { find: /^node:crypto$/, replacement: `${shims}/node-crypto.ts` },
  { find: /^node:zlib$/, replacement: `${shims}/node-zlib.ts` },
  { find: /^better-sqlite3$/, replacement: `${shims}/better-sqlite3.ts` },
  { find: /^@\/webExtras$/, replacement: dir('./src/web/ui/Extras.tsx') },
  { find: /^@shared/, replacement: dir('./src/shared') },
  { find: /^@main/, replacement: dir('./src/main') },
  { find: /^@\//, replacement: dir('./src/renderer/src') + '/' }
];

/** Fără scripturi inline; baza SQLite din WebAssembly cere 'wasm-unsafe-eval'; prețurile vin de la providerii din Setări și de la proxy (https). */
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'";
const cspPlugin: Plugin = {
  name: 'portofoliu-web-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
};

/** Completează în sw.js lista fișierelor din build (pentru cache) și o versiune care se schimbă odată cu ele. */
function swPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'portofoliu-sw',
    apply: 'build',
    configResolved: (c) => {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(relative(outDir, full).replace(/\\/g, '/'));
        }
      };
      walk(outDir);
      // Ce e esențial la pornire se pune în cache de la început; iconițele crypto (sute de fișiere mici) și
      // fonturile rare se adaugă în cache abia când sunt cerute.
      const core = (f: string): boolean =>
        f !== 'sw.js' &&
        !f.endsWith('.svg') &&
        !(/\.woff2$/.test(f) && !/inter-latin(-ext)?-/.test(f)) &&
        !(/^assets\/.+\.js$/.test(f) && !/^assets\/(index|worker)-/.test(f) && statSync(join(outDir, f)).size < 20_000);
      const precache = files.filter(core).sort();
      const hash = createHash('sha1');
      for (const f of precache) hash.update(f).update(readFileSync(join(outDir, f)));
      const sw = join(outDir, 'sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8').replace('__BUILD_ID__', hash.digest('hex').slice(0, 12)).replace('__PRECACHE__', JSON.stringify(precache)));
    }
  };
}

// Build-ul web (PWA): `npm run build:web`. Ieșirea merge în dist-web, pentru GitHub Pages.
// Baza se poate schimba cu WEB_BASE (implicit numele depozitului).
export default defineConfig({
  root: dir('./src/web'),
  base: process.env.WEB_BASE ?? '/portofoliu-bursa/',
  publicDir: dir('./src/web/public'),
  resolve: { alias },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), tailwindcss(), cspPlugin, swPlugin()],
  worker: { format: 'es' },
  build: { outDir: dir('./dist-web'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2500 }
});
