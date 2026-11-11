/**
 * Elemente comune serviciilor: eroarea afișabilă utilizatorului și conversia
 * rândurilor din SQLite (snake_case) în obiectele din `shared/types`.
 *
 * Toate serviciile primesc `userId` de la stratul IPC (din sesiunea curentă),
 * niciodată din interfață, și filtrează fiecare interogare după el.
 */
import type { Asset, AssetType, Broker, Portfolio, PortfolioColor, PortfolioIcon, PriceMode, Transaction, TransactionType, User } from '@shared/types';
import type { LedgerTx } from '@shared/calc';

/** Eroare cu mesaj în română, sigur de afișat utilizatorului. */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppError(message);
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

type Row = Record<string, any>;

export function rowToUser(r: Row): User {
  return { id: r.id, username: r.username, email: r.email ?? null, isDemo: !!r.is_demo, createdAt: r.created_at };
}

export function rowToBroker(r: Row): Broker {
  return {
    id: r.id,
    name: r.name,
    notes: r.notes ?? null,
    residence: r.residence === 'ro' ? 'ro' : 'foreign',
    createdAt: r.created_at,
    transactionCount: r.transaction_count ?? undefined
  };
}

export function rowToPortfolio(r: Row): Portfolio {
  return {
    id: r.id,
    name: r.name,
    color: r.color as PortfolioColor,
    icon: r.icon as PortfolioIcon,
    baseCurrency: r.base_currency,
    benchmark: r.benchmark ?? null,
    archived: !!r.archived,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
    transactionCount: r.transaction_count ?? undefined
  };
}

export function rowToAsset(r: Row): Asset {
  return {
    id: r.id,
    type: r.type as AssetType,
    symbol: r.symbol,
    name: r.name,
    currency: r.currency,
    faceValue: r.face_value ?? null,
    couponRate: r.coupon_rate ?? null,
    couponFrequency: r.coupon_frequency ?? null,
    maturityDate: r.maturity_date ?? null,
    priceMode: r.price_mode as PriceMode,
    manualPrice: r.manual_price ?? null,
    manualPriceDate: r.manual_price_date ?? null,
    isin: r.isin ?? null,
    sector: r.sector ?? null,
    country: r.country ?? null,
    profileSource: r.profile_source ?? null,
    createdAt: r.created_at
  };
}

/** Text zecimal din bază -> număr pentru afișare (calculele folosesc textul exact, vezi rowToLedgerTx). */
const numOf = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function rowToTransaction(r: Row): Transaction {
  return {
    id: r.id,
    portfolioId: r.portfolio_id ?? null,
    assetId: r.asset_id ?? null,
    brokerId: r.broker_id ?? null,
    type: r.type as TransactionType,
    date: r.date,
    quantity: numOf(r.quantity),
    price: numOf(r.price),
    fee: numOf(r.fee),
    currency: r.currency,
    grossAmount: numOf(r.gross_amount),
    taxWithheld: numOf(r.tax_withheld),
    netAmount: numOf(r.net_amount),
    splitNumerator: numOrNull(r.split_numerator),
    splitDenominator: numOrNull(r.split_denominator),
    notes: r.notes ?? null,
    cashAmount: numOrNull(r.cash_amount),
    cashCurrency: r.cash_currency ?? null,
    externalId: r.external_id ?? null,
    batchId: r.batch_id ?? null,
    createdAt: r.created_at
  };
}

/** Forma minimă cerută de motorul de calcul. Sumele rămân text zecimal exact, ca în bază. */
export function rowToLedgerTx(r: Row): LedgerTx {
  return {
    id: r.id,
    portfolioId: r.portfolio_id ?? null,
    assetId: r.asset_id ?? null,
    brokerId: r.broker_id ?? null,
    type: r.type as TransactionType,
    date: r.date,
    quantity: r.quantity,
    price: r.price,
    fee: r.fee,
    grossAmount: r.gross_amount,
    taxWithheld: r.tax_withheld,
    netAmount: r.net_amount,
    splitNumerator: r.split_numerator ?? null,
    splitDenominator: r.split_denominator ?? null,
    currency: r.currency ?? null,
    cashAmount: r.cash_amount ?? null,
    cashCurrency: r.cash_currency ?? null
  };
}
