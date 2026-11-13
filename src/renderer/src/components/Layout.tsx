/**
 * Structura aplicației: meniul (lateral și grupat pe calculator; tab bar jos pe telefon), bara de sus
 * (filtre globale, actualizare prețuri) și conținutul paginii.
 */
import { useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Ellipsis,
  Eye,
  FileText,
  FileUp,
  FlaskConical,
  Layers,
  NotebookPen,
  Target,
  ShieldAlert,
  LayoutDashboard,
  LogOut,
  Newspaper,
  RefreshCw,
  Settings as SettingsIcon,
  Wallet,
  WifiOff
} from 'lucide-react';
import { ASSET_TYPES, type AssetType } from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { api } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { dateTime } from '../lib/format';
import { Badge, Button, Modal, Notice, Select, cx } from './ui';
import { PortfolioSwitcher } from './portfolio';

export type PageId =
  | 'dashboard'
  | 'positions'
  | 'transactions'
  | 'watchlist'
  | 'risk'
  | 'dividends'
  | 'journal'
  | 'simulator'
  | 'goals'
  | 'tax'
  | 'news'
  | 'import'
  | 'portfolios'
  | 'brokers'
  | 'settings';

interface NavItem {
  id: PageId;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Portofoliu',
    items: [
      { id: 'dashboard', label: 'Panou principal', icon: LayoutDashboard },
      { id: 'positions', label: 'Portofoliu', icon: Wallet },
      { id: 'transactions', label: 'Tranzacții', icon: ArrowLeftRight },
      { id: 'watchlist', label: 'Watchlist', icon: Eye }
    ]
  },
  {
    label: 'Analiză',
    items: [
      { id: 'risk', label: 'Risc', icon: ShieldAlert },
      { id: 'dividends', label: 'Dividende', icon: CalendarDays },
      { id: 'news', label: 'Știri', icon: Newspaper },
      { id: 'tax', label: 'Raport fiscal', icon: FileText }
    ]
  },
  {
    label: 'Planificare',
    items: [
      { id: 'goals', label: 'Obiective', icon: Target },
      { id: 'journal', label: 'Jurnal', icon: NotebookPen }
    ]
  },
  {
    label: 'Instrumente',
    items: [
      { id: 'simulator', label: 'Simulator', icon: FlaskConical },
      { id: 'import', label: 'Import', icon: FileUp }
    ]
  },
  {
    label: 'Setări',
    items: [
      { id: 'portfolios', label: 'Portofolii', icon: Layers },
      { id: 'brokers', label: 'Brokeri', icon: Building2 },
      { id: 'settings', label: 'Setări', icon: SettingsIcon }
    ]
  }
];

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

/** Ecranele cele mai folosite, în tab bar-ul de pe telefon; restul sunt în „Mai mult”. */
const TABS: PageId[] = ['dashboard', 'positions', 'transactions', 'goals'];

const TITLES: Record<PageId, string> = {
  dashboard: 'Panou principal',
  positions: 'Portofoliu',
  transactions: 'Istoricul tranzacțiilor',
  watchlist: 'Watchlist',
  risk: 'Analiza riscului',
  dividends: 'Calendar de dividende',
  journal: 'Jurnal de investiții',
  goals: 'Obiective financiare',
  simulator: 'Ce-ar fi fost dacă',
  tax: 'Raport anual pentru taxe',
  news: 'Știri și raportări',
  import: 'Import din extrasul brokerului',
  portfolios: 'Portofolii',
  brokers: 'Brokeri',
  settings: 'Setări'
};

/** Raportul fiscal își alege singur portofoliile (implicit toate, inclusiv cele arhivate): selectorul global nu se aplică. */
const OWN_SCOPE_PAGES: PageId[] = ['tax', 'news'];

/** Paginile pe care se aplică filtrul global (broker + tip de activ). */
const FILTERED_PAGES: PageId[] = ['dashboard', 'positions', 'risk'];

function DueBadge({ due }: { due: number }) {
  return (
    <span className="tabular ml-auto rounded-full bg-warn px-1.5 text-2xs leading-4.5 font-semibold text-accent-ink" aria-label={`${due} de revizuit`}>
      {due}
    </span>
  );
}

function UserBox() {
  const { user, logout } = useApp();
  return (
    <>
      <div className="mb-2 flex items-center gap-2 px-1">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-2 uppercase">{user?.username.slice(0, 2)}</div>
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-ink">{user?.username}</p>
          {user?.isDemo ? <Badge tone="accent">Cont demo</Badge> : <p className="truncate text-xs text-ink-3">{user?.email ?? 'Cont local'}</p>}
        </div>
      </div>
      <Button variant="ghost" size="sm" className="w-full justify-start" icon={<LogOut className="size-4" />} onClick={() => void logout()}>
        Ieșire din cont
      </Button>
    </>
  );
}

