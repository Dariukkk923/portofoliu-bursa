/** Import și export CSV pentru istoricul tranzacțiilor. */
import type { AssetType, CsvImportResult, TransactionFilters, TransactionInput, TransactionType } from '@shared/types';
import { ASSET_TYPE_LABEL, TRANSACTION_TYPE_LABEL } from '@shared/labels';
import {
  CSV_COLUMNS,
  normalizeKey,
  parseAssetType,
  parseCsv,
  parseNumberLoose,
  parseTransactionType,
  toCsv,
  usesDecimalComma,
  type CsvColumn
} from '@shared/csv';
import { parseDateLoose } from '@shared/dates';
import { parseSplitRatio } from '@shared/calc';
import type { Db } from '../db/database';
import { AppError } from './common';
import { findAssetBySymbol, findOrCreateAsset, listAssets, normalizeSymbol } from './assets';
import { createBroker, findBrokerByName } from './brokers';
import { createTransaction, listTransactions } from './transactions';

/** Exportă tranzacțiile (opțional filtrate) în ordine cronologică. */
export function exportTransactionsCsv(db: Db, userId: number, filters: TransactionFilters = {}): { csv: string; count: number } {
  const assets = new Map(listAssets(db, userId).map((a) => [a.id, a]));
  const txs = listTransactions(db, userId, filters).reverse();
  const rows: (string | number | null)[][] = [[...CSV_COLUMNS]];
  for (const t of txs) {
    const a = assets.get(t.assetId);
    const trade = t.type === 'buy' || t.type === 'sell';
    const income = t.type === 'dividend' || t.type === 'coupon';
    rows.push([
      t.date,
      TRANSACTION_TYPE_LABEL[t.type],
      ASSET_TYPE_LABEL[t.assetType],
      t.symbol,
      t.assetName,
      t.brokerName ?? '',
      trade ? t.quantity : '',
      trade ? t.price : '',
      trade ? t.fee : '',
      t.currency,
      income ? t.grossAmount : '',
      income ? t.taxWithheld : '',
      income ? t.netAmount : '',
      t.type === 'split' ? `${t.splitNumerator}:${t.splitDenominator}` : '',
      t.notes ?? '',
      a?.faceValue ?? '',
      a?.couponRate ?? '',
      a?.couponFrequency ?? '',
      a?.maturityDate ?? ''
    ]);
  }
  // BOM-ul face ca Excel să recunoască diacriticele (UTF-8).
  return { csv: '﻿' + toCsv(rows), count: txs.length };
}

interface PendingRow {
  line: number;
  date: string;
  type: TransactionType;
  symbol: string;
  cells: (column: CsvColumn) => string;
}

const TYPE_ORDER: Record<TransactionType, number> = { split: 0, buy: 1, sell: 2, dividend: 3, coupon: 3 };

/** Semnal intern: anulează tranzacția SQL când importul are erori. */
class Rollback extends Error {}

/**
 * Importă tranzacții dintr-un CSV cu antetul din `CSV_COLUMNS` (ordinea
 * coloanelor nu contează; obligatorii sunt data, tip și simbol). Brokerii și
 * activele care lipsesc sunt create automat. Importul este „totul sau nimic”:
 * dacă un singur rând are o eroare, nu se salvează nimic.
 */
