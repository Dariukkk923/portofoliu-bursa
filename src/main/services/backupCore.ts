/**
 * Backup și restaurare.
 *
 * Backup-ul este un fișier SQLite de sine stătător, cu aceeași schemă ca baza
 * aplicației, care conține DOAR datele utilizatorului curent (brokeri, active,
 * tranzacții, setări și prețurile salvate). Nu conține parola și nici cheile
 * API (acestea sunt criptate cu o cheie legată de calculator și se reintroduc).
 *
 * Restaurarea înlocuiește datele utilizatorului curent cu cele din fișier, fără
 * să atingă datele altor utilizatori.
 *
 * Aici stă logica pură, pe baze deschise (fără fișiere): o folosesc și desktopul
 * (backup.ts, cu fișiere temporare) și versiunea web (în memorie).
 */
import { LATEST_SCHEMA_VERSION } from '../db/migrations';
import { migrate, type Db } from '../db/database';
import { AppError, assert } from './common';

const APP_MARKER = 'portofoliu-bursa';
/** Tabelele cu datele utilizatorului, în ordinea în care pot fi inserate (respectă cheile străine). */
const USER_TABLES = [
  'brokers',
  'assets',
  'portfolios',
  'import_batches',
  'transactions',
  'broker_symbols',
  'import_templates',
  'watchlists',
  'watchlist_items',
  'prices',
  'price_history',
  'history_sync',
  'dividend_events',
  'dividend_sync',
  'dividend_dismissals',
  'fx_official',
  'fx_official_sync',
  'journal_entries',
  'journal_tags',
  'goals',
  'alerts',
  'alert_events'
] as const;

type Row = Record<string, unknown>;

function insertRow(target: Db, table: string, row: Row): number {
  const cols = Object.keys(row);
  const info = target
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

/** Umple `out` (o bază goală, deschisă de apelant) cu backup-ul utilizatorului. */
export function buildBackup(db: Db, userId: number, out: Db): { transactions: number } {
  const user = db.prepare('SELECT id, username, email, is_demo, created_at FROM users WHERE id = ?').get(userId) as
    | Row
    | undefined;
  assert(user, 'Contul nu a fost găsit.');

  {
    migrate(out);
    let transactions = 0;
    out.transaction(() => {
      out.exec('CREATE TABLE backup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const meta = out.prepare('INSERT INTO backup_meta (key, value) VALUES (?, ?)');
      meta.run('app', APP_MARKER);
      meta.run('created_at', new Date().toISOString());
      meta.run('username', String(user.username));

      // Parola nu se exportă: restaurarea se face mereu în contul celui autentificat.
      insertRow(out, 'users', { ...user, password_hash: '' });
      const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) as Row | undefined;
      if (settings) insertRow(out, 'settings', { ...settings, last_price_update: null });

      for (const table of USER_TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId) as Row[];
        for (const row of rows) insertRow(out, table, row);
        if (table === 'transactions') transactions = rows.length;
      }
    })();
    return { transactions };
  }
}

