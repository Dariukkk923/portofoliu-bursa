/** Lista de brokeri a utilizatorului: adăugare, redenumire, ștergere, tipul (România / străin) și valoarea deținută la fiecare. */
import { useState, type FormEvent } from 'react';
import { Building2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Broker, BrokerResidence } from '@shared/types';
import { guessResidence, RESIDENCE_HINT } from '@shared/tax';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { money, percent } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, Modal, Notice, Segmented, TD, TH, Textarea, cx } from '../components/ui';

function BrokerForm({ broker, onClose, onSaved }: { broker: Broker | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(broker?.name ?? '');
  const [notes, setNotes] = useState(broker?.notes ?? '');
  // La un broker nou, tipul se deduce din nume până când utilizatorul îl alege.
  const [chosen, setChosen] = useState<BrokerResidence | null>(broker?.residence ?? null);
  const residence = chosen ?? guessResidence(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (broker) await api.brokers.update(broker.id, { name, notes, residence });
      else await api.brokers.create({ name, notes, residence });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={broker ? 'Editează brokerul' : 'Adaugă broker'}
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="broker-form" loading={saving}>
            {broker ? 'Salvează' : 'Adaugă brokerul'}
          </Button>
        </>
      }
    >
      <form id="broker-form" onSubmit={submit} className="space-y-3.5">
        <Field label="Nume">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: XTB, Tradeville, Revolut, Binance" maxLength={60} required autoFocus />
        </Field>
        <Field label="Pentru raportul fiscal" hint={RESIDENCE_HINT[residence]}>
          <Segmented<BrokerResidence>
            value={residence}
            onChange={setChosen}
            options={[
              { value: 'ro', label: 'Broker din România' },
              { value: 'foreign', label: 'Broker străin' }
            ]}
          />
        </Field>
        <Field label="Note (opțional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
        </Field>
        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}

export function BrokersPage() {
  const { brokers, reloadBrokers, dataVersion, bumpData, notify } = useApp();
  const [form, setForm] = useState<{ broker: Broker | null } | null>(null);
  const [deleting, setDeleting] = useState<Broker | null>(null);
  const [busy, setBusy] = useState(false);
  // Valoarea deținută la fiecare broker, din portofoliul nefiltrat.
  const overview = useLoad(() => api.portfolio.overview({}), [dataVersion]);
  const allocation = new Map((overview.data?.allocationByBroker ?? []).map((s) => [s.key, s]));
  const base = overview.data?.totals.baseCurrency ?? 'RON';

  const saved = async (): Promise<void> => {
    setForm(null);
    await reloadBrokers();
    bumpData();
  };

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.brokers.remove(deleting.id);
      notify('success', `Brokerul ${deleting.name} a fost șters.`);
      await reloadBrokers();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <p className="text-body text-ink-2">Brokerii la care ai conturi. La fiecare achiziție alegi brokerul, iar pozițiile se pot vedea pe total sau separat pe broker.</p>
        <Button variant="primary" className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setForm({ broker: null })}>
          Adaugă broker
        </Button>
      </div>

      <Card padded={false}>
        {brokers.length === 0 ? (
          <EmptyState
            icon={<Building2 className="size-5" />}
            title="Niciun broker încă"
            text="Adaugă brokerii pe care îi folosești (de exemplu XTB, Tradeville, Revolut sau Binance)."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ broker: null })}>
                Adaugă primul broker
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={TH}>Broker</th>
                <th className={TH}>Tip</th>
                <th className={TH}>Note</th>
                <th className={cx(TH, 'text-right')}>Tranzacții</th>
                <th className={cx(TH, 'text-right')}>Valoare deținută</th>
                <th className={cx(TH, 'text-right')}>Din portofoliu</th>
                <th className={TH} aria-label="Acțiuni" />
              </tr>
            </thead>
            <tbody>
              {brokers.map((b) => {
                const slice = allocation.get(String(b.id));
                return (
                  <tr key={b.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                    <td className={cx(TD, 'font-semibold')}>{b.name}</td>
                    <td className={TD}>{b.residence === 'ro' ? <Badge tone="accent">România</Badge> : <Badge>Străin</Badge>}</td>
                    <td className={cx(TD, 'max-w-72 truncate text-ink-2')}>{b.notes ?? ''}</td>
                    <td className={cx(TD, 'tabular text-right')}>{b.transactionCount ?? 0}</td>
                    <td className={cx(TD, 'tabular text-right')}>{slice ? money(slice.value, base) : '—'}</td>
                    <td className={cx(TD, 'tabular text-right')}>{slice ? percent(slice.pct, 1) : '—'}</td>
                    <td className={cx(TD, 'text-right')}>
                      <div className="flex justify-end">
                        <IconButton label={`Editează ${b.name}`} onClick={() => setForm({ broker: b })}>
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton label={`Șterge ${b.name}`} onClick={() => setDeleting(b)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      {form && <BrokerForm broker={form.broker} onClose={() => setForm(null)} onSaved={() => void saved()} />}
      {deleting && (
        <ConfirmDialog
          title={`Ștergi brokerul ${deleting.name}?`}
          message={
            (deleting.transactionCount ?? 0) > 0
              ? `Brokerul are ${deleting.transactionCount} tranzacții. Trebuie mai întâi șterse sau mutate la alt broker.`
              : 'Brokerul nu are tranzacții și poate fi șters.'
          }
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
