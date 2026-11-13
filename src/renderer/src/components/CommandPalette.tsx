/**
 * Căutarea globală (Ctrl/⌘ K): găsește pagini, poziții din portofoliu, simboluri din watchlist și,
 * prin căutarea existentă la provider, simboluri noi. Un simbol nou se cumpără (formularul existent)
 * sau se adaugă în watchlist.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, Eye, FileText, Search, ShoppingCart, Wallet } from 'lucide-react';
import { ASSET_CURRENCIES, type AssetType, type SymbolSearchResult } from '@shared/types';
import { ASSET_TYPE_LABEL } from '@shared/labels';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { Spinner, cx } from './ui';
import { TickerLogo } from './TickerLogo';
import type { PageId } from './Layout';

export interface PaletteSymbol {
  type: AssetType;
  symbol: string;
  name?: string;
  currency: string;
}

interface Entry {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
  /** Acțiune secundară (doar la simboluri noi): adăugarea în watchlist. */
  secondary?: { label: string; run: () => void };
}

const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Combinația de taste afișată în câmpul de căutare (⌘ K pe Mac, Ctrl K în rest). */
export const SHORTCUT_LABEL = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K';

export function CommandPalette({
  pages,
  onClose,
  onNavigate,
  onBuy
}: {
  pages: { id: PageId; label: string; icon: ReactNode }[];
  onClose: () => void;
  onNavigate: (page: PageId) => void;
  onBuy: (preset: PaletteSymbol) => void;
}) {
  const { filter, dataVersion, notify, settings } = useApp();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<SymbolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const list = useRef<HTMLUListElement>(null);

  const overview = useLoad(() => api.portfolio.overview({ portfolioId: filter.portfolioId ?? null }), [filter.portfolioId, dataVersion]);
  const watch = useLoad(async () => {
    const lists = await api.watchlists.list();
    return (await Promise.all(lists.map((l) => api.watchlists.items(l.id)))).flat();
  }, [dataVersion]);

  const q = norm(query.trim());

  // Căutare la provider cu întârziere: nu trimitem o cerere pentru fiecare literă.
  useEffect(() => {
    if (q.length < 2) {
      setRemote([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.prices
        .search(query.trim())
        .then((r) => mine === seq.current && setRemote(r.slice(0, 8)))
        .catch(() => mine === seq.current && setRemote([]))
        .finally(() => mine === seq.current && setSearching(false));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [q, query]);

  const addToWatchlist = async (r: SymbolSearchResult): Promise<void> => {
    try {
      const lists = await api.watchlists.list();
      const target = lists[0];
      if (!target) return;
      const type = r.type ?? 'stock';
      const currency = r.currency && (ASSET_CURRENCIES as readonly string[]).includes(r.currency) ? r.currency : (settings?.baseCurrency ?? 'USD');
      await api.watchlists.addItem(target.id, { symbol: r.symbol, type, currency, name: r.name });
      notify('success', `${r.symbol.toUpperCase()} a fost adăugat în listă.`);
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const matches = (...texts: (string | null | undefined)[]): boolean => q === '' || texts.some((t) => t && norm(t).includes(q));
    for (const p of pages) {
      if (matches(p.label)) out.push({ id: `p-${p.id}`, group: 'Pagini', title: p.label, icon: p.icon, run: () => onNavigate(p.id) });
    }
    if (q !== '') {
      for (const p of (overview.data?.aggregated ?? []).filter((x) => matches(x.symbol, x.name)).slice(0, 5)) {
        out.push({
          id: `pos-${p.assetId}`,
          group: 'Poziții',
          title: p.symbol,
          hint: p.name,
          icon: <TickerLogo symbol={p.symbol} type={p.assetType} size={24} />,
          run: () => onNavigate('positions')
        });
      }
      for (const w of (watch.data ?? []).filter((x) => matches(x.symbol, x.name)).slice(0, 5)) {
        out.push({
          id: `w-${w.id}`,
          group: 'Watchlist',
          title: w.symbol,
          hint: w.name,
          icon: <TickerLogo symbol={w.symbol} type={w.type} size={24} />,
          run: () => onNavigate('watchlist')
        });
      }
      for (const r of remote) {
        const type = r.type ?? 'stock';
        const currency = r.currency && (ASSET_CURRENCIES as readonly string[]).includes(r.currency) ? r.currency : (settings?.baseCurrency ?? 'USD');
        out.push({
          id: `s-${r.symbol}-${r.exchange}`,
          group: 'Simboluri',
          title: r.symbol,
          hint: `${r.name}${r.exchange ? ` · ${r.exchange}` : ''} · ${ASSET_TYPE_LABEL[type]}`,
          icon: <TickerLogo symbol={r.symbol} type={type} size={24} />,
          run: () => onBuy({ type, symbol: r.symbol, name: r.name, currency }),
          secondary: { label: 'Watchlist', run: () => void addToWatchlist(r).then(onClose) }
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pages, overview.data, watch.data, remote, settings?.baseCurrency]);

  useEffect(() => setActive(0), [q, remote]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (e: Entry): void => {
    onClose();
    e.run();
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(entries.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && entries[active]) {
      e.preventDefault();
      choose(entries[active]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-overlay p-4 pt-[12vh] max-md:pt-[env(safe-area-inset-top)] max-md:p-0" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Căutare" className="animate-in flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop max-md:max-h-full max-md:max-w-none max-md:rounded-none" onKeyDown={onKey}>
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-4.5 shrink-0 text-ink-3" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Caută simbol, companie sau ETF…"
            aria-label="Caută simbol, companie sau ETF"
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            autoComplete="off"
            className="h-13 min-w-0 flex-1 bg-transparent text-md text-ink placeholder:text-ink-3 focus:outline-none max-md:h-14 max-md:text-base"
          />
          {searching && <Spinner className="size-4" />}
          <kbd className="rounded-md font-sans border border-line bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-ink-2 max-md:hidden">Esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" ref={list} className="min-h-0 flex-1 overflow-y-auto p-2">
          {entries.map((e, i) => (
            <li key={e.id} role="presentation">
              {(i === 0 || entries[i - 1].group !== e.group) && <p className="px-2.5 pt-2 pb-1 text-2xs font-semibold tracking-wider text-ink-3 uppercase">{e.group}</p>}
              <div
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                onMouseMove={() => setActive(i)}
                className={cx('flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-1.5', i === active ? 'bg-brand text-brand-ink' : 'text-ink')}
              >
                <button type="button" onClick={() => choose(e)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none">
                  <span className={cx('flex size-6 shrink-0 items-center justify-center', i === active ? 'text-brand-ink' : 'text-ink-3')}>{e.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold">{e.title}</span>
                    {e.hint && <span className={cx('block truncate text-xs', i === active ? 'text-brand-ink/80' : 'text-ink-3')}>{e.hint}</span>}
                  </span>
                </button>
                {e.group === 'Simboluri' && (
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium">
                      <ShoppingCart className="size-3.5" aria-hidden /> Cumpără
                    </span>
                    {e.secondary && (
                      <button type="button" onClick={e.secondary.run} className={cx('inline-flex min-h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium', i === active ? 'border-brand-ink/40 hover:bg-white/15' : 'border-line hover:bg-surface-2')}>
                        <Eye className="size-3.5" aria-hidden /> {e.secondary.label}
                      </button>
                    )}
                  </span>
                )}
                {i === active && e.group !== 'Simboluri' && <CornerDownLeft className="size-3.5 shrink-0 max-md:hidden" aria-hidden />}
              </div>
            </li>
          ))}
          {entries.length === 0 && (
            <li className="flex flex-col items-center gap-1 px-4 py-10 text-center text-body text-ink-3">
              {searching ? 'Se caută…' : q.length < 2 ? 'Scrie cel puțin două litere.' : 'Niciun rezultat.'}
            </li>
          )}
        </ul>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-2xs text-ink-3 max-md:hidden">
          <span className="inline-flex items-center gap-1">
            <Wallet className="size-3" aria-hidden /> poziții
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3" aria-hidden /> watchlist
          </span>
          <span className="inline-flex items-center gap-1">
            <FileText className="size-3" aria-hidden /> pagini
          </span>
          <span className="ml-auto">↑↓ pentru alegere · Enter pentru deschidere</span>
        </div>
      </div>
    </div>
  );
}
