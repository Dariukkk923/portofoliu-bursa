/** Activele utilizatorului (instrumentele deținute sau deținute cândva). */
import { ASSET_TYPES, type Asset, type AssetInput, type AssetUpdate, type PriceMode } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { isIsoDate, todayIso } from '@shared/dates';
import type { Db } from '../db/database';
import { assert, isFiniteNumber, rowToAsset } from './common';

const COUPON_FREQUENCIES = [1, 2, 4, 12];

export function normalizeSymbol(symbol: unknown): string {
  return String(symbol ?? '')
    .trim()
    .toUpperCase();
}

interface CleanAsset {
  type: Asset['type'];
  symbol: string;
  name: string;
  currency: string;
  faceValue: number | null;
  couponRate: number | null;
  couponFrequency: number | null;
  maturityDate: string | null;
  priceMode: PriceMode;
  manualPrice: number | null;
}

/** Verifică termenii unei obligațiuni (nominal, cupon, frecvență, scadență). */
function cleanBondTerms(input: {
  faceValue?: number | null;
  couponRate?: number | null;
  couponFrequency?: number | null;
  maturityDate?: string | null;
}): Pick<CleanAsset, 'faceValue' | 'couponRate' | 'couponFrequency' | 'maturityDate'> {
  assert(isFiniteNumber(input.faceValue) && input.faceValue > 0, 'Valoarea nominală trebuie să fie mai mare decât zero.');
  const couponRate = input.couponRate ?? 0;
  assert(isFiniteNumber(couponRate) && couponRate >= 0 && couponRate <= 100, 'Rata cuponului trebuie să fie între 0 și 100%.');
  const couponFrequency = input.couponFrequency ?? 1;
  assert(COUPON_FREQUENCIES.includes(couponFrequency), 'Frecvența cuponului poate fi anuală, semestrială, trimestrială sau lunară.');
  const maturityDate = input.maturityDate || null;
  assert(maturityDate === null || isIsoDate(maturityDate), 'Data scadenței nu este validă.');
  return { faceValue: input.faceValue, couponRate, couponFrequency, maturityDate };
}

function cleanManualPrice(price: number | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  assert(isFiniteNumber(price) && price > 0, 'Prețul manual trebuie să fie mai mare decât zero.');
  return price;
}

export function cleanAssetInput(input: AssetInput): CleanAsset {
  assert(ASSET_TYPES.includes(input.type), 'Tip de activ necunoscut.');
  const symbol = normalizeSymbol(input.symbol);
  assert(/^[A-Z0-9.\-=^_/]{1,24}$/.test(symbol), 'Simbolul poate conține litere, cifre, punct și cratimă (maximum 24 de caractere).');
  const currency = String(input.currency ?? '')
    .trim()
    .toUpperCase();
  assert(/^[A-Z]{3}$/.test(currency), 'Moneda trebuie să fie un cod de 3 litere (ex.: RON, EUR, USD).');

  const bond =
    input.type === 'bond'
      ? cleanBondTerms(input)
      : { faceValue: null, couponRate: null, couponFrequency: null, maturityDate: null };
  const manualPrice = cleanManualPrice(input.manualPrice);
  return {
    type: input.type,
    symbol,
    name: String(input.name ?? '').trim().slice(0, 120),
    currency,
    ...bond,
    // Obligațiunile au de regulă doar preț introdus manual (titlurile de stat nu apar în API-uri).
    priceMode: input.priceMode ?? (input.type === 'bond' ? 'manual' : 'auto'),
    manualPrice
  };
}

export function listAssets(db: Db, userId: number): Asset[] {
  const rows = db.prepare('SELECT * FROM assets WHERE user_id = ? ORDER BY symbol').all(userId) as Record<string, unknown>[];
  return rows.map(rowToAsset);
}

