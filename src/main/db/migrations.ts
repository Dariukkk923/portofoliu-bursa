/**
 * Migrările schemei. Fiecare intrare este aplicată o singură dată, în ordine,
 * iar versiunea curentă se ține în `PRAGMA user_version`.
 *
 * Reguli:
 *  - nu modifica o migrare deja publicată; adaugă una nouă la finalul listei;
 *  - toate tabelele au `user_id`, inclusiv cache-ul de prețuri, astfel încât
 *    datele unui utilizator nu pot fi văzute sau deduse de alt utilizator.
 */
import type { Db } from './database';
import { dec, decText } from '@shared/calc/decimal';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Pași care nu se pot scrie în SQL (ex.: normalizarea valorilor), rulați după `sql`, în aceeași tranzacție. */
  after?: (db: Db) => void;
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
  },
  {
    version: 2,
    name: 'import din rapoartele brokerilor',
    sql: `
      -- Identificatorul operațiunii în raportul brokerului (ex.: „xtb:530692719”).
      -- Reimportul aceluiași raport nu dublează tranzacțiile deja preluate.
      ALTER TABLE transactions ADD COLUMN external_id TEXT;
      CREATE UNIQUE INDEX idx_tx_external ON transactions (user_id, external_id) WHERE external_id IS NOT NULL;

      -- Corespondența dintre simbolul folosit de broker (ex.: „CSPX.UK”) și activul din aplicație,
      -- reținută ca la următorul import să nu mai fie nevoie de nicio alegere.
      CREATE TABLE broker_symbols (
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source        TEXT NOT NULL,
        broker_symbol TEXT NOT NULL,
        asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, source, broker_symbol)
      ) WITHOUT ROWID;
    `
  },
  {
    version: 3,
    name: 'sume exacte, tranzacții de cash și loturi de import',
    sql: `
      -- Loturile de import: fiecare fișier importat poate fi anulat complet.
      CREATE TABLE import_batches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source      TEXT NOT NULL,
        file_name   TEXT,
        broker_id   INTEGER REFERENCES brokers(id) ON DELETE SET NULL,
        tx_count    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Tabela tranzacțiilor se reconstruiește:
      --  - sumele și cantitățile se păstrează ca text zecimal exact („0.1”), nu ca virgulă mobilă;
      --  - tranzacțiile de cash (depuneri, retrageri, dobânzi, ajustări) nu au activ;
      --  - suma debitată efectiv de broker (cash_amount, în cash_currency), dacă apare în extras;
      --  - lotul de import din care provine tranzacția.
      CREATE TABLE transactions_v3 (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asset_id          INTEGER REFERENCES assets(id) ON DELETE CASCADE,
        broker_id         INTEGER REFERENCES brokers(id) ON DELETE RESTRICT,
        type              TEXT NOT NULL CHECK (type IN ('buy', 'sell', 'dividend', 'coupon', 'split',
                                                        'deposit', 'withdrawal', 'fee', 'interest', 'adjustment')),
        date              TEXT NOT NULL,
        quantity          TEXT NOT NULL DEFAULT '0',
        price             TEXT NOT NULL DEFAULT '0',
        fee               TEXT NOT NULL DEFAULT '0',
        currency          TEXT NOT NULL,
        gross_amount      TEXT NOT NULL DEFAULT '0',
        tax_withheld      TEXT NOT NULL DEFAULT '0',
        net_amount        TEXT NOT NULL DEFAULT '0',
        split_numerator   TEXT,
        split_denominator TEXT,
        notes             TEXT,
        cash_amount       TEXT,
        cash_currency     TEXT,
        external_id       TEXT,
        batch_id          INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        -- doar split-urile pot fi fără broker (se aplică la toți brokerii)
        CHECK (type = 'split' OR broker_id IS NOT NULL),
        -- tranzacțiile cu activ au activ; depunerile, retragerile, dobânzile și ajustările nu au
        CHECK (type IN ('deposit', 'withdrawal', 'fee', 'interest', 'adjustment') OR asset_id IS NOT NULL),
        CHECK (type NOT IN ('deposit', 'withdrawal', 'interest', 'adjustment') OR asset_id IS NULL)
      );
      INSERT INTO transactions_v3 (id, user_id, asset_id, broker_id, type, date, quantity, price, fee, currency,
          gross_amount, tax_withheld, net_amount, split_numerator, split_denominator, notes, external_id, created_at)
        SELECT id, user_id, asset_id, broker_id, type, date, CAST(quantity AS TEXT), CAST(price AS TEXT), CAST(fee AS TEXT),
          currency, CAST(gross_amount AS TEXT), CAST(tax_withheld AS TEXT), CAST(net_amount AS TEXT),
          CAST(split_numerator AS TEXT), CAST(split_denominator AS TEXT), notes, external_id, created_at
        FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_v3 RENAME TO transactions;
      CREATE INDEX idx_tx_user_date  ON transactions (user_id, date, id);
      CREATE INDEX idx_tx_user_asset ON transactions (user_id, asset_id);
      CREATE INDEX idx_tx_user_batch ON transactions (user_id, batch_id) WHERE batch_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_tx_external ON transactions (user_id, external_id) WHERE external_id IS NOT NULL;
    `,
    after(db) {
      // SQLite scrie valorile REAL ca text cu 15 cifre semnificative („10.0”, „1.0e-08”);
      // le aducem la forma zecimală obișnuită („10”, „0.00000001”), fără pierderi.
      const columns = ['quantity', 'price', 'fee', 'gross_amount', 'tax_withheld', 'net_amount', 'split_numerator', 'split_denominator'];
      const rows = db.prepare(`SELECT id, type, ${columns.join(', ')} FROM transactions`).all() as Record<string, string | null>[];
      const update = db.prepare(`UPDATE transactions SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
      for (const row of rows) {
        const values = columns.map((c) => (row[c] === null || row[c] === undefined ? null : decText(row[c] as string)));
        // Suma netă a dividendelor/cupoanelor se recalculează exact: brut − impozit.
        if (row.type === 'dividend' || row.type === 'coupon') values[5] = decText(dec(values[3]).minus(dec(values[4])));
        update.run(...values, row.id);
      }
    }
  },
  {
    version: 4,
    name: 'mai multe portofolii',
    sql: `
      -- Portofoliile utilizatorului (ex.: „Pe termen lung”, „Trading”, „Pensie”), fiecare cu evidență separată.
      CREATE TABLE portfolios (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT NOT NULL COLLATE NOCASE,
        color         TEXT NOT NULL DEFAULT 'blue',
        icon          TEXT NOT NULL DEFAULT 'wallet',
        base_currency TEXT NOT NULL DEFAULT 'RON',
        benchmark     TEXT,
        archived      INTEGER NOT NULL DEFAULT 0,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, name)
      );

      -- Toate datele existente ajung în portofoliul „Principal” al fiecărui utilizator, cu moneda de bază din setări.
      INSERT INTO portfolios (user_id, name, base_currency)
        SELECT u.id, 'Principal', COALESCE((SELECT s.base_currency FROM settings s WHERE s.user_id = u.id), 'RON') FROM users u;

      -- Fiecare tranzacție aparține unui portofoliu; split-urile (evenimente ale companiei) rămân fără portofoliu
      -- și se aplică în toate. Ștergerea unui portofoliu îi șterge și tranzacțiile.
      ALTER TABLE transactions ADD COLUMN portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE CASCADE;
      UPDATE transactions SET portfolio_id = (SELECT p.id FROM portfolios p WHERE p.user_id = transactions.user_id)
        WHERE type <> 'split';
      CREATE INDEX idx_tx_user_portfolio ON transactions (user_id, portfolio_id);

      -- Ultimul portofoliu selectat: id-ul lui sau „all” (toate, combinate); NULL = primul portofoliu.
      ALTER TABLE settings ADD COLUMN active_portfolio TEXT;
      ALTER TABLE import_batches ADD COLUMN portfolio_id INTEGER REFERENCES portfolios(id) ON DELETE SET NULL;
    `
  },
  {
    version: 5,
    name: 'import universal din extrase',
    sql: `
      -- Șabloanele de mapare a coloanelor pentru importul universal, recunoscute după antetul fișierului.
      CREATE TABLE import_templates (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        signature    TEXT NOT NULL,
        mapping      TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        UNIQUE (user_id, signature)
      );

      -- Detaliile unui import, ca să poată fi afișat și anulat complet:
      --  created  = activele (și brokerul) create de import, șterse la anulare dacă nu mai sunt folosite;
      --  replaced = tranzacțiile introduse manual înlocuite de import, puse la loc la anulare.
      ALTER TABLE import_batches ADD COLUMN format_label TEXT;
      ALTER TABLE import_batches ADD COLUMN date_from TEXT;
      ALTER TABLE import_batches ADD COLUMN date_to TEXT;
      ALTER TABLE import_batches ADD COLUMN summary TEXT;
      ALTER TABLE import_batches ADD COLUMN created TEXT;
      ALTER TABLE import_batches ADD COLUMN replaced TEXT;

      -- Codul ISIN al activelor importate: același instrument este recunoscut și la alt broker.
      ALTER TABLE assets ADD COLUMN isin TEXT;
      CREATE INDEX idx_assets_isin ON assets (user_id, isin) WHERE isin IS NOT NULL;
    `
  },
  {
    version: 6,
    name: 'logo-uri și watchlist',
    sql: `
      -- Logo-urile companiilor, descărcate o singură dată de la providerii configurați (merg și offline).
      -- data NULL = providerul nu are logo pentru simbol (se reîncearcă după o vreme).
      CREATE TABLE logos (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol     TEXT NOT NULL,
        mime       TEXT,
        data       BLOB,
        source     TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (user_id, symbol)
      );

      -- Listele de urmărire și instrumentele din ele (fără să fie deținute).
      CREATE TABLE watchlists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL COLLATE NOCASE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, name)
      );
      CREATE TABLE watchlist_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        symbol       TEXT NOT NULL,
        type         TEXT NOT NULL CHECK (type IN ('stock', 'etf', 'bond', 'crypto')),
        currency     TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        target_price TEXT,
        note         TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (watchlist_id, symbol)
      );
      CREATE INDEX idx_watchlist_items_user ON watchlist_items (user_id, watchlist_id, sort_order);
    `
  },
  {
    version: 7,
    name: 'indice de referință și analiza riscului',
    sql: `
      -- Indicele cu care se compară randamentul (implicit S&P 500) și pragul de concentrare (implicit 20%).
      ALTER TABLE settings ADD COLUMN benchmark TEXT NOT NULL DEFAULT '^GSPC';
      ALTER TABLE settings ADD COLUMN concentration_limit REAL NOT NULL DEFAULT 0.2;

      -- Sectorul (categoria, la ETF-uri) și țara fiecărui activ: de la provider sau completate manual.
      ALTER TABLE assets ADD COLUMN sector TEXT;
      ALTER TABLE assets ADD COLUMN country TEXT;
      ALTER TABLE assets ADD COLUMN profile_source TEXT CHECK (profile_source IN ('api', 'manual', 'none'));
      ALTER TABLE assets ADD COLUMN profile_fetched_at TEXT;
    `
  },
  {
    version: 8,
    name: 'raport fiscal și calendar de dividende',
    sql: `
      -- Brokerul din România (impozitul se reține la sursă) sau străin (veniturile se declară în Declarația Unică).
      ALTER TABLE brokers ADD COLUMN residence TEXT NOT NULL DEFAULT 'foreign' CHECK (residence IN ('ro', 'foreign'));
      UPDATE brokers SET residence = 'ro'
       WHERE lower(name) LIKE '%tradeville%' OR lower(name) LIKE '%bt capital%' OR lower(name) LIKE '%bt trade%'
          OR lower(name) LIKE '%bcr%' OR lower(name) LIKE '%goldring%' OR lower(name) LIKE '%investimental%'
          OR lower(name) LIKE '%prime transaction%' OR lower(name) LIKE '%swiss capital%' OR lower(name) LIKE '%estinvest%'
          OR lower(name) LIKE '%intercapital%' OR lower(name) LIKE '%ssif%' OR lower(name) LIKE '%fidelis%';

      -- Cursurile oficiale BNR (lei pentru o unitate), descărcate pe ani, pentru raportul fiscal.
      CREATE TABLE fx_official (
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        currency TEXT NOT NULL,
        date     TEXT NOT NULL,
        rate     TEXT NOT NULL,
        PRIMARY KEY (user_id, currency, date)
      );
      CREATE TABLE fx_official_sync (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        year       INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        complete   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, year)
      );

      -- Dividendele cunoscute (de la provideri sau introduse manual), pe simbol; suma este pe acțiune.
      -- amount_estimated = 1: data este anunțată, dar suma este cea a dividendului anterior.
      CREATE TABLE dividend_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol           TEXT NOT NULL,
        ex_date          TEXT NOT NULL,
        pay_date         TEXT,
        amount           TEXT NOT NULL,
        currency         TEXT,
        source           TEXT NOT NULL,
        amount_estimated INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, symbol, ex_date, source)
      );
      CREATE INDEX idx_dividend_events_user ON dividend_events (user_id, symbol, ex_date);
      CREATE TABLE dividend_sync (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol     TEXT NOT NULL,
        provider   TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (user_id, symbol)
      );
      -- Dividendele propuse pe care utilizatorul a spus că nu le-a primit (nu se mai propun).
      CREATE TABLE dividend_dismissals (
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        ex_date  TEXT NOT NULL,
        PRIMARY KEY (user_id, asset_id, ex_date)
      );
    `
  },
  {
    version: 9,
    name: 'jurnal de investiții',
    sql: `
      -- Intrările din jurnal: motivul deciziei, planul (țintă, stop-loss, orizont), încrederea și mementoul de revizuire.
      -- Fiecare intrare ține de un activ dintr-un portofoliu; poate fi legată de tranzacția de cumpărare/vânzare.
      CREATE TABLE journal_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        asset_id       INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('buy', 'sell', 'note')),
        date           TEXT NOT NULL,
        reason         TEXT NOT NULL DEFAULT '',
        target_price   TEXT,
        stop_loss      TEXT,
        horizon_months INTEGER,
        confidence     INTEGER CHECK (confidence BETWEEN 1 AND 5),
        review_date    TEXT,
        reviewed_at    TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_journal_user ON journal_entries (user_id, date);
      CREATE INDEX idx_journal_tx ON journal_entries (transaction_id) WHERE transaction_id IS NOT NULL;
      CREATE TABLE journal_tags (
        entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tag      TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (entry_id, tag)
      );
    `
  },
  {
    version: 10,
    name: 'obiective financiare',
    sql: `
      -- Obiectivele: suma-țintă (opțional cu dată), ce valoare se urmărește și datele proiecției
      -- (contribuția lunară, sursa randamentului și a volatilității, inflația). NULL = calculat din aplicație.
      CREATE TABLE goals (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        portfolio_id         INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
        broker_id            INTEGER REFERENCES brokers(id) ON DELETE SET NULL,
        asset_type           TEXT CHECK (asset_type IN ('stock', 'etf', 'bond', 'crypto')),
        name                 TEXT NOT NULL,
        target_amount        TEXT NOT NULL,
        target_date          TEXT,
        monthly_contribution TEXT,
        return_source        TEXT NOT NULL DEFAULT 'auto' CHECK (return_source IN ('auto', 'personal', 'benchmark', 'manual')),
        manual_return        REAL,
        volatility_source    TEXT NOT NULL DEFAULT 'auto' CHECK (volatility_source IN ('auto', 'personal', 'benchmark', 'manual')),
        manual_volatility    REAL,
        inflation            REAL NOT NULL DEFAULT 0.04,
        sort_order           INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_goals_user ON goals (user_id, sort_order);
    `
  },
  {
    version: 11,
    name: 'cache pentru știri și raportări financiare',
    sql: `
      -- Cache generic per utilizator: știri ('news'), raportări ('fin'), calendar ('cal'), imagini ('thumb').
      -- Se poate reface oricând din rețea, de aceea nu intră în backup.
      CREATE TABLE research_cache (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        symbol     TEXT NOT NULL,
        payload    TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, symbol)
      );
    `
  },
  // Versiunea 12 nu a fost folosită (monedele și bursele nu au avut nevoie de migrare).
  {
    version: 13,
    name: 'alerte personalizate',
    sql: `
      -- Alertele utilizatorului: condiția (JSON cu tipul și pragurile), regulile de livrare și starea internă.
      -- portfolio_id NULL = toate portofoliile (sau alertă pe simbol, fără portofoliu).
      CREATE TABLE alerts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        portfolio_id      INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL,
        condition         TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        repeat_mode       TEXT NOT NULL DEFAULT 'once' CHECK (repeat_mode IN ('once', 'repeat')),
        min_pause_min     INTEGER NOT NULL DEFAULT 1440,
        window_start      TEXT,
        window_end        TEXT,
        sound             INTEGER NOT NULL DEFAULT 1,
        snoozed_until     TEXT,
        note              TEXT,
        state             TEXT NOT NULL DEFAULT '{}',
        last_triggered_at TEXT,
        trigger_count     INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_alerts_user ON alerts (user_id, enabled);
      -- Istoricul declanșărilor (centrul de notificări); rămâne și după ștergerea alertei.
      CREATE TABLE alert_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        alert_id   INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        note       TEXT,
        created_at TEXT NOT NULL,
        read_at    TEXT
      );
      CREATE INDEX idx_alert_events_user ON alert_events (user_id, id);
    `
  }
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
