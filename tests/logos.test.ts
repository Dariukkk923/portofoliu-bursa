/**
 * Logo-urile fără cheie API: alegerea surselor (ISIN, simbol, emitentul ETF-ului, site-ul companiei),
 * respingerea imaginilor care nu sunt logo-uri reale și ordinea încercărilor în PriceService (fără rețea).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderId, User } from '@shared/types';
import { openDatabase, type Db } from '@main/db/database';
import { createAesBox } from '@main/secrets';
import { register } from '@main/services/auth';
import {
  brandLogoCandidates,
  createKeylessLogoFinder,
  imageSize,
  isUsableLogo,
  issuerSymbol,
  symbolLogoCandidates,
  websiteDomain,
  type KeylessLogoFinder,
  type LogoCandidate
} from '@main/prices/logos';
import { ProviderError, type LogoImage, type PriceProvider, type SymbolRef } from '@main/prices/provider';
import { PriceService } from '@main/prices/service';
import { getLogos, saveLogo } from '@main/prices/store';

/** Un PNG minim (doar antetul cu dimensiunile), completat până la `bytes` octeți. */
function png(width: number, height: number, bytes = 400): LogoImage {
  const data = new Uint8Array(Math.max(bytes, 24));
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(data.buffer).setUint32(16, width);
  new DataView(data.buffer).setUint32(20, height);
  return { data, mime: 'image/png' };
}

const P = 'https://assets.parqet.com/logos';

describe('sursele de logo-uri', () => {
  it('după simbol: Parqet (ISIN înainte de simbol), apoi Financial Modeling Prep', () => {
    expect(symbolLogoCandidates({ symbol: 'nvda', type: 'stock' })).toEqual([
      { source: 'parqet', url: `${P}/symbol/NVDA?format=png&size=128` },
      { source: 'fmp', url: 'https://financialmodelingprep.com/image-stock/NVDA.png' }
    ]);
    expect(symbolLogoCandidates({ symbol: 'TLV.RO', type: 'stock' }, 'ROTLVAACNOR1').map((c) => c.url)).toEqual([
      `${P}/isin/ROTLVAACNOR1?format=png&size=128`,
      `${P}/symbol/TLV.RO?format=png&size=128`,
      'https://financialmodelingprep.com/image-stock/TLV.RO.png'
    ]);
    // ISIN invalid: ignorat. Simbolul fără sufix NU se încearcă (SNP în SUA este altă companie decât SNP.RO).
    const urls = symbolLogoCandidates({ symbol: 'SNP.RO', type: 'stock' }, 'nu-e-isin').map((c) => c.url);
    expect(urls.some((u) => /isin|\/SNP\?|\/SNP\.png/.test(u))).toBe(false);
    for (const type of ['crypto', 'bond', 'fx'] as const) expect(symbolLogoCandidates({ symbol: 'BTC-USD', type })).toEqual([]);
  });

  it('ETF-uri: logo-ul emitentului, după familia fondului sau nume', () => {
    expect(issuerSymbol({ fundFamily: 'Vanguard Group (Ireland) Limited', name: null })).toBe('VOO');
    expect(issuerSymbol({ fundFamily: 'BlackRock Asset Management Ireland - ETF', name: null })).toBe('IVV');
    expect(issuerSymbol({ fundFamily: null, name: 'iShares Core S&P 500 UCITS ETF USD (Acc)' })).toBe('IVV');
    expect(issuerSymbol({ fundFamily: null, name: 'Xtrackers MSCI World UCITS ETF 1C' })).toBe('XDWD.DE');
    expect(issuerSymbol({ fundFamily: 'Amundi Asset Management', name: null })).toBe('CW8.PA');
    expect(issuerSymbol({ fundFamily: null, name: 'Fondul Proprietatea' })).toBeNull();

    expect(brandLogoCandidates({ symbol: 'VWCE.DE', type: 'etf' }, { website: null, fundFamily: 'Vanguard Group (Ireland) Limited', name: null })).toEqual([
      { source: 'parqet', url: `${P}/symbol/VOO?format=png&size=128` }
    ]);
  });

  it('acțiuni: iconița site-ului companiei (H2O.RO -> hidroelectrica.ro)', () => {
    expect(brandLogoCandidates({ symbol: 'H2O.RO', type: 'stock' }, { website: 'https://www.hidroelectrica.ro', fundFamily: null, name: 'Hidroelectrica' })).toEqual([
      { source: 'favicon', url: 'https://www.google.com/s2/favicons?domain=hidroelectrica.ro&sz=128' }
    ]);
    // La acțiuni, familia/numele nu aduc logo-ul unui emitent de fonduri.
    expect(brandLogoCandidates({ symbol: 'HSBA.L', type: 'stock' }, { website: null, fundFamily: null, name: 'HSBC Holdings' })).toEqual([]);
    expect(brandLogoCandidates({ symbol: 'X', type: 'stock' }, null)).toEqual([]);
    expect(websiteDomain('www.omvpetrom.com/ro')).toBe('omvpetrom.com');
    expect(websiteDomain('http://WWW2.Brd.ro')).toBe('brd.ro');
    expect(websiteDomain('nu este site')).toBeNull();
    expect(websiteDomain('')).toBeNull();
  });
});

