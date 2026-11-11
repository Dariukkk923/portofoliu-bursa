/**
 * Starea globală a interfeței: utilizatorul autentificat, setările, lista de
 * brokeri și de portofolii, portofoliul selectat, filtrul global, starea
 * prețurilor și notificările.
 *
 * `dataVersion` crește la orice modificare a datelor (o tranzacție nouă, prețuri
 * actualizate); paginile îl folosesc ca semnal că trebuie să-și reîncarce datele.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Broker, Portfolio, PortfolioFilter, PortfolioScope, PriceStatus, Settings, SettingsUpdate, Theme, User } from '@shared/types';
import { api, errorMessage, onAppEvent } from '../api';

export interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  text: string;
}

interface AppState {
  /** undefined = încă se verifică sesiunea; null = neautentificat. */
  user: User | null | undefined;
  settings: Settings | null;
  brokers: Broker[];
  /** Toate portofoliile (inclusiv arhivate); `activePortfolios` doar cele nearhivate. */
  portfolios: Portfolio[];
  activePortfolios: Portfolio[];
  /** Portofoliul selectat sau „all” (toate, combinate); ținut minte în setări. */
  scope: PortfolioScope;
  /** Portofoliul selectat, sau null în vederea combinată. */
  currentPortfolio: Portfolio | null;
  /** Portofoliul preselectat la adăugarea unei tranzacții: cel selectat, altfel primul activ. */
  defaultPortfolioId: number | null;
  setScope: (scope: PortfolioScope) => void;
  reloadPortfolios: () => Promise<void>;
  /** Filtrul global (broker, tip de activ) împreună cu portofoliul selectat. */
  filter: PortfolioFilter;
  priceStatus: PriceStatus | null;
  dataVersion: number;
  toasts: Toast[];
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
  setFilter: (filter: PortfolioFilter) => void;
  updateSettings: (patch: SettingsUpdate) => Promise<void>;
  reloadSettings: () => Promise<void>;
  reloadBrokers: () => Promise<void>;
  /** Anunță că datele s-au schimbat și ecranele trebuie reîncărcate. */
  bumpData: () => void;
  refreshPrices: () => Promise<void>;
  notify: (tone: Toast['tone'], text: string) => void;
  dismissToast: (id: number) => void;
  /**
   * Butonul „Import Excel / CSV” din orice pagină cere deschiderea ecranului Import cu alegerea
   * fișierului: `importRequest` crește la fiecare cerere, iar `takeImportRequest` o „consumă” o singură dată.
   */
  importRequest: number;
  requestImport: () => void;
  takeImportRequest: (request: number) => boolean;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp trebuie folosit în interiorul AppProvider.');
  return ctx;
}

const THEME_KEY = 'portofoliu.theme';

