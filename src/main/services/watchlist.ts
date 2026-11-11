/**
 * Watchlist: liste de instrumente urmărite fără să fie deținute (acțiuni, ETF-uri,
 * obligațiuni, crypto), fiecare cu preț țintă de cumpărare și notă opționale.
 *
 * Listele sunt ale utilizatorului (nu ale unui portofoliu); o cumpărare făcută din
 * watchlist intră în portofoliul ales în formular. Prețurile vin din cache-ul de
 * prețuri: serviciul de prețuri cere cotația și istoricul recent și pentru
 * simbolurile din watchlist, deci totul merge și offline, cu ultimele valori.
 */
import { ASSET_CURRENCIES, ASSET_TYPES, type Watchlist, type WatchlistItemInput, type WatchlistItemUpdate, type WatchlistItemView } from '@shared/types';
import { addDays, todayIso } from '@shared/dates';
import { Ledger } from '@shared/calc';
import { dec } from '@shared/calc/decimal';
import type { Db } from '../db/database';
import { getCachedPrices, loadHistory, resolvePrice } from '../prices/store';
import { assert, rowToAsset } from './common';
import { normalizeSymbol } from './assets';
import { allLedgerTxs } from './portfolio';

type Row = Record<string, unknown>;

export const DEFAULT_WATCHLIST_NAME = 'De urmărit';
const MAX_LISTS = 30;
const MAX_ITEMS = 300;
const SPARKLINE_DAYS = 90;

function rowToWatchlist(r: Row): Watchlist {
  return { id: r.id as number, name: r.name as string, sortOrder: r.sort_order as number, itemCount: (r.item_count as number) ?? 0 };
}

function cleanName(name: unknown): string {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  assert(n.length >= 1 && n.length <= 40, 'Numele listei trebuie să aibă între 1 și 40 de caractere.');
  return n;
}