export function importTransactionsCsv(db: Db, userId: number, text: string): CsvImportResult {
  const result: CsvImportResult = { imported: 0, errors: [], createdAssets: 0, createdBrokers: 0 };
  const rows = parseCsv(text);
  if (rows.length < 2) {
    result.errors.push({ line: 1, message: 'Fișierul nu conține tranzacții (lipsește antetul sau rândurile de date).' });
    return result;
  }

  const header = rows[0].map(normalizeKey);
  const indexOf = new Map<CsvColumn, number>();
  for (const col of CSV_COLUMNS) {
    const i = header.indexOf(normalizeKey(col));
    if (i >= 0) indexOf.set(col, i);
  }
  for (const required of ['data', 'tip', 'simbol'] as const) {
    if (!indexOf.has(required)) {
      result.errors.push({ line: 1, message: `Lipsește coloana obligatorie „${required}” din antet.` });
    }
  }
  if (result.errors.length > 0) return result;

  // Pasul 1: citim câmpurile de bază ale fiecărui rând.
  const pending: PendingRow[] = [];
  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    const cells = (column: CsvColumn): string => {
      const idx = indexOf.get(column);
      return idx === undefined ? '' : (row[idx] ?? '').trim();
    };
    const date = parseDateLoose(cells('data'));
    const type = parseTransactionType(cells('tip'));
    const symbol = normalizeSymbol(cells('simbol'));
    if (!date) return void result.errors.push({ line, message: `Dată invalidă: „${cells('data')}”.` });
    if (!type) return void result.errors.push({ line, message: `Tip de tranzacție necunoscut: „${cells('tip')}”.` });
    if (!symbol) return void result.errors.push({ line, message: 'Lipsește simbolul.' });
    pending.push({ line, date, type, symbol, cells });
  });
  if (result.errors.length > 0) return result;

  // Tranzacțiile se inserează cronologic, ca o vânzare să-și găsească cumpărarea deja salvată.
  pending.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.line - b.line
  );

  // Format european (virgulă zecimală)? Atunci punctele sunt separatori de mii în tot fișierul.
  const NUMERIC: CsvColumn[] = ['cantitate', 'pret', 'comision', 'suma_bruta', 'impozit', 'suma_neta', 'valoare_nominala', 'rata_cupon'];
  const decimalComma = usesDecimalComma(pending.flatMap((p) => NUMERIC.map((c) => p.cells(c))));
  const num = (p: PendingRow, column: CsvColumn): number | undefined =>
    parseNumberLoose(p.cells(column), decimalComma) ?? undefined;

  // Pasul 2: inserăm totul într-o singură tranzacție SQL.
  try {
    db.transaction(() => {
      for (const p of pending) {
        try {
          // Broker (opțional doar la split).
          let brokerId: number | null = null;
          const brokerName = p.cells('broker');
          if (brokerName) {
            let broker = findBrokerByName(db, userId, brokerName);
            if (!broker) {
              broker = createBroker(db, userId, { name: brokerName });
              result.createdBrokers++;
            }
            brokerId = broker.id;
          }

          // Activ: existent sau creat din coloanele tip_activ + moneda.
          const existing = findAssetBySymbol(db, userId, p.symbol);
          const typeText = p.cells('tip_activ');
          const assetType: AssetType | null = typeText ? parseAssetType(typeText) : (existing?.type ?? null);
          const currency = (p.cells('moneda') || existing?.currency || '').toUpperCase();
          if (typeText && !assetType) throw new AppError(`Tip de activ necunoscut: „${typeText}”.`);
          if (!assetType || !currency) {
            throw new AppError(`Activul ${p.symbol} nu există încă: completează coloanele „tip_activ” și „moneda”.`);
          }
          const { asset, created } = findOrCreateAsset(db, userId, {
            type: assetType,
            symbol: p.symbol,
            name: p.cells('nume'),
            currency,
            faceValue: num(p, 'valoare_nominala') ?? 100,
            couponRate: num(p, 'rata_cupon') ?? 0,
            couponFrequency: num(p, 'frecventa_cupon') ?? 1,
            maturityDate: parseDateLoose(p.cells('data_scadenta'))
          });
          if (created) result.createdAssets++;

          const input: TransactionInput = {
            assetId: asset.id,
            brokerId,
            type: p.type,
            date: p.date,
            notes: p.cells('note') || null
          };
          if (p.type === 'buy' || p.type === 'sell') {
            input.quantity = num(p, 'cantitate');
            input.price = num(p, 'pret');
            input.fee = num(p, 'comision') ?? 0;
          } else if (p.type === 'split') {
            const ratio = parseSplitRatio(p.cells('raport_split'));
            if (!ratio) throw new AppError(`Raport de split invalid: „${p.cells('raport_split')}” (exemplu: 4:1).`);
            input.splitNumerator = ratio.numerator;
            input.splitDenominator = ratio.denominator;
          } else {
            const tax = num(p, 'impozit') ?? 0;
            const net = num(p, 'suma_neta');
            // Dacă lipsește suma brută, o deducem din net + impozit.
            input.grossAmount = num(p, 'suma_bruta') ?? (net !== undefined ? net + tax : undefined);
            input.taxWithheld = tax;
          }
          createTransaction(db, userId, input);
          result.imported++;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          result.errors.push({ line: p.line, message: err.message });
        }
      }
      if (result.errors.length > 0) throw new Rollback();
    })();
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    result.imported = 0;
    result.createdAssets = 0;
    result.createdBrokers = 0;
    result.errors.sort((a, b) => a.line - b.line);
  }
  return result;
}
