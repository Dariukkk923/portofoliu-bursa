/**
 * Bannerele versiunii web, plutitoare deasupra aplicației: instalare (Safari), versiune nouă,
 * backup vechi și eroarea de pornire a bazei de date. Fiecare poate fi închis.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Download, Share, TriangleAlert, X } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import { webClient } from './webClient';

const DAY = 86_400_000;
const BACKUP_MAX_AGE_DAYS = 30;
const DISMISS_KEY = 'pb-install-dismissed';

/** Aplicația rulează ca instalată (de pe ecranul principal), nu într-o filă Safari. */
function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const isIos = (): boolean => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function Banner({ tone, icon, children, action, onClose }: { tone: 'accent' | 'warn'; icon: ReactNode; children: ReactNode; action?: ReactNode; onClose?: () => void }) {
  return (
    <div
      role="status"
      className={cx(
        'pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line px-3.5 py-3 text-body text-ink shadow-lg',
        tone === 'accent' ? 'bg-accent-soft' : 'bg-warn-soft'
      )}
    >
      <span className={cx('mt-0.5 shrink-0', tone === 'accent' ? 'text-accent' : 'text-warn')}>{icon}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <div>{children}</div>
        {action}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Închide" className="-m-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-3">
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

export function WebChrome({ subscribeUpdate, getUpdate }: { subscribeUpdate: (l: () => void) => () => void; getUpdate: () => (() => void) | null }) {
  const [update, setUpdate] = useState<(() => void) | null>(getUpdate());
  const [showInstall, setShowInstall] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => subscribeUpdate(() => setUpdate(() => getUpdate())), [subscribeUpdate, getUpdate]);

  useEffect(() => {
    if (isStandalone() || !isIos()) return;
    try {
      const until = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      if (Date.now() < until) return;
    } catch {
      /* fără localStorage: arătăm bannerul */
    }
    setShowInstall(true);
  }, []);

  useEffect(() => {
    const client = webClient();
    client.ready.catch((e: Error) => setFatal(e.message));
    let stop = false;
    const check = async (): Promise<void> => {
      try {
        const cfg = await client.config();
        if (stop) return;
        if (!cfg.hasData || cfg.isDemo) return setBackupMsg(null);
        if (cfg.lastBackupAt === null) return setBackupMsg('Nu ai făcut încă niciun backup.');
        const days = Math.floor((Date.now() - cfg.lastBackupAt) / DAY);
        setBackupMsg(days > BACKUP_MAX_AGE_DAYS ? `Ultimul backup are ${days} de zile.` : null);
      } catch {
        /* backendul nu e gata: încercăm din nou la următoarea verificare */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const dismissInstall = (): void => {
    setShowInstall(false);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + 14 * DAY));
    } catch {
      /* nu e grav */
    }
  };

  if (!fatal && !update && !showInstall && !backupMsg) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col gap-2 px-3 pb-2" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)' }}>
      {fatal && (
        <Banner tone="warn" icon={<TriangleAlert className="size-4" aria-hidden />}>
          Baza de date nu a putut porni în acest browser. Dacă ești în fereastră privată, deschide aplicația într-o fereastră obișnuită. ({fatal})
        </Banner>
      )}
      {update && (
        <Banner tone="accent" icon={<Download className="size-4" aria-hidden />} action={<Button size="sm" variant="primary" onClick={() => update()}>Actualizează</Button>}>
          Versiune nouă disponibilă — Actualizează
        </Banner>
      )}
      {showInstall && (
        <Banner tone="accent" icon={<Share className="size-4" aria-hidden />} onClose={dismissInstall}>
          Instalează aplicația: apasă <b>Partajare</b> → <b>Adaugă pe ecranul principal</b>.
        </Banner>
      )}
      {backupMsg && (
        <Banner tone="warn" icon={<TriangleAlert className="size-4" aria-hidden />} onClose={() => setBackupMsg(null)}>
          {backupMsg} Salvează un backup din Setări. Datele sunt doar pe acest telefon.
        </Banner>
      )}
    </div>
  );
}
