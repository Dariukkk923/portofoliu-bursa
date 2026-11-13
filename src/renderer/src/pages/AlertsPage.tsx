/**
 * Alertele personalizate: lista, adăugarea și modificarea, pornirea/oprirea, amânarea și ștergerea.
 * Condițiile se evaluează în procesul principal după fiecare actualizare de prețuri.
 */
import { useState, type FormEvent } from 'react';
import { BellPlus, BellRing, Pencil, Trash2, Volume2, VolumeX } from 'lucide-react';
import type { AlertCondition, AlertInput, AlertKind, AlertRepeat, AlertView, GoalView, HistoryRange } from '@shared/types';
import { ALERT_KIND_LABEL } from '@shared/alerts';
import { parseNumberLoose } from '@shared/csv';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { dateTime } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, ListSkeleton, LoadError, Modal, Notice, Segmented, Select, Textarea } from '../components/ui';

const KINDS: AlertKind[] = [
  'price',
  'watchlist_target',
  'daily_move',
  'position_pnl',
  'break_even',
  'sell_target',
  'portfolio',
  'benchmark_lag',
  'dividend',
  'concentration',
  'goal',
  'journal_review',
  'earnings'
];

const PAUSES: { value: number; label: string }[] = [
  { value: 15, label: '15 minute' },
  { value: 60, label: 'O oră' },
  { value: 240, label: '4 ore' },
  { value: 1440, label: 'O zi' },
  { value: 10080, label: 'O săptămână' }
];

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: '1M', label: '1 lună' },
  { value: '3M', label: '3 luni' },
  { value: '6M', label: '6 luni' },
  { value: '1Y', label: '1 an' },
  { value: 'ALL', label: 'De la început' }
];

const text = (v: number | null | undefined): string => (v == null ? '' : String(v).replace('.', ','));

/** Valorile din formular, toate ca text; se transformă în `AlertInput` la salvare. */
interface Draft {
  kind: AlertKind;
  symbol: string;
  direction: string;
  value: string;
  metric: string;
  range: HistoryRange;
  event: string;
  days: string;
  goalId: string;
  takeProfit: string;
  stopLoss: string;
  portfolioId: number | null;
  repeat: AlertRepeat;
  pause: number;
  windowOn: boolean;
  windowStart: string;
  windowEnd: string;
  sound: boolean;
  note: string;
}

const emptyDraft = (portfolioId: number | null): Draft => ({
  kind: 'price',
  symbol: '',
  direction: 'above',
  value: '',
  metric: 'pct',
  range: '1Y',
  event: 'ex_soon',
  days: '3',
  goalId: '',
  takeProfit: '',
  stopLoss: '',
  portfolioId,
  repeat: 'once',
  pause: 1440,
  windowOn: false,
  windowStart: '09:00',
  windowEnd: '18:00',
  sound: true,
  note: ''
});

function draftOf(a: AlertView): Draft {
  const d = emptyDraft(a.portfolioId);
  const c = a.condition;
  d.kind = c.kind;
  if ('symbol' in c && c.symbol) d.symbol = c.symbol;
  switch (c.kind) {
    case 'price':
      d.direction = c.direction;
      d.value = text(c.value);
      break;
    case 'daily_move':
      d.direction = c.direction;
      d.value = text(c.pct);
      break;
    case 'position_pnl':
      d.direction = c.direction;
      d.metric = c.metric;
      d.value = text(c.value);
      break;
    case 'sell_target':
      d.takeProfit = text(c.takeProfit);
      d.stopLoss = text(c.stopLoss);
      break;
    case 'portfolio':
      d.metric = c.metric;
      d.direction = c.direction;
      d.value = text(c.value);
      break;
    case 'benchmark_lag':
      d.range = c.range;
      d.value = text(c.lagPct);
      break;
    case 'dividend':
      d.event = c.event;
      d.days = String(c.daysBefore);
      break;
    case 'concentration':
      d.value = text(c.limitPct);
      break;
    case 'goal':
      d.goalId = String(c.goalId);
      d.event = c.mode;
      d.value = text(c.pct);
      break;
    case 'earnings':
      d.event = c.event;
      d.days = String(c.daysBefore);
      break;
    default:
      break;
  }
  d.repeat = a.repeat;
  d.pause = a.minPauseMin;
  d.windowOn = a.windowStart !== null;
  d.windowStart = a.windowStart ?? '09:00';
  d.windowEnd = a.windowEnd ?? '18:00';
  d.sound = a.sound;
  d.note = a.note ?? '';
  return d;
}

