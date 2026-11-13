/**
 * Structura aplicației: meniul lateral (pe calculator) cu grupuri care se deschid, bara de sus (titlu,
 * portofoliu, căutare Ctrl/⌘ K, notificări, cont) și tab bar-ul de jos pe telefon.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  Bell,
  Building2,
  ChartColumn,
  ChartNoAxesCombined,
  ChartPie,
  ChevronDown,
  Coins,
  Ellipsis,
  Eye,
  FileText,
  FileUp,
  FlaskConical,
  Layers,
  LayoutDashboard,
  LogOut,
  NotebookPen,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  SlidersHorizontal,
  Target,
  WifiOff,
  type LucideIcon
} from 'lucide-react';
import { ASSET_TYPES, type AssetType } from '@shared/types';
import { ASSET_TYPE_LABEL_PLURAL } from '@shared/labels';
import { api } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { dateTime } from '../lib/format';
import { Badge, Modal, Notice, Select, cx } from './ui';
import { PortfolioSwitcher } from './portfolio';
import { NotificationBell } from './alertsBell';
import { CommandPalette, SHORTCUT_LABEL, type PaletteSymbol } from './CommandPalette';
import { PurchaseForm } from './PurchaseForm';

export type PageId =
  | 'dashboard'
  | 'positions'
  | 'transactions'
  | 'watchlist'
  | 'risk'
  | 'dividends'
  | 'journal'
  | 'alerts'
  | 'simulator'
  | 'goals'
  | 'tax'
  | 'import'
  | 'portfolios'
  | 'brokers'
  | 'settings';
// Știri: la îmbinarea cu ramura „Știri” se adaugă aici PageId-ul 'news'.

interface NavLeaf {
  id: PageId;
  label: string;
  icon: LucideIcon;
}

/** Un element din meniu: o pagină, sau un grup care se deschide (și, opțional, are pagină proprie). */
interface NavEntry {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Pagina deschisă la apăsare (la grupurile fără pagină proprie: prima din grup). */
  page: PageId;
  /** True dacă `page` este pagina grupului însuși, nu a unui copil. */
  own?: boolean;
  children?: NavLeaf[];
}

const NAV: NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, page: 'dashboard', own: true },
  {
    key: 'positions',
    label: 'Portofoliu',
    icon: ChartPie,
    page: 'positions',
    own: true,
    children: [
      { id: 'watchlist', label: 'Watchlist', icon: Eye },
      { id: 'journal', label: 'Jurnal', icon: NotebookPen },
      { id: 'alerts', label: 'Alerte', icon: Bell }
    ]
  },
  { key: 'transactions', label: 'Tranzacții', icon: ArrowLeftRight, page: 'transactions', own: true },
  { key: 'dividends', label: 'Dividende', icon: Coins, page: 'dividends', own: true },
  // Știri: aici se adaugă { key: 'news', label: 'Știri', icon: Newspaper, page: 'news', own: true } la îmbinarea cu ramura „Știri”.
  {
    key: 'analysis',
    label: 'Analiză',
    icon: ChartColumn,
    page: 'risk',
    children: [
      { id: 'risk', label: 'Risc', icon: ShieldAlert },
      { id: 'simulator', label: 'Simulator', icon: FlaskConical }
    ]
  },
  {
    key: 'reports',
    label: 'Rapoarte',
    icon: FileText,
    page: 'tax',
    children: [
      { id: 'tax', label: 'Raport fiscal', icon: FileText },
      { id: 'import', label: 'Import', icon: FileUp }
    ]
  },
  { key: 'goals', label: 'Obiective', icon: Target, page: 'goals', own: true },
  {
    key: 'settings',
    label: 'Setări',
    icon: SettingsIcon,
    page: 'settings',
    own: true,
    children: [
      { id: 'portfolios', label: 'Portofolii', icon: Layers },
      { id: 'brokers', label: 'Brokeri', icon: Building2 }
    ]
  }
];

