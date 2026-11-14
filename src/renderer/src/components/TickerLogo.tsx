/**
 * Iconița rotundă de lângă simbol (NVDA -> logo NVIDIA), ca în aplicațiile de investiții:
 *  - acțiuni și ETF-uri: logo-ul descărcat și salvat local (vezi src/main/prices/logos.ts).
 *    Logo-urile „pătrat plin” (NVIDIA pe verde, Apple pe negru) umplu cercul, pe culoarea mărcii;
 *    siglele pe fundal transparent stau centrate pe un cerc alb;
 *  - crypto: iconițele incluse în aplicație (pachetul cryptocurrency-icons, licență CC0);
 *  - altfel (sau până sosește logo-ul): un cerc cu inițialele tickerului, pe un gradient discret.
 */
import { useEffect, useState } from 'react';
import type { AssetType } from '@shared/types';
import { useLogo } from '../lib/logos';
import { cx } from './ui';

/** Iconițele crypto, încărcate doar când sunt afișate (câte un fișier SVG mic pe monedă). */
const CRYPTO_ICONS = import.meta.glob('../../../../node_modules/cryptocurrency-icons/svg/color/*.svg', {
  query: '?url',
  import: 'default',
  exhaustive: true
}) as Record<string, () => Promise<string>>;
const CRYPTO_BY_CODE = new Map(Object.entries(CRYPTO_ICONS).map(([path, load]) => [path.slice(path.lastIndexOf('/') + 1, -4).toLowerCase(), load]));
const cryptoUrls = new Map<string, string>();

/** „BTC-USD” -> „btc”. */
const cryptoCode = (symbol: string): string => symbol.split('-')[0].toLowerCase();

export const hasCryptoIcon = (symbol: string): boolean => CRYPTO_BY_CODE.has(cryptoCode(symbol));

function useCryptoIcon(symbol: string | null): string | null {
  const code = symbol ? cryptoCode(symbol) : null;
  const [url, setUrl] = useState<string | null>(code ? (cryptoUrls.get(code) ?? null) : null);
  useEffect(() => {
    if (!code) return setUrl(null);
    const known = cryptoUrls.get(code);
    if (known) return setUrl(known);
    const load = CRYPTO_BY_CODE.get(code);
    if (!load) return setUrl(null);
    let alive = true;
    void load()
      .then((u) => {
        cryptoUrls.set(code, u);
        if (alive) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);
  return url;
}

/* ------------------------------------------------- forma logo-ului descărcat */

/**
 * Cum se așază logo-ul în cerc: `fill` = imaginea umple cercul (pătrat pe culoarea mărcii, ca NVIDIA pe verde);
 * altfel sigla stă centrată, cu margine, pe `background` (culoarea fundalului imaginii sau alb).
 */
interface LogoLook {
  fill: boolean;
  background: string;
}

const MARK: LogoLook = { fill: false, background: '#fff' };
const looks = new Map<string, LogoLook | 'broken'>();

/**
 * Marginile imaginii spun ce fel de logo este: colțuri transparente = siglă (pe cerc alb); colțuri opace
 * de aceeași culoare = fundalul mărcii. Dacă și mijlocul fiecărei laturi are aceeași culoare, desenul nu
 * atinge marginile și imaginea poate umple cercul; altfel ar fi tăiată, deci primește margine.
 */
function analyzeLogo(img: HTMLImageElement): LogoLook {
  try {
    const n = 24;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return MARK;
    ctx.drawImage(img, 0, 0, n, n);
    const px = ctx.getImageData(0, 0, n, n).data;
    const at = (x: number, y: number): number[] => {
      const i = (y * n + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    const corners = [at(1, 1), at(n - 2, 1), at(1, n - 2), at(n - 2, n - 2)];
    if (corners.some((c) => c[3] < 230)) return MARK;
    const avg = [0, 1, 2].map((k) => Math.round(corners.reduce((s, c) => s + c[k], 0) / corners.length));
    const near = (c: number[]): boolean => c[3] >= 230 && Math.abs(c[0] - avg[0]) + Math.abs(c[1] - avg[1]) + Math.abs(c[2] - avg[2]) < 48;
    if (!corners.every(near)) return MARK;
    const h = n >> 1;
    const edges = [at(h, 1), at(h, n - 2), at(1, h), at(n - 2, h)];
    return { fill: edges.every(near), background: `rgb(${avg.join(' ')})` };
  } catch {
    return MARK;
  }
}

function useLogoLook(src: string | null): LogoLook | 'broken' | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!src || looks.has(src)) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      looks.set(src, img.naturalWidth > 0 ? analyzeLogo(img) : 'broken');
      if (alive) setTick((t) => t + 1);
    };
    img.onerror = () => {
      looks.set(src, 'broken');
      if (alive) setTick((t) => t + 1);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return src ? (looks.get(src) ?? null) : null;
}

/* ---------------------------------------------------------- inițialele */

/** Inițialele: „TLV.RO” -> „TL”, „BTC-USD” -> „BT”, „BRK-B” -> „BR”. */
export function tickerInitials(symbol: string): string {
  const base = symbol.split(/[.\-=]/)[0].replace(/[^A-Z0-9]/gi, '') || symbol;
  return base.slice(0, base.length <= 3 ? base.length : 2).toUpperCase();
}

/** Nuanța cercului, mereu aceeași pentru același simbol. */
export function tickerHue(symbol: string): number {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const RING = 'ring-1 ring-inset ring-black/[0.06] dark:ring-white/10';

export function TickerLogo({ symbol, type, size = 28, className }: { symbol: string; type: AssetType; size?: number; className?: string }) {
  const isCrypto = type === 'crypto';
  const remote = useLogo(isCrypto || type === 'bond' ? null : symbol, type);
  const crypto = useCryptoIcon(isCrypto ? symbol : null);
  const look = useLogoLook(isCrypto ? null : remote);
  const [brokenCrypto, setBrokenCrypto] = useState<string | null>(null);
  const style = { width: size, height: size };

  if (isCrypto && crypto && brokenCrypto !== crypto) {
    return (
      <img
        src={crypto}
        alt=""
        aria-hidden
        draggable={false}
        style={style}
        onError={() => setBrokenCrypto(crypto)}
        className={cx('shrink-0 rounded-full object-contain', className)}
      />
    );
  }

  if (remote && look && look !== 'broken') {
    return (
      <span
        aria-hidden
        className={cx('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full', className)}
        style={{ ...style, background: look.background }}
      >
        <img src={remote} alt="" draggable={false} className={look.fill ? 'size-full object-cover' : 'size-[70%] object-contain'} />
        <span className={cx('pointer-events-none absolute inset-0 rounded-full', RING)} />
      </span>
    );
  }

  const initials = tickerInitials(symbol);
  const hue = tickerHue(symbol);
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight',
        'bg-[linear-gradient(140deg,hsl(var(--h)_85%_95%),hsl(var(--h2)_70%_84%))] text-[hsl(var(--h)_55%_30%)]',
        'dark:bg-[linear-gradient(140deg,hsl(var(--h)_40%_30%),hsl(var(--h2)_45%_17%))] dark:text-[hsl(var(--h)_75%_86%)]',
        RING,
        className
      )}
      style={{
        ...style,
        ['--h' as string]: hue,
        ['--h2' as string]: (hue + 28) % 360,
        fontSize: Math.max(9, Math.round(size * (initials.length > 2 ? 0.32 : 0.38)))
      }}
    >
      {initials}
    </span>
  );
}