/** La schimbarea tipului, câmpurile comune primesc valorile implicite ale tipului nou (altfel ar rămâne valori din alt tip). */
const kindDefaults = (kind: AlertKind): Partial<Draft> => ({
  kind,
  metric: kind === 'portfolio' ? 'value' : 'pct',
  direction: kind === 'daily_move' ? 'up' : kind === 'position_pnl' ? 'profit' : 'above',
  event: kind === 'goal' ? 'progress' : kind === 'earnings' ? 'soon' : 'ex_soon',
  value: ''
});

const n = (v: string): number => parseNumberLoose(v) ?? NaN;
const nOrNull = (v: string): number | null => (v.trim() === '' ? null : n(v));

function conditionOf(d: Draft): AlertCondition {
  const symbol = d.symbol.trim().toUpperCase();
  switch (d.kind) {
    case 'price':
      return { kind: 'price', symbol, direction: d.direction as 'above' | 'below', value: n(d.value) };
    case 'watchlist_target':
      return { kind: 'watchlist_target', symbol };
    case 'daily_move':
      return { kind: 'daily_move', symbol, direction: d.direction as 'up' | 'down', pct: n(d.value) };
    case 'position_pnl':
      return { kind: 'position_pnl', symbol, metric: d.metric as 'pct' | 'amount', direction: d.direction as 'profit' | 'loss', value: n(d.value) };
    case 'break_even':
      return { kind: 'break_even', symbol };
    case 'sell_target':
      return { kind: 'sell_target', symbol, takeProfit: nOrNull(d.takeProfit), stopLoss: nOrNull(d.stopLoss) };
    case 'portfolio':
      return { kind: 'portfolio', metric: d.metric as 'value' | 'profit', direction: d.direction as 'above' | 'below', value: n(d.value) };
    case 'benchmark_lag':
      return { kind: 'benchmark_lag', range: d.range, lagPct: n(d.value) };
    case 'dividend':
      return { kind: 'dividend', symbol: symbol || null, event: d.event as 'ex_soon' | 'paid', daysBefore: n(d.days) };
    case 'concentration':
      return { kind: 'concentration', symbol: symbol || null, limitPct: nOrNull(d.value) };
    case 'goal':
      return { kind: 'goal', goalId: Number(d.goalId), mode: d.event === 'behind' ? 'behind' : 'progress', pct: d.event === 'behind' ? null : n(d.value || '100') };
    case 'journal_review':
      return { kind: 'journal_review', entryId: null };
    case 'earnings':
      return { kind: 'earnings', symbol, event: d.event === 'published' ? 'published' : 'soon', daysBefore: n(d.days || '3') };
    default:
      throw new Error('Tip necunit.');
  }
}

