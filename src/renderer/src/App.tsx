import { useState } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { Spinner, cx } from './components/ui';
import { Layout, type PageId } from './components/Layout';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { PositionsPage } from './pages/PositionsPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { BrokersPage } from './pages/BrokersPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <AppProvider>
      <Shell />
      <Toasts />
    </AppProvider>
  );
}

/** Alege ce se vede: ecranul de încărcare, autentificarea sau aplicația propriu-zisă. */
function Shell() {
  const { user, settings } = useApp();

  if (user === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-7" />
      </div>
    );
  }
  // Fără sesiune activă, aplicația pornește întotdeauna pe ecranul de login.
  if (user === null) return <AuthPage />;
  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-7" />
      </div>
    );
  }

  // `key` repornește totul când se schimbă utilizatorul: fiecare cont pornește pe dashboard, fără date din contul anterior.
  return <Workspace key={user.id} />;
}

/** Aplicația propriu-zisă, pentru utilizatorul autentificat. */
function Workspace() {
  const [page, setPage] = useState<PageId>('dashboard');
  return (
    <Layout page={page} onNavigate={setPage}>
      {page === 'dashboard' && <DashboardPage onNavigate={setPage} />}
      {page === 'positions' && <PositionsPage />}
      {page === 'transactions' && <TransactionsPage />}
      {page === 'brokers' && <BrokersPage />}
      {page === 'settings' && <SettingsPage />}
    </Layout>
  );
}

/** Notificările scurte din colțul ecranului (confirmări și erori). */
function Toasts() {
  const { toasts, dismissToast } = useApp();
  const icons = { success: CircleCheck, error: CircleAlert, info: Info };
  const tones = { success: 'text-gain', error: 'text-loss', info: 'text-accent' };
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const Icon = icons[t.tone];
        return (
          <div key={t.id} className="animate-in pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3 shadow-lg">
            <Icon className={cx('mt-0.5 size-4 shrink-0', tones[t.tone])} aria-hidden />
            <p className="min-w-0 flex-1 text-[13px] text-ink">{t.text}</p>
            <button type="button" aria-label="Închide notificarea" onClick={() => dismissToast(t.id)} className="text-ink-3 hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
