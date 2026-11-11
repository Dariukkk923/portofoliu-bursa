/**
 * Portofoliile utilizatorului: fiecare are tranzacțiile, cash-ul și randamentul
 * lui, plus nume, culoare, iconiță, monedă de bază și indice de referință proprii.
 *
 * Fiecare utilizator are cel puțin un portofoliu („Principal”, creat automat).
 * Vederea „Toate portofoliile” combină portofoliile active (nearhivate), cu
 * totalurile în moneda de bază din setări.
 */
import { BASE_CURRENCIES, PORTFOLIO_COLORS, PORTFOLIO_ICONS, type Portfolio, type PortfolioInput } from '@shared/types';
import type { LedgerTx } from '@shared/calc';
import type { Db } from '../db/database';
import { assert, rowToPortfolio } from './common';

export const DEFAULT_PORTFOLIO_NAME = 'Principal';

type Row = Record<string, unknown>;

function cleanName(name: unknown): string {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  assert(n.length >= 1 && n.length <= 40, 'Numele portofoliului trebuie să aibă între 1 și 40 de caractere.');
  return n;
}

function cleanBenchmark(value: unknown): string | null {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return null;
  assert(/^[A-Z0-9.^=\-]{1,24}$/.test(s), 'Simbolul indicelui de referință nu este valid (ex.: ^GSPC).');
  return s;
}

function baseCurrencyOf(db: Db, userId: number): string {
  const r = db.prepare('SELECT base_currency FROM settings WHERE user_id = ?').get(userId) as { base_currency: string } | undefined;
  return r?.base_currency ?? 'RON';
}

