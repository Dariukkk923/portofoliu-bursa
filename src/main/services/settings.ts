/** Setările utilizatorului și cheile API (criptate). */
import {
  BASE_CURRENCIES,
  PROVIDER_IDS,
  REFRESH_INTERVALS,
  type CostMethod,
  type PortfolioScope,
  type ProviderId,
  type Settings,
  type SettingsUpdate,
  type Theme
} from '@shared/types';
import { BENCHMARKS, DEFAULT_BENCHMARK } from '@shared/benchmarks';
import type { Db } from '../db/database';
import type { SecretBox } from '../secrets';
import { assert } from './common';

interface SettingsRow {
  base_currency: string;
  cost_method: CostMethod;
  theme: Theme;
  primary_provider: ProviderId;
  refresh_interval_min: number;
  last_price_update: string | null;
  active_portfolio: string | null;
  benchmark: string | null;
  concentration_limit: number | null;
}

function row(db: Db, userId: number): SettingsRow {
  let r = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) as SettingsRow | undefined;
  if (!r) {
    db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(userId);
    r = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) as SettingsRow;
  }
  return r;
}

/**
 * Portofoliul selectat ultima dată: „all” sau id-ul unui portofoliu activ al utilizatorului.
 * Dacă lipsește (ex.: portofoliul a fost șters sau arhivat), primul portofoliu activ.
 */
function activeScope(db: Db, userId: number, stored: string | null): PortfolioScope {
  if (stored === 'all') return 'all';
  const id = Number(stored);
  if (stored && Number.isInteger(id)) {
    const ok = db.prepare('SELECT 1 FROM portfolios WHERE id = ? AND user_id = ? AND archived = 0').get(id, userId);
    if (ok) return id;
  }
  const first = db.prepare('SELECT id FROM portfolios WHERE user_id = ? AND archived = 0 ORDER BY sort_order, id LIMIT 1').get(userId) as
    | { id: number }
    | undefined;
  return first?.id ?? 'all';
}

export function getSettings(db: Db, userId: number): Settings {
  const r = row(db, userId);
  const keys = db.prepare('SELECT provider, hint FROM api_keys WHERE user_id = ?').all(userId) as {
    provider: ProviderId;
    hint: string | null;
  }[];
  const apiKeys = Object.fromEntries(
    PROVIDER_IDS.map((p) => {
      const k = keys.find((x) => x.provider === p);
      return [p, { configured: !!k, hint: k?.hint ?? null }];
    })
  ) as Settings['apiKeys'];
  return {
    baseCurrency: r.base_currency,
    costMethod: r.cost_method,
    theme: r.theme,
    primaryProvider: PROVIDER_IDS.includes(r.primary_provider) ? r.primary_provider : 'yahoo',
    refreshIntervalMin: r.refresh_interval_min,
    lastPriceUpdate: r.last_price_update,
    activePortfolio: activeScope(db, userId, r.active_portfolio),
    benchmark: r.benchmark || DEFAULT_BENCHMARK,
    concentrationLimit: r.concentration_limit ?? 0.2,
    apiKeys
  };
}

export function updateSettings(db: Db, userId: number, patch: SettingsUpdate): Settings {
  const current = row(db, userId);
  const next = { ...current };
  if (patch.baseCurrency !== undefined) {
    assert((BASE_CURRENCIES as readonly string[]).includes(patch.baseCurrency), 'Monedă de bază necunoscută.');
    next.base_currency = patch.baseCurrency;
  }
  if (patch.costMethod !== undefined) {
    assert(patch.costMethod === 'AVG' || patch.costMethod === 'FIFO', 'Metodă de calcul necunoscută.');
    next.cost_method = patch.costMethod;
  }
  if (patch.theme !== undefined) {
    assert(['light', 'dark', 'system'].includes(patch.theme), 'Temă necunoscută.');
    next.theme = patch.theme;
  }
  if (patch.primaryProvider !== undefined) {
    assert(PROVIDER_IDS.includes(patch.primaryProvider), 'Provider necunoscut.');
    next.primary_provider = patch.primaryProvider;
  }
  if (patch.refreshIntervalMin !== undefined) {
    assert(
      (REFRESH_INTERVALS as readonly number[]).includes(patch.refreshIntervalMin),
      'Interval de actualizare invalid.'
    );
    next.refresh_interval_min = patch.refreshIntervalMin;
  }
  if (patch.activePortfolio !== undefined) {
    const scope = patch.activePortfolio;
    if (scope === 'all') next.active_portfolio = 'all';
    else {
      const ok = Number.isInteger(scope) && db.prepare('SELECT 1 FROM portfolios WHERE id = ? AND user_id = ?').get(scope, userId);
      assert(ok, 'Portofoliul nu a fost găsit.');
      next.active_portfolio = String(scope);
    }
  }
  if (patch.benchmark !== undefined) {
    assert(BENCHMARKS.some((b) => b.symbol === patch.benchmark), 'Indice de referință necunoscut.');
    next.benchmark = patch.benchmark;
  }
  if (patch.concentrationLimit !== undefined) {
    const limit = Number(patch.concentrationLimit);
    assert(Number.isFinite(limit) && limit >= 0.05 && limit <= 0.9, 'Pragul de concentrare trebuie să fie între 5% și 90%.');
    next.concentration_limit = Math.round(limit * 1000) / 1000;
  }
  db.prepare(
    `UPDATE settings SET base_currency = ?, cost_method = ?, theme = ?, primary_provider = ?, refresh_interval_min = ?,
       active_portfolio = ?, benchmark = ?, concentration_limit = ? WHERE user_id = ?`
  ).run(
    next.base_currency,
    next.cost_method,
    next.theme,
    next.primary_provider,
    next.refresh_interval_min,
    next.active_portfolio,
    next.benchmark || DEFAULT_BENCHMARK,
    next.concentration_limit ?? 0.2,
    userId
  );
  return getSettings(db, userId);
}

export function setLastPriceUpdate(db: Db, userId: number, iso: string): void {
  db.prepare('UPDATE settings SET last_price_update = ? WHERE user_id = ?').run(iso, userId);
}

/** Salvează (criptat) sau șterge cheia API a unui provider. Interfața primește înapoi doar ultimele 4 caractere. */
export function setApiKey(db: Db, secrets: SecretBox, userId: number, provider: ProviderId, key: string | null): void {
  assert(PROVIDER_IDS.includes(provider) && provider !== 'yahoo', 'Acest provider nu folosește cheie API.');
  const trimmed = (key ?? '').trim();
  if (!trimmed) {
    db.prepare('DELETE FROM api_keys WHERE user_id = ? AND provider = ?').run(userId, provider);
    return;
  }
  assert(trimmed.length <= 200, 'Cheia API este prea lungă.');
  const hint = trimmed.length > 4 ? `…${trimmed.slice(-4)}` : '…';
  db.prepare(
    `INSERT INTO api_keys (user_id, provider, encrypted_key, hint, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_key = excluded.encrypted_key, hint = excluded.hint,
       updated_at = excluded.updated_at`
  ).run(userId, provider, secrets.encrypt(trimmed), hint);
}

/** Cheia decriptată — folosită doar în procesul principal, de providerii de prețuri. */
export function getApiKey(db: Db, secrets: SecretBox, userId: number, provider: ProviderId): string | null {
  const r = db.prepare('SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = ?').get(userId, provider) as
    | { encrypted_key: string }
    | undefined;
  return r ? secrets.decrypt(r.encrypted_key) : null;
}