function getList(db: Db, userId: number, id: number): Row {
  const r = db.prepare('SELECT * FROM watchlists WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
  assert(r, 'Lista nu a fost găsită.');
  return r;
}

function assertUniqueName(db: Db, userId: number, name: string, exceptId: number | null): void {
  const clash = db.prepare('SELECT id FROM watchlists WHERE user_id = ? AND name = ? AND id IS NOT ?').get(userId, name, exceptId);
  assert(!clash, `Există deja o listă cu numele „${name}”.`);
}

/** Listele utilizatorului, în ordinea aleasă; la prima folosire se creează lista „De urmărit”. */
export function listWatchlists(db: Db, userId: number): Watchlist[] {
  const read = (): Row[] =>
    db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM watchlist_items i WHERE i.watchlist_id = w.id) AS item_count
         FROM watchlists w WHERE w.user_id = ? ORDER BY w.sort_order, w.id`
      )
      .all(userId) as Row[];
  let rows = read();
  if (rows.length === 0) {
    db.prepare('INSERT INTO watchlists (user_id, name, sort_order) VALUES (?, ?, 0)').run(userId, DEFAULT_WATCHLIST_NAME);
    rows = read();
  }
  return rows.map(rowToWatchlist);
}

export function createWatchlist(db: Db, userId: number, name: unknown): Watchlist {
  const clean = cleanName(name);
  assertUniqueName(db, userId, clean, null);
  const count = (db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), -1) AS last FROM watchlists WHERE user_id = ?').get(userId) as { n: number; last: number });
  assert(count.n < MAX_LISTS, `Poți avea cel mult ${MAX_LISTS} de liste.`);
  const id = Number(db.prepare('INSERT INTO watchlists (user_id, name, sort_order) VALUES (?, ?, ?)').run(userId, clean, count.last + 1).lastInsertRowid);
  return listWatchlists(db, userId).find((w) => w.id === id) as Watchlist;
}

export function renameWatchlist(db: Db, userId: number, id: number, name: unknown): Watchlist {
  getList(db, userId, id);
  const clean = cleanName(name);
  assertUniqueName(db, userId, clean, id);
  db.prepare('UPDATE watchlists SET name = ? WHERE id = ? AND user_id = ?').run(clean, id, userId);
  return listWatchlists(db, userId).find((w) => w.id === id) as Watchlist;
}

/** Șterge o listă cu tot ce conține; cel puțin o listă rămâne mereu. */
export function deleteWatchlist(db: Db, userId: number, id: number): void {
  getList(db, userId, id);
  const n = (db.prepare('SELECT COUNT(*) AS n FROM watchlists WHERE user_id = ?').get(userId) as { n: number }).n;
  assert(n > 1, 'Trebuie să rămână cel puțin o listă. Poți să o redenumești.');
  db.prepare('DELETE FROM watchlists WHERE id = ? AND user_id = ?').run(id, userId);
}

/** Noua ordine a listelor (id-urile, în ordinea dorită). */
export function reorderWatchlists(db: Db, userId: number, ids: number[]): void {
  const own = new Set((db.prepare('SELECT id FROM watchlists WHERE user_id = ?').all(userId) as { id: number }[]).map((r) => r.id));
  assert(Array.isArray(ids) && ids.every((id) => own.has(Number(id))), 'Lista nu a fost găsită.');
  const set = db.prepare('UPDATE watchlists SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.transaction(() => ids.forEach((id, i) => set.run(i, Number(id), userId)))();
}

/* ------------------------------------------------------------- elementele */

function cleanTarget(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? String(value) : String(value).trim().replace(/\s/g, '').replace(',', '.');
  let d;
  try {
    d = dec(text);
  } catch {
    d = null;
  }
  assert(d && d.isFinite() && d.gt(0), 'Prețul țintă trebuie să fie un număr mai mare decât zero.');
  return d.toString();
}

function cleanNote(value: unknown): string | null {
  const note = String(value ?? '').trim();
  assert(note.length <= 500, 'Nota poate avea cel mult 500 de caractere.');
  return note || null;
}

/** Simbolurile deținute acum, în oricare portofoliu (pentru eticheta „În portofoliu”). */
function heldSymbols(db: Db, userId: number): Set<string> {
  const symbols = new Map((db.prepare('SELECT id, symbol FROM assets WHERE user_id = ?').all(userId) as { id: number; symbol: string }[]).map((r) => [r.id, r.symbol]));
  const held = new Set<string>();
  for (const p of new Ledger({ method: 'AVG', strict: false }).applyAll(allLedgerTxs(db, userId)).list()) {
    const symbol = symbols.get(p.assetId);
    if (p.quantity > 0 && symbol) held.add(symbol);
  }
  return held;
}

/** Instrumentele dintr-o listă, cu prețul, variația de azi și istoricul pentru graficul mic. */
export function listWatchlistItems(db: Db, userId: number, watchlistId: number, today: string = todayIso()): WatchlistItemView[] {
  getList(db, userId, watchlistId);
  const rows = db.prepare('SELECT * FROM watchlist_items WHERE user_id = ? AND watchlist_id = ? ORDER BY sort_order, id').all(userId, watchlistId) as Row[];
  if (rows.length === 0) return [];
  const cache = getCachedPrices(db, userId);
  const history = loadHistory(db, userId, rows.map((r) => r.symbol as string));
  const assets = new Map((db.prepare('SELECT * FROM assets WHERE user_id = ?').all(userId) as Row[]).map((r) => [r.symbol as string, rowToAsset(r)]));
  const held = heldSymbols(db, userId);
  const from = addDays(today, -SPARKLINE_DAYS);

  return rows.map((r) => {
    const symbol = r.symbol as string;
    const asset = assets.get(symbol);
    const cached = cache.get(symbol);
    // Activul deținut cu preț manual își păstrează prețul manual; altfel ultimul preț din API.
    const resolved = asset ? resolvePrice(asset, cache) : cached && cached.price > 0 ? { price: cached.price, asOf: cached.asOf } : null;
    const price = resolved?.price ?? null;
    const asOf = resolved?.asOf ?? null;
    const points = history.get(symbol) ?? [];
    const quoteDay = (asOf ?? today).slice(0, 10);
    let previousClose: number | null = null;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].date < quoteDay) {
        previousClose = points[i].close;
        break;
      }
    }
    const target = r.target_price == null ? null : Number(r.target_price);
    return {
      id: r.id as number,
      watchlistId: r.watchlist_id as number,
      symbol,
      type: r.type as WatchlistItemView['type'],
      currency: r.currency as string,
      name: (r.name as string) || asset?.name || '',
      targetPrice: target,
      note: (r.note as string | null) ?? null,
      sortOrder: r.sort_order as number,
      createdAt: r.created_at as string,
      price,
      priceAsOf: asOf,
      previousClose,
      changePct: price !== null && previousClose ? price / previousClose - 1 : null,
      sparkline: points.filter((p) => p.date >= from).map((p) => ({ date: p.date, close: p.close })),
      toTargetPct: price !== null && target ? price / target - 1 : null,
      held: held.has(symbol)
    };
  });
}

function getItemRow(db: Db, userId: number, id: number): Row {
  const r = db.prepare('SELECT * FROM watchlist_items WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
  assert(r, 'Instrumentul nu a fost găsit în listă.');
  return r;
}

function itemView(db: Db, userId: number, id: number): WatchlistItemView {
  const r = getItemRow(db, userId, id);
  return listWatchlistItems(db, userId, r.watchlist_id as number).find((i) => i.id === id) as WatchlistItemView;
}

export function addWatchlistItem(db: Db, userId: number, watchlistId: number, input: WatchlistItemInput): WatchlistItemView {
  getList(db, userId, watchlistId);
  assert(ASSET_TYPES.includes(input.type), 'Tip de activ necunoscut.');
  const symbol = normalizeSymbol(input.symbol);
  assert(/^[A-Z0-9.\-=^_/]{1,24}$/.test(symbol), 'Simbolul poate conține litere, cifre, punct și cratimă (maximum 24 de caractere).');
  const currency = String(input.currency ?? '').trim().toUpperCase();
  assert((ASSET_CURRENCIES as readonly string[]).includes(currency), `Moneda trebuie să fie una dintre: ${ASSET_CURRENCIES.join(', ')}.`);
  const exists = db.prepare('SELECT 1 FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?').get(watchlistId, symbol);
  assert(!exists, `${symbol} este deja în această listă.`);
  const count = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), -1) AS last FROM watchlist_items WHERE watchlist_id = ?').get(watchlistId) as { n: number; last: number };
  assert(count.n < MAX_ITEMS, `O listă poate avea cel mult ${MAX_ITEMS} de instrumente.`);
  // Un activ deja cunoscut își păstrează tipul și moneda (ca la cumpărare să nu apară nepotriviri).
  const asset = db.prepare('SELECT * FROM assets WHERE user_id = ? AND symbol = ?').get(userId, symbol) as Row | undefined;
  const name = String(input.name ?? '').trim().slice(0, 120) || (asset?.name as string | undefined) || '';
  const id = Number(
    db
      .prepare(
        'INSERT INTO watchlist_items (user_id, watchlist_id, symbol, type, currency, name, target_price, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        userId,
        watchlistId,
        symbol,
        asset ? (asset.type as string) : input.type,
        asset ? (asset.currency as string) : currency,
        name,
        cleanTarget(input.targetPrice),
        cleanNote(input.note),
        count.last + 1
      ).lastInsertRowid
  );
  return itemView(db, userId, id);
}

export function updateWatchlistItem(db: Db, userId: number, id: number, patch: WatchlistItemUpdate): WatchlistItemView {
  const row = getItemRow(db, userId, id);
  const sets: string[] = [];
  const values: unknown[] = [];
  if ('targetPrice' in patch) {
    sets.push('target_price = ?');
    values.push(cleanTarget(patch.targetPrice));
  }
  if ('note' in patch) {
    sets.push('note = ?');
    values.push(cleanNote(patch.note));
  }
  if ('name' in patch) {
    sets.push('name = ?');
    values.push(String(patch.name ?? '').trim().slice(0, 120));
  }
  if (patch.watchlistId !== undefined && Number(patch.watchlistId) !== row.watchlist_id) {
    const target = Number(patch.watchlistId);
    getList(db, userId, target);
    const clash = db.prepare('SELECT 1 FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?').get(target, row.symbol);
    assert(!clash, `${row.symbol} este deja în lista aleasă.`);
    const last = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS last FROM watchlist_items WHERE watchlist_id = ?').get(target) as { last: number }).last;
    sets.push('watchlist_id = ?', 'sort_order = ?');
    values.push(target, last + 1);
  }
  if (sets.length > 0) db.prepare(`UPDATE watchlist_items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values, id, userId);
  return itemView(db, userId, id);
}

export function removeWatchlistItem(db: Db, userId: number, id: number): void {
  getItemRow(db, userId, id);
  db.prepare('DELETE FROM watchlist_items WHERE id = ? AND user_id = ?').run(id, userId);
}

/** Noua ordine a instrumentelor dintr-o listă (id-urile, în ordinea dorită). */
export function reorderWatchlistItems(db: Db, userId: number, watchlistId: number, ids: number[]): void {
  getList(db, userId, watchlistId);
  const own = new Set((db.prepare('SELECT id FROM watchlist_items WHERE user_id = ? AND watchlist_id = ?').all(userId, watchlistId) as { id: number }[]).map((r) => r.id));
  assert(Array.isArray(ids) && ids.every((id) => own.has(Number(id))), 'Instrumentul nu a fost găsit în listă.');
  const set = db.prepare('UPDATE watchlist_items SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.transaction(() => ids.forEach((id, i) => set.run(i, Number(id), userId)))();
}
