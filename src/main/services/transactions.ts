/**
 * Istoricul tranzacțiilor: listare cu filtre, adăugare, editare, ștergere.
 *
 * Înainte de orice scriere, istoricul activului este „rejucat” cu modificarea
 * propusă; dacă vreo vânzare ar depăși cantitatea deținută la acel broker în
 * acel moment, operațiunea este respinsă. Asta acoperă și cazurile indirecte:
 * ștergerea unei cumpărări sau mutarea unei date care ar invalida o vânzare ulterioară.
 *
 * Sumele și cantitățile se salvează ca text zecimal exact (vezi migrarea 3);
 * calculele derivate (ex.: suma netă = brut − impozit) se fac cu aritmetică zecimală.
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
import { CASH_TRANSACTION_TYPES, TRANSACTION_TYPES } from '@shared/types';
import { formatQuantityPlain } from '@shared/labels';
import { isIsoDate, todayIso } from '@shared/dates';
import { validateLedger, type LedgerTx } from '@shared/calc';
import { dec, decText, type DecValue } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { AppError, assert, isFiniteNumber, rowToLedgerTx, rowToTransaction } from './common';
import { findOrCreateAsset, getAsset } from './assets';
import { getBroker } from './brokers';
import { resolvePortfolioId } from './portfolios';

/** Valorile efective ale unei tranzacții, după validare (câmpurile nefolosite de tip sunt puse pe zero). */
interface CleanTx {
  /** Null doar la split-uri: se aplică în toate portofoliile. */
  portfolioId: number | null;
  assetId: number | null;
  brokerId: number | null;
  type: TransactionType;
  date: string;
  currency: string;
  /** Text zecimal exact. */
  quantity: string;
  price: string;
  fee: string;
  grossAmount: string;
  taxWithheld: string;
  netAmount: string;
  splitNumerator: string | null;
  splitDenominator: string | null;
  notes: string | null;
}

/** Câmpurile pe care le completează doar importurile din extrasele brokerilor. */
interface ImportFields {
  cashAmount?: number | string | null;
  cashCurrency?: string | null;
  externalId?: string | null;
  batchId?: number | null;
}

