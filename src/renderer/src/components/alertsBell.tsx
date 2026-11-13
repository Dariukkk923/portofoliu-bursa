/**
 * Clopoțelul din bara de sus: numărul de notificări necitite și istoricul alertelor declanșate,
 * cu „marchează ca citite”. Se reîncarcă la evenimentul `alerts:triggered` și la fiecare
 * schimbare de date (alertele se evaluează după actualizarea prețurilor).
 */
import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import type { AlertCenter } from '@shared/types';
import { api, onAppEvent } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { dateTime } from '../lib/format';
import { cx } from './ui';

export function NotificationBell({ onOpenAlerts }: { onOpenAlerts: () => void }) {
  const { user, dataVersion } = useApp();
  const [open, setOpen] = useState(false);
  const [override, setOverride] = useState<AlertCenter | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const load = useLoad(() => api.alerts.center(), [dataVersion, user?.id]);
  const center = override ?? load.data;
  // O încărcare nouă are prioritate față de răspunsul ultimei acțiuni.
  useEffect(() => setOverride(null), [load.data]);
  useEffect(() => onAppEvent((event) => event.type === 'alerts:triggered' && load.reload()), [load.reload]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = center?.unread ?? 0;
  const markRead = (ids: number[] | null): void => void api.alerts.markRead(ids).then(setOverride).catch(() => undefined);

  return (
    <div ref={root} className="relative max-md:order-2">
      <button
        type="button"
        aria-label={unread > 0 ? `Notificări: ${unread} necitite` : 'Notificări'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex size-9.5 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 transition hover:bg-surface-2 hover:text-ink max-md:size-11"
      >
        <Bell className="size-4" aria-hidden />
        {unread > 0 && (
          <span data-testid="alerts-unread" className="tabular absolute -top-1.5 -right-1.5 min-w-4.5 rounded-full bg-warn px-1 text-center text-2xs leading-4.5 font-semibold text-accent-ink">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Centrul de notificări" className="animate-in absolute right-0 z-40 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface shadow-pop max-md:fixed max-md:inset-x-4 max-md:top-16 max-md:w-auto">
          <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-body font-semibold text-ink">Notificări</h2>
            <button
              type="button"
              disabled={unread === 0}
              onClick={() => markRead(null)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft disabled:text-ink-3 disabled:hover:bg-transparent"
            >
              <CheckCheck className="size-3.5" aria-hidden /> Marchează tot ca citit
            </button>
          </header>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {(center?.events ?? []).map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => e.readAt === null && markRead([e.id])} className={cx('block w-full px-4 py-2.5 text-left transition hover:bg-surface-2', e.readAt === null && 'bg-accent-soft/40')}>
                  <span className="flex items-start gap-2">
                    {e.readAt === null && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" aria-label="Necitită" />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium text-ink">{e.title}</span>
                      {e.body && <span className="block text-xs text-ink-2">{e.body}</span>}
                      {e.note && <span className="mt-0.5 block text-xs text-ink-2 italic">„{e.note}”</span>}
                      <span className="mt-0.5 block text-2xs text-ink-3">{dateTime(e.createdAt)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {center && center.events.length === 0 && <li className="px-4 py-6 text-center text-body text-ink-3">Nicio alertă declanșată încă.</li>}
          </ul>
          <footer className="border-t border-line px-4 py-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenAlerts();
              }}
              className="text-xs font-medium text-accent hover:underline"
            >
              Gestionează alertele
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
