/** Etichetele în română folosite atât în interfață, cât și în mesajele și exporturile din procesul principal. */
import type { AssetType, CostMethod, HistoryRange, ProviderId, TransactionType } from './types';

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  stock: 'Acțiune',
  etf: 'ETF',
  bond: 'Obligațiune',
  crypto: 'Crypto'
};

export const ASSET_TYPE_LABEL_PLURAL: Record<AssetType, string> = {
  stock: 'Acțiuni',
  etf: 'ETF-uri',
  bond: 'Obligațiuni',
  crypto: 'Crypto'
};

export const TRANSACTION_TYPE_LABEL: Record<TransactionType, string> = {
  buy: 'Cumpărare',
  sell: 'Vânzare',
  dividend: 'Dividend',
  coupon: 'Cupon',
  split: 'Split',
  deposit: 'Depunere',
  withdrawal: 'Retragere',
  fee: 'Comision',
  interest: 'Dobândă',
  adjustment: 'Ajustare sold'
};

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  yahoo: 'Yahoo Finance',
  alphavantage: 'Alpha Vantage',
  twelvedata: 'Twelve Data',
  polygon: 'Polygon'
};

export const COST_METHOD_LABEL: Record<CostMethod, string> = {
  AVG: 'Cost mediu ponderat',
  FIFO: 'FIFO (primul intrat, primul ieșit)'
};

export const RANGE_LABEL: Record<HistoryRange, string> = {
  '1W': '1S',
  '1M': '1L',
  '3M': '3L',
  '6M': '6L',
  YTD: 'YTD',
  '1Y': '1A',
  ALL: 'Tot'
};

/** Perioadele din selectoarele de pe panoul principal, în ordine. */
export const PERIODS: HistoryRange[] = ['1W', '1M', '3M', '6M', 'YTD', '1Y', 'ALL'];

/** Afișează o cantitate fără zerouri inutile (maximum 8 zecimale). */
export function formatQuantityPlain(n: number): string {
  return Number(n.toFixed(8)).toString();
}