export function Layout({ page, onNavigate, children }: { page: PageId; onNavigate: (p: PageId) => void; children: ReactNode }) {
  const { user, brokers, filter, setFilter, priceStatus, refreshPrices, dataVersion } = useApp();
  // Tezele din jurnal ajunse la termenul de revizuire apar ca număr lângă „Jurnal”.
  const due = useLoad(() => api.journal.dueCount(), [dataVersion, user?.id]).data ?? 0;
  const refreshing = priceStatus?.refreshing ?? false;
  const [more, setMore] = useState(false);
  const go = (id: PageId): void => {
    setMore(false);
    onNavigate(id);
  };

  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <ChartNoAxesCombined className="size-4.5" aria-hidden />
          </div>
          <span className="text-sm font-semibold text-ink">Portofoliu Bursa</span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2" aria-label="Meniu principal">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="mt-3 first:mt-0">
              <p className="px-3 pb-1 text-2xs font-semibold tracking-wider text-ink-3 uppercase">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => go(id)}
                    aria-current={page === id ? 'page' : undefined}
                    className={cx(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-body font-medium transition',
                      page === id ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                    {id === 'journal' && due > 0 && <DueBadge due={due} />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <UserBox />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-line bg-surface">
          <div className="pt-safe md:hidden" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:min-h-15 md:px-6">
            {!OWN_SCOPE_PAGES.includes(page) && (
              <div className="max-md:order-3">
                <PortfolioSwitcher onManage={() => go('portfolios')} />
              </div>
            )}
            <h1 className="mr-auto min-w-0 truncate text-base font-semibold text-ink max-md:order-1 max-md:flex-1">{TITLES[page]}</h1>

            {FILTERED_PAGES.includes(page) && (
              <>
                <div className="flex gap-2 max-md:order-3 max-md:basis-full">
                  <Select
                    aria-label="Filtru broker"
                    className="w-40! max-md:flex-1"
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
                    className="w-40! max-md:flex-1"
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
                </div>
                <span className="mx-1 hidden h-6 w-px bg-line lg:block" />
              </>
            )}

            <div className="hidden text-right text-xs leading-tight text-ink-3 md:block">
              <div>Prețuri actualizate</div>
              <div className="tabular font-medium text-ink-2">{dateTime(priceStatus?.lastPriceUpdate)}</div>
            </div>
            <Button
              className="max-md:order-2"
              onClick={() => void refreshPrices()}
              disabled={refreshing}
              icon={<RefreshCw className={cx('size-4', refreshing && 'animate-spin')} />}
            >
              <span className="max-md:sr-only">{refreshing ? 'Se actualizează…' : 'Actualizează acum'}</span>
            </Button>
            {/* Pe telefon: titlul și butonul pe primul rând, selectorul și filtrele dedesubt. */}
            <div className="order-2 basis-full md:hidden" aria-hidden />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] space-y-4 p-4 max-md:pb-28 md:p-6">
            {priceStatus?.offline && (
              <Notice tone="warn">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <WifiOff className="size-3.5" aria-hidden /> Fără conexiune la internet.
                </span>{' '}
                Aplicația folosește ultimele prețuri salvate ({dateTime(priceStatus.lastPriceUpdate)}).
              </Notice>
            )}
            <div key={page} className="animate-in space-y-4">
              {children}
            </div>
          </div>
        </main>
      </div>

      <nav aria-label="Meniu rapid" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface md:hidden">
        <div className="grid grid-cols-5">
          {TABS.map((id) => {
            const item = NAV_ITEMS.find((n) => n.id === id) as NavItem;
            const Icon = item.icon;
            return (
              <button
                key={id}
                type="button"
                onClick={() => go(id)}
                aria-current={page === id ? 'page' : undefined}
                className={cx('flex min-h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium', page === id ? 'text-accent' : 'text-ink-2')}
              >
                <Icon className="size-5" aria-hidden />
                {id === 'dashboard' ? 'Panou' : item.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMore(true)}
            aria-expanded={more}
            className={cx('relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium', TABS.includes(page) ? 'text-ink-2' : 'text-accent')}
          >
            <Ellipsis className="size-5" aria-hidden />
            Mai mult
            {due > 0 && <span className="absolute top-2 right-1/4 size-2 rounded-full bg-warn" aria-label={`${due} de revizuit în jurnal`} />}
          </button>
        </div>
      </nav>

      {more && (
        <Modal title="Mai mult" onClose={() => setMore(false)}>
          <div className="space-y-4">
            {NAV_GROUPS.map((group) => {
              const items = group.items.filter((i) => !TABS.includes(i.id));
              if (items.length === 0) return null;
              return (
                <div key={group.label} role="group" aria-label={group.label}>
                  <p className="pb-1 text-2xs font-semibold tracking-wider text-ink-3 uppercase">{group.label}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {items.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => go(id)}
                        aria-current={page === id ? 'page' : undefined}
                        className={cx(
                          'flex min-h-12 items-center gap-2.5 rounded-lg border px-3 text-body font-medium',
                          page === id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink'
                        )}
                      >
                        <Icon className="size-4.5 shrink-0" aria-hidden />
                        {label}
                        {id === 'journal' && due > 0 && <DueBadge due={due} />}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="border-t border-line pt-3">
              <UserBox />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
