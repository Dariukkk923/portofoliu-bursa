/**
 * Cititor minimal de fișiere Excel (.xlsx), fără dependențe.
 *
 * Un .xlsx este o arhivă ZIP cu fișiere XML. De aici citim doar ce ne trebuie
 * pentru rapoartele brokerilor: numele foilor și valorile celulelor (text sau
 * număr). Formatările, formulele și stilurile sunt ignorate — o dată salvată
 * ca număr de serie Excel rămâne număr și este interpretată de cel care
 * folosește foaia (vezi `shared/brokers/xtb.ts`).
 */
import { inflateRawSync } from 'node:zlib';

export type Cell = string | number | null;

export interface Sheet {
  name: string;
  /** Rândurile care conțin cel puțin o valoare, în ordine; celulele goale sunt null. */
  rows: Cell[][];
}

/** Fișierul nu este un .xlsx valid (mesajul este pentru jurnal, nu pentru utilizator). */
export class XlsxError extends Error {}

/** Limită de siguranță pentru un fișier dezarhivat (un raport real are câțiva MB). */
const MAX_ENTRY_BYTES = 96 * 1024 * 1024;
/** Coloanele de după aceasta sunt ignorate (rapoartele au cel mult câteva zeci). */
const MAX_COLUMNS = 256;

/* -------------------------------------------------------------------- ZIP */

interface ZipEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Citește directorul central al arhivei: nume de fișier (cu litere mici) -> poziția datelor. */
function readDirectory(buf: Buffer): Map<string, ZipEntry> {
  // Înregistrarea „end of central directory” stă la sfârșit, urmată cel mult de un comentariu.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('arhivă ZIP invalidă');

  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) throw new XlsxError('director ZIP corupt');
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name.toLowerCase(), {
      method: buf.readUInt16LE(pos + 10),
      compressedSize: buf.readUInt32LE(pos + 20),
      localOffset: buf.readUInt32LE(pos + 42)
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== SIG_LOCAL) throw new XlsxError('intrare ZIP coruptă');
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data; // stocat fără compresie
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new XlsxError(`metodă de compresie nesuportată: ${entry.method}`);
}

/* -------------------------------------------------------------------- XML */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_all, name: string) => {
    if (name[0] !== '#') return ENTITIES[name];
    const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** Elimină prefixele de namespace ale elementelor: `<x:row>` devine `<row>`. */
const stripPrefixes = (xml: string): string => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');

function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Textul unui fragment cu elemente `<t>` (text simplu sau formatat pe bucăți). */
function textOf(fragment: string): string {
  // Ghidajele fonetice (<rPh>) nu fac parte din text.
  const clean = fragment.includes('<rPh') ? fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : fragment;
  let text = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decodeEntities(m[1]);
  return text;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) out.push(textOf(m[1] ?? ''));
  return out;
}

/** „B12” -> 1, „AA3” -> 26. */
function columnIndex(ref: string): number {
  let col = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) col = col * 26 + (code - 64);
    else if (code >= 97 && code <= 122) col = col * 26 + (code - 96);
    else break;
  }
  return col - 1;
}

function cellValue(type: string | undefined, body: string, shared: string[]): Cell {
  if (type === 'inlineStr') return textOf(body);
  const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  if (!v) return null;
  const raw = decodeEntities(v[1]);
  switch (type) {
    case 's':
      return shared[Number(raw)] ?? '';
    case 'str':
    case 'd':
      return raw;
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return null; // eroare de formulă (#N/A etc.)
    default: {
      const n = Number(raw);
      return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
    }
  }
}

function parseSheet(xml: string, shared: string[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: Cell[] = [];
    let next = 0;
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = parseAttrs(c[1]);
      const col = attrs.r ? columnIndex(attrs.r) : next;
      next = col + 1;
      if (col < 0 || col >= MAX_COLUMNS) continue;
      const value = cellValue(attrs.t, c[2] ?? '', shared);
      if (value === null || value === '') continue;
      while (cells.length < col) cells.push(null);
      cells[col] = value;
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/* ---------------------------------------------------------------- registru */

/** True dacă datele încep ca o arhivă ZIP (deci pot fi un .xlsx). */
export const looksLikeZip = (data: Buffer): boolean => data.length > 4 && data[0] === 0x50 && data[1] === 0x4b;

/** Citește toate foile unui registru .xlsx. Aruncă `XlsxError` dacă fișierul nu poate fi interpretat. */
export function readXlsx(data: Buffer): Sheet[] {
  const directory = readDirectory(data);
  const xml = (path: string): string | null => {
    const entry = directory.get(path.toLowerCase());
    if (!entry) return null;
    const text = readEntry(data, entry).toString('utf8');
    return stripPrefixes(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  };

  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new XlsxError('lipsește xl/workbook.xml');

  // Legătura dintre foaie și fișierul ei trece prin „relații” (rId -> cale).
  const targets = new Map<string, string>();
  for (const m of (xml('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = parseAttrs(m[1]);
    if (a.Id && a.Target) targets.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`);
  }
  const shared = parseSharedStrings(xml('xl/sharedStrings.xml') ?? '');

  const sheets: Sheet[] = [];
  let index = 0;
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    index++;
    const a = parseAttrs(m[1]);
    const relId = Object.entries(a).find(([key]) => key === 'id' || key.endsWith(':id'))?.[1];
    const content = xml((relId && targets.get(relId)) || `xl/worksheets/sheet${index}.xml`);
    if (content === null) continue;
    sheets.push({ name: a.name ?? `Foaia ${index}`, rows: parseSheet(content, shared) });
  }
  if (sheets.length === 0) throw new XlsxError('registrul nu are nicio foaie');
  return sheets;
}
