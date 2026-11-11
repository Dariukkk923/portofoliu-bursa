/** Setările utilizatorului și cheile API (criptate). */
import {
  BASE_CURRENCIES,
  PROVIDER_IDS,
  REFRESH_INTERVALS,
  type CostMethod,
  type ProviderId,
  type Settings,
  type SettingsUpdate,
  type Theme
} from '@shared/types';
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
}

function row(db: Db, userId: number): SettingsRow {
  let r = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) as SettingsRow | undefined;
  if (!r) {
    db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(userId);
    r = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) as SettingsRow;
  }
  return r;
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
  db.prepare(
    `UPDATE settings SET base_currency = ?, cost_method = ?, theme = ?, primary_provider = ?, refresh_interval_min = ?
     WHERE user_id = ?`
  ).run(next.base_currency, next.cost_method, next.theme, next.primary_provider, next.refresh_interval_min, userId);
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
