/**
 * Cutia de secrete folosită în aplicație: `safeStorage` din Electron, adică
 * depozitul de chei al sistemului de operare (DPAPI pe Windows, Keychain pe
 * macOS, libsecret/kwallet pe Linux). Datele criptate astfel pot fi citite doar
 * de același utilizator al sistemului, pe același calculator.
 *
 * Pe sistemele fără depozit de chei (unele distribuții Linux) se folosește
 * AES-256-GCM cu o cheie aleatoare păstrată într-un fișier din folderul de date.
 */
import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createAesBox, type SecretBox } from './secrets';

const SAFE_PREFIX = 'ss1:';

function safeStorageUsable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // Pe Linux, „basic_text” înseamnă că nu există un depozit de chei real.
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    return false;
  }
}

export function createElectronSecretBox(dataDir: string): SecretBox {
  let fallback: SecretBox | null = null;
  const aes = (): SecretBox => {
    if (!fallback) {
      const keyFile = join(dataDir, 'local.key');
      if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
      fallback = createAesBox(readFileSync(keyFile));
    }
    return fallback;
  };

  return {
    encrypt(plain) {
      if (safeStorageUsable()) return SAFE_PREFIX + safeStorage.encryptString(plain).toString('base64');
      return aes().encrypt(plain);
    },
    decrypt(stored) {
      if (stored.startsWith(SAFE_PREFIX)) {
        try {
          return safeStorage.decryptString(Buffer.from(stored.slice(SAFE_PREFIX.length), 'base64'));
        } catch {
          return null;
        }
      }
      return aes().decrypt(stored);
    }
  };
}
