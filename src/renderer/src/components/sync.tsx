/** Sincronizarea între calculator și telefon: cardul din Setări și alegerea datelor la conflict. */
import { useEffect, useState } from 'react';
import { RefreshCw, Smartphone } from 'lucide-react';
import type { SyncChoice, SyncStatus } from '@shared/sync';
import { useApp } from '../context/AppContext';
import { dateTime } from '../lib/format';
import { Badge, Button, Card, Modal } from './ui';

const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

/** Starea, pe scurt și pe înțelesul oricui. */
function describe(status: SyncStatus | null, isDemo: boolean): { badge: string; tone: 'gain' | 'warn' | 'loss' | 'neutral'; text: string } {
  if (isDemo) return { badge: 'Oprită', tone: 'neutral', text: 'Contul demo nu se sincronizează.' };
  switch (status?.state) {
    case 'ok':
      return { badge: 'La zi', tone: 'gain', text: 'Datele sunt aceleași pe toate dispozitivele.' };
    case 'syncing':
      return { badge: 'Se sincronizează…', tone: 'neutral', text: 'Se verifică datele cu celălalt dispozitiv.' };
    case 'offline':
      return { badge: 'Fără internet', tone: 'warn', text: 'Modificările se trimit singure când revine internetul.' };
    case 'conflict':
      return { badge: 'Alege datele', tone: 'warn', text: 'Datele s-au schimbat pe ambele dispozitive. Alege ce păstrăm.' };
    case 'name_taken':
      return {
        badge: 'Nesincronizat',
        tone: 'warn',
        text: 'Numele acestui cont este folosit online de alt cont sau cu altă parolă. Datele rămân aici. Dacă e contul tău de pe celălalt dispozitiv, schimbă parola de aici în cea de acolo.'
      };
    case 'error':
      return { badge: 'Problemă', tone: 'loss', text: status.message || 'Sincronizarea nu a reușit. Se reîncearcă automat.' };
    default:
      return { badge: 'Oprită', tone: 'neutral', text: status?.message || 'Sincronizarea nu este pornită.' };
  }
}

export function SyncCard() {
  const { user, syncStatus, syncNow } = useApp();
  const [busy, setBusy] = useState(false);
  const [choose, setChoose] = useState(false);
  const isDemo = !!user?.isDemo;
  const info = describe(syncStatus, isDemo);
  const canSync = !isDemo && syncStatus !== null && syncStatus.state !== 'off';

  const now = async (): Promise<void> => {
    setBusy(true);
    await syncNow();
    setBusy(false);
  };

  return (
    <Card title={<span className="flex items-center gap-2"><Smartphone className="size-4 text-ink-3" aria-hidden /> Sincronizare</span>}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="max-w-xl min-w-0 space-y-1">
          <p className="text-body text-ink">
            Același cont merge pe calculator și pe telefon. <Badge tone={info.tone}>{info.badge}</Badge>
          </p>
          <p className="text-xs text-ink-2">{info.text}</p>
          {canSync && (
            <p className="text-xs text-ink-3">
              Ultima sincronizare: {dateTime(iso(syncStatus?.lastSyncAt ?? null))}
              {syncStatus?.device ? ` · ultima modificare de pe ${syncStatus.device}` : ''}
            </p>
          )}
          {!isDemo && <p className="text-xs text-ink-3">Datele se trimit criptat cu parola ta: serverul nu le poate citi.</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {syncStatus?.state === 'conflict' && (
            <Button variant="primary" onClick={() => setChoose(true)}>
              Alege ce păstrăm
            </Button>
          )}
          {canSync && (
            <Button icon={<RefreshCw className="size-4" />} loading={busy || syncStatus?.state === 'syncing'} onClick={() => void now()}>
              Sincronizează acum
            </Button>
          )}
        </div>
      </div>
      {choose && <SyncConflictDialog onClose={() => setChoose(false)} />}
    </Card>
  );
}

/** „Datele s-au schimbat și pe celălalt dispozitiv. Ce păstrăm?” */
export function SyncConflictDialog({ onClose }: { onClose: () => void }) {
  const { syncStatus, resolveSync } = useApp();
  const [busy, setBusy] = useState<SyncChoice | null>(null);
  const device = syncStatus?.device || 'celălalt dispozitiv';

  const choose = async (choice: SyncChoice): Promise<void> => {
    setBusy(choice);
    await resolveSync(choice);
    setBusy(null);
    onClose();
  };

  return (
    <Modal title="Datele s-au schimbat și pe celălalt dispozitiv" onClose={onClose} width="max-w-md">
      <p className="text-sm text-ink-2">Datele s-au schimbat și pe celălalt dispozitiv. Ce păstrăm?</p>
      <p className="mt-2 text-xs text-ink-3">Datele alese ajung pe ambele dispozitive; celelalte se înlocuiesc.</p>
      <div className="mt-4 flex flex-col gap-2">
        <Button variant="primary" loading={busy === 'local'} disabled={busy !== null} onClick={() => void choose('local')}>
          Datele de pe acest dispozitiv
        </Button>
        <Button loading={busy === 'remote'} disabled={busy !== null} onClick={() => void choose('remote')}>
          Datele de pe {device}
        </Button>
      </div>
    </Modal>
  );
}

/** Afișată singură, oriunde în aplicație, când apare un conflict (se poate amâna; rămâne în Setări). */
export function SyncConflictPrompt() {
  const { syncStatus } = useApp();
  const [dismissed, setDismissed] = useState(false);
  const conflict = syncStatus?.state === 'conflict';
  // Un conflict nou (după ce cel vechi s-a rezolvat) se arată din nou.
  useEffect(() => {
    if (!conflict) setDismissed(false);
  }, [conflict]);
  if (!conflict || dismissed) return null;
  return <SyncConflictDialog onClose={() => setDismissed(true)} />;
}
