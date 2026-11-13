/// <reference types="vite/client" />
import type { Bridge } from '@shared/api';

declare global {
  /** Versiunea aplicației, pusă la build (vite.web.config.mts). */
  const __APP_VERSION__: string;
  interface Window {
    bridge: Bridge;
  }
}

export {};