/** Toate paginile din meniu, cu iconița lor (pentru titlu și căutare). */
const NAV_PAGES: NavLeaf[] = NAV.flatMap((e) => [...(e.own ? [{ id: e.page, label: e.label, icon: e.icon }] : []), ...(e.children ?? [])]);

/** Ecranele cele mai folosite, în tab bar-ul de pe telefon; restul sunt în „Mai mult”. */
const TABS: PageId[] = ['dashboard', 'positions', 'transactions', 'goals'];

const TITLES: Record<PageId, string> = {
  dashboard: 'Dashboard',
  positions: 'Portofoliu',
  transactions: 'Istoricul tranzacțiilor',
  watchlist: 'Watchlist',
  risk: 'Analiza riscului',
  dividends: 'Calendar de dividende',
  journal: 'Jurnal de investiții',
  goals: 'Obiective financiare',
  alerts: 'Alerte',
  simulator: 'Ce-ar fi fost dacă',
  tax: 'Raport anual pentru taxe',
  import: 'Import din extrasul brokerului',
  portfolios: 'Portofolii',
  brokers: 'Brokeri',
  settings: 'Setări'
};

/** Raportul fiscal își alege singur portofoliile (implicit toate, inclusiv cele arhivate): selectorul global nu se aplică. */
const OWN_SCOPE_PAGES: PageId[] = ['tax'];

/** Paginile pe care se aplică filtrul global (broker + tip de activ). */
const FILTERED_PAGES: PageId[] = ['dashboard', 'positions', 'risk'];

/** Grupul din care face parte pagina (pentru a-l ține deschis în meniu). */
const groupOf = (page: PageId): string | undefined => NAV.find((e) => e.children?.some((c) => c.id === page) || (e.own && e.children && e.page === page))?.key;

/** Închide un meniu plutitor la click în afara lui sau la Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

function DueBadge({ due }: { due: number }) {
  return (
    <span className="tabular ml-auto rounded-full bg-warn px-1.5 text-2xs leading-4.5 font-semibold text-warn-ink" aria-label={`${due} de revizuit`}>
      {due}
    </span>
  );
}

/** Butonul rotund din bara de sus (reîmprospătare, filtre). */
const TOP_BUTTON =
  'relative flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-2 transition hover:border-brand/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-55 md:size-10.5';

function UserBox({ onDone }: { onDone?: () => void }) {
  const { user, logout } = useApp();
  return (
    <>
      <div className="mb-2 flex items-center gap-2 px-1">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent uppercase">{user?.username.slice(0, 2)}</div>
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-ink">{user?.username}</p>
          {user?.isDemo ? <Badge tone="accent">Cont demo</Badge> : <p className="truncate text-xs text-ink-3">{user?.email ?? 'Cont local'}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          onDone?.();
          void logout();
        }}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-body font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink md:min-h-9"
      >
        <LogOut className="size-4" aria-hidden /> Ieșire din cont
      </button>
    </>
  );
}

/** Avatarul din colț: profil, setări, ieșire. */
function AvatarMenu({ onSettings }: { onSettings: () => void }) {
  const { user, logout } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const item = 'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-body font-medium text-ink transition hover:bg-surface-2 md:min-h-9';
  return (
    <div ref={ref} className="relative max-md:order-1">
      <button
        type="button"
        aria-label="Meniul contului"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 items-center gap-1.5 rounded-full pr-1.5 pl-0.5 transition hover:bg-surface-2 md:h-10.5"
      >
        <span className="flex size-9.5 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-ink uppercase">{user?.username.slice(0, 2)}</span>
        <ChevronDown className="size-4 text-ink-3 max-md:hidden" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="animate-in absolute right-0 z-40 mt-2 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          <button
            type="button"
            role="menuitem"
            className={cx(item, 'h-auto! py-2')}
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent uppercase">{user?.username.slice(0, 2)}</span>
            <span className="min-w-0">
              <span className="block truncate">{user?.username}</span>
              <span className="block truncate text-xs font-normal text-ink-3">{user?.isDemo ? 'Cont demo' : (user?.email ?? 'Cont local')} · Profil</span>
            </span>
          </button>
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <SettingsIcon className="size-4 text-ink-3" aria-hidden /> Setări
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => void logout()}>
            <LogOut className="size-4 text-ink-3" aria-hidden /> Ieșire din cont
          </button>
        </div>
      )}
    </div>
  );
}

