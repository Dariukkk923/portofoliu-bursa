/**
 * Citire și scriere CSV (RFC 4180), fără dependențe.
 * La citire se acceptă atât virgula, cât și punct-virgula ca separator
 * (Excel în limba română exportă cu „;”) și zecimale cu punct sau virgulă.
 */
import type { AssetType, TransactionType } from './types';

/** Coloanele fișierului de tranzacții, în ordinea în care sunt exportate. */
export const CSV_COLUMNS = [
  'data',
  'tip',
  'tip_activ',
  'simbol',
  'nume',
  'broker',
  'cantitate',
  'pret',
  'comision',
  'moneda',
  'suma_bruta',
  'impozit',
  'suma_neta',
  'raport_split',
  'note',
  'valoare_nominala',
  'rata_cupon',
  'frecventa_cupon',
  'data_scadenta',
  'portofoliu'
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** Ghicește separatorul după prima linie (în afara ghilimelelor). */
function detectDelimiter(text: string): string {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === ',') commas++;
    else if (!inQuotes && ch === ';') semicolons++;
    else if (!inQuotes && ch === '\t') tabs++;
    else if (!inQuotes && ch === '\n') break;
  }
  if (tabs > commas && tabs > semicolons) return '\t';
  return semicolons > commas ? ';' : ',';
}

/** Împarte textul în rânduri și celule. Liniile complet goale sunt ignorate. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // BOM
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const endRow = (): void => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'; // ghilimele dublate = o ghilimea literală
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function escapeCell(value: string | number | null | undefined, delimiter: string): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')
    ? `"${s.replaceAll('"', '""')}"`
    : s;
}

export function toCsv(rows: (string | number | null | undefined)[][], delimiter = ','): string {
  return rows.map((r) => r.map((c) => escapeCell(c, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

const DIGITS = '0123456789';

/**
 * Interpretează un număr scris cu punct sau virgulă zecimală („1234.56”,
 * „1234,56”, „1.234,56”, „1,234.56”). Întoarce null pentru text gol sau invalid.
 *
 * „1.000” este ambiguu (o mie sau unu?). Cu `decimalComma = true` — fișier în
 * format european, vezi `usesDecimalComma` — punctele sunt separatori de mii.
 */
export function parseNumberLoose(text: string | undefined | null, decimalComma = false): number | null {
  if (text === undefined || text === null) return null;
  // Eliminăm spațiile (inclusiv cele nedespărțitoare, folosite uneori la mii) și semnul de procent.
  let s = [...text].filter((ch) => ch.trim() !== '').join('');
  if (s.endsWith('%')) s = s.slice(0, -1);
  if (s === '') return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (decimalComma) {
    s = s.replaceAll('.', '').replace(',', '.');
  } else if (lastComma >= 0 && lastDot >= 0) {
    // Ambele apar: ultimul este separatorul zecimal, celălalt grupează miile.
    s = lastComma > lastDot ? s.replaceAll('.', '').replace(',', '.') : s.replaceAll(',', '');
  } else if (lastComma >= 0) {
    s = s.replace(',', '.');
  }

  // Formă acceptată: semn opțional, cifre și cel mult un punct zecimal.
  const body = s.startsWith('-') ? s.slice(1) : s;
  const parts = body.split('.');
  const onlyDigits = (p: string): boolean => [...p].every((ch) => DIGITS.includes(ch));
  if (parts.length > 2 || !parts.every(onlyDigits) || parts[parts.length - 1] === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detectează formatul european al unui fișier: dacă vreo celulă numerică folosește
 * virgula ca separator zecimal (ex.: „0,621”) fără să conțină și un punct după ea,
 * punctele din tot fișierul sunt tratate ca separatori de mii.
 */
export function usesDecimalComma(cells: string[]): boolean {
  return cells.some((cell) => {
    const c = cell.trim();
    const comma = c.lastIndexOf(',');
    if (comma <= 0 || comma !== c.indexOf(',')) return false; // exact o virgulă, nu pe prima poziție
    return c.lastIndexOf('.') < comma && parseNumberLoose(c, true) !== null;
  });
}

/** Litere mici, fără diacritice și fără spații: „Vânzare” -> „vanzare”. */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

const TX_TYPE_ALIASES: Record<string, TransactionType> = {
  cumparare: 'buy',
  buy: 'buy',
  vanzare: 'sell',
  sell: 'sell',
  dividend: 'dividend',
  dividendincasat: 'dividend',
  cupon: 'coupon',
  coupon: 'coupon',
  cuponincasat: 'coupon',
  split: 'split',
  depunere: 'deposit',
  deposit: 'deposit',
  alimentare: 'deposit',
  retragere: 'withdrawal',
  withdrawal: 'withdrawal',
  comision: 'fee',
  fee: 'fee',
  taxa: 'fee',
  dobanda: 'interest',
  interest: 'interest',
  ajustare: 'adjustment',
  ajustaresold: 'adjustment',
  adjustment: 'adjustment'
};

const ASSET_TYPE_ALIASES: Record<string, AssetType> = {
  actiune: 'stock',
  actiuni: 'stock',
  stock: 'stock',
  etf: 'etf',
  etfuri: 'etf',
  obligatiune: 'bond',
  obligatiuni: 'bond',
  bond: 'bond',
  crypto: 'crypto',
  cripto: 'crypto',
  criptomoneda: 'crypto'
};

export const parseTransactionType = (text: string): TransactionType | null => TX_TYPE_ALIASES[normalizeKey(text)] ?? null;
export const parseAssetType = (text: string): AssetType | null => ASSET_TYPE_ALIASES[normalizeKey(text)] ?? null;
