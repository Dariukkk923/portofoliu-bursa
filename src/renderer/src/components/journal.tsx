/**
 * Piesele jurnalului de investiții folosite în mai multe locuri: câmpurile unei intrări (motiv,
 * plan, încredere, etichete, memento), formularul de adăugare/editare și planul afișat la vânzare.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, NotebookPen } from 'lucide-react';
import { JOURNAL_HORIZONS, JOURNAL_REVIEW_MONTHS, type Asset, type JournalEntry, type JournalEntryInput } from '@shared/types';
import { parseNumberLoose } from '@shared/csv';
import { daysBetween, todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { date as fmtDate } from '../lib/format';
import { Badge, Button, Field, Input, Modal, Notice, Select, Textarea, cx } from './ui';
import { PortfolioField } from './portfolio';

/** O durată în luni, în cuvinte: „3 luni”, „1 an”, „1 an și 10 luni”. */
export function horizonLabel(m: number): string {
  const monthsText = (n: number): string => `${n} ${n === 1 ? 'lună' : 'luni'}`;
  if (m < 12) return monthsText(m);
  const years = Math.floor(m / 12);
  const rest = m % 12;
  const yearsText = `${years} ${years === 1 ? 'an' : 'ani'}`;
  return rest ? `${yearsText} și ${monthsText(rest)}` : yearsText;
}
/** Eticheta din lista de orizonturi (ultimul înseamnă „10 ani sau mai mult”). */
const horizonOption = (m: number): string => (m >= 120 ? '10+ ani' : horizonLabel(m));
const priceText = (v: number): string => v.toLocaleString('ro-RO', { maximumFractionDigits: 4 });

/** Valorile câmpurilor, ca text (cum le scrie utilizatorul). */
export interface JournalDraft {
  reason: string;
  target: string;
  stop: string;
  horizon: string;
  confidence: number | null;
  tags: string;
  review: string;
}

export const emptyDraft: JournalDraft = { reason: '', target: '', stop: '', horizon: '', confidence: null, tags: '', review: '' };

export function draftFrom(e: JournalEntry): JournalDraft {
  const t = (v: number | null): string => (v === null ? '' : String(v).replace('.', ','));
  return { reason: e.reason, target: t(e.targetPrice), stop: t(e.stopLoss), horizon: e.horizonMonths ? String(e.horizonMonths) : '', confidence: e.confidence, tags: e.tags.join(', '), review: '' };
}

export const draftIsEmpty = (d: JournalDraft): boolean => !d.reason.trim() && !d.target.trim() && !d.stop.trim() && !d.horizon && d.confidence === null && !d.tags.trim() && !d.review;

/** Verificarea de dinainte de salvare (ca tranzacția să nu se salveze cu o notă invalidă). */
export function draftError(d: JournalDraft): string | null {
  const target = d.target.trim() ? parseNumberLoose(d.target) : null;
  const stop = d.stop.trim() ? parseNumberLoose(d.stop) : null;
  if (d.target.trim() && (target === null || target <= 0)) return 'Prețul țintă din jurnal trebuie să fie un număr mai mare decât zero.';
  if (d.stop.trim() && (stop === null || stop <= 0)) return 'Stop-loss-ul din jurnal trebuie să fie un număr mai mare decât zero.';
  if (target !== null && stop !== null && stop >= target) return 'Stop-loss-ul din jurnal trebuie să fie sub prețul țintă.';
  return null;
}

/** Câmpurile ca intrare pentru API (mementoul în luni de azi; data exactă se păstrează la editare). */
export function draftToInput(d: JournalDraft, keepReviewDate: string | null = null): JournalEntryInput {
  return {
    reason: d.reason,
    targetPrice: parseNumberLoose(d.target),
    stopLoss: parseNumberLoose(d.stop),
    horizonMonths: d.horizon ? Number(d.horizon) : null,
    confidence: d.confidence,
    tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
    reviewInMonths: d.review ? Number(d.review) : null,
    reviewDate: d.review ? null : keepReviewDate
  };
}

/** Încrederea, 1–5, ca butoane. */
function ConfidencePicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Încrederea în decizie (1–5)">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`Încredere ${n} din 5`}
          onClick={() => onChange(value === n ? null : n)}
          className={cx(
            'tabular flex size-8 items-center justify-center rounded-lg border text-body font-semibold transition',
            value !== null && n <= value ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-surface text-ink-2 hover:bg-surface-2'
          )}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** Câmpurile unei intrări din jurnal. */
