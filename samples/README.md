# Extrase de exemplu pentru import

Fișierele de aici au **date inventate**: nu conțin niciun cont, nume, sold sau tranzacție reală.
Au structura exporturilor reale ale brokerilor și sunt folosite de testele automate
(`tests/statementImport.test.ts`), ca fiecare cititor să rămână corect când formatele se schimbă.

| Folder | Broker | De unde se exportă (în aplicația brokerului) |
| --- | --- | --- |
| `xtb/` | XTB (xStation) | Istoric cont → Operațiuni cash / Raport → export Excel (`.xlsx`); varianta veche CSV `xStation5_cashOperations_…csv` |
| `trading212/` | Trading 212 | History → Export (CSV, cel mult un an pe fișier) |
| `revolut/` | Revolut (acțiuni) | Invest → … → Documents → Account statement → Excel/CSV (nu „Profit and loss”) |
| `ibkr/` | Interactive Brokers | Performance & Reports → Statements → Activity → format CSV |
| `generic/` | orice alt broker | un tabel cu o operațiune pe rând (aici: CSV românesc cu `;`, virgulă zecimală și date ZZ.LL.AAAA) |

Exemplul Excel pentru XTB se generează din cod: `node scripts/make-samples.mjs`.

## Cum adaugi un exemplu nou (sau un broker nou)

1. **Anonimizează fișierul înainte să-l pui aici.** Nu adăuga niciodată un extras real:
   - înlocuiește numele, numărul de cont, IBAN-ul și orice identificator personal (ex.: `U0000000`, `Exemplu Anonim`);
   - schimbă sumele, cantitățile și datele (păstrează doar formatul: separatorul, virgula zecimală, ordinea zilei și a lunii);
   - păstrează antetul coloanelor și denumirile tipurilor de operațiuni exact ca în export — după ele se recunoaște formatul.
2. Pune fișierul în folderul brokerului (`samples/<broker>/…-exemplu.csv`).
3. Adaugă un test în `tests/statementImport.test.ts` care citește fișierul cu `sample('…')` și verifică rândurile
   rezultate (tip, dată, simbol, cantitate, preț, sumă) și, după import, pozițiile și cash-ul.
4. Pentru un broker nou: scrie un cititor în `src/shared/import/readers/<broker>.ts` după modelul celor existente
   (`detect` recunoaște fișierul după coloane, nu după nume; `read` întoarce rândurile în forma comună
   `StatementRow`) și adaugă-l în lista `READERS` din `src/shared/import/index.ts`.
   Până atunci, fișierul brokerului se poate importa oricum prin maparea coloanelor (ecranul Import),
   iar maparea se salvează ca șablon.
5. Rulează `npm test`.
