# Proxy de prețuri (Cloudflare Worker)

Versiunea web a aplicației (cea de iPhone) rulează în browser, iar browserul nu poate cere direct Yahoo Finance,
fișierele BNR sau imaginile logo (nu trimit antete CORS). Acest Worker transmite doar aceste cereri.

## Ce face și ce nu face

- Transmite doar GET către adrese fixe din `src/index.js`:
  - `/yahoo/chart/<simbol>`: istoric, dividende, cotația din `meta` (și cursurile valutare, ex. `EURRON=X`);
  - `/yahoo/quote?symbols=A,B`: cotații (cu cookie și crumb);
  - `/yahoo/quoteSummary/<simbol>?modules=…`: sector, țară, calendarul dividendelor (cu cookie și crumb);
  - `/yahoo/search?q=…`: căutarea simbolurilor;
  - `/bnr?u=…`: doar fișiere `.xml` de pe `www.bnr.ro`;
  - `/logo?u=…`: doar imagini de pe `api.twelvedata.com`, `logo.twelvedata.com` și `api.polygon.io`, cel mult 256 KB.
- Răspunde doar originii din `ALLOWED_ORIGIN` (aplicația ta); orice alt site primește 403.
- Nu salvează și nu loghează nimic: fără KV, D1, R2, cron sau analytics, fără `console.log`, răspunsuri cu
  `cache-control: no-store`. Cheile API (Polygon pentru logo-uri) trec doar prin cerere și nu sunt citite sau păstrate.
  Singurul lucru ținut în memorie este crumb-ul Yahoo (un jeton public de sesiune), cât timp instanța rămâne pornită.
- Ceilalți provideri (Alpha Vantage, Twelve Data, Polygon pentru prețuri) răspund cu CORS și se apelează direct din
  aplicație, fără proxy.

## Publicare (o singură dată, gratuit)

1. Cont gratuit Cloudflare: <https://dash.cloudflare.com/sign-up>.
2. În acest folder: `npx wrangler login`, apoi `npx wrangler deploy`.
3. Dacă aplicația nu este la `https://dariukkk923.github.io`, schimbă `ALLOWED_ORIGIN` în `wrangler.toml`
   (doar schema și hostul, fără cale și fără „/” la final) și publică din nou.
4. Wrangler afișează adresa Worker-ului, de forma `https://portofoliu-proxy.<contul-tău>.workers.dev`.
   Lipește-o în aplicație, la Setări, în cardul „Versiunea pentru telefon”, la „Adresa proxy-ului de prețuri”.

Planul gratuit are 100.000 de cereri pe zi, mult peste nevoile unui portofoliu personal.

## Test local

`npx wrangler dev` pornește Worker-ul la `http://localhost:8787`. Pentru aplicația rulată local
(`npm run preview:web`, origine `http://localhost:4173`) setează temporar `ALLOWED_ORIGIN = "http://localhost:4173"`.
Adresa `http://localhost:8787` este acceptată în Setări pentru dezvoltare.

## Limite cunoscute

- Yahoo poate schimba oricând cookie-ul sau crumb-ul; dacă `/yahoo/quote` nu mai răspunde, aplicația cade pe
  `/yahoo/chart` (cotația din `meta`), care nu are nevoie de crumb. Sectorul și țara (quoteSummary) lipsesc atunci.
- Fișierele anuale BNR au fost mutate de BNR; dacă adresa se schimbă, aplicația folosește cursul propriu pentru raportul fiscal.
