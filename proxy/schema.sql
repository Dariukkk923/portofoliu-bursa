-- Sincronizarea conturilor (Cloudflare D1, legătura SYNC_DB).
-- Serverul păstrează doar: numele de utilizator, sha256 al cheii de autentificare, momente de timp,
-- un contor de încercări greșite și copia criptată end-to-end (base64). Parola și cheia de criptare
-- nu ajung niciodată aici.
--
-- Aplicare: npx wrangler d1 execute portofoliu-sync --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS sync_users (
  username     TEXT PRIMARY KEY,            -- litere mici, [a-z0-9._-]{3,32}
  key_hash     TEXT NOT NULL,               -- sha256(authKey), hex
  created_at   INTEGER NOT NULL,            -- ms
  failed       INTEGER NOT NULL DEFAULT 0,  -- autentificări greșite la rând
  locked_until INTEGER NOT NULL DEFAULT 0,  -- ms; blocat până atunci după 10 greșeli
  version      INTEGER NOT NULL DEFAULT 0,  -- 0 = nicio copie încă
  updated_at   INTEGER,                     -- ms, ora serverului
  device       TEXT,                        -- „Windows · PC”, „iPhone · Safari” …
  gen          TEXT,                        -- generația bucăților din sync_chunks care formează copia curentă
  chunks       INTEGER NOT NULL DEFAULT 0   -- numărul de bucăți ale copiei curente
);

-- Copia criptată (base64), tăiată în bucăți sub limita D1 de ~2 MB pe valoare. Bucățile unei scrieri noi
-- primesc o generație nouă (aleatoare); comutarea pe ea și ștergerea celor vechi se fac atomic, într-un batch.
CREATE TABLE IF NOT EXISTS sync_chunks (
  username TEXT NOT NULL,
  gen      TEXT NOT NULL,
  idx      INTEGER NOT NULL,
  data     TEXT NOT NULL,
  PRIMARY KEY (username, gen, idx)
);
