/**
 * Istoricul tranzacțiilor: listare cu filtre, adăugare, editare, ștergere.
 *
 * Înainte de orice scriere, istoricul activului este „rejucat” cu modificarea
 * propusă; dacă vreo vânzare ar depăși cantitatea deținută la acel broker în
 * acel moment, operațiunea este respinsă. Asta acoperă și cazurile indirecte:
 * ștergerea unei cumpărări sau mutarea unei date care ar invalida o vânzare ulterioară.
 */
import type {
  Asset,
  PurchaseInput,
  Transaction,
  TransactionFilters,
  TransactionInput,
  TransactionType,
  TransactionView
} from '@shared/types';
import { TRANSACTION_TYPES } from '@shared/types';
import { formatQuantityPlain } from '@shared/labels';
import { isIsoDate, todayIso } from '@shared/dates';
import { validateLedger, type LedgerTx } from '@shared/calc';
import type { Db } from '../db/database';
import { AppError, assert, isFiniteNumber, rowToLedgerTx, rowToTransaction } from './common';
import { findOrCreateAsset, getAsset } from './assets';
import { getBroker } from './brokers';

/** Valorile efective ale unei tranzacții, după validare (câmpurile nefolosite de tip sunt puse pe zero). */
interface CleanTx {
  assetId: number;
  brokerId: number | null;
  type: TransactionType;
  date: string;
  quantity: number;
  price: number;
  fee: number;
  grossAmount: number;
  taxWithheld: number;
  netAmount: number;
  splitNumerator: number | null;
  splitDenominator: number | null;
  notes: string | null;
}

const nonNegative = (v: unknown, label: string): number => {
  const n = v ?? 0;
  assert(isFiniteNumber(n) && n >= 0, `${label} nu poate fi negativ.`);
  return n;
};

const positive = (v: unknown, label: string): number => {
  assert(isFiniteNumber(v) && v > 0, `${label} trebuie să fie mai mare decât zero.`);
  return v;
};

/** Validează câmpurile în funcție de tipul tranzacției. */
function cleanInput(db: Db, userId: number, input: TransactionInput): { tx: CleanTx; asset: Asset } {
  assert(TRANSACTION_TYPES.includes(input.type), 'Tip de tranzacție necunoscut.');
  const asset = getAsset(db, userId, input.assetId);
  assert(asset, 'Activul nu a fost găsit.');
  assert(isIsoDate(input.date), 'Data tranzacției nu este validă.');
  assert(input.date <= todayIso(), 'Data tranzacției nu poate fi în viitor.');

  const brokerId: number | null = input.brokerId ?? null;
  if (brokerId !== null) assert(getBroker(db, userId, brokerId), 'Brokerul nu a fost găsit.');
  assert(input.type === 'split' || brokerId !== null, 'Alege brokerul.');

  const tx: CleanTx = {
    assetId: asset.id,
    brokerId,
    type: input.type,
    date: input.date,
    quantity: 0,
    price: 0,
    fee: 0,
    grossAmount: 0,
    taxWithheld: 0,
    netAmount: 0,
    splitNumerator: null,
    splitDenominator: null,
    notes: input.notes?.trim() ? input.notes.trim().slice(0, 500) : null
  };

  switch (input.type) {
    case 'buy':
    case 'sell':
      tx.quantity = positive(input.quantity, 'Cantitatea');
      tx.price = nonNegative(input.price, 'Prețul');
      tx.fee = nonNegative(input.fee, 'Comisionul');
      break;
    case 'dividend':
    case 'coupon': {
      assert(
        input.type === 'coupon' ? asset.type === 'bond' : asset.type !== 'bond',
        input.type === 'coupon'
          ? 'Cupoanele se pot înregistra doar pentru obligațiuni.'
          : 'Pentru obligațiuni înregistrează un cupon, nu un dividend.'
      );
      tx.grossAmount = positive(input.grossAmount, 'Suma brută');
      tx.taxWithheld = nonNegative(input.taxWithheld, 'Impozitul reținut');
      assert(tx.taxWithheld <= tx.grossAmount, 'Impozitul reținut nu poate depăși suma brută.');
      // Suma netă este întotdeauna brut − impozit, ca cele trei valori să rămână coerente.
      tx.netAmount = tx.grossAmount - tx.taxWithheld;
      break;
    }
    case 'split':
      assert(asset.type !== 'bond', 'Split-ul nu se aplică obligațiunilor.');
      tx.splitNumerator = positive(input.splitNumerator, 'Raportul de split');
      tx.splitDenominator = positive(input.splitDenominator, 'Raportul de split');
      assert(tx.splitNumerator !== tx.splitDenominator, 'Un split 1:1 nu schimbă nimic.');
      break;
  }
  return { tx, asset };
}