/** Un număr finit sau un text zecimal exact („0.1”, „-12.5”), cum vin sumele din extrasele brokerilor. */
const exact = (v: unknown): DecValue | null => {
  if (isFiniteNumber(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return null;
};

const nonNegative = (v: unknown, label: string): DecValue => {
  const n = exact(v ?? 0);
  assert(n !== null && !dec(n).isNegative(), `${label} nu poate fi negativ.`);
  return n;
};

const positive = (v: unknown, label: string): DecValue => {
  const n = exact(v);
  assert(n !== null && dec(n).gt(0), `${label} trebuie să fie mai mare decât zero.`);
  return n;
};

const isCash = (type: TransactionType): boolean => CASH_TRANSACTION_TYPES.includes(type);

/** Validează câmpurile în funcție de tipul tranzacției. */
function cleanInput(db: Db, userId: number, input: ImportedTransaction): { tx: CleanTx; asset: Asset | null } {
  assert(TRANSACTION_TYPES.includes(input.type), 'Tip de tranzacție necunoscut.');
  assert(isIsoDate(input.date), 'Data tranzacției nu este validă.');
  assert(input.date <= todayIso(), 'Data tranzacției nu poate fi în viitor.');

  // Activul: obligatoriu la tranzacțiile cu activ, opțional la comisioane, interzis la celelalte tranzacții de cash.
  const wantsAsset = !isCash(input.type) || (input.type === 'fee' && input.assetId != null);
  let asset: Asset | null = null;
  if (wantsAsset) {
    asset = input.assetId != null ? getAsset(db, userId, input.assetId) : null;
    assert(asset, 'Activul nu a fost găsit.');
  }

  const brokerId: number | null = input.brokerId ?? null;
  if (brokerId !== null) assert(getBroker(db, userId, brokerId), 'Brokerul nu a fost găsit.');
  assert(input.type === 'split' || brokerId !== null, 'Alege brokerul.');

  const currency = asset ? asset.currency : String(input.currency ?? '').trim().toUpperCase();
  assert(/^[A-Z]{3}$/.test(currency), 'Alege moneda (cod de 3 litere, ex.: RON).');

  const tx: CleanTx = {
    // Split-ul este un eveniment al companiei: se aplică în toate portofoliile.
    portfolioId: input.type === 'split' ? null : resolvePortfolioId(db, userId, input.portfolioId),
    assetId: asset?.id ?? null,
    brokerId,
    type: input.type,
    date: input.date,
    currency,
    quantity: '0',
    price: '0',
    fee: '0',
    grossAmount: '0',
    taxWithheld: '0',
    netAmount: '0',
    splitNumerator: null,
    splitDenominator: null,
    notes: input.notes?.trim() ? input.notes.trim().slice(0, 500) : null
  };

  /** Brut, impozit și net (= brut − impozit, calculat exact). */
  const income = (gross: unknown, tax: unknown): void => {
    const g = positive(gross, 'Suma brută');
    const t = nonNegative(tax, 'Impozitul reținut');
    assert(dec(t).lte(dec(g)), 'Impozitul reținut nu poate depăși suma brută.');
    tx.grossAmount = decText(g);
    tx.taxWithheld = decText(t);
    tx.netAmount = decText(dec(g).minus(dec(t)));
  };

  switch (input.type) {
    case 'buy':
    case 'sell':
      tx.quantity = decText(positive(input.quantity, 'Cantitatea'));
      tx.price = decText(nonNegative(input.price, 'Prețul'));
      tx.fee = decText(nonNegative(input.fee, 'Comisionul'));
      break;
    case 'dividend':
    case 'coupon': {
      const a = asset as Asset;
      assert(
        input.type === 'coupon' ? a.type === 'bond' : a.type !== 'bond',
        input.type === 'coupon' ? 'Cupoanele se pot înregistra doar pentru obligațiuni.' : 'Pentru obligațiuni înregistrează un cupon, nu un dividend.'
      );
      income(input.grossAmount, input.taxWithheld);
      break;
    }
    case 'interest':
      income(input.grossAmount ?? input.amount, input.taxWithheld);
      break;
    case 'split':
      assert((asset as Asset).type !== 'bond', 'Split-ul nu se aplică obligațiunilor.');
      tx.splitNumerator = decText(positive(input.splitNumerator, 'Raportul de split'));
      tx.splitDenominator = decText(positive(input.splitDenominator, 'Raportul de split'));
      assert(!dec(tx.splitNumerator).eq(dec(tx.splitDenominator)), 'Un split 1:1 nu schimbă nimic.');
      break;
    case 'deposit':
    case 'withdrawal':
    case 'fee': {
      const amount = decText(positive(input.amount ?? input.netAmount, 'Suma'));
      tx.grossAmount = amount;
      tx.netAmount = amount;
      break;
    }
    case 'adjustment': {
      const amount = exact(input.amount ?? input.netAmount);
      assert(amount !== null && !dec(amount).isZero(), 'Ajustarea trebuie să fie o sumă diferită de zero (cu minus pentru o scădere a soldului).');
      tx.grossAmount = decText(amount);
      tx.netAmount = decText(amount);
      break;
    }
  }
  return { tx, asset };
}

/** Toate tranzacțiile unui activ, în forma cerută de motorul de calcul. */
export function ledgerOf(db: Db, userId: number, assetId: number): LedgerTx[] {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND asset_id = ?').all(userId, assetId) as Record<string, unknown>[];
  return rows.map(rowToLedgerTx);
}

/** Aruncă o eroare explicită dacă istoricul rezultat ar conține o vânzare fără acoperire. */
export function ensureValidLedger(db: Db, userId: number, asset: Asset, txs: LedgerTx[]): void {
  const err = validateLedger(txs);
  if (!err) return;
  const broker = err.tx.brokerId != null ? getBroker(db, userId, err.tx.brokerId)?.name : null;
  throw new AppError(
    `Nu poți vinde mai mult decât deții: vânzarea de ${formatQuantityPlain(Number(err.tx.quantity))} ${asset.symbol} din ${err.tx.date}` +
      `${broker ? ` (${broker})` : ''} ar depăși cantitatea deținută la acel broker, în acel portofoliu, în acel moment (${formatQuantityPlain(err.available)}).`
  );
}

/** Un split schimbă prețurile istorice ajustate, deci istoricul salvat al simbolului trebuie descărcat din nou. */
export function invalidateHistory(db: Db, userId: number, symbol: string): void {
  db.prepare('DELETE FROM price_history WHERE user_id = ? AND symbol = ?').run(userId, symbol);
  db.prepare('DELETE FROM history_sync WHERE user_id = ? AND symbol = ?').run(userId, symbol);
}

const toLedger = (id: number, tx: CleanTx): LedgerTx => ({ id, ...tx });

/** Validarea cantităților are sens doar pentru tranzacțiile care schimbă o poziție. */
const affectsHoldings = (type: TransactionType): boolean => type === 'buy' || type === 'sell' || type === 'split';

export function getTransaction(db: Db, userId: number, id: number): Transaction | null {
  const r = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, userId) as Record<string, unknown> | undefined;
  return r ? rowToTransaction(r) : null;
}

export function listTransactions(db: Db, userId: number, filters: TransactionFilters = {}): TransactionView[] {
  const where = ['t.user_id = @userId'];
  const params: Record<string, unknown> = { userId };
  if (filters.portfolioId) {
    // Split-urile (fără portofoliu) se aplică în toate portofoliile, deci apar peste tot.
    where.push('(t.portfolio_id = @portfolioId OR t.portfolio_id IS NULL)');
    params.portfolioId = filters.portfolioId;
  } else {
    where.push('(t.portfolio_id IS NULL OR p.archived = 0)');
  }
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
      `SELECT t.*, a.symbol, a.name AS asset_name, a.type AS asset_type, b.name AS broker_name, p.name AS portfolio_name
       FROM transactions t
       LEFT JOIN assets a ON a.id = t.asset_id AND a.user_id = t.user_id
       LEFT JOIN brokers b ON b.id = t.broker_id AND b.user_id = t.user_id
       LEFT JOIN portfolios p ON p.id = t.portfolio_id AND p.user_id = t.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.date DESC, t.id DESC`
    )
    .all(params) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...rowToTransaction(r),
    symbol: (r.symbol as string | null) ?? null,
    assetName: (r.asset_name as string | null) ?? null,
    assetType: (r.asset_type as TransactionView['assetType']) ?? null,
    brokerName: (r.broker_name as string | null) ?? null,
    portfolioName: (r.portfolio_name as string | null) ?? null
  }));
}