export function JournalFields({ draft, onChange, currency, tagSuggestions = [] }: { draft: JournalDraft; onChange: (d: JournalDraft) => void; currency?: string; tagSuggestions?: string[] }) {
  const set = <K extends keyof JournalDraft>(key: K, value: JournalDraft[K]): void => onChange({ ...draft, [key]: value });
  const unit = currency ? ` (${currency})` : '';
  return (
    <div className="space-y-3.5">
      <Field label="Motivul deciziei">
        <Textarea value={draft.reason} onChange={(e) => set('reason', e.target.value)} maxLength={2000} rows={3} placeholder="De ce cumperi / vinzi? Ce trebuie să se întâmple ca teza să fie corectă?" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={`Preț țintă${unit}`}>
          <Input inputMode="decimal" value={draft.target} onChange={(e) => set('target', e.target.value)} placeholder="opțional" />
        </Field>
        <Field label={`Stop-loss${unit}`}>
          <Input inputMode="decimal" value={draft.stop} onChange={(e) => set('stop', e.target.value)} placeholder="opțional" />
        </Field>
        <Field label="Orizont de timp">
          <Select value={draft.horizon} onChange={(e) => set('horizon', e.target.value)}>
            <option value="">—</option>
            {JOURNAL_HORIZONS.map((m) => (
              <option key={m} value={m}>
                {horizonOption(m)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Încredere (1–5)">
          <ConfidencePicker value={draft.confidence} onChange={(v) => set('confidence', v)} />
        </Field>
        <Field label="Amintește-mi să revizuiesc teza">
          <Select value={draft.review} onChange={(e) => set('review', e.target.value)}>
            <option value="">Fără memento</option>
            {JOURNAL_REVIEW_MONTHS.map((m) => (
              <option key={m} value={m}>
                peste {horizonLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Etichete" hint="Separate prin virgulă, ex.: dividende, termen lung">
        <Input value={draft.tags} onChange={(e) => set('tags', e.target.value)} list="journal-tags" maxLength={300} />
        <datalist id="journal-tags">
          {tagSuggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </Field>
    </div>
  );
}

/** Secțiune pliabilă „Notează în jurnal (opțional)” pentru formularele de cumpărare/vânzare. */
export function JournalSection({ title, draft, onChange, currency }: { title: string; draft: JournalDraft; onChange: (d: JournalDraft) => void; currency?: string }) {
  const [open, setOpen] = useState(!draftIsEmpty(draft));
  return (
    <div className="rounded-lg border border-line">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-body font-medium text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
        <NotebookPen className="size-4 text-accent" aria-hidden />
        {title}
        <span className="ml-auto text-xs font-normal text-ink-3">opțional</span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          <JournalFields draft={draft} onChange={onChange} currency={currency} />
        </div>
      )}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="tabular rounded-md bg-surface-2 px-2 py-0.5 text-xs text-ink-2">{children}</span>;
}

/** Elementele planului ca etichete scurte. */
export function PlanChips({ e }: { e: Pick<JournalEntry, 'targetPrice' | 'stopLoss' | 'horizonMonths' | 'confidence' | 'currency'> }) {
  return (
    <>
      {e.targetPrice !== null && (
        <Chip>
          Țintă {priceText(e.targetPrice)} {e.currency}
        </Chip>
      )}
      {e.stopLoss !== null && (
        <Chip>
          Stop-loss {priceText(e.stopLoss)} {e.currency}
        </Chip>
      )}
      {e.horizonMonths !== null && <Chip>Orizont {horizonOption(e.horizonMonths)}</Chip>}
      {e.confidence !== null && <Chip>Încredere {e.confidence}/5</Chip>}
    </>
  );
}

/** La vânzare: planul în vigoare pentru poziție, comparat pe loc cu prețul scris. */
export function SellPlanBox({ portfolioId, assetId, price, date }: { portfolioId: number | null; assetId: number | ''; price: number | null; date: string }) {
  const [plan, setPlan] = useState<JournalEntry | null>(null);
  useEffect(() => {
    let alive = true;
    setPlan(null);
    if (assetId === '') return;
    api.journal
      .planFor(portfolioId, assetId)
      .then((p) => alive && setPlan(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [portfolioId, assetId]);
  if (!plan) return null;
  const notes: { tone: 'ok' | 'warn' | 'info'; text: string }[] = [];
  if (price !== null && price > 0) {
    if (plan.targetPrice !== null) {
      const d = price / plan.targetPrice - 1;
      notes.push(d >= 0 ? { tone: 'ok', text: `Vinzi la țintă sau peste (${priceText(plan.targetPrice)} ${plan.currency}).` } : { tone: 'info', text: `Prețul e cu ${Math.abs(d * 100).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}% sub ținta de ${priceText(plan.targetPrice)} ${plan.currency}.` });
    }
    if (plan.stopLoss !== null && price <= plan.stopLoss) notes.push({ tone: 'ok', text: `Prețul a ajuns la stop-loss (${priceText(plan.stopLoss)} ${plan.currency}): vinzi cum ți-ai propus.` });
  }
  if (plan.horizonMonths !== null) {
    const held = Math.round(Math.max(0, daysBetween(plan.date, date || todayIso())) / 30.44);
    notes.push(
      held >= plan.horizonMonths
        ? { tone: 'ok', text: `Au trecut ${horizonLabel(Math.max(1, held))}; orizontul planificat era de ${horizonLabel(plan.horizonMonths)}.` }
        : { tone: 'info', text: `Au trecut ${held < 1 ? 'mai puțin de o lună' : horizonLabel(held)} din orizontul de ${horizonLabel(plan.horizonMonths)}.` }
    );
  }
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-soft/50 p-3">
      <p className="flex items-center gap-1.5 text-body font-semibold text-ink">
        <NotebookPen className="size-4 text-accent" aria-hidden /> Planul tău din {fmtDate(plan.date)}
      </p>
      {plan.reason && <p className="mt-1 text-body text-ink-2 italic">„{plan.reason}”</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <PlanChips e={plan} />
      </div>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {notes.map((n) => (
            <li key={n.text} className={cx(n.tone === 'ok' ? 'text-gain' : n.tone === 'warn' ? 'text-warn' : 'text-ink-2')}>
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Formularul unei intrări: o notă nouă pe o poziție sau editarea unei intrări existente. */
export function JournalEntryForm({
  entry,
  preset,
  assets,
  tagSuggestions,
  onClose,
  onSaved
}: {
  entry: JournalEntry | null;
  preset?: { assetId?: number; portfolioId?: number | null };
  assets: Asset[];
  tagSuggestions?: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { defaultPortfolioId, notify } = useApp();
  const choices = assets;
  const [assetId, setAssetId] = useState<number | ''>(entry?.assetId ?? preset?.assetId ?? choices[0]?.id ?? '');
  const [portfolioId, setPortfolioId] = useState<number | null>(entry?.portfolioId ?? preset?.portfolioId ?? defaultPortfolioId);
  const [date, setDate] = useState(entry?.date ?? todayIso());
  const [draft, setDraft] = useState<JournalDraft>(entry ? draftFrom(entry) : emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const asset = assets.find((a) => a.id === assetId);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const invalid = draftError(draft);
    if (invalid) return setError(invalid);
    setSaving(true);
    try {
      const input = { ...draftToInput(draft, entry?.reviewedAt ? null : (entry?.reviewDate ?? null)), date };
      if (entry?.id) await api.journal.update(entry.id, input);
      else await api.journal.create({ ...input, assetId: assetId === '' ? null : assetId, portfolioId });
      notify('success', entry ? 'Intrarea din jurnal a fost modificată.' : 'Nota a fost adăugată în jurnal.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={entry ? 'Editează intrarea din jurnal' : 'Notează în jurnal'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="journal-form" loading={saving}>
            Salvează
          </Button>
        </>
      }
    >
      <form id="journal-form" onSubmit={submit} className="space-y-3.5">
        {entry ? (
          <p className="flex items-center gap-2 text-body text-ink-2">
            <Badge tone="accent">{entry.symbol}</Badge> {entry.name} · {entry.portfolioName}
            {entry.transactionId !== null && ` · ${entry.kind === 'buy' ? 'cumpărarea' : 'vânzarea'} din ${fmtDate(entry.date)}`}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Poziția">
              <Select value={assetId} onChange={(e) => setAssetId(Number(e.target.value))} required>
                {choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.symbol} — {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <PortfolioField value={portfolioId} onChange={setPortfolioId} />
          </div>
        )}
        {(!entry || entry.transactionId === null) && (
          <Field label="Data">
            <Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        )}
        <JournalFields draft={draft} onChange={setDraft} currency={asset?.currency ?? entry?.currency} tagSuggestions={tagSuggestions} />
        {entry?.reviewDate && !entry.reviewedAt && !draft.review && <p className="text-xs text-ink-3">Memento de revizuire: {fmtDate(entry.reviewDate)}.</p>}
        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}
