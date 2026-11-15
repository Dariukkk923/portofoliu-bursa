import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Testele rulează în Node (fără Electron): modulul de calcul este pur, iar
// serviciile bazei de date nu depind de API-urile Electron.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': dir('./src/shared'),
      '@main': dir('./src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Derivarea cheilor de sincronizare (PBKDF2, 310.000 de iterații) și bcrypt sunt lente intenționat;
    // pe mașinile GitHub Actions un test cu mai multe autentificări depășește limita implicită de 5 s.
    testTimeout: 60_000
  }
});
