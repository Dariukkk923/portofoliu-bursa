/**
 * Bursele cunoscute: sufixul simbolului (format Yahoo) -> nume, monedă, fus orar și program.
 * Folosit la afișarea căutării și la indicatorul „Piață deschisă / închisă”.
 */
import type { AssetType } from './types';

export interface Exchange {
  /** Sufixul simbolului fără punct; gol pentru SUA. */
  suffix: string;
  name: string;
  currency: string;
  /** Fus orar IANA, ca ora locală să țină cont de ora de vară. */
  timeZone: string;
  /** Program regulat, ora locală „HH:MM”; null pentru piețele non-stop. */
  hours: { open: string; close: string } | null;
}

const hours = (open: string, close: string) => ({ open, close });

// shortcut: nu se țin cont de sărbătorile legale și de zilele cu program scurt; doar luni–vineri la orele regulate.
export const EXCHANGES: Exchange[] = [
  { suffix: '', name: 'SUA', currency: 'USD', timeZone: 'America/New_York', hours: hours('09:30', '16:00') },
  { suffix: 'RO', name: 'BVB', currency: 'RON', timeZone: 'Europe/Bucharest', hours: hours('10:00', '18:00') },
  { suffix: 'L', name: 'London', currency: 'GBP', timeZone: 'Europe/London', hours: hours('08:00', '16:30') },
  { suffix: 'DE', name: 'Xetra', currency: 'EUR', timeZone: 'Europe/Berlin', hours: hours('09:00', '17:30') },
  { suffix: 'PA', name: 'Paris', currency: 'EUR', timeZone: 'Europe/Paris', hours: hours('09:00', '17:30') },
  { suffix: 'AS', name: 'Amsterdam', currency: 'EUR', timeZone: 'Europe/Amsterdam', hours: hours('09:00', '17:30') },
  { suffix: 'BR', name: 'Bruxelles', currency: 'EUR', timeZone: 'Europe/Brussels', hours: hours('09:00', '17:30') },
  { suffix: 'LS', name: 'Lisabona', currency: 'EUR', timeZone: 'Europe/Lisbon', hours: hours('08:00', '16:30') },
  { suffix: 'MI', name: 'Milano', currency: 'EUR', timeZone: 'Europe/Rome', hours: hours('09:00', '17:30') },
  { suffix: 'MC', name: 'Madrid', currency: 'EUR', timeZone: 'Europe/Madrid', hours: hours('09:00', '17:30') },
  { suffix: 'SW', name: 'SIX Elveția', currency: 'CHF', timeZone: 'Europe/Zurich', hours: hours('09:00', '17:30') },
  { suffix: 'WA', name: 'Varșovia', currency: 'PLN', timeZone: 'Europe/Warsaw', hours: hours('09:00', '17:00') },
  { suffix: 'ST', name: 'Stockholm', currency: 'SEK', timeZone: 'Europe/Stockholm', hours: hours('09:00', '17:30') },
  { suffix: 'CO', name: 'Copenhaga', currency: 'DKK', timeZone: 'Europe/Copenhagen', hours: hours('09:00', '17:00') },
  { suffix: 'OL', name: 'Oslo', currency: 'NOK', timeZone: 'Europe/Oslo', hours: hours('09:00', '16:20') }
];

/** Criptomonedele se tranzacționează non-stop; moneda reală vine din simbol (BTC-USD). */
export const CRYPTO_EXCHANGE: Exchange = { suffix: '-', name: 'Crypto', currency: 'USD', timeZone: 'UTC', hours: null };

const BY_SUFFIX = new Map(EXCHANGES.map((e) => [e.suffix, e]));

/** Bursa unui simbol după sufix („VUAG.L” -> Londra); null pentru curs valutar, indici sau sufix necunoscut. */
export function exchangeForSymbol(symbol: string, type?: AssetType | 'fx' | null): Exchange | null {
  const s = symbol.toUpperCase();
  if (type === 'fx' || type === 'bond' || s.endsWith('=X') || s.startsWith('^')) return null;
  if (type === 'crypto' || (!type && /^[A-Z0-9]{2,10}-[A-Z]{3,4}$/.test(s))) return CRYPTO_EXCHANGE;
  const i = s.lastIndexOf('.');
  if (i <= 0) return BY_SUFFIX.get('') ?? null;
  return BY_SUFFIX.get(s.slice(i + 1)) ?? null;
}

/** Ora locală a bursei: ziua săptămânii (0 = duminică) și minutele de la miezul nopții. */
function localClock(timeZone: string, now: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Piața este deschisă acum? Luni–vineri, între deschidere (inclusiv) și închidere (exclusiv), ora locală. */
export function isMarketOpen(exchange: Exchange, now: Date = new Date()): boolean {
  if (!exchange.hours) return true;
  const { day, minutes } = localClock(exchange.timeZone, now);
  if (day < 1 || day > 5) return false;
  return minutes >= toMinutes(exchange.hours.open) && minutes < toMinutes(exchange.hours.close);
}

/** Starea pieței unui simbol; null când bursa nu se cunoaște (atunci nu se afișează nimic). */
export function marketStatus(symbol: string, type?: AssetType | 'fx' | null, now: Date = new Date()): boolean | null {
  const ex = exchangeForSymbol(symbol, type);
  return ex ? isMarketOpen(ex, now) : null;
}

type Listing = { symbol: string; exchange: string | null; currency: string | null; type?: AssetType | null };

/** Bursa și moneda unui rezultat de căutare: „London · GBP”; părțile necunoscute se omit. */
export function listingDetail(r: Listing): string {
  const ex = exchangeForSymbol(r.symbol, r.type);
  const known = ex && ex !== CRYPTO_EXCHANGE ? ex : null;
  // shortcut: fără moneda dată de provider se folosește cea uzuală a bursei (unele ETF-uri din Londra cotează în USD).
  return [known?.name ?? r.exchange, r.currency ?? known?.currency].filter(Boolean).join(' · ');
}

/** Textul complet: „VUAG · London · GBP” (simbolul fără sufixul bursei, care se vede din nume). */
export function listingLabel(r: Listing): string {
  const ex = exchangeForSymbol(r.symbol, r.type);
  const dot = r.symbol.lastIndexOf('.');
  const ticker = ex && ex.suffix && dot > 0 ? r.symbol.slice(0, dot) : r.symbol;
  return [ticker, listingDetail(r)].filter(Boolean).join(' · ');
}