/** Toate tranzacțiile unui activ, în forma cerută de motorul de calcul. */
export function ledgerOf(db: Db, userId: number, assetId: number): LedgerTx[] {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND asset_id = ?').all(userId, assetId) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToLedgerTx);
}

/** Aruncă o eroare explicită dacă istoricul rezultat ar conține o vânzare fără acoperire. */
function ensureValidLedger(db: Db, userId: number, asset: Asset, txs: LedgerTx[]): void {
  const err = validateLedger(txs);
  if (!err) return;
  const broker = err.tx.brokerId != null ? getBroker(db, userId, err.tx.brokerId)?.name : null;
  throw new AppError(
    `Nu poți vinde mai mult decât deții: vânzarea de ${formatQuantityPlain(err.tx.quantity)} ${asset.symbol} din ${err.tx.date}` +
      `${broker ? ` (${broker})` : ''} ar depăși cantitatea deținută la acel broker în acel moment (${formatQuantityPlain(err.available)}).`
  );
}

/** Un split schimbă prețurile istorice ajustate, deci istoricul salvat al simbolului trebuie descărcat din nou. */
function invalidateHistory(db: Db, userId: number, symbol: string): void {
  db.prepare('DELETE FROM price_history WHERE user_id = ? AND symbol = ?').run(userId, symbol);
  db.prepare('DELETE FROM history_sync WHERE user_id = ? AND symbol = ?').run(userId, symbol);
}

const toLedger = (id: number, tx: CleanTx): LedgerTx => ({ id, ...tx });

export function getTransaction(db: Db, userId: number, id: number): Transaction | null {
  const r = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, userId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToTransaction(r) : null;
}

export function listTransactions(db: Db, userId: number, filters: TransactionFilters = {}): TransactionView[] {
  const where = ['t.user_id = @userId'];
  const params: Record<string, unknown> = { userId };
  if (filters.type) {
    where.push('t.type = @type');
    params.type = filters.type;
  }
  if (filters.assetType) {
    where.push('a.type = @assetType');
    params.assetType = filters.assetType;
  }
  if (filters.symbol?.trim()) {
    where.push("a.symbol LIKE @symbol ESCAPE '\\'");
    params.symbol = `%${filters.symbol.trim().replace(/[\\%_]/g, '\\$&')}%`;
  }
  if (filters.brokerId) {
    where.push('t.broker_id = @brokerId');
    params.brokerId = filters.brokerId;
  }
  if (filters.dateFrom) {
    where.push('t.date >= @dateFrom');
    params.dateFrom = filters.dateFrom;
  }
  if (filters.dateTo) {
    where.push('t.date <= @dateTo');
    params.dateTo = filters.dateTo;
  }
  const rows = db
    .prepare(
      `SELECT t.*, a.symbol, a.name AS asset_name, a.type AS asset_type, b.name AS broker_name
       FROM transactions t
       JOIN assets a ON a.id = t.asset_id
       LEFT JOIN brokers b ON b.id = t.broker_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.date DESC, t.id DESC`
    )
    .all(params) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...rowToTransaction(r),
    symbol: r.symbol as string,
    assetName: r.asset_name as string,
    assetType: r.asset_type as TransactionView['assetType'],
    brokerName: (r.broker_name as string | null) ?? null
  }));
}

