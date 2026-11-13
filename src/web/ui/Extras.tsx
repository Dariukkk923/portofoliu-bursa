/** Cardul „Versiunea pentru iPhone” din Setări: adresa proxy-ului de prețuri și avertismentul despre datele locale. */
import { useEffect, useState, type FormEvent } from 'react';
import { Smartphone } from 'lucide-react';
import { Button, Card, Field, Input, Notice } from '@/components/ui';
import { useApp } from '@/context/AppContext';
import type { WebConfig } from '../protocol';
import { webClient } from './webClient';

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function WebSettingsExtras() {
  const { notify, bumpData } = useApp();
  const [cfg, setCfg] = useState<WebConfig | null>(null);
  const [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void webClient()
      .config()
      .then((c) => {
        setCfg(c);
        setProxy(c.proxyUrl ?? '');
      });
  }, []);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    const res = await webClient().setProxy(proxy);
    setBusy(false);
    if (!res.ok) return notify('error', res.error);
    notify('success', proxy.trim() ? 'Adresa proxy-ului a fost salvată.' : 'Proxy-ul a fost șters.');
    bumpData();
  };

  return (
    <Card title={<span className="flex items-center gap-2"><Smartphone className="size-4 text-ink-3" aria-hidden /> Versiunea pentru telefon</span>}>
      <div className="space-y-4">
        <Notice tone="warn">
          Datele tale sunt păstrate doar în acest browser, pe acest telefon. Se pierd dacă ștergi aplicația de pe ecranul principal sau dacă ștergi datele Safari.
          Salvează un backup din când în când (Backup și restaurare, mai sus).
        </Notice>
        {cfg && (
          <p className="text-xs text-ink-3">
            Ultimul backup: {cfg.lastBackupAt ? fmtDate(cfg.lastBackupAt) : 'niciunul încă'} · stocare persistentă:{' '}
            {cfg.persisted === null ? 'se verifică…' : cfg.persisted ? 'activă' : 'neacordată de browser'}
          </p>
        )}
        <form onSubmit={(e) => void save(e)} className="space-y-2">
          <Field
            label="Adresa proxy-ului de prețuri"
            hint="Yahoo Finance, cursurile BNR și logo-urile nu pot fi cerute direct din browser. Adresa o primești după ce publici proxy-ul din folderul proxy (vezi proxy/README.md)."
          >
            <Input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="https://portofoliu-proxy.contul-tau.workers.dev" inputMode="url" autoCapitalize="none" autoCorrect="off" />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>
            Salvează adresa
          </Button>
        </form>
      </div>
    </Card>
  );
}
