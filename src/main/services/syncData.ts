/**
 * Ce date se sincronizează și cum se vede că s-au schimbat.
 *
 * Amprenta (`dataHash`) cuprinde doar ce introduce utilizatorul. Tot ce rescrie aplicația singură
 * — prețuri și istoric, profilul activelor adus de provideri, dividendele de la provideri, ora ultimei
 * actualizări, starea internă a alertelor și istoricul declanșărilor — este lăsat deoparte, ca o
 * actualizare automată a prețurilor să nu pornească o încărcare pe server (și nici conflicte între dispozitive).
 * Amprenta se compară doar cu ea însăși pe același dispozitiv, deci id-urile locale pot rămâne în ea.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import type { SyncState } from '@shared/sync';

type Row = Record<string, unknown>;

/** Tabelele cu date introduse de utilizator, cu coloanele scoase din amprentă (sau un filtru pe rând). */
const HASHED: { table: string; where?: string; row?: (r: Row) => Row }[] = [
  { table: 'brokers' },
  {
    table: 'assets',
    row: ({ profile_fetched_at: _f, ...r }) => {
      // Sectorul și țara venite de la provider se reîmprospătează singure; doar cele completate manual contează.
      if (r.profile_source === 'manual') return r;
      const { sector: _s, country: _c, profile_source: _p, ...rest } = r;
      return rest;
    }
  },
  { table: 'portfolios' },
  { table: 'import_batches' },
  { table: 'transactions' },
  { table: 'broker_symbols' },
  { table: 'import_templates' },
  { table: 'watchlists' },
  { table: 'watchlist_items' },
  { table: 'dividend_events', where: "source = 'manual'" },
  { table: 'dividend_dismissals' },
  { table: 'journal_entries' },
  { table: 'journal_tags' },
  { table: 'goals' },
  {
    table: 'alerts',
    // Starea internă și declanșările le scrie evaluarea automată. O alertă „o dată” care a sunat se oprește singură:
    // pentru amprentă rămâne pornită, cum a lăsat-o utilizatorul.
    row: ({ state: _s, last_triggered_at: _l, trigger_count, ...r }) => ({
      ...r,
      enabled: r.repeat_mode === 'once' && Number(trigger_count) > 0 ? 1 : r.enabled
    })
  }
];

/** Preferințele sincronizate (fără ora ultimei actualizări și fără portofoliul selectat pe ecran). */
const SETTINGS_COLUMNS = ['base_currency', 'cost_method', 'theme', 'primary_provider', 'refresh_interval_min', 'benchmark', 'concentration_limit'];

/** Textul canonic al datelor sincronizate ale utilizatorului (determinist: rândurile sunt sortate). */
export function canonicalData(db: Db, userId: number): string {
  const parts: string[] = [];
  const s = db.prepare(`SELECT ${SETTINGS_COLUMNS.join(', ')} FROM settings WHERE user_id = ?`).get(userId) as Row | undefined;
  parts.push('settings:' + JSON.stringify(s ?? null));
  for (const { table, where, row } of HASHED) {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE user_id = ?${where ? ` AND ${where}` : ''}`).all(userId) as Row[];
    const lines = rows.map((r) => {
      const { user_id: _u, ...rest } = r;
      const out = row ? row(rest) : rest;
      return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
    });
    lines.sort();
    parts.push(`${table}:${lines.length}\n${lines.join('\n')}`);
  }
  return parts.join('\n');
}

export const dataHash = (db: Db, userId: number): string => createHash('sha256').update(canonicalData(db, userId)).digest('hex');

/** Contul nu are încă nimic introdus (doar portofoliul „Principal” creat la înregistrare). */
export function hasNoUserData(db: Db, userId: number): boolean {
  for (const table of ['transactions', 'assets', 'brokers', 'watchlist_items', 'journal_entries', 'goals', 'alerts']) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE user_id = ? LIMIT 1`).get(userId)) return false;
  }
  if (db.prepare("SELECT 1 FROM dividend_events WHERE user_id = ? AND source = 'manual' LIMIT 1").get(userId)) return false;
  return (db.prepare('SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ?').get(userId) as { n: number }).n <= 1;
}

// --- starea locală a sincronizării (tabela sync_state) ----------------------

export interface SyncRow {
  creds: string | null;
  linked: boolean;
  version: number;
  hash: string | null;
  syncedAt: number | null;
  /** Starea salvată: ok/off/conflict/name_taken, plus „password_changed” (parola schimbată pe alt dispozitiv). */
  status: SyncState | 'password_changed';
  remoteDevice: string | null;
}

export function readSyncRow(db: Db, userId: number): SyncRow {
  const r = db.prepare('SELECT * FROM sync_state WHERE user_id = ?').get(userId) as Row | undefined;
  return {
    creds: (r?.creds as string | null) ?? null,
    linked: Number(r?.linked ?? 0) === 1,
    version: Number(r?.version ?? 0),
    hash: (r?.hash as string | null) ?? null,
    syncedAt: r?.synced_at == null ? null : Number(r.synced_at),
    status: (r?.status as SyncRow['status'] | undefined) ?? 'off',
    remoteDevice: (r?.remote_device as string | null) ?? null
  };
}

const COLUMN: Record<keyof SyncRow, string> = {
  creds: 'creds',
  linked: 'linked',
  version: 'version',
  hash: 'hash',
  syncedAt: 'synced_at',
  status: 'status',
  remoteDevice: 'remote_device'
};

export function writeSyncRow(db: Db, userId: number, patch: Partial<SyncRow>): void {
  db.prepare('INSERT OR IGNORE INTO sync_state (user_id) VALUES (?)').run(userId);
  const keys = (Object.keys(patch) as (keyof SyncRow)[]).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const value = (k: keyof SyncRow): unknown => (k === 'linked' ? (patch.linked ? 1 : 0) : patch[k]);
  db.prepare(`UPDATE sync_state SET ${keys.map((k) => `${COLUMN[k]} = ?`).join(', ')} WHERE user_id = ?`).run(...keys.map(value), userId);
}
