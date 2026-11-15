# Proxy de prețuri și sincronizare (Cloudflare Worker)

Versiunea web a aplicației (cea de iPhone) rulează în browser, iar browserul nu poate cere direct Yahoo Finance,
fișierele BNR sau imaginile logo (nu trimit antete CORS). Acest Worker transmite doar aceste cereri.
Tot el ține sincronizarea contului între PC și telefon (vezi „Sincronizare” mai jos).

## Ce face și ce nu face

- Transmite doar GET către adrese fixe din `src/index.js`:
  - `/yahoo/chart/<simbol>`: istoric, dividende, cotația din `meta` (și cursurile valutare, ex. `EURRON=X`);
  - `/yahoo/quote?symbols=A,B`: cotații (cu cookie și crumb);
  - `/yahoo/quoteSummary/<simbol>?modules=…`: sector, țară, calendarul dividendelor (cu cookie și crumb);
  - `/yahoo/search?q=…`: căutarea simbolurilor;
  - `/bnr?u=…`: doar fișiere `.xml` de pe `www.bnr.ro`;
  - `/logo?u=…`: doar imagini de pe `api.twelvedata.com`, `logo.twelvedata.com`, `api.polygon.io`, `assets.parqet.com`,
    `financialmodelingprep.com` și favicon-urile Google (`www.google.com/s2/favicons`), cel mult 256 KB.
    După actualizarea aplicației, publică din nou proxy-ul ca să primească noile surse de logo-uri.
- Răspunde doar originii din `ALLOWED_ORIGIN` (aplicația ta); orice alt site primește 403.
- Rutele de prețuri nu salvează nimic. Nimic nu se loghează: fără KV, R2, cron sau analytics, fără `console.log`,
  răspunsuri cu `cache-control: no-store`. Singura stocare este baza D1 a sincronizării (vezi mai jos). Cheile API (Polygon pentru logo-uri) trec doar prin cerere și nu sunt citite sau păstrate.
  Singurul lucru ținut în memorie este crumb-ul Yahoo (un jeton public de sesiune), cât timp instanța rămâne pornită.
- Ceilalți provideri (Alpha Vantage, Twelve Data, Polygon pentru prețuri) răspund cu CORS și se apelează direct din
  aplicație, fără proxy.

## Sincronizare (`/sync/*`)

Același utilizator și aceeași parolă merg pe PC și pe telefon, cu aceleași date. Datele sunt criptate end-to-end:
din parolă, aplicația derivă (PBKDF2-SHA256, 310.000 iterații) o cheie de autentificare, trimisă serverului, și o cheie
AES-256-GCM, care nu părăsește dispozitivul. **Serverul păstrează doar**: numele de utilizator (litere mici),
sha256 al cheii de autentificare, momente de timp (creare, ultima copie, blocare), un contor de încercări greșite,
numele scurt al dispozitivului care a scris ultima copie și copia criptată (base64). Nu poate citi datele și nu
cunoaște parola.

| Metodă și adresă | Corp | Răspuns |
|---|---|---|
| `POST /sync/register` | `{ username, authKey }` | `201 {}`; `409 taken`; `400 invalid` |
| `GET /sync/head` | – | `200 { version, updatedAt, device }` (versiunea 0 dacă nu există copie) |
| `GET /sync/snapshot` | – | `200 { version, updatedAt, device, data }` sau `204` |
| `PUT /sync/snapshot` | `{ baseVersion, device, data }` | `200 { version, updatedAt }`; `409 conflict` (cu versiunea curentă); `413 too_large` |
| `POST /sync/password` | `{ newAuthKey, baseVersion, device, data }` | ca PUT; după succes merge doar cheia nouă |
| `DELETE /sync/account` | – | `200 {}`: contul și copia sunt șterse |

- Autentificare: `authorization: Sync base64(utilizator:authKey)`. Utilizator necunoscut și cheie greșită dau același
  `401 {error:"auth"}`. După 10 greșeli la rând contul se blochează 15 minute (`429 {error:"locked", retryAfter}`);
  o autentificare reușită golește contorul. Hash-urile se compară în timp constant.
- Copia are cel mult 20 MB (după decodare). D1 acceptă ~2 MB pe valoare, așa că serverul o taie în bucăți de base64:
  le scrie sub o generație nouă, apoi un singur batch (tranzacție) mută contul pe ea doar dacă versiunea este încă
  `baseVersion` și șterge bucățile vechi. Două dispozitive care scriu deodată nu pot câștiga amândouă (al doilea primește
  409), iar cine citește vede mereu o copie întreagă.
- Origini: cererile din browser doar de la `ALLOWED_ORIGIN` (CORS pentru GET, PUT, POST, DELETE), plus cererile fără
  antet `Origin` (aplicația desktop cere din Node). Orice alt site primește 403.

Baza D1 (`portofoliu-sync`, legătura `SYNC_DB` din `wrangler.toml`) se creează o singură dată:

```
npx wrangler d1 create portofoliu-sync          # pune database_id în wrangler.toml
npx wrangler d1 execute portofoliu-sync --remote --file=schema.sql
```

## Publicare (o singură dată, gratuit)

1. Cont gratuit Cloudflare: <https://dash.cloudflare.com/sign-up>.
2. În acest folder: `npx wrangler login`, apoi (o singură dată) baza D1 de mai sus și `npx wrangler deploy`.
3. Dacă aplicația nu este la `https://dariukkk923.github.io`, schimbă `ALLOWED_ORIGIN` în `wrangler.toml`
   (doar schema și hostul, fără cale și fără „/” la final) și publică din nou.
4. Wrangler afișează adresa Worker-ului, de forma `https://portofoliu-proxy.<contul-tău>.workers.dev`.
   Lipește-o în aplicație, la Setări, în cardul „Versiunea pentru telefon”, la „Adresa proxy-ului de prețuri”.

Planul gratuit are 100.000 de cereri pe zi și 5 GB în D1, mult peste nevoile unui portofoliu personal.

## Test local

`npx wrangler dev` pornește Worker-ul la `http://localhost:8787`. Pentru aplicația rulată local
(`npm run preview:web`, origine `http://localhost:4173`) setează temporar `ALLOWED_ORIGIN = "http://localhost:4173"`.
Adresa `http://localhost:8787` este acceptată în Setări pentru dezvoltare. Pentru sincronizare local:
`npx wrangler d1 execute portofoliu-sync --local --file=schema.sql`, apoi `npx wrangler dev`.

## Limite cunoscute

- Yahoo poate schimba oricând cookie-ul sau crumb-ul; dacă `/yahoo/quote` nu mai răspunde, aplicația cade pe
  `/yahoo/chart` (cotația din `meta`), care nu are nevoie de crumb. Sectorul și țara (quoteSummary) lipsesc atunci.
- Fișierele anuale BNR au fost mutate de BNR; dacă adresa se schimbă, aplicația folosește cursul propriu pentru raportul fiscal.