function insert(db: Db, userId: number, tx: CleanTx, currency: string, externalId: string | null = null): number {
  const info = db
    .prepare(
      `INSERT INTO transactions (user_id, asset_id, broker_id, type, date, quantity, price, fee, currency,
         gross_amount, tax_withheld, net_amount, split_numerator, split_denominator, notes, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      tx.assetId,
      tx.brokerId,
      tx.type,
      tx.date,
      tx.quantity,
      tx.price,
      tx.fee,
      currency,
      tx.grossAmount,
      tx.taxWithheld,
      tx.netAmount,
      tx.splitNumerator,
      tx.splitDenominator,
      tx.notes,
      externalId
    );
  return Number(info.lastInsertRowid);
}

export function createTransaction(db: Db, userId: number, input: TransactionInput): Transaction {
  const { tx, asset } = cleanInput(db, userId, input);
  // Tranzacția nouă primește un id provizoriu mai mare decât toate celelalte.
  ensureValidLedger(db, userId, asset, [...ledgerOf(db, userId, asset.id), toLedger(Number.MAX_SAFE_INTEGER, tx)]);
  const id = db.transaction(() => {
    const newId = insert(db, userId, tx, asset.currency);
    if (tx.type === 'split') invalidateHistory(db, userId, asset.symbol);
    return newId;
  })();
  return getTransaction(db, userId, id) as Transaction;
}

export function updateTransaction(db: Db, userId: number, id: number, input: TransactionInput): Transaction {
  const existing = getTransaction(db, userId, id);
  assert(existing, 'Tranzacția nu a fost găsită.');
  const { tx, asset } = cleanInput(db, userId, input);

  // Dacă tranzacția a fost mutată pe alt activ, verificăm și istoricul activului vechi, fără ea.
  if (existing.assetId !== asset.id) {
    const oldAsset = getAsset(db, userId, existing.assetId) as Asset;
    ensureValidLedger(
      db,
      userId,
      oldAsset,
      ledgerOf(db, userId, oldAsset.id).filter((t) => t.id !== id)
    );
  }
  ensureValidLedger(db, userId, asset, [
    ...ledgerOf(db, userId, asset.id).filter((t) => t.id !== id),
    toLedger(id, tx)
  ]);

  db.transaction(() => {
    db.prepare(
      `UPDATE transactions SET asset_id = ?, broker_id = ?, type = ?, date = ?, quantity = ?, price = ?, fee = ?,
         currency = ?, gross_amount = ?, tax_withheld = ?, net_amount = ?, split_numerator = ?, split_denominator = ?, notes = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      tx.assetId,
      tx.brokerId,
      tx.type,
      tx.date,
      tx.quantity,
      tx.price,
      tx.fee,
      asset.currency,
      tx.grossAmount,
      tx.taxWithheld,
      tx.netAmount,
      tx.splitNumerator,
      tx.splitDenominator,
      tx.notes,
      id,
      userId
    );
    if (tx.type === 'split' || existing.type === 'split') {
      invalidateHistory(db, userId, asset.symbol);
      if (existing.assetId !== asset.id) {
        invalidateHistory(db, userId, (getAsset(db, userId, existing.assetId) as Asset).symbol);
      }
    }
  })();
  return getTransaction(db, userId, id) as Transaction;
}

export function deleteTransaction(db: Db, userId: number, id: number): void {
  const existing = getTransaction(db, userId, id);
  assert(existing, 'Tranzacția nu a fost găsită.');
  const asset = getAsset(db, userId, existing.assetId) as Asset;
  ensureValidLedger(
    db,
    userId,
    asset,
    ledgerOf(db, userId, asset.id).filter((t) => t.id !== id)
  );
  db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(id, userId);
    if (existing.type === 'split') invalidateHistory(db, userId, asset.symbol);
  })();
}

/**
 * Formularul „Adaugă activ”: creează activul dacă nu există și înregistrează
 * achiziția ca tranzacție de tip Cumpărare, într-o singură tranzacție SQL.
 */
export function addPurchase(db: Db, userId: number, input: PurchaseInput): { asset: Asset; transaction: Transaction } {
  return db.transaction(() => {
    const { asset } = findOrCreateAsset(db, userId, input.asset);
    const transaction = createTransaction(db, userId, {
      assetId: asset.id,
      brokerId: input.brokerId,
      type: 'buy',
      date: input.date,
      quantity: input.quantity,
      price: input.price,
      fee: input.fee,
      notes: input.notes
    });
    return { asset, transaction };
  })();
}

/** O tranzacție de importat în bloc; `externalId` este identificatorul ei din raportul brokerului. */
export type ImportedTransaction = TransactionInput & { externalId?: string | null };

/**
 * Import în bloc (raportul unui broker): inserează toate tranzacțiile, apoi
 * validează o singură dată istoricul fiecărui activ atins. Trebuie apelată
 * într-o tranzacție SQL — dacă validarea eșuează, apelantul anulează tot importul.
 */
export function importTransactions(db: Db, userId: number, inputs: ImportedTransaction[]): number {
  const touched = new Map<number, { asset: Asset; hasSplit: boolean }>();
  for (const input of inputs) {
    const { tx, asset } = cleanInput(db, userId, input);
    insert(db, userId, tx, asset.currency, input.externalId ?? null);
    const entry = touched.get(asset.id) ?? { asset, hasSplit: false };
    entry.hasSplit ||= tx.type === 'split';
    touched.set(asset.id, entry);
  }
  for (const { asset, hasSplit } of touched.values()) {
    ensureValidLedger(db, userId, asset, ledgerOf(db, userId, asset.id));
    if (hasSplit) invalidateHistory(db, userId, asset.symbol);
  }
  return inputs.length;
}
