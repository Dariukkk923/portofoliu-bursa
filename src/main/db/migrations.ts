/**
 * Migrările schemei. Fiecare intrare este aplicată o singură dată, în ordine,
 * iar versiunea curentă se ține în `PRAGMA user_version`.
 *
 * Reguli:
 *  - nu modifica o migrare deja publicată; adaugă una nouă la finalul listei;
 *  - toate tabelele au `user_id`, inclusiv cache-ul de prețuri, astfel încât
 *    datele unui utilizator nu pot fi văzute sau deduse de alt utilizator.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'schema inițială',
    sql: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email         TEXT,
        password_hash TEXT NOT NULL,
        is_demo       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Sesiuni „ține-mă minte”: în bază stă doar hash-ul tokenului.
      CREATE TABLE sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        base_currency        TEXT NOT NULL DEFAULT 'RON',
        cost_method          TEXT NOT NULL DEFAULT 'AVG' CHECK (cost_method IN ('AVG', 'FIFO')),
        theme                TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
        primary_provider     TEXT NOT NULL DEFAULT 'yahoo',
        refresh_interval_min INTEGER NOT NULL DEFAULT 5,
        last_price_update    TEXT
      );

      -- Chei API criptate (vezi main/secrets.ts).
      CREATE TABLE api_keys (
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider      TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        hint          TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, provider)
      );

      CREATE TABLE brokers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL COLLATE NOCASE,
        notes      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, name)
      );

      CREATE TABLE assets (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type              TEXT NOT NULL CHECK (type IN ('stock', 'etf', 'bond', 'crypto')),
        symbol            TEXT NOT NULL COLLATE NOCASE,
        name              TEXT NOT NULL DEFAULT '',
        currency          TEXT NOT NULL,
        face_value        REAL,
        coupon_rate       REAL,
        coupon_frequency  INTEGER,
        maturity_date     TEXT,
        price_mode        TEXT NOT NULL DEFAULT 'auto' CHECK (price_mode IN ('auto', 'manual')),
        manual_price      REAL,
        manual_price_date TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, symbol)
      );

      CREATE TABLE transactions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asset_id          INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        broker_id         INTEGER REFERENCES brokers(id) ON DELETE RESTRICT,
        type              TEXT NOT NULL CHECK (type IN ('buy', 'sell', 'dividend', 'coupon', 'split')),
        date              TEXT NOT NULL,
        quantity          REAL NOT NULL DEFAULT 0,
        price             REAL NOT NULL DEFAULT 0,
        fee               REAL NOT NULL DEFAULT 0,
        currency          TEXT NOT NULL,
        gross_amount      REAL NOT NULL DEFAULT 0,
        tax_withheld      REAL NOT NULL DEFAULT 0,
        net_amount        REAL NOT NULL DEFAULT 0,
        split_numerator   REAL,
        split_denominator REAL,
        notes             TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        -- doar split-urile pot fi fără broker (se aplică la toți brokerii)
        CHECK (type = 'split' OR broker_id IS NOT NULL)
      );
      CREATE INDEX idx_tx_user_date  ON transactions (user_id, date, id);
      CREATE INDEX idx_tx_user_asset ON transactions (user_id, asset_id);

      -- Ultimul preț cunoscut pentru fiecare simbol (și pentru perechile valutare, ex. EURRON=X).
      CREATE TABLE prices (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol     TEXT NOT NULL,
        price      REAL NOT NULL,
        currency   TEXT,
        as_of      TEXT NOT NULL,
        provider   TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (user_id, symbol)
      ) WITHOUT ROWID;

      -- Prețuri de închidere zilnice, folosite de graficul de evoluție.
      CREATE TABLE price_history (
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol         TEXT NOT NULL,
        date           TEXT NOT NULL,
        close          REAL NOT NULL,
        split_adjusted INTEGER NOT NULL DEFAULT 1,
        provider       TEXT,
        PRIMARY KEY (user_id, symbol, date)
      ) WITHOUT ROWID;

      -- Evidența descărcărilor de istoric (cache: nu cerem de două ori același interval).
      CREATE TABLE history_sync (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol     TEXT NOT NULL,
        from_date  TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        provider   TEXT,
        PRIMARY KEY (user_id, symbol)
      ) WITHOUT ROWID;
    `
  }
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
