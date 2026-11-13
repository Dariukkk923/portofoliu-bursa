/**
 * Înlocuiește `inflateRawSync` din `node:zlib` în browser (citirea fișierelor .xlsx, care sunt ZIP).
 * Decompresor DEFLATE după algoritmul „puff”: scurt și corect; viteza e suficientă pentru extrase de cont.
 */
import { WebBuffer } from './buffer';

interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function build(lengths: number[], n: number): Huffman {
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  const symbol = new Uint16Array(n);
  for (let sym = 0; sym < n; sym++) if (lengths[sym] !== 0) symbol[offs[lengths[sym]]++] = sym;
  return { count, symbol };
}

let fixedTables: { lit: Huffman; dist: Huffman } | null = null;
function fixed(): { lit: Huffman; dist: Huffman } {
  if (!fixedTables) {
    const l: number[] = [];
    for (let i = 0; i < 288; i++) l.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
    fixedTables = { lit: build(l, 288), dist: build(new Array(30).fill(5), 30) };
  }
  return fixedTables;
}

export function inflateRawSync(src: Uint8Array, options?: { maxOutputLength?: number }): WebBuffer {
  const max = options?.maxOutputLength ?? Infinity;
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let outLen = 0;
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const bits = (need: number): number => {
    let val = bitBuf;
    while (bitCnt < need) {
      if (pos >= src.length) throw new Error('date comprimate incomplete');
      val |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    bitBuf = val >>> need;
    bitCnt -= need;
    return val & ((1 << need) - 1);
  };

  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('cod Huffman invalid');
  };

  const put = (byte: number): void => {
    if (outLen >= max) throw new Error('rezultat prea mare');
    if (outLen === out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[outLen++] = byte;
  };

  const codes = (lit: Huffman, dist: Huffman): void => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        put(sym);
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new Error('simbol invalid');
        const len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
        const ds = decode(dist);
        if (ds >= 30) throw new Error('distanță invalidă');
        const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
        if (d > outLen) throw new Error('distanță prea mare');
        for (let i = 0; i < len; i++) put(out[outLen - d]);
      }
    }
  };

  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error('bloc incomplet');
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error('bloc incomplet');
      for (let i = 0; i < len; i++) put(src[pos++]);
    } else if (type === 1) {
      const t = fixed();
      codes(t.lit, t.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const lengths = new Array<number>(320).fill(0);
      for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]] = bits(3);
      const clh = build(lengths, 19);
      const all = new Array<number>(320).fill(0);
      let idx = 0;
      while (idx < nlen + ndist) {
        const sym = decode(clh);
        if (sym < 16) {
          all[idx++] = sym;
        } else {
          let prev = 0;
          let rep: number;
          if (sym === 16) {
            if (idx === 0) throw new Error('lungime lipsă');
            prev = all[idx - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) {
            rep = 3 + bits(3);
          } else {
            rep = 11 + bits(7);
          }
          if (idx + rep > nlen + ndist) throw new Error('prea multe lungimi');
          while (rep--) all[idx++] = prev;
        }
      }
      codes(build(all.slice(0, nlen), nlen), build(all.slice(nlen, nlen + ndist), ndist));
    } else {
      throw new Error('tip de bloc invalid');
    }
  } while (!last);

  return new WebBuffer(out.buffer as ArrayBuffer, 0, outLen);
}
