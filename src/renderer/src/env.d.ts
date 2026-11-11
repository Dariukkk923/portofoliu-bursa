/// <reference types="vite/client" />
import type { Bridge } from '@shared/api';

declare global {
  interface Window {
    /** Expus de scriptul preload (vezi src/preload/index.ts). */
    bridge: Bridge;
  }
}

export {};
