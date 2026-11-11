/**
 * Denumirile în română pentru sectoarele și țările primite de la provideri (în
 * engleză), plus valorile implicite când providerul nu le știe: ETF-urile și
 * crypto nu au o singură țară sau un singur sector.
 */
import type { AssetType } from './types';

const SECTORS: Record<string, string> = {
  technology: 'Tehnologie',
  'information technology': 'Tehnologie',
  'financial services': 'Servicii financiare',
  financials: 'Servicii financiare',
  healthcare: 'Sănătate',
  'health care': 'Sănătate',
  'consumer cyclical': 'Consum ciclic',
  'consumer discretionary': 'Consum ciclic',
  'consumer defensive': 'Consum de bază',
  'consumer staples': 'Consum de bază',
  'communication services': 'Comunicații',
  industrials: 'Industrie',
  energy: 'Energie',
  utilities: 'Utilități',
  'real estate': 'Imobiliare',
  'basic materials': 'Materiale de bază',
  materials: 'Materiale de bază'
};

const COUNTRIES: Record<string, string> = {
  'united states': 'SUA',
  usa: 'SUA',
  romania: 'România',
  germany: 'Germania',
  france: 'Franța',
  netherlands: 'Țările de Jos',
  'united kingdom': 'Regatul Unit',
  ireland: 'Irlanda',
  italy: 'Italia',
  spain: 'Spania',
  switzerland: 'Elveția',
  austria: 'Austria',
  belgium: 'Belgia',
  poland: 'Polonia',
  hungary: 'Ungaria',
  sweden: 'Suedia',
  denmark: 'Danemarca',
  norway: 'Norvegia',
  finland: 'Finlanda',
  portugal: 'Portugalia',
  greece: 'Grecia',
  canada: 'Canada',
  china: 'China',
  'hong kong': 'Hong Kong',
  taiwan: 'Taiwan',
  japan: 'Japonia',
  'south korea': 'Coreea de Sud',
  india: 'India',
  israel: 'Israel',
  brazil: 'Brazilia',
  australia: 'Australia',
  luxembourg: 'Luxemburg',
  bermuda: 'Bermuda',
  'cayman islands': 'Insulele Cayman',
  jersey: 'Jersey'
};

/** Țara după sufixul bursei, când providerul nu o spune. */
const COUNTRY_BY_SUFFIX: Record<string, string> = {
  RO: 'România',
  DE: 'Germania',
  F: 'Germania',
  PA: 'Franța',
  AS: 'Țările de Jos',
  L: 'Regatul Unit',
  MI: 'Italia',
  MC: 'Spania',
  SW: 'Elveția',
  VI: 'Austria',
  BR: 'Belgia',
  WA: 'Polonia',
  ST: 'Suedia',
  CO: 'Danemarca',
  OL: 'Norvegia',
  HE: 'Finlanda',
  LS: 'Portugalia',
  TO: 'Canada'
};

export const UNKNOWN_SECTOR = 'Necunoscut';
export const UNKNOWN_COUNTRY = 'Necunoscută';
/** Expunerile „diversificate”: nu se socotesc concentrare pe un singur sector sau o singură țară. */
export const DIVERSIFIED_ETF = 'ETF (mai multe)';
export const CRYPTO_SECTOR = 'Crypto';
export const NO_COUNTRY = 'Fără țară (crypto)';
export const BOND_SECTOR = 'Obligațiuni';

export const sectorLabel = (value: string): string => SECTORS[value.trim().toLowerCase()] ?? value.trim();
export const countryLabel = (value: string): string => COUNTRIES[value.trim().toLowerCase()] ?? value.trim();

/** Sectorul afișat al unui activ: cel salvat (manual sau de la provider), altfel o valoare după tipul activului. */
export function assetSector(asset: { type: AssetType; sector: string | null }): string {
  if (asset.sector?.trim()) return sectorLabel(asset.sector);
  if (asset.type === 'crypto') return CRYPTO_SECTOR;
  if (asset.type === 'bond') return BOND_SECTOR;
  if (asset.type === 'etf') return DIVERSIFIED_ETF;
  return UNKNOWN_SECTOR;
}

/**
 * Țara afișată a unui activ: cea salvată, altfel dedusă din bursă (sufixul simbolului) sau din tipul activului.
 * Un ETF fără țară salvată contează ca „mai multe țări”: bursa pe care se tranzacționează (ex.: VWCE.DE la
 * Frankfurt) nu spune nimic despre companiile din interior.
 */
export function assetCountry(asset: { type: AssetType; symbol: string; currency: string; country: string | null }): string {
  if (asset.country?.trim()) return countryLabel(asset.country);
  if (asset.type === 'crypto') return NO_COUNTRY;
  if (asset.type === 'etf') return DIVERSIFIED_ETF;
  const dot = asset.symbol.lastIndexOf('.');
  const suffix = dot > 0 ? asset.symbol.slice(dot + 1).toUpperCase() : '';
  if (COUNTRY_BY_SUFFIX[suffix]) return COUNTRY_BY_SUFFIX[suffix];
  if (asset.type === 'bond' && asset.currency === 'RON') return 'România';
  if (!suffix && asset.currency === 'USD' && asset.type === 'stock') return 'SUA';
  return UNKNOWN_COUNTRY;
}
