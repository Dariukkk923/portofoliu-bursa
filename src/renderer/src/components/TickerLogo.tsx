/**
 * Iconița de lângă simbol (NVDA -> logo NVIDIA):
 *  - acțiuni și ETF-uri: logo-ul de la providerii configurați care oferă logo-uri, salvat local;
 *  - crypto: iconițele incluse în aplicație (pachetul cryptocurrency-icons, licență CC0);
 *  - altfel (sau până sosește logo-ul): un cerc colorat cu inițialele tickerului.
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

export function TickerLogo({ symbol, type, size = 28, className }: { symbol: string; type: AssetType; size?: number; className?: string }) {
  const isCrypto = type === 'crypto';
  const remote = useLogo(isCrypto || type === 'bond' ? null : symbol, type);
  const crypto = useCryptoIcon(isCrypto ? symbol : null);
  const src = isCrypto ? crypto : remote;
  const [broken, setBroken] = useState<string | null>(null);
  const style = { width: size, height: size };

  if (src && broken !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        style={style}
        onError={() => setBroken(src)}
        className={cx('shrink-0 rounded-full bg-white object-contain ring-1 ring-line', isCrypto ? '' : 'p-[2px]', className)}
      />
    );
  }
  const initials = tickerInitials(symbol);
  return (
    <span
      aria-hidden
      className={cx('ticker-initials inline-flex shrink-0 items-center justify-center rounded-full font-semibold', className)}
      style={{ ...style, ['--h' as string]: tickerHue(symbol), fontSize: Math.max(9, Math.round(size * (initials.length > 2 ? 0.32 : 0.38))) }}
    >
      {initials}
    </span>
  );
}
