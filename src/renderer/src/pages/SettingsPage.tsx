/** Setări: preferințe de calcul și afișare, provideri de prețuri și chei API, parolă, backup și restaurare. */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Database, KeyRound, Lock, Save, Upload } from 'lucide-react';
import { BASE_CURRENCIES, PROVIDER_IDS, REFRESH_INTERVALS, type CostMethod, type ProviderId, type Theme } from '@shared/types';
import { COST_METHOD_LABEL, PROVIDER_LABEL } from '@shared/labels';
import { BENCHMARKS } from '@shared/benchmarks';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { Badge, Button, Card, ConfirmDialog, Field, Input, Notice, Segmented, Select } from '../components/ui';
import { WebSettingsExtras } from '@/webExtras';

/** Un rând de setare: etichetă și explicație în stânga, controlul în dreapta. */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3.5 first:pt-0 last:border-0 last:pb-0">
      <div className="max-w-xl min-w-0">
        <p className="text-body font-medium text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const KEY_HELP: Record<Exclude<ProviderId, 'yahoo'>, string> = {
  alphavantage: 'Cheie gratuită pe alphavantage.co (circa 25 de cereri pe zi).',
  twelvedata: 'Cheie gratuită pe twelvedata.com (8 cereri pe minut, 800 pe zi).',
  polygon: 'Cheie gratuită pe polygon.io (5 cereri pe minut, doar piața SUA, crypto și valute).'
};

function ApiKeyRow({ provider }: { provider: Exclude<ProviderId, 'yahoo'> }) {
  const { settings, reloadSettings, notify } = useApp();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const state = settings?.apiKeys[provider];

  const save = async (key: string | null): Promise<void> => {
    setBusy(true);
    try {
      await api.settings.setApiKey(provider, key);
      await reloadSettings();
      setValue('');
      notify('success', key ? `Cheia ${PROVIDER_LABEL[provider]} a fost salvată (criptat).` : `Cheia ${PROVIDER_LABEL[provider]} a fost ștearsă.`);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      label={PROVIDER_LABEL[provider]}
      hint={
        <>
          {KEY_HELP[provider]} {state?.configured && <Badge tone="gain">cheie salvată {state.hint}</Badge>}
        </>
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void save(value);
        }}
      >
        <Input
          type="password"
          className="w-56!"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={state?.configured ? 'Înlocuiește cheia…' : 'Cheia API'}
          autoComplete="off"
          aria-label={`Cheia API ${PROVIDER_LABEL[provider]}`}
        />
        <Button type="submit" loading={busy} disabled={!value.trim()}>
          Salvează
        </Button>
        {state?.configured && (
          <Button variant="ghost" disabled={busy} onClick={() => void save(null)}>
            Șterge
          </Button>
        )}
      </form>
    </Row>
  );
}

function PasswordCard() {
  const { notify } = useApp();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) return setError('Parolele noi nu coincid.');
    setBusy(true);
    try {
      await api.auth.changePassword(oldPassword, newPassword);
      notify('success', 'Parola a fost schimbată.');
      setOld('');
      setNew('');
      setConfirm('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={<span className="flex items-center gap-2"><Lock className="size-4 text-ink-3" aria-hidden /> Schimbă parola</span>}>
      <form onSubmit={submit} className="grid max-w-3xl grid-cols-3 items-end gap-3.5">
        <Field label="Parola actuală">
          <Input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="Parola nouă">
          <Input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" minLength={8} required />
        </Field>
        <Field label="Confirmă parola nouă">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && (
          <div className="col-span-3">
            <Notice tone="loss">{error}</Notice>
          </div>
        )}
        <div className="col-span-3">
          <Button type="submit" variant="primary" loading={busy}>
            Schimbă parola
          </Button>
          <span className="ml-3 text-xs text-ink-3">Cel puțin 8 caractere. Sesiunile „ține-mă minte” existente sunt invalidate.</span>
        </div>
      </form>
    </Card>
  );
}