/** Înlocuiește datele utilizatorului curent cu cele din `src` (o copie a backup-ului, deschisă de apelant; este migrată aici). */
export function restoreFrom(
  db: Db,
  userId: number,
  src: Db
): { brokers: number; assets: number; transactions: number } {
  {
    try {
      const marker = src.prepare("SELECT value FROM backup_meta WHERE key = 'app'").get() as { value: string } | undefined;
      if (marker?.value !== APP_MARKER) throw new Error('marker');
    } catch {
      throw new AppError('Fișierul ales nu este un backup creat de această aplicație.');
    }
    const version = src.pragma('user_version', { simple: true }) as number;
    assert(
      version <= LATEST_SCHEMA_VERSION,
      'Backup-ul a fost creat cu o versiune mai nouă a aplicației. Actualizează aplicația și încearcă din nou.'
    );
    migrate(src);

    const source = src;
    const owner = source.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    assert(owner, 'Backup-ul nu conține date.');
    const read = (table: string): Row[] =>
      source.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(owner.id) as Row[];

    const counts = { brokers: 0, assets: 0, transactions: 0 };
    db.transaction(() => {
      // 1. Ștergem datele actuale ale utilizatorului (tranzacțiile întâi, din cauza cheilor străine).
      for (const table of [
        'alert_events',
        'alerts',
        'goals',
        'journal_tags',
        'journal_entries',
        'transactions',
        'broker_symbols',
        'import_batches',
        'import_templates',
        'watchlist_items',
        'watchlists',
        'dividend_dismissals',
        'dividend_events',
        'dividend_sync',
        'fx_official',
        'fx_official_sync',
        'assets',
        'brokers',
        'portfolios',
        'prices',
        'price_history',
        'history_sync'
      ]) {
        db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
      }

      // 2. Brokerii și activele primesc id-uri noi; păstrăm corespondența veche -> nouă.
      const brokerIds = new Map<number, number>();
      for (const { id, ...row } of read('brokers')) {
        brokerIds.set(id as number, insertRow(db, 'brokers', { ...row, user_id: userId }));
      }
      const assetIds = new Map<number, number>();
      for (const { id, ...row } of read('assets')) {
        assetIds.set(id as number, insertRow(db, 'assets', { ...row, user_id: userId }));
      }

      // Portofoliile (backup-urile vechi au primit la migrare portofoliul „Principal”).
      const portfolioIds = new Map<number, number>();
      for (const { id, ...row } of read('portfolios')) {
        portfolioIds.set(id as number, insertRow(db, 'portfolios', { ...row, user_id: userId }));
      }
      const portfolioOf = (value: unknown): number | null => (value == null ? null : (portfolioIds.get(value as number) ?? null));

      // Loturile de import (ca un import restaurat să poată fi anulat în continuare). Id-urile din
      // detaliile lotului (activele create, tranzacțiile manuale înlocuite) se traduc și ele.
      const mapIds = (ids: unknown, map: Map<number, number>): number[] =>
        Array.isArray(ids) ? ids.map((x) => map.get(Number(x))).filter((x): x is number => x !== undefined) : [];
      const json = (value: unknown): Record<string, unknown> | unknown[] | null => {
        try {
          return typeof value === 'string' && value ? JSON.parse(value) : null;
        } catch {
          return null;
        }
      };
      const batchIds = new Map<number, number>();
      for (const { id, ...row } of read('import_batches')) {
        const created = json(row.created) as Record<string, unknown> | null;
        const replaced = json(row.replaced) as Record<string, unknown>[] | null;
        batchIds.set(
          id as number,
          insertRow(db, 'import_batches', {
            ...row,
            user_id: userId,
            broker_id: row.broker_id == null ? null : (brokerIds.get(row.broker_id as number) ?? null),
            portfolio_id: portfolioOf(row.portfolio_id),
            created: created
              ? JSON.stringify({
                  assets: mapIds(created.assets, assetIds),
                  broker: created.broker == null ? null : (brokerIds.get(Number(created.broker)) ?? null),
                  brokers: mapIds(created.brokers, brokerIds),
                  portfolios: mapIds(created.portfolios, portfolioIds)
                })
              : null,
            replaced: Array.isArray(replaced)
              ? JSON.stringify(
                  replaced.map((t) => ({
                    ...t,
                    user_id: userId,
                    asset_id: t.asset_id == null ? null : (assetIds.get(Number(t.asset_id)) ?? null),
                    broker_id: t.broker_id == null ? null : (brokerIds.get(Number(t.broker_id)) ?? null),
                    portfolio_id: portfolioOf(t.portfolio_id),
                    batch_id: null
                  }))
                )
              : null
          })
        );
      }

      // 3. Tranzacțiile, cu referințele traduse la noile id-uri. Tranzacțiile de cash nu au activ.
      const txIds = new Map<number, number>();
      for (const { id: oldTxId, ...row } of read('transactions')) {
        const assetId = row.asset_id == null ? null : assetIds.get(row.asset_id as number);
        if (assetId === undefined) continue;
        const portfolioId = portfolioOf(row.portfolio_id);
        if (portfolioId === null && row.type !== 'split') continue;
        const newTxId = insertRow(db, 'transactions', {
          ...row,
          user_id: userId,
          portfolio_id: portfolioId,
          asset_id: assetId,
          broker_id: row.broker_id == null ? null : (brokerIds.get(row.broker_id as number) ?? null),
          batch_id: row.batch_id == null ? null : (batchIds.get(row.batch_id as number) ?? null)
        });
        txIds.set(oldTxId as number, newTxId);
        counts.transactions++;
      }

      // Jurnalul: intrările (cu activul, portofoliul și tranzacția traduse la id-urile noi), apoi etichetele lor.
      const entryIds = new Map<number, number>();
      for (const { id, ...row } of read('journal_entries')) {
        const assetId = assetIds.get(row.asset_id as number);
        const portfolioId = portfolioOf(row.portfolio_id);
        if (assetId === undefined || portfolioId === null) continue;
        entryIds.set(
          id as number,
          insertRow(db, 'journal_entries', {
            ...row,
            user_id: userId,
            asset_id: assetId,
            portfolio_id: portfolioId,
            transaction_id: row.transaction_id == null ? null : (txIds.get(row.transaction_id as number) ?? null)
          })
        );
      }
      for (const row of read('journal_tags')) {
        const entryId = entryIds.get(row.entry_id as number);
        if (entryId !== undefined) insertRow(db, 'journal_tags', { ...row, user_id: userId, entry_id: entryId });
      }

      // Obiectivele (cu portofoliul și brokerul traduse; un portofoliu care nu mai există = toate portofoliile).
      const goalIds = new Map<number, number>();
      for (const { id: gid, ...row } of read('goals')) {
        goalIds.set(gid as number, insertRow(db, 'goals', {
          ...row,
          user_id: userId,
          portfolio_id: portfolioOf(row.portfolio_id),
          broker_id: row.broker_id == null ? null : (brokerIds.get(row.broker_id as number) ?? null)
        }));
      }

      // Alertele: condiția poartă id-uri de obiectiv și de intrare din jurnal, traduse la cele noi; istoricul declanșărilor le urmează.
      const alertIds = new Map<number, number>();
      for (const { id: aid, ...row } of read('alerts')) {
        const cond = json(row.condition) as Record<string, unknown> | null;
        if (!cond || Array.isArray(cond)) continue;
        if (cond.kind === 'goal') {
          const g = goalIds.get(Number(cond.goalId));
          if (g === undefined) continue;
          cond.goalId = g;
        }
        if (cond.kind === 'journal_review' && cond.entryId != null) {
          const e = entryIds.get(Number(cond.entryId));
          if (e === undefined) continue;
          cond.entryId = e;
        }
        alertIds.set(aid as number, insertRow(db, 'alerts', { ...row, user_id: userId, portfolio_id: portfolioOf(row.portfolio_id), condition: JSON.stringify(cond) }));
      }
      for (const { id: _eid, ...row } of read('alert_events')) {
        insertRow(db, 'alert_events', { ...row, user_id: userId, alert_id: row.alert_id == null ? null : (alertIds.get(row.alert_id as number) ?? null) });
      }

      // Corespondențele dintre simbolurile brokerului și active și șabloanele de mapare (pentru importurile viitoare).
      for (const row of read('broker_symbols')) {
        const assetId = assetIds.get(row.asset_id as number);
        if (assetId !== undefined) insertRow(db, 'broker_symbols', { ...row, user_id: userId, asset_id: assetId });
      }
      for (const { id: _tid, ...row } of read('import_templates')) insertRow(db, 'import_templates', { ...row, user_id: userId });

      // Watchlist-ul: listele, apoi instrumentele lor (cu id-ul nou al listei).
      const watchlistIds = new Map<number, number>();
      for (const { id, ...row } of read('watchlists')) watchlistIds.set(id as number, insertRow(db, 'watchlists', { ...row, user_id: userId }));
      for (const { id: _wid, ...row } of read('watchlist_items')) {
        const list = watchlistIds.get(row.watchlist_id as number);
        if (list !== undefined) insertRow(db, 'watchlist_items', { ...row, user_id: userId, watchlist_id: list });
      }

      // Dividendele (cele introduse manual și cele de la provideri) și propunerile respinse.
      for (const { id: _did, ...row } of read('dividend_events')) insertRow(db, 'dividend_events', { ...row, user_id: userId });
      for (const row of read('dividend_dismissals')) {
        const assetId = assetIds.get(row.asset_id as number);
        if (assetId !== undefined) insertRow(db, 'dividend_dismissals', { ...row, user_id: userId, asset_id: assetId });
      }

      // 4. Prețurile, dividendele și cursurile BNR salvate (ca aplicația să funcționeze și fără internet).
      for (const table of ['prices', 'price_history', 'history_sync', 'dividend_sync', 'fx_official', 'fx_official_sync']) {
        for (const row of read(table)) insertRow(db, table, { ...row, user_id: userId });
      }

      // 5. Preferințele (fără cheile API).
      const s = source.prepare('SELECT * FROM settings WHERE user_id = ?').get(owner.id) as Row | undefined;
      if (s) {
        const active = s.active_portfolio === 'all' ? 'all' : portfolioOf(Number(s.active_portfolio) || null);
        db.prepare(
          `UPDATE settings SET base_currency = ?, cost_method = ?, theme = ?, primary_provider = ?,
             refresh_interval_min = ?, active_portfolio = ?, benchmark = ?, concentration_limit = ?, last_price_update = NULL WHERE user_id = ?`
        ).run(
          s.base_currency,
          s.cost_method,
          s.theme,
          s.primary_provider,
          s.refresh_interval_min,
          active === null ? null : String(active),
          s.benchmark ?? '^GSPC',
          s.concentration_limit ?? 0.2,
          userId
        );
      }
      counts.brokers = brokerIds.size;
      counts.assets = assetIds.size;
    })();
    return counts;
  }
}
