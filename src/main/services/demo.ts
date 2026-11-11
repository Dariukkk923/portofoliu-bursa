/**
 * Contul demo: un utilizator obișnuit, creat la cerere din ecranul de login,
 * cu date de test la doi brokeri (acțiuni, un ETF, o obligațiune și crypto).
 * Prețurile de cumpărare sunt închiderile reale din zilele respective.
 */
import type { AssetInput, User } from '@shared/types';
import type { Db } from '../db/database';
import { findUserByName, register } from './auth';
import { rowToUser } from './common';
import { createBroker } from './brokers';
import { addPurchase, createTransaction } from './transactions';
import { findAssetBySymbol } from './assets';
import { saveQuote } from '../prices/store';

export const DEMO_USERNAME = 'demo';
export const DEMO_PASSWORD = 'demo1234';

/** Prețuri orientative, afișate până la prima actualizare din internet. */
const DEMO_PRICES_DATE = '2026-11-11';
const DEMO_PRICES: [symbol: string, price: number, currency: string | null][] = [
  ['AAPL', 348.51, 'USD'],
  ['NVDA', 168.89, 'USD'],
  ['SNP.RO', 1.287, 'RON'],
  ['VWCE.DE', 169.94, 'EUR'],
  ['BTC-USD', 73834.67, 'USD'],
  ['ETH-EUR', 1845.78, 'EUR'],
  ['USDRON=X', 4.806, 'RON'],
  ['EURRON=X', 5.344, 'RON']
];

const AAPL: AssetInput = { type: 'stock', symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD' };
const NVDA: AssetInput = { type: 'stock', symbol: 'NVDA', name: 'NVIDIA Corporation', currency: 'USD' };
const SNP: AssetInput = { type: 'stock', symbol: 'SNP.RO', name: 'OMV Petrom S.A.', currency: 'RON' };
const VWCE: AssetInput = { type: 'etf', symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World UCITS ETF (Acc)', currency: 'EUR' };
const BTC: AssetInput = { type: 'crypto', symbol: 'BTC-USD', name: 'Bitcoin', currency: 'USD' };
const ETH: AssetInput = { type: 'crypto', symbol: 'ETH-EUR', name: 'Ethereum', currency: 'EUR' };
const BOND: AssetInput = {
  type: 'bond',
  symbol: 'R2710A',
  name: 'Titluri de stat Fidelis RON 2027',
  currency: 'RON',
  faceValue: 100,
  couponRate: 7.2,
  couponFrequency: 1,
  maturityDate: '2027-10-15',
  priceMode: 'manual',
  manualPrice: 101.4
};

function seed(db: Db, userId: number): void {
  const xtb = createBroker(db, userId, { name: 'XTB', notes: 'Acțiuni SUA, ETF-uri, crypto' }).id;
  const tradeville = createBroker(db, userId, { name: 'Tradeville', notes: 'BVB și titluri de stat' }).id;

  const purchase = (asset: AssetInput, brokerId: number, date: string, quantity: number, price: number, fee = 0): void => {
    addPurchase(db, userId, { asset, brokerId, date, quantity, price, fee });
  };
  const idOf = (symbol: string): number => (findAssetBySymbol(db, userId, symbol) as { id: number }).id;

  // Acțiuni SUA — AAPL cumpărat la ambii brokeri (apare separat pe broker și agregat pe total).
  purchase(AAPL, xtb, '2024-02-12', 10, 187.15);
  purchase(AAPL, tradeville, '2024-09-10', 5, 220.11, 1.5);
  createTransaction(db, userId, { assetId: idOf('AAPL'), brokerId: xtb, type: 'dividend', date: '2024-05-16', grossAmount: 2.5, taxWithheld: 0.25 });
  createTransaction(db, userId, { assetId: idOf('AAPL'), brokerId: xtb, type: 'dividend', date: '2025-05-15', grossAmount: 2.6, taxWithheld: 0.26 });
  createTransaction(db, userId, { assetId: idOf('AAPL'), brokerId: xtb, type: 'sell', date: '2025-07-15', quantity: 4, price: 209.11 });

  // NVDA: cumpărat înainte de split-ul 10:1 din iunie 2024.
  purchase(NVDA, xtb, '2024-03-15', 2, 878.37);
  createTransaction(db, userId, { assetId: idOf('NVDA'), brokerId: null, type: 'split', date: '2024-06-10', splitNumerator: 10, splitDenominator: 1, notes: 'Split 10:1' });

  // BVB (sufix .RO).
  purchase(SNP, tradeville, '2024-03-04', 5000, 0.621, 21.7);
  createTransaction(db, userId, { assetId: idOf('SNP.RO'), brokerId: tradeville, type: 'dividend', date: '2024-06-07', grossAmount: 206.5, taxWithheld: 16.52 });
  createTransaction(db, userId, { assetId: idOf('SNP.RO'), brokerId: tradeville, type: 'sell', date: '2025-03-10', quantity: 1000, price: 0.74, fee: 5.18 });
  createTransaction(db, userId, { assetId: idOf('SNP.RO'), brokerId: tradeville, type: 'dividend', date: '2025-06-05', grossAmount: 177.6, taxWithheld: 17.76 });

  // ETF, cumpărat în trei tranșe.
  purchase(VWCE, xtb, '2024-01-15', 8, 107.58);
  purchase(VWCE, xtb, '2024-10-01', 6, 125.48);
  purchase(VWCE, xtb, '2025-08-05', 5, 133.22);

  // Obligațiune cu preț manual (procent din nominal) și cupoane anuale.
  purchase(BOND, tradeville, '2024-10-15', 50, 100);
  createTransaction(db, userId, { assetId: idOf('R2710A'), brokerId: tradeville, type: 'coupon', date: '2025-10-15', grossAmount: 360, taxWithheld: 0 });
  createTransaction(db, userId, { assetId: idOf('R2710A'), brokerId: tradeville, type: 'coupon', date: '2026-10-15', grossAmount: 360, taxWithheld: 0 });

  // Crypto, cu unități fracționare.
  purchase(BTC, xtb, '2024-01-10', 0.035, 46627.78, 5);
  purchase(ETH, xtb, '2024-02-05', 0.85, 2140.25, 3);
  createTransaction(db, userId, { assetId: idOf('ETH-EUR'), brokerId: xtb, type: 'sell', date: '2024-12-05', quantity: 0.25, price: 3599.87, fee: 2 });

  for (const [symbol, price, currency] of DEMO_PRICES) {
    saveQuote(db, userId, { symbol, price, currency, asOf: DEMO_PRICES_DATE, provider: 'demo' });
  }
}

/** Întoarce contul demo, creându-l (cu datele de test) la prima folosire. */
export async function ensureDemoAccount(db: Db): Promise<User> {
  // Contul demo se recunoaște după marcajul is_demo, nu după nume: un cont obișnuit
  // numit „demo” nu trebuie să poată fi deschis fără parolă.
  const existing = db.prepare('SELECT * FROM users WHERE is_demo = 1 ORDER BY id LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
  if (existing) return rowToUser(existing);
  let username = DEMO_USERNAME;
  for (let i = 2; findUserByName(db, username); i++) username = `${DEMO_USERNAME}-${i}`;
  const user = await register(db, { username, password: DEMO_PASSWORD }, { isDemo: true });
  db.transaction(() => seed(db, user.id))();
  return user;
}
