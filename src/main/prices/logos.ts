/**
 * Logo-uri fără cheie API (merg pentru toți utilizatorii, din prima):
 *
 *  1. Parqet (assets.parqet.com), după ISIN (dacă activul îl are) și după simbolul în format Yahoo
 *     (NVDA, VWCE.DE, VUAG.L, BRK-B). Dă pătrate pline, pe culoarea mărcii (NVIDIA verde, Apple negru).
 *  2. Financial Modeling Prep (image-stock), după simbol: sigla pe fundal transparent.
 *  3. Dacă tot nu s-a găsit (ex.: acțiunile BVB, H2O.RO), din profilul Yahoo:
 *     - ETF-uri: logo-ul emitentului (Vanguard, iShares, Xtrackers...), luat de la un fond reprezentativ;
 *     - acțiuni: iconița site-ului companiei, prin serviciul de favicon-uri Google.
 *
 * Nu se încearcă simbolul fără sufixul bursei („SNP.RO” -> „SNP”): același ticker este adesea altă
 * companie pe altă bursă (SNP în SUA este Sinopec, nu OMV Petrom).
 *
 * Imaginile care nu sunt logo-uri reale (pagini de eroare, iconița generică „glob” a Google, imagini de
 * 1x1 sau 16x16) sunt respinse: doar răspunsuri 200, doar imagini, cel puțin 32x32 pixeli.
 */
import { fetchImage, isNetworkError, ProviderError, RateLimiter, type LogoImage, type SymbolRef } from './provider';

/** Ce se știe despre emitent, din profilul Yahoo (folosit doar când sursele după simbol nu au logo). */
export interface BrandInfo {
  /** Site-ul companiei („https://www.nvidia.com”). */
  website: string | null;
  /** Familia fondului, la ETF-uri („Vanguard Group (Ireland) Limited”). */
  fundFamily: string | null;
  /** Numele lung („iShares Core S&P 500 UCITS ETF”). */
  name: string | null;
}

export interface LogoCandidate {
  /** Sursa, salvată lângă logo (coloana „source”). */
  source: string;
  url: string;
}

const PARQET = 'https://assets.parqet.com/logos';
const FMP = 'https://financialmodelingprep.com/image-stock';
/** 128 px: clar și pe ecranele retina la cercul de 40 px, dar tot câteva sute de octeți. */
const PARQET_SIZE = 128;

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const SAFE_SYMBOL = /^[A-Z0-9.\-^]{1,24}$/;

// Versiunea web cere Parqet și Google prin proxy (fără CORS), iar FMP direct: vezi src/web/net.ts și proxy/.

const parqet = (kind: 'symbol' | 'isin', id: string): string => `${PARQET}/${kind}/${encodeURIComponent(id)}?format=png&size=${PARQET_SIZE}`;

/** Sursele după simbol și ISIN, în ordinea preferinței. Crypto, obligațiunile și cursurile nu au. */
export function symbolLogoCandidates(ref: SymbolRef, isin?: string | null): LogoCandidate[] {
  if (ref.type !== 'stock' && ref.type !== 'etf') return [];
  const symbol = ref.symbol.trim().toUpperCase();
  const out: LogoCandidate[] = [];
  const code = isin?.trim().toUpperCase();
  if (code && ISIN.test(code)) out.push({ source: 'parqet', url: parqet('isin', code) });
  if (SAFE_SYMBOL.test(symbol)) {
    out.push({ source: 'parqet', url: parqet('symbol', symbol) });
    out.push({ source: 'fmp', url: `${FMP}/${encodeURIComponent(symbol)}.png` });
  }
  return out;
}

/**
 * Emitenții de ETF-uri -> un simbol al cărui logo Parqet este chiar marca emitentului
 * (verificat: VOO = Vanguard, IVV = iShares, XDWD.DE = Xtrackers, CW8.PA = Amundi...).
 */
const ISSUERS: { match: RegExp; symbol: string }[] = [
  { match: /\bvanguard\b/i, symbol: 'VOO' },
  { match: /\bi\s?shares\b|\bblackrock\b/i, symbol: 'IVV' },
  { match: /\bx-?trackers\b|\bdws\b/i, symbol: 'XDWD.DE' },
  { match: /\bamundi\b|\blyxor\b/i, symbol: 'CW8.PA' },
  { match: /\bspdr\b|\bstate street\b/i, symbol: 'SPY' },
  { match: /\binvesco\b|\bpowershares\b/i, symbol: 'QQQ' },
  { match: /\bvaneck\b|\bvan eck\b/i, symbol: 'SMH' },
  { match: /\bwisdomtree\b/i, symbol: 'WT' },
  { match: /\blegal\s*(&|and)\s*general\b|\bl&g\b/i, symbol: 'LGEN.L' },
  { match: /\bhsbc\b/i, symbol: 'HSBC' },
  { match: /\bubs\b/i, symbol: 'UBS' },
  { match: /\bj\.?\s?p\.?\s?morgan\b/i, symbol: 'JPM' },
  { match: /\bfranklin\b/i, symbol: 'BEN' },
  { match: /\bschwab\b/i, symbol: 'SCHW' },
  { match: /\bglobal x\b/i, symbol: 'PAVE' }
];

