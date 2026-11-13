/**
 * Buffer minimal pentru browser: serviciile din src/main folosesc Buffer pentru octeți și text
 * (import de extrase, logo-uri, backup), iar browserul nu are unul. Aici este doar ce se folosește.
 */
export type Encoding = 'utf8' | 'utf-8' | 'latin1' | 'binary' | 'ascii' | 'utf16le' | 'ucs2' | 'base64' | 'base64url' | 'hex';

const utf8 = new TextEncoder();

function encodeString(text: string, encoding: string): Uint8Array {
  switch (encoding) {
    case 'utf8':
    case 'utf-8':
      return utf8.encode(text);
    case 'latin1':
    case 'binary':
    case 'ascii':
      return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
    case 'utf16le':
    case 'ucs2': {
      const out = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        out[i * 2] = text.charCodeAt(i) & 0xff;
        out[i * 2 + 1] = text.charCodeAt(i) >> 8;
      }
      return out;
    }
    case 'hex':
      return Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));
    case 'base64':
    case 'base64url': {
      const std = text.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
    default:
      throw new Error(`Codare nesuportată: ${encoding}`);
  }
}

export class WebBuffer extends Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(value: any, a?: any, b?: any): WebBuffer {
    if (typeof value === 'string') {
      const bytes = encodeString(value, typeof a === 'string' ? a : 'utf8');
      return new WebBuffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      return new WebBuffer(value as ArrayBuffer, typeof a === 'number' ? a : 0, b);
    }
    const copy = Uint8Array.from(value as ArrayLike<number>);
    return new WebBuffer(copy.buffer, copy.byteOffset, copy.length);
  }

  static alloc(size: number): WebBuffer {
    return new WebBuffer(size);
  }

  static concat(list: Uint8Array[]): WebBuffer {
    const out = new WebBuffer(list.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of list) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  static byteLength(text: string, encoding: string = 'utf8'): number {
    return encodeString(text, encoding).length;
  }

  static isBuffer(value: unknown): value is WebBuffer {
    return value instanceof WebBuffer;
  }

  toString(encoding: string = 'utf8', start = 0, end = this.length): string {
    const part = Uint8Array.prototype.subarray.call(this, start, end) as Uint8Array;
    switch (encoding) {
      case 'utf8':
      case 'utf-8':
        return new TextDecoder('utf-8').decode(part);
      case 'utf16le':
      case 'ucs2':
        return new TextDecoder('utf-16le').decode(part);
      case 'latin1':
      case 'binary':
      case 'ascii': {
        let s = '';
        for (const byte of part) s += String.fromCharCode(byte);
        return s;
      }
      case 'hex':
        return Array.from(part, (x) => x.toString(16).padStart(2, '0')).join('');
      case 'base64':
      case 'base64url': {
        let bin = '';
        for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode(...part.subarray(i, i + 0x8000));
        const b64 = btoa(bin);
        return encoding === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }
      default:
        throw new Error(`Codare nesuportată: ${encoding}`);
    }
  }

  // Uint8Array.subarray întoarce deja un WebBuffer (specia clasei); aici doar tipul.
  subarray(start?: number, end?: number): WebBuffer {
    return super.subarray(start, end) as WebBuffer;
  }

  private view(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  readUInt16LE(at: number): number {
    return this.view().getUint16(at, true);
  }

  readUInt32LE(at: number): number {
    return this.view().getUint32(at, true);
  }

  readUInt32BE(at: number): number {
    return this.view().getUint32(at, false);
  }
}

/** Pune Buffer-ul în spațiul global (o singură dată, înaintea serviciilor). */
export function installBuffer(): void {
  const g = globalThis as unknown as { Buffer?: unknown };
  if (!g.Buffer) g.Buffer = WebBuffer;
}