export function SettingsPage() {
  const { settings, updateSettings, notify, bumpData, reloadBrokers } = useApp();
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [busy, setBusy] = useState<'backup' | 'restore' | null>(null);
  const info = useLoad(() => api.app.info(), []);
  if (!settings) return null;

  const backup = async (): Promise<void> => {
    setBusy('backup');
    try {
      const res = await api.backup.create();
      if (!res.canceled) notify('success', `Backup salvat în ${res.path} (${res.count} tranzacții).`);
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (): Promise<void> => {
    setConfirmRestore(false);
    setBusy('restore');
    try {
      const res = await api.backup.restore();
      if (!res.canceled) {
        notify('success', `Datele au fost restaurate din backup (${res.count} tranzacții).`);
        await reloadBrokers();
        bumpData();
      }
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const primaryMissingKey = settings.primaryProvider !== 'yahoo' && !settings.apiKeys[settings.primaryProvider].configured;

  return (
    <>
      <Card title="Calcul și afișare">
        <Row label="Moneda de bază" hint="Totalurile portofoliului sunt convertite în această monedă, la cursul curent.">
          <Segmented value={settings.baseCurrency} onChange={(v) => void updateSettings({ baseCurrency: v })} options={BASE_CURRENCIES.map((c) => ({ value: c, label: c }))} />
        </Row>
        <Row
          label="Metoda de calcul a costului"
          hint="Cost mediu ponderat: unitățile vândute ies la prețul mediu. FIFO: se vând întâi cele mai vechi cumpărări. Metoda schimbă doar împărțirea profitului între realizat și nerealizat."
        >
          <Select className="w-72!" value={settings.costMethod} onChange={(e) => void updateSettings({ costMethod: e.target.value as CostMethod })}>
            {(Object.keys(COST_METHOD_LABEL) as CostMethod[]).map((m) => (
              <option key={m} value={m}>
                {COST_METHOD_LABEL[m]}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          label="Indicele de referință"
          hint="Randamentul portofoliului se compară cu el pe panoul principal și în ecranul Risc. Fiecare portofoliu își poate alege altul (Portofolii → editează)."
        >
          <Select className="w-72!" value={settings.benchmark} onChange={(e) => void updateSettings({ benchmark: e.target.value })} aria-label="Indicele de referință">
            {BENCHMARKS.map((b) => (
              <option key={b.symbol} value={b.symbol}>
                {b.name}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Temă">
          <Segmented<Theme>
            value={settings.theme}
            onChange={(v) => void updateSettings({ theme: v })}
            options={[
              { value: 'light', label: 'Luminoasă' },
              { value: 'dark', label: 'Întunecată' },
              { value: 'system', label: 'Ca sistemul' }
            ]}
          />
        </Row>
      </Card>

      <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-ink-3" aria-hidden /> Prețuri și provideri de date</span>}>
        <Row
          label="Provider principal"
          hint="Dacă providerul principal dă eroare sau nu are un simbol, aplicația încearcă automat ceilalți provideri configurați. Yahoo Finance nu cere cheie și acoperă BVB (.RO), crypto și cursurile valutare."
        >
          <Select className="w-56!" value={settings.primaryProvider} onChange={(e) => void updateSettings({ primaryProvider: e.target.value as ProviderId })}>
            {PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
                {p === 'yahoo' ? ' (fără cheie)' : settings.apiKeys[p].configured ? '' : ' — lipsește cheia'}
              </option>
            ))}
          </Select>
        </Row>
        {primaryMissingKey && (
          <div className="py-3">
            <Notice tone="warn">
              {PROVIDER_LABEL[settings.primaryProvider]} nu are o cheie API salvată, deci prețurile se iau deocamdată de la Yahoo Finance. Introdu cheia mai jos.
            </Notice>
          </div>
        )}
        <Row label="Interval de actualizare automată" hint="Prețurile sunt păstrate în cache între actualizări, ca să nu depășești limitele planurilor gratuite. Butonul „Actualizează acum” forțează oricând o actualizare.">
          <Select className="w-56!" value={settings.refreshIntervalMin} onChange={(e) => void updateSettings({ refreshIntervalMin: Number(e.target.value) })}>
            {REFRESH_INTERVALS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Doar manual' : m === 1 ? 'La 1 minut' : `La ${m} minute`}
              </option>
            ))}
          </Select>
        </Row>
        <ApiKeyRow provider="alphavantage" />
        <ApiKeyRow provider="twelvedata" />
        <ApiKeyRow provider="polygon" />
        <p className="pt-3 text-xs text-ink-3">Cheile sunt salvate criptat pe acest calculator, separat pentru fiecare utilizator, și nu sunt afișate după salvare.</p>
      </Card>

      <PasswordCard />

      <Card title={<span className="flex items-center gap-2"><Database className="size-4 text-ink-3" aria-hidden /> Backup și restaurare</span>}>
        <Row label="Salvează un backup" hint="Un fișier cu toate datele contului tău: brokeri, active, tranzacții, setări și prețurile salvate. Nu conține parola și nici cheile API.">
          <Button icon={<Save className="size-4" />} loading={busy === 'backup'} onClick={() => void backup()}>
            Salvează backup…
          </Button>
        </Row>
        <Row label="Restaurează din backup" hint="Înlocuiește datele contului curent cu cele din fișierul ales. Datele altor utilizatori nu sunt afectate.">
          <Button icon={<Upload className="size-4" />} loading={busy === 'restore'} onClick={() => setConfirmRestore(true)}>
            Restaurează…
          </Button>
        </Row>
        {info.data && (
          <p className="pt-3 text-xs text-ink-3">
            Versiunea {info.data.version} · baza de date: <span className="select-all">{info.data.dataPath}</span>
          </p>
        )}
      </Card>

      <WebSettingsExtras />

      {confirmRestore && (
        <ConfirmDialog
          title="Restaurezi din backup?"
          message="Toate datele contului curent (brokeri, active, tranzacții) vor fi înlocuite cu cele din fișierul de backup. Dacă vrei să le păstrezi, salvează mai întâi un backup."
          confirmLabel="Alege fișierul și restaurează"
          onConfirm={() => void restore()}
          onCancel={() => setConfirmRestore(false)}
        />
      )}
    </>
  );
}