/** Simbolul reprezentativ al emitentului unui ETF (după familia fondului sau, în lipsă, după nume). */
export function issuerSymbol(brand: Pick<BrandInfo, 'fundFamily' | 'name'>): string | null {
  for (const text of [brand.fundFamily, brand.name]) {
    if (!text) continue;
    const hit = ISSUERS.find((i) => i.match.test(text));
    if (hit) return hit.symbol;
  }
  return null;
}

/** „https://www.nvidia.com/en-us/” -> „nvidia.com”. Null dacă adresa nu arată a site. */
export function websiteDomain(website: string | null | undefined): string | null {
  const text = website?.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.toLowerCase().replace(/^www\d?\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Sursele după emitent / site, încercate doar dacă cele după simbol nu au avut logo. */
export function brandLogoCandidates(ref: SymbolRef, brand: BrandInfo | null): LogoCandidate[] {
  if (!brand || (ref.type !== 'stock' && ref.type !== 'etf')) return [];
  const out: LogoCandidate[] = [];
  if (ref.type === 'etf') {
    const issuer = issuerSymbol(brand);
    if (issuer) out.push({ source: 'parqet', url: parqet('symbol', issuer) });
  }
  const domain = websiteDomain(brand.website);
  if (domain) out.push({ source: 'favicon', url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` });
  return out;
}

/* --------------------------------------------------- imagini nepotrivite */

/** Lățimea și înălțimea unei imagini PNG, GIF, JPEG sau WebP (din antet); null dacă formatul nu se recunoaște. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number): number => (data[i] << 8) | data[i + 1];
  const u32be = (i: number): number => ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
  const ascii = (i: number, n: number): string => String.fromCharCode(...data.subarray(i, i + n));
  if (data.length >= 24 && data[0] === 0x89 && ascii(1, 3) === 'PNG') return { width: u32be(16), height: u32be(20) };
  if (data.length >= 10 && ascii(0, 3) === 'GIF') return { width: data[6] | (data[7] << 8), height: data[8] | (data[9] << 8) };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // JPEG: se caută segmentul SOFn (dimensiunile cadrului).
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(i + 7), height: u16be(i + 5) };
      }
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  if (data.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') return { width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)), height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16)) };
    if (kind === 'VP8 ') return { width: (data[26] | (data[27] << 8)) & 0x3fff, height: (data[28] | (data[29] << 8)) & 0x3fff };
    if (kind === 'VP8L') {
      const b = data.subarray(21, 25);
      return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) };
    }
  }
  return null;
}

/** Cel mai mic logo acceptat: sub 32x32 este o iconiță generică sau un favicon prea mic pentru cercul de 40 px. */
const MIN_SIDE = 32;
const MIN_BYTES = 100;

/**
 * Este o imagine bună de afișat? Respinge imaginile goale sau minuscule (1x1, 16x16), pe cele foarte
 * alungite (bannere) și fișierele care nu sunt imagini. SVG-urile se acceptă dacă sunt chiar SVG.
 */
export function isUsableLogo(image: LogoImage | null): image is LogoImage {
  if (!image) return false;
  if (image.mime === 'image/svg+xml') {
    const head = new TextDecoder().decode(image.data.subarray(0, 512));
    return /<svg[\s>]/i.test(head);
  }
  if (image.data.length < MIN_BYTES) return false;
  const size = imageSize(image.data);
  if (!size) return false;
  const { width, height } = size;
  if (Math.min(width, height) < MIN_SIDE) return false;
  return Math.max(width, height) / Math.min(width, height) <= 3;
}

/* ------------------------------------------------------------- căutarea */

export interface LogoFound {
  image: LogoImage;
  source: string;
}

/** Caută logo-ul unui simbol la sursele fără cheie. Injectabilă în teste. */
export interface KeylessLogoFinder {
  /**
   * Primul logo bun dintre candidați, sau null dacă niciunul nu are (rezultat sigur, se poate ține minte).
   * Aruncă o eroare de rețea dacă nu s-a găsit nimic și măcar o sursă nu a putut fi contactată
   * (atunci nu se notează „fără logo”, se reîncearcă la următoarea cerere).
   */
  find(candidates: LogoCandidate[]): Promise<LogoFound | null>;
}

export type ImageFetcher = (url: string) => Promise<LogoImage | null>;

/** Implementarea reală: cererile trec prin `fetchImage` (deci și prin proxy-ul versiunii web), cu o mică pauză între ele. */
export function createKeylessLogoFinder(fetcher: ImageFetcher = (url) => fetchImage(url, 10_000), minIntervalMs = 150): KeylessLogoFinder {
  const limiter = new RateLimiter(minIntervalMs);
  return {
    async find(candidates) {
      let unreachable: unknown = null;
      let limited = false;
      const tried = new Set<string>();
      for (const c of candidates) {
        if (tried.has(c.url)) continue;
        tried.add(c.url);
        try {
          const image = await limiter.schedule(() => fetcher(c.url));
          if (isUsableLogo(image)) return { image, source: c.source };
        } catch (err) {
          if (isNetworkError(err)) unreachable ??= err;
          else if (err instanceof ProviderError && err.kind === 'ratelimit') limited = true;
          // alte erori (403 etc.): sursa nu are logo pentru simbol
        }
      }
      if (unreachable) throw unreachable instanceof ProviderError ? unreachable : new ProviderError('network', (unreachable as Error).message);
      if (limited) throw new ProviderError('ratelimit', 'Sursa de logo-uri a limitat cererile.');
      return null;
    }
  };
}