/** Câmpurile care depind de tipul alertei. */
function KindFields({ d, set, symbols, goals }: { d: Draft; set: (patch: Partial<Draft>) => void; symbols: string[]; goals: GoalView[] }) {
  const symbolField = (optional = false) => (
    <Field label={optional ? 'Simbol (gol = oricare)' : 'Simbol'}>
      <Input list="alert-symbols" value={d.symbol} onChange={(e) => set({ symbol: e.target.value })} placeholder="ex.: NVDA" autoCapitalize="characters" />
    </Field>
  );
  const number = (label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input inputMode="decimal" value={d.value} onChange={(e) => set({ value: e.target.value })} />
    </Field>
  );
  const above = (
    <Field label="Condiția">
      <Select value={d.direction} onChange={(e) => set({ direction: e.target.value })}>
        <option value="above">Peste</option>
        <option value="below">Sub</option>
      </Select>
    </Field>
  );
  return (
    <>
      <datalist id="alert-symbols">
        {symbols.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {d.kind === 'price' && (
        <>
          {symbolField()}
          <div className="grid grid-cols-2 gap-3">
            {above}
            {number('Valoare', 'În moneda instrumentului.')}
          </div>
        </>
      )}
      {d.kind === 'watchlist_target' && (
        <>
          {symbolField()}
          <p className="text-xs text-ink-3">Te anunță când prețul ajunge la ținta de cumpărare setată în watchlist pentru acest simbol.</p>
        </>
      )}
      {d.kind === 'daily_move' && (
        <>
          {symbolField()}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sens">
              <Select value={d.direction} onChange={(e) => set({ direction: e.target.value })}>
                <option value="up">Crește azi cu mai mult de</option>
                <option value="down">Scade azi cu mai mult de</option>
              </Select>
            </Field>
            {number('Procent (%)')}
          </div>
        </>
      )}
      {d.kind === 'position_pnl' && (
        <>
          {symbolField()}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Rezultat">
              <Select value={d.direction} onChange={(e) => set({ direction: e.target.value })}>
                <option value="profit">Profit</option>
                <option value="loss">Pierdere</option>
              </Select>
            </Field>
            <Field label="Măsurat în">
              <Select value={d.metric} onChange={(e) => set({ metric: e.target.value })}>
                <option value="pct">Procente</option>
                <option value="amount">Moneda de bază</option>
              </Select>
            </Field>
            {number(d.metric === 'pct' ? 'Prag (%)' : 'Prag (sumă)')}
          </div>
        </>
      )}
      {d.kind === 'break_even' && (
        <>
          {symbolField()}
          <p className="text-xs text-ink-3">Sună când o poziție aflată pe minus revine la prețul la care iese pe zero.</p>
        </>
      )}
      {d.kind === 'sell_target' && (
        <>
          {symbolField()}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Țintă de profit">
              <Input inputMode="decimal" value={d.takeProfit} onChange={(e) => set({ takeProfit: e.target.value })} />
            </Field>
            <Field label="Stop-loss">
              <Input inputMode="decimal" value={d.stopLoss} onChange={(e) => set({ stopLoss: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      {d.kind === 'portfolio' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Valoarea urmărită">
            <Select value={d.metric} onChange={(e) => set({ metric: e.target.value })}>
              <option value="value">Valoarea totală</option>
              <option value="profit">Profitul total</option>
            </Select>
          </Field>
          {above}
          {number('Valoare', 'În moneda de bază.')}
        </div>
      )}
      {d.kind === 'benchmark_lag' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Perioada">
            <Select value={d.range} onChange={(e) => set({ range: e.target.value as HistoryRange })}>
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          {number('În urma indicelui cu (%)', 'Față de indicele de referință.')}
        </div>
      )}
      {d.kind === 'dividend' && (
        <>
          {symbolField(true)}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Eveniment">
              <Select value={d.event} onChange={(e) => set({ event: e.target.value })}>
                <option value="ex_soon">Se apropie data ex-dividend</option>
                <option value="paid">Am primit un dividend</option>
              </Select>
            </Field>
            {d.event === 'ex_soon' && (
              <Field label="Cu câte zile înainte">
                <Input inputMode="numeric" value={d.days} onChange={(e) => set({ days: e.target.value })} />
              </Field>
            )}
          </div>
        </>
      )}
      {d.kind === 'concentration' && (
        <>
          {symbolField(true)}
          {number('Prag (% din portofoliu)', 'Gol = pragul de concentrare din Setări.')}
        </>
      )}
      {d.kind === 'goal' && (
        <>
          <Field label="Obiectiv">
            <Select value={d.goalId} onChange={(e) => set({ goalId: e.target.value })}>
              <option value="">Alege obiectivul</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Eveniment">
              <Select value={d.event === 'behind' ? 'behind' : 'progress'} onChange={(e) => set({ event: e.target.value })}>
                <option value="progress">Am atins un procent din obiectiv</option>
                <option value="behind">Sunt în urma ritmului necesar</option>
              </Select>
            </Field>
            {d.event !== 'behind' && number('Procent atins (%)')}
          </div>
        </>
      )}
      {d.kind === 'journal_review' && <p className="text-xs text-ink-3">Te anunță când o teză din jurnal ajunge la data de revizuire.</p>}
      {d.kind === 'earnings' && (
        <>
          {symbolField()}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Eveniment">
              <Select value={d.event === 'published' ? 'published' : 'soon'} onChange={(e) => set({ event: e.target.value })}>
                <option value="soon">Compania își publică rezultatele în curând</option>
                <option value="published">Au apărut rezultatele</option>
              </Select>
            </Field>
            {d.event !== 'published' && (
              <Field label="Cu câte zile înainte">
                <Input inputMode="numeric" value={d.days} onChange={(e) => set({ days: e.target.value })} />
              </Field>
            )}
          </div>
          <p className="text-xs text-ink-3">Datele vin din calendarul de raportări, pentru acțiunile pe care le deții.</p>
        </>
      )}
    </>
  );
}

function AlertForm({ alert, onClose, onSaved }: { alert: AlertView | null; onClose: () => void; onSaved: () => void }) {
  const { portfolios, filter, notify } = useApp();
  const [d, setD] = useState<Draft>(() => (alert ? draftOf(alert) : emptyDraft(filter.portfolioId ?? null)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const symbols = useLoad(() => api.alerts.symbols(), []);
  const goals = useLoad(() => api.goals.list(), []);
  const set = (patch: Partial<Draft>): void => setD((prev) => ({ ...prev, ...patch }));
  const scoped = ['position_pnl', 'break_even', 'portfolio', 'benchmark_lag', 'dividend', 'concentration'].includes(d.kind);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const input: AlertInput = {
        portfolioId: scoped ? d.portfolioId : null,
        condition: conditionOf(d),
        repeat: d.repeat,
        minPauseMin: d.pause,
        windowStart: d.windowOn ? d.windowStart : null,
        windowEnd: d.windowOn ? d.windowEnd : null,
        sound: d.sound,
        note: d.note
      };
      if (alert) await api.alerts.update(alert.id, input);
      else await api.alerts.create(input);
      notify('success', alert ? 'Alerta a fost salvată.' : 'Alerta a fost creată.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={alert ? 'Modifică alerta' : 'Alertă nouă'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="alert-form" loading={saving}>
            Salvează
          </Button>
        </>
      }
    >
      <form id="alert-form" onSubmit={(e) => void submit(e)} className="space-y-3">
        <Field label="Tipul alertei">
          <Select value={d.kind} onChange={(e) => set(kindDefaults(e.target.value as AlertKind))}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {ALERT_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <KindFields d={d} set={set} symbols={(symbols.data ?? []).map((s) => s.symbol)} goals={goals.data ?? []} />
        {scoped && portfolios.length > 1 && (
          <Field label="Portofoliu">
            <Select value={d.portfolioId ?? ''} onChange={(e) => set({ portfolioId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Toate portofoliile</option>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="space-y-3 border-t border-line pt-3">
          <Field label="Cât de des sună">
            <Segmented<AlertRepeat>
              value={d.repeat}
              onChange={(repeat) => set({ repeat })}
              options={[
                { value: 'once', label: 'O singură dată' },
                { value: 'repeat', label: 'De fiecare dată' }
              ]}
            />
          </Field>
          {d.repeat === 'repeat' && (
            <Field label="Pauză minimă între alerte">
              <Select value={d.pause} onChange={(e) => set({ pause: Number(e.target.value) })}>
                {PAUSES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <label className="flex items-center gap-2 text-body text-ink">
            <input type="checkbox" className="size-4 accent-accent" checked={d.windowOn} onChange={(e) => set({ windowOn: e.target.checked })} />
            Doar la anumite ore
          </label>
          {d.windowOn && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="De la">
                <Input type="time" value={d.windowStart} onChange={(e) => set({ windowStart: e.target.value })} />
              </Field>
              <Field label="Până la">
                <Input type="time" value={d.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} />
              </Field>
            </div>
          )}
          <label className="flex items-center gap-2 text-body text-ink">
            <input type="checkbox" className="size-4 accent-accent" checked={d.sound} onChange={(e) => set({ sound: e.target.checked })} />
            Cu sunet
          </label>
          <Field label="Notă personală (apare în notificare)">
            <Textarea value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} placeholder="ex.: Vinde jumătate din poziție" />
          </Field>
        </div>
        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}

function AlertRow({ a, onEdit, onDelete, onChanged }: { a: AlertView; onEdit: () => void; onDelete: () => void; onChanged: () => void }) {
  const { notify } = useApp();
  const snoozed = a.snoozedUntil !== null && Date.parse(a.snoozedUntil) > Date.now();
  const run = (job: Promise<unknown>): void =>
    void job.then(onChanged).catch((err) => notify('error', errorMessage(err)));
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
      <input
        type="checkbox"
        role="switch"
        className="size-4 accent-accent"
        aria-label={`${a.enabled ? 'Oprește' : 'Pornește'} alerta: ${a.summary}`}
        checked={a.enabled}
        onChange={(e) => run(api.alerts.setEnabled(a.id, e.target.checked))}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium text-ink">{a.summary}</span>
          <Badge>{ALERT_KIND_LABEL[a.kind]}</Badge>
          {a.portfolioName && <Badge tone="accent">{a.portfolioName}</Badge>}
          {snoozed && <Badge tone="warn">Amânată până la {dateTime(a.snoozedUntil)}</Badge>}
          {!a.enabled && a.triggerCount > 0 && a.repeat === 'once' && <Badge tone="gain">A sunat</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-ink-3">
          {a.repeat === 'once' ? 'O singură dată' : `De fiecare dată, pauză minimă ${PAUSES.find((p) => p.value === a.minPauseMin)?.label.toLowerCase() ?? `${a.minPauseMin} min`}`}
          {a.windowStart && ` · ${a.windowStart}–${a.windowEnd}`}
          {a.lastTriggeredAt && ` · ultima dată: ${dateTime(a.lastTriggeredAt)}`}
        </p>
        {a.note && <p className="mt-0.5 text-xs text-ink-2 italic">„{a.note}”</p>}
      </div>
      <span className="text-ink-3" title={a.sound ? 'Cu sunet' : 'Fără sunet'}>
        {a.sound ? <Volume2 className="size-4" aria-label="Cu sunet" /> : <VolumeX className="size-4" aria-label="Fără sunet" />}
      </span>
      <Select aria-label={`Amână alerta: ${a.summary}`} className="w-32!" value="" onChange={(e) => run(api.alerts.snooze(a.id, e.target.value === 'off' ? null : Number(e.target.value)))}>
        <option value="">Amână…</option>
        <option value="60">1 oră</option>
        <option value="240">4 ore</option>
        <option value="1440">1 zi</option>
        <option value="10080">1 săptămână</option>
        {snoozed && <option value="off">Anulează amânarea</option>}
      </Select>
      <IconButton label={`Modifică alerta: ${a.summary}`} onClick={onEdit}>
        <Pencil className="size-4" />
      </IconButton>
      <IconButton label={`Șterge alerta: ${a.summary}`} onClick={onDelete}>
        <Trash2 className="size-4" />
      </IconButton>
    </li>
  );
}

export function AlertsPage() {
  const { filter, dataVersion, notify } = useApp();
  const list = useLoad(() => api.alerts.list(filter.portfolioId ?? null), [filter.portfolioId, dataVersion]);
  const [form, setForm] = useState<{ alert: AlertView | null } | null>(null);
  const [deleting, setDeleting] = useState<AlertView | null>(null);
  const [busy, setBusy] = useState(false);
  const alerts = list.data ?? [];

  const remove = async (): Promise<void> => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.alerts.remove(deleting.id);
      notify('success', 'Alerta a fost ștearsă.');
      setDeleting(null);
      list.reload();
    } catch (err) {
      notify('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-body text-ink-2">Alertele se verifică după fiecare actualizare de prețuri, cât timp aplicația rulează. Primești o notificare pe calculator și o găsești în clopoțelul din bara de sus.</p>
        <Button variant="primary" icon={<BellPlus className="size-4" />} onClick={() => setForm({ alert: null })}>
          Adaugă alertă
        </Button>
      </div>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <ListSkeleton />
      ) : alerts.length === 0 ? (
        <EmptyState icon={<BellRing className="size-6" />} title="Nicio alertă încă" text="Creează o alertă ca să fii anunțat când un preț, un profit sau un obiectiv ajunge unde îți dorești." action={<Button variant="primary" onClick={() => setForm({ alert: null })}>Adaugă alertă</Button>} />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line px-4">
            {alerts.map((a) => (
              <AlertRow key={a.id} a={a} onEdit={() => setForm({ alert: a })} onDelete={() => setDeleting(a)} onChanged={list.reload} />
            ))}
          </ul>
        </Card>
      )}

      {form && (
        <AlertForm
          alert={form.alert}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            list.reload();
          }}
        />
      )}
      {deleting && <ConfirmDialog title="Ștergi alerta?" message={deleting.summary} onConfirm={() => void remove()} onCancel={() => setDeleting(null)} busy={busy} />}
    </div>
  );
}