/** Filtrele globale (broker, tip de activ), într-o fereastră mică, pe paginile care le folosesc. */
function FilterMenu() {
  const { brokers, filter, setFilter } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const active = !!(filter.brokerId || filter.assetType);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label="Filtre" title="Filtre" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cx(TOP_BUTTON, active && 'border-brand text-accent')}>
        <SlidersHorizontal className="size-4.5" aria-hidden />
        {active && <span className="absolute top-0.5 right-0.5 size-2.5 rounded-full bg-brand ring-2 ring-surface" aria-hidden />}
      </button>
      {open && (
        <div role="dialog" aria-label="Filtre" className="animate-in absolute right-0 z-40 mt-2 w-72 space-y-3 rounded-xl border border-line bg-surface p-3 shadow-pop max-md:fixed max-md:inset-x-4 max-md:top-28 max-md:w-auto">
          <Select aria-label="Filtru broker" value={filter.brokerId ?? ''} onChange={(e) => setFilter({ ...filter, brokerId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Toți brokerii</option>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Filtru tip de activ" value={filter.assetType ?? ''} onChange={(e) => setFilter({ ...filter, assetType: (e.target.value || null) as AssetType | null })}>
            <option value="">Toate activele</option>
            {ASSET_TYPES.map((t) => (
              <option key={t} value={t}>
                {ASSET_TYPE_LABEL_PLURAL[t]}
              </option>
            ))}
          </Select>
          {active && (
            <button type="button" onClick={() => setFilter({ ...filter, brokerId: null, assetType: null })} className="text-xs font-medium text-accent hover:underline">
              Șterge filtrele
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Layout({ page, onNavigate, children }: { page: PageId; onNavigate: (p: PageId) => void; children: ReactNode }) {
  const { user, priceStatus, refreshPrices, dataVersion, bumpData, notify } = useApp();
  // Tezele din jurnal ajunse la termenul de revizuire apar ca număr lângă „Jurnal”.
  const due = useLoad(() => api.journal.dueCount(), [dataVersion, user?.id]).data ?? 0;
  const refreshing = priceStatus?.refreshing ?? false;
  const [more, setMore] = useState(false);
  const [palette, setPalette] = useState(false);
  const [purchase, setPurchase] = useState<PaletteSymbol | null>(null);
  const [opened, setOpened] = useState<string[]>(() => {
    const g = groupOf(page);
    return g ? [g] : [];
  });
  const assets = useLoad(() => (purchase ? api.assets.list() : Promise.resolve(null)), [purchase]);

  // Grupul paginii active rămâne deschis.
  useEffect(() => {
    const g = groupOf(page);
    if (g) setOpened((o) => (o.includes(g) ? o : [...o, g]));
  }, [page]);

  // O pagină nouă începe de sus, nu de unde a rămas cea veche.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [page]);

  // Ctrl/⌘ K deschide căutarea de oriunde.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (id: PageId): void => {
    setMore(false);
    onNavigate(id);
  };
  const toggle = (key: string): void => setOpened((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]));
  const refreshLabel = refreshing ? 'Se actualizează…' : 'Actualizează prețurile';
  const updated = `Prețuri actualizate: ${dateTime(priceStatus?.lastPriceUpdate)}`;

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex dark:bg-bg">
        <div className="flex items-center gap-3 px-5 pt-6 pb-5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-brand text-brand-ink shadow-lg shadow-brand/30">
            <ChartNoAxesCombined className="size-5" aria-hidden />
          </div>
          <span className="text-lg leading-tight font-bold tracking-tight text-ink">Portofoliu Bursa</span>
        </div>

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3" aria-label="Meniu principal">
          {NAV.map((entry) => {
            const Icon = entry.icon;
            const selfActive = entry.own && page === entry.page;
            const childActive = !!entry.children?.some((c) => c.id === page);
            const isOpen = opened.includes(entry.key);
            return (
              <div key={entry.key}>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      go(entry.page);
                      if (entry.children && !isOpen) toggle(entry.key);
                    }}
                    aria-current={selfActive ? 'page' : undefined}
                    className={cx(
                      'flex h-11 w-full items-center gap-3 rounded-xl px-3 text-md font-medium transition',
                      entry.children && 'pr-10',
                      selfActive ? 'bg-brand text-brand-ink shadow-lg shadow-brand/25' : childActive ? 'text-ink hover:bg-surface-2' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                    {entry.label}
                    {entry.key === 'positions' && due > 0 && !isOpen && <span className="size-2 rounded-full bg-warn" aria-label={`${due} de revizuit în jurnal`} />}
                  </button>
                  {entry.children && (
                    <button
                      type="button"
                      aria-label={`${isOpen ? 'Închide' : 'Deschide'} grupul ${entry.label}`}
                      aria-expanded={isOpen}
                      onClick={() => toggle(entry.key)}
                      className={cx('absolute top-1 right-1 flex size-9 items-center justify-center rounded-lg transition hover:bg-white/10', selfActive ? 'text-brand-ink' : 'text-ink-3 hover:bg-surface-2')}
                    >
                      <ChevronDown className={cx('size-4 transition-transform', isOpen && 'rotate-180')} aria-hidden />
                    </button>
                  )}
                </div>
                {entry.children && isOpen && (
                  <div className="mt-1 mb-1 space-y-0.5 pl-5">
                    {entry.children.map((c) => {
                      const CIcon = c.icon;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => go(c.id)}
                          aria-current={page === c.id ? 'page' : undefined}
                          className={cx(
                            'flex h-9.5 w-full items-center gap-2.5 rounded-lg px-3 text-body font-medium transition',
                            page === c.id ? 'bg-brand text-brand-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                          )}
                        >
                          <CIcon className="size-4" aria-hidden />
                          {c.label}
                          {c.id === 'journal' && due > 0 && <DueBadge due={due} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <p className="border-t border-line px-5 py-3 text-xs text-ink-3">{updated}</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-line bg-surface dark:bg-bg">
          <div className="pt-safe md:hidden" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:min-h-18 md:flex-nowrap md:px-6">
            <h1 className="min-w-0 text-xl font-bold tracking-tight text-ink max-md:flex-1 max-md:text-lg max-md:leading-tight md:mr-2 md:truncate">{TITLES[page]}</h1>
            {!OWN_SCOPE_PAGES.includes(page) && (
              <div className="max-md:order-3">
                <PortfolioSwitcher onManage={() => go('portfolios')} />
              </div>
            )}
            <div className="hidden min-w-0 flex-1 md:block" />

            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label="Caută simbol, companie sau ETF"
              className="hidden h-11 w-full max-w-105 min-w-0 flex-1 items-center gap-3 rounded-xl border border-line bg-surface px-3.5 text-left text-body text-ink-3 transition hover:border-brand/50 md:flex"
            >
              <Search className="size-4.5 shrink-0 text-ink-2" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Caută simbol, companie sau ETF…</span>
              <kbd className="rounded-md font-sans border border-line bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-ink-2">{SHORTCUT_LABEL}</kbd>
            </button>
            <button type="button" onClick={() => setPalette(true)} aria-label="Caută" className={cx(TOP_BUTTON, 'md:hidden')}>
              <Search className="size-4.5" aria-hidden />
            </button>

            <button type="button" onClick={() => void refreshPrices()} disabled={refreshing} aria-label={refreshLabel} title={`${refreshLabel}\n${updated}`} className={cx(TOP_BUTTON, 'max-md:order-3')}>
              <RefreshCw className={cx('size-4.5', refreshing && 'animate-spin')} aria-hidden />
            </button>
            {FILTERED_PAGES.includes(page) && (
              <div className="max-md:order-3">
                <FilterMenu />
              </div>
            )}
            <NotificationBell onOpenAlerts={() => go('alerts')} />
            <AvatarMenu onSettings={() => go('settings')} />
            {/* Pe telefon: titlul și iconițele pe primul rând, portofoliul și filtrele dedesubt. */}
            <div className="order-2 basis-full md:hidden" aria-hidden />
          </div>
        </header>

        <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1600px] space-y-5 p-4 max-md:pb-28 md:p-6">
            {priceStatus?.offline && (
              <Notice tone="warn">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <WifiOff className="size-3.5" aria-hidden /> Fără conexiune la internet.
                </span>{' '}
                Aplicația folosește ultimele prețuri salvate ({dateTime(priceStatus.lastPriceUpdate)}).
              </Notice>
            )}
            <div key={page} className="animate-in space-y-5">
              {children}
            </div>
          </div>
        </main>
      </div>

      <nav aria-label="Meniu rapid" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur md:hidden dark:bg-bg/95">
        <div className="grid grid-cols-5">
          {TABS.map((id) => {
            const item = NAV_PAGES.find((n) => n.id === id) as NavLeaf;
            const Icon = item.icon;
            const on = page === id;
            return (
              <button key={id} type="button" onClick={() => go(id)} aria-current={on ? 'page' : undefined} className={cx('flex min-h-15 flex-col items-center justify-center gap-0.5 text-2xs font-medium', on ? 'text-accent' : 'text-ink-2')}>
                <span className={cx('flex h-7 w-12 items-center justify-center rounded-full transition', on && 'bg-brand text-brand-ink')}>
                  <Icon className="size-5" aria-hidden />
                </span>
                {item.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMore(true)}
            aria-expanded={more}
            className={cx('relative flex min-h-15 flex-col items-center justify-center gap-0.5 text-2xs font-medium', TABS.includes(page) ? 'text-ink-2' : 'text-accent')}
          >
            <span className={cx('flex h-7 w-12 items-center justify-center rounded-full transition', !TABS.includes(page) && 'bg-brand text-brand-ink')}>
              <Ellipsis className="size-5" aria-hidden />
            </span>
            Mai mult
            {due > 0 && <span className="absolute top-2 right-1/4 size-2 rounded-full bg-warn" aria-label={`${due} de revizuit în jurnal`} />}
          </button>
        </div>
      </nav>

      {more && (
        <Modal title="Mai mult" onClose={() => setMore(false)}>
          <div className="space-y-4">
            {NAV.map((entry) => {
              // Grupurile fără pagină proprie se arată doar prin copii; paginile din tab bar nu se repetă.
              const items: NavLeaf[] = [...(entry.own ? [{ id: entry.page, label: entry.label, icon: entry.icon }] : []), ...(entry.children ?? [])].filter((i) => !TABS.includes(i.id));
              if (items.length === 0) return null;
              return (
                <div key={entry.key} role="group" aria-label={entry.label}>
                  <p className="pb-1 text-2xs font-semibold tracking-wider text-ink-3 uppercase">{entry.label}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {items.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => go(id)}
                        aria-current={page === id ? 'page' : undefined}
                        className={cx('flex min-h-12 items-center gap-2.5 rounded-xl border px-3 text-body font-medium', page === id ? 'border-brand bg-brand text-brand-ink' : 'border-line text-ink')}
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
              <UserBox onDone={() => setMore(false)} />
            </div>
          </div>
        </Modal>
      )}

      {palette && (
        <CommandPalette
          pages={NAV_PAGES.map((p) => ({ id: p.id, label: p.label, icon: <p.icon className="size-4.5" aria-hidden /> }))}
          onClose={() => setPalette(false)}
          onNavigate={go}
          onBuy={setPurchase}
        />
      )}
      {purchase && assets.data && (
        <PurchaseForm
          assets={assets.data}
          preset={purchase}
          onClose={() => setPurchase(null)}
          onSaved={() => {
            setPurchase(null);
            notify('success', `Achiziția pentru ${purchase.symbol.toUpperCase()} a fost adăugată.`);
            bumpData();
          }}
        />
      )}
    </div>
  );
}