export function getAsset(db: Db, userId: number, id: number): Asset | null {
  const r = db.prepare('SELECT * FROM assets WHERE id = ? AND user_id = ?').get(id, userId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToAsset(r) : null;
}

export function findAssetBySymbol(db: Db, userId: number, symbol: string): Asset | null {
  const r = db.prepare('SELECT * FROM assets WHERE user_id = ? AND symbol = ?').get(userId, normalizeSymbol(symbol)) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToAsset(r) : null;
}

export function createAsset(db: Db, userId: number, input: AssetInput): Asset {
  const a = cleanAssetInput(input);
  const existing = findAssetBySymbol(db, userId, a.symbol);
  assert(!existing, `Simbolul ${a.symbol} există deja în portofoliu.`);
  const info = db
    .prepare(
      `INSERT INTO assets (user_id, type, symbol, name, currency, face_value, coupon_rate, coupon_frequency,
         maturity_date, price_mode, manual_price, manual_price_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      a.type,
      a.symbol,
      a.name,
      a.currency,
      a.faceValue,
      a.couponRate,
      a.couponFrequency,
      a.maturityDate,
      a.priceMode,
      a.manualPrice,
      a.manualPrice != null ? todayIso() : null
    );
  return getAsset(db, userId, Number(info.lastInsertRowid)) as Asset;
}

/**
 * Găsește activul după simbol sau îl creează. Dacă există deja, tipul și moneda
 * trebuie să coincidă (altfel calculele ar amesteca monede diferite).
 */
export function findOrCreateAsset(db: Db, userId: number, input: AssetInput): { asset: Asset; created: boolean } {
  const existing = findAssetBySymbol(db, userId, input.symbol);
  if (!existing) return { asset: createAsset(db, userId, input), created: true };
  const currency = String(input.currency ?? '').trim().toUpperCase();
  assert(
    existing.type === input.type && existing.currency === currency,
    `Simbolul ${existing.symbol} există deja în portofoliu ca ${ASSET_TYPE_LABEL[existing.type]} în ${existing.currency}.`
  );
  return { asset: existing, created: false };
}

/** Modifică denumirea, termenii obligațiunii sau modul/valoarea prețului manual. */
export function updateAsset(db: Db, userId: number, id: number, patch: AssetUpdate): Asset {
  const current = getAsset(db, userId, id);
  assert(current, 'Activul nu a fost găsit.');
  const next = { ...current };

  if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 120);
  if (current.type === 'bond') {
    Object.assign(
      next,
      cleanBondTerms({
        faceValue: patch.faceValue !== undefined ? patch.faceValue : current.faceValue,
        couponRate: patch.couponRate !== undefined ? patch.couponRate : current.couponRate,
        couponFrequency: patch.couponFrequency !== undefined ? patch.couponFrequency : current.couponFrequency,
        maturityDate: patch.maturityDate !== undefined ? patch.maturityDate : current.maturityDate
      })
    );
  }
  if (patch.priceMode !== undefined) {
    assert(patch.priceMode === 'auto' || patch.priceMode === 'manual', 'Mod de preț necunoscut.');
    next.priceMode = patch.priceMode;
  }
  if (patch.manualPrice !== undefined) {
    next.manualPrice = cleanManualPrice(patch.manualPrice);
    next.manualPriceDate = next.manualPrice != null ? todayIso() : null;
  }
  // Sectorul și țara completate manual nu mai sunt suprascrise de provider; ambele goale = înapoi la provider.
  if (patch.sector !== undefined || patch.country !== undefined) {
    const clean = (v: unknown): string | null => {
      const s = String(v ?? '').trim().replace(/\s+/g, ' ');
      assert(s.length <= 60, 'Sectorul și țara pot avea cel mult 60 de caractere.');
      return s || null;
    };
    next.sector = patch.sector !== undefined ? clean(patch.sector) : current.sector;
    next.country = patch.country !== undefined ? clean(patch.country) : current.country;
    next.profileSource = next.sector || next.country ? 'manual' : null;
  }

  db.prepare(
    `UPDATE assets SET name = ?, face_value = ?, coupon_rate = ?, coupon_frequency = ?, maturity_date = ?,
       price_mode = ?, manual_price = ?, manual_price_date = ?, sector = ?, country = ?, profile_source = ?,
       profile_fetched_at = CASE WHEN ? IS NULL THEN NULL ELSE profile_fetched_at END
     WHERE id = ? AND user_id = ?`
  ).run(
    next.name,
    next.faceValue,
    next.couponRate,
    next.couponFrequency,
    next.maturityDate,
    next.priceMode,
    next.manualPrice,
    next.manualPriceDate,
    next.sector,
    next.country,
    next.profileSource,
    next.profileSource,
    id,
    userId
  );
  return getAsset(db, userId, id) as Asset;
}

/** Șterge activul împreună cu toate tranzacțiile lui și cu prețurile salvate. */
export function deleteAsset(db: Db, userId: number, id: number): void {
  const asset = getAsset(db, userId, id);
  assert(asset, 'Activul nu a fost găsit.');
  db.transaction(() => {
    db.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?').run(id, userId); // tranzacțiile se șterg în cascadă
    for (const table of ['prices', 'price_history', 'history_sync']) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND symbol = ?`).run(userId, asset.symbol);
    }
  })();
}