/** Aplică tema pe <html>; „system” urmează setarea sistemului de operare. */
function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null | undefined>(undefined);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [baseFilter, setFilter] = useState<PortfolioFilter>({});
  const [priceStatus, setPriceStatus] = useState<PriceStatus | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    (tone: Toast['tone'], text: string) => {
      const id = ++toastId.current;
      setToasts((list) => [...list.slice(-3), { id, tone, text }]);
      window.setTimeout(() => dismissToast(id), tone === 'error' ? 8000 : 4500);
    },
    [dismissToast]
  );

  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);

  const [importRequest, setImportRequest] = useState(0);
  const handledImport = useRef(0);
  const requestImport = useCallback(() => setImportRequest((n) => n + 1), []);
  const takeImportRequest = useCallback((request: number) => {
    if (request <= handledImport.current) return false;
    handledImport.current = request;
    return true;
  }, []);

  const reloadSettings = useCallback(async () => setSettings(await api.settings.get()), []);
  const reloadBrokers = useCallback(async () => setBrokers(await api.brokers.list()), []);
  const reloadPortfolios = useCallback(async () => {
    const [list, s] = await Promise.all([api.portfolios.list(), api.settings.get()]);
    setPortfolios(list);
    setSettings(s); // portofoliul selectat se poate schimba (ex.: cel curent a fost șters)
  }, []);

  /** Încarcă tot ce ține de utilizatorul proaspăt autentificat (sau golește starea la ieșire). */
  const setUser = useCallback((next: User | null) => {
    setUserState(next);
    setFilter({});
    setPriceStatus(null);
    setToasts([]); // notificările contului anterior nu trebuie să rămână pe ecran
    if (!next) {
      setSettings(null);
      setBrokers([]);
      setPortfolios([]);
      return;
    }
    void Promise.all([api.settings.get(), api.brokers.list(), api.portfolios.list(), api.prices.status()])
      .then(([s, b, pf, p]) => {
        setSettings(s);
        setBrokers(b);
        setPortfolios(pf);
        setPriceStatus(p);
      })
      .catch(() => undefined);
  }, []);

  // La pornire: există o sesiune activă (inclusiv „ține-mă minte”)? Altfel se afișează ecranul de login.
  useEffect(() => {
    api.auth
      .current()
      .then(setUser)
      .catch(() => setUser(null));
  }, [setUser]);

  // Evenimentele din procesul principal: starea actualizării și date schimbate în fundal.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === 'prices:status') setPriceStatus(event.payload);
        else if (event.type === 'data:changed') {
          bumpData();
          void reloadBrokers().catch(() => undefined);
          void reloadPortfolios().catch(() => undefined);
        }
      }),
    [bumpData, reloadBrokers, reloadPortfolios]
  );

  // Tema: din setările utilizatorului; înainte de login, ultima temă folosită pe acest calculator.
  const theme: Theme = settings?.theme ?? ((localStorage.getItem(THEME_KEY) as Theme | null) || 'system');
  useEffect(() => {
    applyTheme(theme);
    if (settings) localStorage.setItem(THEME_KEY, theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme, settings]);

  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => undefined);
    setUser(null);
  }, [setUser]);

  const updateSettings = useCallback(
    async (patch: SettingsUpdate) => {
      try {
        setSettings(await api.settings.update(patch));
        bumpData();
      } catch (err) {
        notify('error', errorMessage(err));
      }
    },
    [bumpData, notify]
  );

  const scope: PortfolioScope = settings?.activePortfolio ?? 'all';
  const activePortfolios = useMemo(() => portfolios.filter((p) => !p.archived), [portfolios]);
  const currentPortfolio = scope === 'all' ? null : (portfolios.find((p) => p.id === scope) ?? null);
  const defaultPortfolioId = currentPortfolio?.id ?? activePortfolios[0]?.id ?? null;
  const filter = useMemo<PortfolioFilter>(() => ({ ...baseFilter, portfolioId: scope === 'all' ? null : scope }), [baseFilter, scope]);

  const setScope = useCallback(
    (next: PortfolioScope) => {
      // Schimbare imediată pe ecran; setarea se salvează în fundal (aplicația pornește data viitoare tot aici).
      setSettings((s) => (s ? { ...s, activePortfolio: next } : s));
      api.settings.update({ activePortfolio: next }).catch((err) => notify('error', errorMessage(err)));
    },
    [notify]
  );

  const refreshPrices = useCallback(async () => {
    try {
      const result = await api.prices.refresh();
      if (result.offline) notify('error', 'Fără conexiune la internet. Se folosesc ultimele prețuri salvate.');
      else if (result.failed.length > 0) notify('info', `Prețuri actualizate. Fără preț pentru: ${result.failed.join(', ')}.`);
      else notify('success', result.updated > 0 ? 'Prețurile au fost actualizate.' : 'Prețurile sunt deja la zi.');
    } catch (err) {
      notify('error', errorMessage(err));
    }
  }, [notify]);

  const value = useMemo<AppState>(
    () => ({
      user,
      settings,
      brokers,
      portfolios,
      activePortfolios,
      scope,
      currentPortfolio,
      defaultPortfolioId,
      setScope,
      reloadPortfolios,
      filter,
      priceStatus,
      dataVersion,
      toasts,
      setUser,
      logout,
      setFilter,
      updateSettings,
      reloadSettings,
      reloadBrokers,
      bumpData,
      refreshPrices,
      notify,
      dismissToast,
      importRequest,
      requestImport,
      takeImportRequest
    }),
    [
      user,
      settings,
      brokers,
      portfolios,
      activePortfolios,
      scope,
      currentPortfolio,
      defaultPortfolioId,
      setScope,
      reloadPortfolios,
      filter,
      priceStatus,
      dataVersion,
      toasts,
      setUser,
      logout,
      updateSettings,
      reloadSettings,
      reloadBrokers,
      bumpData,
      refreshPrices,
      notify,
      dismissToast,
      importRequest,
      requestImport,
      takeImportRequest
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Încarcă date asincron și le reîncarcă atunci când se schimbă dependențele
 * (de regulă `dataVersion` și filtrul). Păstrează datele vechi pe ecran în timpul reîncărcării.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
      })
      .catch((err) => alive && setError(errorMessage(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [...deps, tick]);

  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}