describe('imaginile respinse', () => {
  it('citește dimensiunile din antet (PNG, GIF, JPEG, WebP)', () => {
    expect(imageSize(png(128, 64).data)).toEqual({ width: 128, height: 64 });
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 48, 0, 32, 0]))).toEqual({ width: 48, height: 32 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 200, height: 100 });
    const webp = new Uint8Array(30);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    webp.set([63, 0, 0, 31, 0, 0], 24);
    expect(imageSize(webp)).toEqual({ width: 64, height: 32 });
    expect(imageSize(new TextEncoder().encode('<html>'))).toBeNull();
  });

  it('acceptă doar logo-uri reale: nu iconițe generice 16x16, imagini goale, bannere sau HTML', () => {
    expect(isUsableLogo(png(128, 128))).toBe(true);
    expect(isUsableLogo(png(48, 48))).toBe(true);
    expect(isUsableLogo(png(16, 16))).toBe(false); // globul generic al Google, favicon-uri prea mici
    expect(isUsableLogo(png(1, 1))).toBe(false);
    expect(isUsableLogo(png(128, 128, 60))).toBe(false); // prea puțini octeți: imagine goală
    expect(isUsableLogo(png(400, 50))).toBe(false); // banner
    expect(isUsableLogo({ data: new TextEncoder().encode('<html>'.repeat(40)), mime: 'image/png' })).toBe(false);
    expect(isUsableLogo({ data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), mime: 'image/svg+xml' })).toBe(true);
    expect(isUsableLogo({ data: new TextEncoder().encode('<html>eroare</html>'), mime: 'image/svg+xml' })).toBe(false);
    expect(isUsableLogo(null)).toBe(false);
  });
});

describe('căutarea fără cheie', () => {
  const c = (url: string): LogoCandidate => ({ source: url.split(':')[0], url });

  it('sare peste imaginile nepotrivite și peste adresele repetate; prima imagine bună câștigă', async () => {
    const calls: string[] = [];
    const answers: Record<string, LogoImage | null> = { 'a:1': null, 'b:1': png(16, 16), 'c:1': png(100, 100), 'd:1': png(100, 100) };
    const finder = createKeylessLogoFinder(async (url) => {
      calls.push(url);
      return answers[url];
    }, 0);
    expect(await finder.find([c('a:1'), c('a:1'), c('b:1'), c('c:1'), c('d:1')])).toEqual({ image: answers['c:1'], source: 'c' });
    expect(calls).toEqual(['a:1', 'b:1', 'c:1']);
    expect(await finder.find([c('a:1'), c('b:1')])).toBeNull();
  });

  it('fără rețea la o sursă: folosește alta; dacă nu găsește nimic, nu spune „fără logo”', async () => {
    const offline = new ProviderError('network', 'fetch failed');
    const finder = createKeylessLogoFinder(async (url) => {
      if (url.startsWith('net')) throw offline;
      if (url.startsWith('lim')) throw new ProviderError('ratelimit', '429');
      return url.startsWith('ok') ? png(64, 64) : null;
    }, 0);
    expect((await finder.find([c('net:1'), c('ok:1')]))?.source).toBe('ok');
    await expect(finder.find([c('net:1'), c('none:1')])).rejects.toMatchObject({ kind: 'network' });
    await expect(finder.find([c('lim:1'), c('none:1')])).rejects.toMatchObject({ kind: 'ratelimit' });
  });
});

/* ------------------------------------------------- integrarea în PriceService */

class BrandProvider implements PriceProvider {
  calls: string[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly brands: Record<string, { website: string | null; fundFamily: string | null; name: string | null }> = {}
  ) {}
  async getQuote(): Promise<never> {
    throw new ProviderError('notfound', 'nu');
  }
  async getHistory() {
    return { points: [], splitAdjusted: true };
  }
  async search() {
    return [];
  }
  async getBrand(ref: SymbolRef) {
    this.calls.push(`brand:${ref.symbol}`);
    return this.brands[ref.symbol] ?? null;
  }
}