export function listPortfolios(db: Db, userId: number): Portfolio[] {
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM transactions t WHERE t.portfolio_id = p.id AND t.user_id = p.user_id) AS transaction_count
       FROM portfolios p WHERE p.user_id = ? ORDER BY p.archived, p.sort_order, p.id`
    )
    .all(userId) as Row[];
  return rows.map(rowToPortfolio);
}

export function getPortfolio(db: Db, userId: number, id: number): Portfolio | null {
  const r = db.prepare('SELECT * FROM portfolios WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
  return r ? rowToPortfolio(r) : null;
}

function findByName(db: Db, userId: number, name: string): Portfolio | null {
  const r = db.prepare('SELECT * FROM portfolios WHERE user_id = ? AND name = ?').get(userId, name) as Row | undefined;
  return r ? rowToPortfolio(r) : null;
}

/** Primul portofoliu activ; dacă utilizatorul nu are niciunul, se creează „Principal”. */
export function ensureDefaultPortfolio(db: Db, userId: number): Portfolio {
  const r = db.prepare('SELECT * FROM portfolios WHERE user_id = ? AND archived = 0 ORDER BY sort_order, id LIMIT 1').get(userId) as Row | undefined;
  if (r) return rowToPortfolio(r);
  const name = findByName(db, userId, DEFAULT_PORTFOLIO_NAME) ? `${DEFAULT_PORTFOLIO_NAME} 2` : DEFAULT_PORTFOLIO_NAME;
  return createPortfolio(db, userId, { name });
}

/** Portofoliul în care intră o tranzacție nouă: cel selectat, altfel primul activ. */
export function defaultPortfolioId(db: Db, userId: number): number {
  const s = db.prepare('SELECT active_portfolio FROM settings WHERE user_id = ?').get(userId) as { active_portfolio: string | null } | undefined;
  const id = Number(s?.active_portfolio);
  if (s?.active_portfolio && s.active_portfolio !== 'all' && Number.isInteger(id)) {
    const p = getPortfolio(db, userId, id);
    if (p && !p.archived) return p.id;
  }
  return ensureDefaultPortfolio(db, userId).id;
}

/** Verifică portofoliul cerut pentru o tranzacție (al utilizatorului, nearhivat) sau îl alege pe cel implicit. */
export function resolvePortfolioId(db: Db, userId: number, requested: number | null | undefined): number {
  if (requested === null || requested === undefined) return defaultPortfolioId(db, userId);
  const p = getPortfolio(db, userId, requested);
  assert(p, 'Portofoliul nu a fost găsit.');
  assert(!p.archived, `Portofoliul „${p.name}” este arhivat. Dezarhivează-l ca să adaugi tranzacții în el.`);
  return p.id;
}

/** Portofoliul cu numele dat (pentru importuri); creat dacă lipsește. */
export function findOrCreatePortfolio(db: Db, userId: number, name: string): { portfolio: Portfolio; created: boolean } {
  const existing = findByName(db, userId, cleanName(name));
  if (existing) return { portfolio: existing, created: false };
  return { portfolio: createPortfolio(db, userId, { name }), created: true };
}

function clean(db: Db, userId: number, input: PortfolioInput, current?: Portfolio) {
  const name = cleanName(input.name ?? current?.name);
  const other = findByName(db, userId, name);
  assert(!other || other.id === current?.id, `Ai deja un portofoliu numit „${name}”.`);
  const color = input.color ?? current?.color ?? PORTFOLIO_COLORS[0];
  assert(PORTFOLIO_COLORS.includes(color), 'Culoare necunoscută.');
  const icon = input.icon ?? current?.icon ?? PORTFOLIO_ICONS[0];
  assert(PORTFOLIO_ICONS.includes(icon), 'Iconiță necunoscută.');
  const baseCurrency = input.baseCurrency ?? current?.baseCurrency ?? baseCurrencyOf(db, userId);
  assert((BASE_CURRENCIES as readonly string[]).includes(baseCurrency), 'Monedă de bază necunoscută.');
  const benchmark = input.benchmark === undefined ? (current?.benchmark ?? null) : cleanBenchmark(input.benchmark);
  return { name, color, icon, baseCurrency, benchmark };
}

export function createPortfolio(db: Db, userId: number, input: PortfolioInput): Portfolio {
  const p = clean(db, userId, input);
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM portfolios WHERE user_id = ?').get(userId) as { n: number };
  const info = db
    .prepare('INSERT INTO portfolios (user_id, name, color, icon, base_currency, benchmark, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, p.name, p.color, p.icon, p.baseCurrency, p.benchmark, order.n);
  return getPortfolio(db, userId, Number(info.lastInsertRowid)) as Portfolio;
}

export function updatePortfolio(db: Db, userId: number, id: number, input: PortfolioInput): Portfolio {
  const current = getPortfolio(db, userId, id);
  assert(current, 'Portofoliul nu a fost găsit.');
  const p = clean(db, userId, input, current);
  db.prepare('UPDATE portfolios SET name = ?, color = ?, icon = ?, base_currency = ?, benchmark = ? WHERE id = ? AND user_id = ?').run(
    p.name,
    p.color,
    p.icon,
    p.baseCurrency,
    p.benchmark,
    id,
    userId
  );
  return getPortfolio(db, userId, id) as Portfolio;
}

const activeCount = (db: Db, userId: number): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ? AND archived = 0').get(userId) as { n: number }).n;

/** Arhivează sau dezarhivează. Trebuie să rămână cel puțin un portofoliu activ. */
export function setPortfolioArchived(db: Db, userId: number, id: number, archived: boolean): Portfolio {
  const p = getPortfolio(db, userId, id);
  assert(p, 'Portofoliul nu a fost găsit.');
  if (archived && !p.archived) assert(activeCount(db, userId) > 1, 'Nu poți arhiva singurul portofoliu activ. Creează întâi altul.');
  db.prepare('UPDATE portfolios SET archived = ? WHERE id = ? AND user_id = ?').run(archived ? 1 : 0, id, userId);
  return getPortfolio(db, userId, id) as Portfolio;
}

/** Șterge portofoliul împreună cu tranzacțiile lui. Trebuie să rămână cel puțin un portofoliu activ. */
export function deletePortfolio(db: Db, userId: number, id: number): void {
  const p = getPortfolio(db, userId, id);
  assert(p, 'Portofoliul nu a fost găsit.');
  if (!p.archived) assert(activeCount(db, userId) > 1, 'Nu poți șterge singurul portofoliu activ. Creează întâi altul.');
  db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE user_id = ? AND portfolio_id = ?').run(userId, id);
    db.prepare('DELETE FROM portfolios WHERE id = ? AND user_id = ?').run(id, userId);
  })();
}

/**
 * Copiază portofoliul cu toate tranzacțiile lui (ex.: pentru a încerca o variantă).
 * Copiile nu păstrează legătura cu extrasele brokerilor (identificatorul operațiunii și lotul de import).
 */
export function duplicatePortfolio(db: Db, userId: number, id: number, name?: string): Portfolio {
  const source = getPortfolio(db, userId, id);
  assert(source, 'Portofoliul nu a fost găsit.');
  let candidate = name?.trim() || `${source.name} (copie)`;
  for (let i = 2; !name && findByName(db, userId, candidate); i++) candidate = `${source.name} (copie ${i})`;
  return db.transaction(() => {
    const copy = createPortfolio(db, userId, { ...source, name: candidate });
    db.prepare(
      `INSERT INTO transactions (user_id, portfolio_id, asset_id, broker_id, type, date, quantity, price, fee, currency,
         gross_amount, tax_withheld, net_amount, split_numerator, split_denominator, notes, cash_amount, cash_currency)
       SELECT user_id, ?, asset_id, broker_id, type, date, quantity, price, fee, currency,
         gross_amount, tax_withheld, net_amount, split_numerator, split_denominator, notes, cash_amount, cash_currency
       FROM transactions WHERE user_id = ? AND portfolio_id = ? ORDER BY id`
    ).run(copy.id, userId, id);
    return listPortfolios(db, userId).find((p) => p.id === copy.id) as Portfolio;
  })();
}

/** Ordinea portofoliilor în selector (lista completă a id-urilor, în ordinea dorită). */
export function reorderPortfolios(db: Db, userId: number, ids: number[]): void {
  const update = db.prepare('UPDATE portfolios SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.transaction(() => ids.forEach((id, i) => update.run(i, id, userId)))();
}

/** Ce portofolii intră într-un calcul și în ce monedă se exprimă rezultatul. */
export interface PortfolioScopeInfo {
  /** Portofoliul cerut, sau null pentru vederea combinată. */
  single: Portfolio | null;
  /** Id-urile portofoliilor incluse. */
  ids: Set<number>;
  byId: Map<number, Portfolio>;
  baseCurrency: string;
  /** True dacă tranzacția intră în calcul (split-urile fără portofoliu intră mereu). */
  includes(t: Pick<LedgerTx, 'portfolioId'>): boolean;
}

/**
 * Un portofoliu anume (inclusiv arhivat, ca să poată fi consultat), în moneda lui de bază,
 * sau toate portofoliile active, în moneda de bază din setări.
 */
export function resolveScope(db: Db, userId: number, portfolioId?: number | null, baseOverride?: string): PortfolioScopeInfo {
  const all = listPortfolios(db, userId);
  const byId = new Map(all.map((p) => [p.id, p]));
  let single: Portfolio | null = null;
  if (portfolioId !== null && portfolioId !== undefined) {
    single = byId.get(portfolioId) ?? null;
    assert(single, 'Portofoliul nu a fost găsit.');
  }
  const ids = new Set(single ? [single.id] : all.filter((p) => !p.archived).map((p) => p.id));
  return {
    single,
    ids,
    byId,
    baseCurrency: baseOverride ?? single?.baseCurrency ?? baseCurrencyOf(db, userId),
    includes: (t) => t.portfolioId == null || ids.has(t.portfolioId)
  };
}