function insert(db: Db, userId: number, tx: CleanTx, extra: ImportFields = {}): number {
  const cashAmount = extra.cashAmount === null || extra.cashAmount === undefined ? null : decText(extra.cashAmount);
  const info = db
    .prepare(
      `INSERT INTO transactions (user_id, portfolio_id, asset_id, broker_id, type, date, quantity, price, fee, currency,
         gross_amount, tax_withheld, net_amount, split_numerator, split_denominator, notes,
         cash_amount, cash_currency, external_id, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      tx.portfolioId,
      tx.assetId,
      tx.brokerId,
      tx.type,
      tx.date,
      tx.quantity,
      tx.price,
      tx.fee,
      tx.currency,
      tx.grossAmount,
      tx.taxWithheld,
      tx.netAmount,
      tx.splitNumerator,
      tx.splitDenominator,
      tx.notes,
      cashAmount,
      cashAmount === null ? null : (extra.cashCurrency ?? null),
      extra.externalId ?? null,
      extra.batchId ?? null
    );
  return Number(info.lastInsertRowid);
}

export function createTransaction(db: Db, userId: number, input: TransactionInput): Transaction {
  const { tx, asset } = cleanInput(db, userId, input);
  // Tranzacția nouă primește un id provizoriu mai mare decât toate celelalte.
  if (asset && affectsHoldings(tx.type)) {
    ensureValidLedger(db, userId, asset, [...ledgerOf(db, userId, asset.id), toLedger(Number.MAX_SAFE_INTEGER, tx)]);
  }
  const id = db.transaction(() => {
    const newId = insert(db, userId, tx);
    if (tx.type === 'split' && asset) invalidateHistory(db, userId, asset.symbol);
    return newId;
  })();
  return getTransaction(db, userId, id) as Transaction;
}

export function updateTransaction(db: Db, userId: number, id: number, input: TransactionInput): Transaction {
  const existing = getTransaction(db, userId, id);
  assert(existing, 'Tranzacția nu a fost găsită.');
  const { tx, asset } = cleanInput(db, userId, input);
  const oldAsset = existing.assetId != null ? getAsset(db, userId, existing.assetId) : null;

  // Dacă tranzacția a fost mutată pe alt activ, verificăm și istoricul activului vechi, fără ea.
  if (oldAsset && oldAsset.id !== asset?.id) {
    ensureValidLedger(db, userId, oldAsset, ledgerOf(db, userId, oldAsset.id).filter((t) => t.id !== id));
  }
  if (asset) {
    ensureValidLedger(db, userId, asset, [...ledgerOf(db, userId, asset.id).filter((t) => t.id !== id), toLedger(id, tx)]);
  }

  // Suma raportată de broker nu mai corespunde dacă s-au schimbat cifrele tranzacției.
  const sameMoney =
    existing.type === tx.type &&
    dec(existing.quantity).eq(dec(tx.quantity)) &&
    dec(existing.price).eq(dec(tx.price)) &&
    dec(existing.fee).eq(dec(tx.fee)) &&
    dec(existing.netAmount).eq(dec(tx.netAmount));

  db.transaction(() => {
    db.prepare(
      `UPDATE transactions SET portfolio_id = ?, asset_id = ?, broker_id = ?, type = ?, date = ?, quantity = ?, price = ?, fee = ?,
         currency = ?, gross_amount = ?, tax_withheld = ?, net_amount = ?, split_numerator = ?, split_denominator = ?, notes = ?,
         cash_amount = CASE WHEN ? THEN cash_amount ELSE NULL END, cash_currency = CASE WHEN ? THEN cash_currency ELSE NULL END
       WHERE id = ? AND user_id = ?`
    ).run(
      tx.portfolioId,
      tx.assetId,
      tx.brokerId,
      tx.type,
      tx.date,
      tx.quantity,
      tx.price,
      tx.fee,
      tx.currency,
      tx.grossAmount,
      tx.taxWithheld,
      tx.netAmount,
      tx.splitNumerator,
      tx.splitDenominator,
      tx.notes,
      sameMoney ? 1 : 0,
      sameMoney ? 1 : 0,
      id,
      userId
    );
    if (tx.type === 'split' || existing.type === 'split') {
      if (asset) invalidateHistory(db, userId, asset.symbol);
      if (oldAsset && oldAsset.id !== asset?.id) invalidateHistory(db, userId, oldAsset.symbol);
    }
  })();
  return getTransaction(db, userId, id) as Transaction;
}

export function deleteTransaction(db: Db, userId: number, id: number): void {
  const existing = getTransaction(db, userId, id);
  assert(existing, 'Tranzacția nu a fost găsită.');
  const asset = existing.assetId != null ? getAsset(db, userId, existing.assetId) : null;
  if (asset) ensureValidLedger(db, userId, asset, ledgerOf(db, userId, asset.id).filter((t) => t.id !== id));
  db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(id, userId);
    if (existing.type === 'split' && asset) invalidateHistory(db, userId, asset.symbol);
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
      portfolioId: input.portfolioId,
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

type Exact = number | string;
/**
 * O tranzacție de importat în bloc, cu datele din extrasul brokerului. Sumele pot fi
 * și text zecimal exact („0.1”), ca să nu treacă prin virgulă mobilă.
 */
export type ImportedTransaction = Omit<
  TransactionInput,
  'quantity' | 'price' | 'fee' | 'grossAmount' | 'taxWithheld' | 'netAmount' | 'amount' | 'splitNumerator' | 'splitDenominator'
> & {
  quantity?: Exact;
  price?: Exact;
  fee?: Exact;
  grossAmount?: Exact;
  taxWithheld?: Exact;
  netAmount?: Exact;
  amount?: Exact;
  splitNumerator?: Exact | null;
  splitDenominator?: Exact | null;
} & ImportFields;

/**
 * Import în bloc (raportul unui broker): inserează toate tranzacțiile, apoi
 * validează o singură dată istoricul fiecărui activ atins. Trebuie apelată
 * într-o tranzacție SQL — dacă validarea eșuează, apelantul anulează tot importul.
 */
export function importTransactions(db: Db, userId: number, inputs: ImportedTransaction[]): number {
  const touched = new Map<number, { asset: Asset; hasSplit: boolean }>();
  for (const input of inputs) {
    const { tx, asset } = cleanInput(db, userId, input);
    insert(db, userId, tx, input);
    if (!asset) continue;
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