class FakeFinder implements KeylessLogoFinder {
  calls: string[][] = [];
  constructor(private readonly answer: (urls: string[]) => LogoImage | null | Error) {}
  async find(candidates: LogoCandidate[]) {
    const urls = candidates.map((x) => x.url);
    this.calls.push(urls);
    const a = this.answer(urls);
    if (a instanceof Error) throw a;
    return a ? { image: a, source: candidates[0].source } : null;
  }
}

let db: Db;
let user: User;
const secrets = createAesBox(randomBytes(32));
beforeAll(async () => {
  db = openDatabase(':memory:');
  user = await register(db, { username: 'logo', password: 'parola-logo-1' });
});
afterAll(() => db.close());
beforeEach(() => {
  db.prepare('DELETE FROM logos').run();
  db.prepare('DELETE FROM assets').run();
});

describe('PriceService: logo-urile fără cheie API', () => {
  it('fără nicio cheie: sursele după simbol, apoi emitentul / site-ul din profilul Yahoo; „fără logo” se ține minte', async () => {
    const yahoo = new BrandProvider('yahoo', {
      'VWCE.DE': { website: null, fundFamily: 'Vanguard Group (Ireland) Limited', name: null },
      'H2O.RO': { website: 'https://www.hidroelectrica.ro', fundFamily: null, name: null }
    });
    const finder = new FakeFinder((urls) => (urls.some((u) => u.includes('/symbol/NVDA') || u.includes('/symbol/VOO') || u.includes('hidroelectrica')) ? png(100, 100) : null));
    const service = new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? yahoo : null), keylessLogos: finder });
    const refs: SymbolRef[] = [
      { symbol: 'NVDA', type: 'stock' },
      { symbol: 'VWCE.DE', type: 'etf' },
      { symbol: 'H2O.RO', type: 'stock' },
      { symbol: 'XYZ.RO', type: 'stock' },
      { symbol: 'BTC-USD', type: 'crypto' }
    ];
    const wanted = service.logosToFetch(user.id, refs);
    expect(wanted.map((r) => r.symbol)).toEqual(['NVDA', 'VWCE.DE', 'H2O.RO', 'XYZ.RO']);
    expect(await service.fetchLogos(user.id, wanted)).toEqual(['NVDA', 'VWCE.DE', 'H2O.RO']);
    // Profilul Yahoo se cere doar pentru simbolurile fără logo după simbol.
    expect(yahoo.calls).toEqual(['brand:VWCE.DE', 'brand:H2O.RO', 'brand:XYZ.RO']);
    const cached = getLogos(db, user.id, ['NVDA', 'XYZ.RO']);
    expect(cached.get('NVDA')?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(cached.get('XYZ.RO')).toMatchObject({ dataUrl: null, source: 'missing' });
    expect(service.logosToFetch(user.id, refs)).toEqual([]);
  });

  it('ISIN-ul activului se încearcă primul; marcajele vechi „none” se reîncearcă', async () => {
    db.prepare("INSERT INTO assets (user_id, symbol, name, type, currency, isin) VALUES (?, 'SNP.RO', 'OMV Petrom', 'stock', 'RON', 'ROSNPPACNOR9')").run(user.id);
    saveLogo(db, user.id, 'SNP.RO', null, 'none');
    const finder = new FakeFinder((urls) => (urls[0].includes('/isin/ROSNPPACNOR9') ? png(100, 100) : null));
    const service = new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? new BrandProvider('yahoo') : null), keylessLogos: finder });
    const refs: SymbolRef[] = [{ symbol: 'SNP.RO', type: 'stock' }];
    expect(service.logosToFetch(user.id, refs)).toEqual(refs);
    expect(await service.fetchLogos(user.id, refs)).toEqual(['SNP.RO']);
  });

  it('fără internet se oprește și nu notează „fără logo”', async () => {
    const yahoo = new BrandProvider('yahoo');
    const finder = new FakeFinder(() => new ProviderError('network', 'fetch failed'));
    const service = new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? yahoo : null), keylessLogos: finder });
    expect(await service.fetchLogos(user.id, [{ symbol: 'AAPL', type: 'stock' }, { symbol: 'MSFT', type: 'stock' }])).toEqual([]);
    expect(finder.calls).toHaveLength(1);
    expect(getLogos(db, user.id, ['AAPL', 'MSFT']).size).toBe(0);
  });

  it('limita de cereri la o sursă: nu se notează „fără logo”, se reîncearcă data viitoare', async () => {
    const finder = new FakeFinder(() => new ProviderError('ratelimit', '429'));
    const service = new PriceService({ db, secrets, providerFactory: (id) => (id === 'yahoo' ? new BrandProvider('yahoo') : null), keylessLogos: finder });
    expect(await service.fetchLogos(user.id, [{ symbol: 'AAPL', type: 'stock' }])).toEqual([]);
    expect(getLogos(db, user.id, ['AAPL']).size).toBe(0);
  });
});
