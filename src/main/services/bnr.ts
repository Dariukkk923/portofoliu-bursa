/**
 * Cursurile oficiale BNR, pentru raportul fiscal: lei pentru o unitate de monedă, pe zile.
 *
 * Se descarcă fișierul anual publicat de BNR (XML) și se păstrează local; anii încheiați nu se
 * mai descarcă a doua oară. Pentru o zi fără curs (weekend, sărbătoare) se folosește cursul
 * din ultima zi lucrătoare de dinainte. Nu se trimite nimic despre utilizator: cererea este
 * doar pentru fișierul public al anului. Dacă descărcarea nu reușește, raportul folosește
 * cursul din aplicație și spune asta.
 */
import { dec } from '@shared/calc/decimal';
import { addDays, todayIso } from '@shared/dates';
import type { Db } from '../db/database';
import { providerFetch } from '../prices/provider';

/** Adresele fișierelor BNR. Dacă BNR le mută, se schimbă doar aici. */
export const BNR_YEAR_URL = (year: number): string => `https://www.bnr.ro/files/xml/years/nbrfxrates${year}.xml`;
/** BNR publică arhiva XML începând cu 2005. */
export const BNR_FIRST_YEAR = 2005;
/** Cursul găsit poate fi cu cel mult atâtea zile mai vechi decât data cerută (weekenduri lungi, sărbători). */
const MAX_GAP_DAYS = 10;
/** Anul curent se reîmprospătează cel mult o dată la 12 ore; după o descărcare eșuată se reîncearcă după 10 minute. */
const CURRENT_YEAR_TTL_MS = 12 * 3_600_000;
const FAILURE_RETRY_MS = 10 * 60_000;

export interface BnrRate {
  date: string;
  currency: string;
  /** Lei pentru o unitate (multiplicatorul BNR, ex.: 100 HUF, este deja aplicat). */
  rate: string;
}

/** Citește cursurile din formatul XML al BNR (elemente `Cube date="…"` cu `Rate currency="…" multiplier="…"`). */
export function parseBnrXml(xml: string): BnrRate[] {
  const out: BnrRate[] = [];
  const cubes = /<Cube\b[^>]*\bdate="(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/Cube>/g;
  const rates = /<Rate\b([^>]*)>\s*([0-9]+(?:[.,][0-9]+)?)\s*<\/Rate>/g;
  for (const cube of xml.matchAll(cubes)) {
    const date = cube[1];
    for (const r of cube[2].matchAll(rates)) {
      const currency = /\bcurrency="([A-Za-z]{3})"/.exec(r[1])?.[1]?.toUpperCase();
      if (!currency) continue;
      const multiplier = Number(/\bmultiplier="(\d+)"/.exec(r[1])?.[1] ?? 1) || 1;
      const value = dec(r[2].replace(',', '.'));
      if (!value.gt(0)) continue;
      out.push({ date, currency, rate: value.div(multiplier).toString() });
    }
  }
  return out;
}

export type Fetcher = (url: string) => Promise<string>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await providerFetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/xml, text/xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const failures = new Map<string, number>();

/**
 * Se asigură că există cursurile BNR pentru anii dați (descarcă ce lipsește).
 * Întoarce null dacă totul e în regulă, altfel un mesaj pentru raport.
 */
export async function ensureBnrYears(db: Db, userId: number, years: number[], fetcher: Fetcher = defaultFetcher, now: Date = new Date()): Promise<string | null> {
  const currentYear = Number(todayIso().slice(0, 4));
  const wanted = [...new Set(years)].filter((y) => y >= BNR_FIRST_YEAR && y <= currentYear).sort();
  const failed: number[] = [];
  const save = db.prepare('INSERT OR REPLACE INTO fx_official (user_id, currency, date, rate) VALUES (?, ?, ?, ?)');
  const sync = db.prepare('INSERT OR REPLACE INTO fx_official_sync (user_id, year, fetched_at, complete) VALUES (?, ?, ?, ?)');
  for (const year of wanted) {
    const row = db.prepare('SELECT fetched_at, complete FROM fx_official_sync WHERE user_id = ? AND year = ?').get(userId, year) as
      | { fetched_at: string; complete: number }
      | undefined;
    if (row && (row.complete || now.getTime() - Date.parse(row.fetched_at) < CURRENT_YEAR_TTL_MS)) continue;
    const failKey = `${userId}:${year}`;
    const lastFail = failures.get(failKey);
    if (lastFail && now.getTime() - lastFail < FAILURE_RETRY_MS) {
      if (!row) failed.push(year);
      continue;
    }
    try {
      const parsed = parseBnrXml(await fetcher(BNR_YEAR_URL(year))).filter((r) => r.date.startsWith(`${year}-`));
      if (parsed.length === 0) throw new Error('fișier fără cursuri');
      const last = parsed.reduce((max, r) => (r.date > max ? r.date : max), '');
      db.transaction(() => {
        for (const r of parsed) save.run(userId, r.currency, r.date, r.rate);
        // Un an încheiat, cu cursuri până la final de decembrie, nu se mai descarcă.
        sync.run(userId, year, now.toISOString(), year < currentYear && last >= `${year}-12-20` ? 1 : 0);
      })();
      failures.delete(failKey);
    } catch {
      failures.set(failKey, now.getTime());
      if (!row) failed.push(year);
    }
  }
  if (failed.length === 0) return null;
  return `Cursurile BNR pentru ${failed.join(', ')} nu au putut fi descărcate de pe bnr.ro. Se folosește cursul din aplicație (sursa apare la fiecare tranzacție); aplicația reîncearcă la următoarea deschidere a raportului.`;
}

/** Cursurile BNR salvate pentru monedele date, în ordinea datelor. */
export function loadBnrRates(db: Db, userId: number, currencies: string[]): Map<string, { date: string; rate: string }[]> {
  const out = new Map<string, { date: string; rate: string }[]>();
  const stmt = db.prepare('SELECT date, rate FROM fx_official WHERE user_id = ? AND currency = ? ORDER BY date');
  for (const c of new Set(currencies)) out.set(c, stmt.all(userId, c) as { date: string; rate: string }[]);
  return out;
}

/** Cursul BNR valabil la o dată: cel din acea zi sau din ultima zi lucrătoare de dinainte (cel mult 10 zile). */
export function bnrRateOn(rows: { date: string; rate: string }[] | undefined, date: string): { date: string; rate: string } | null {
  if (!rows || rows.length === 0) return null;
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const row = rows[found];
  return row.date >= addDays(date, -MAX_GAP_DAYS) ? row : null;
}
