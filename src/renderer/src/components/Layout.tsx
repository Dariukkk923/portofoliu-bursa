/** Structura aplicației: meniul lateral, bara de sus (filtre globale, actualizare prețuri) și conținutul paginii. */
import type { ReactNode } from 'react';
import { ArrowLeftRight, Building2, ChartNoAxesCombined, LayoutDashboard, LogOut, RefreshCw, Settings as SettingsIcon, Wallet, WifiOff } from 'lucide-react';
import { ASSET_TYPES, type AssetType } from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { useApp } from '../context/AppContext';
import { dateTime } from '../lib/format';
import { Badge, Button, Notice, Select, cx } from './ui';

export type PageId = 'dashboard' | 'positions' | 'transactions' | 'brokers' | 'settings';

const NAV: { id: PageId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Panou principal', icon: LayoutDashboard },
  { id: 'positions', label: 'Portofoliu', icon: Wallet },
  { id: 'transactions', label: 'Tranzacții', icon: ArrowLeftRight },
  { id: 'brokers', label: 'Brokeri', icon: Building2 },
  { id: 'settings', label: 'Setări', icon: SettingsIcon }
];

const TITLES: Record<PageId, string> = {
  dashboard: 'Panou principal',
  positions: 'Portofoliu',
  transactions: 'Istoricul tranzacțiilor',
  brokers: 'Brokeri',
  settings: 'Setări'
};

/** Paginile pe care se aplică filtrul global (broker + tip de activ). */
const FILTERED_PAGES: PageId[] = ['dashboard', 'positions'];

export function Layout({ page, onNavigate, children }: { page: PageId; onNavigate: (p: PageId) => void; children: ReactNode }) {
  const { user, brokers, filter, setFilter, priceStatus, refreshPrices, logout } = useApp();
  const refreshing = priceStatus?.refreshing ?? false;

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <ChartNoAxesCombined className="size-4.5" aria-hidden />
          </div>
          <span className="text-sm font-semibold text-ink">Portofoliu Bursa</span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2.5 py-2" aria-label="Meniu principal">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={page === id ? 'page' : undefined}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition',
                'focus-visible:outline-2 focus-visible:outline-accent',
                page === id ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-2 uppercase">
              {user?.username.slice(0, 2)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">{user?.username}</p>
              {user?.isDemo ? <Badge tone="accent">Cont demo</Badge> : <p className="truncate text-xs text-ink-3">{user?.email ?? 'Cont local'}</p>}
            </div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" icon={<LogOut className="size-4" />} onClick={() => void logout()}>
            Ieșire din cont
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-15 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-6 py-2.5">
          <h1 className="mr-auto text-base font-semibold text-ink">{TITLES[page]}</h1>

          {FILTERED_PAGES.includes(page) && (
            <>
              <Select
                aria-label="Filtru broker"
                className="w-40!"
                value={filter.brokerId ?? ''}
                onChange={(e) => setFilter({ ...filter, brokerId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Toți brokerii</option>
                {brokers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filtru tip de activ"
                className="w-40!"
                value={filter.assetType ?? ''}
                onChange={(e) => setFilter({ ...filter, assetType: (e.target.value || null) as AssetType | null })}
              >
                <option value="">Toate activele</option>
                {ASSET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ASSET_TYPE_LABEL_PLURAL[t]}
                  </option>
                ))}
              </Select>
              <span className="mx-1 hidden h-6 w-px bg-line lg:block" />
            </>
          )}

          <div className="text-right text-xs leading-tight text-ink-3">
            <div>Prețuri actualizate</div>
            <div className="tabular font-medium text-ink-2">{dateTime(priceStatus?.lastPriceUpdate)}</div>
          </div>
          <Button onClick={() => void refreshPrices()} disabled={refreshing} icon={<RefreshCw className={cx('size-4', refreshing && 'animate-spin')} />}>
            {refreshing ? 'Se actualizează…' : 'Actualizează acum'}
          </Button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] space-y-4 p-6">
            {priceStatus?.offline && (
              <Notice tone="warn">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <WifiOff className="size-3.5" aria-hidden /> Fără conexiune la internet.
                </span>{' '}
                Aplicația folosește ultimele prețuri salvate ({dateTime(priceStatus.lastPriceUpdate)}).
              </Notice>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
