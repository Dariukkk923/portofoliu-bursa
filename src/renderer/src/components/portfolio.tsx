/**
 * Componentele pentru portofolii: iconița colorată, selectorul din bara de sus,
 * câmpul de alegere din formulare, formularul de creare/editare și dialogul de
 * mutare a tranzacțiilor între portofolii.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Bitcoin,
  Briefcase,
  Check,
  ChevronDown,
  GraduationCap,
  House,
  Landmark,
  Layers,
  PiggyBank,
  Rocket,
  Settings2,
  Shield,
  TrendingUp,
  Wallet,
  type LucideIcon
} from 'lucide-react';
import {
  BASE_CURRENCIES,
  PORTFOLIO_COLORS,
  PORTFOLIO_ICONS,
  type MovePreview,
  type Portfolio,
  type PortfolioColor,
  type PortfolioIcon as IconName,
  type PortfolioInput
} from '@shared/types';
import { BENCHMARKS } from '@shared/benchmarks';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { money } from '../lib/format';
import { Button, Field, Input, Modal, Notice, Select, Spinner, cx } from './ui';

export const PORTFOLIO_COLOR_HEX: Record<PortfolioColor, string> = {
  blue: '#2a78d6',
  green: '#1a9e6f',
  violet: '#6d5ce0',
  amber: '#d99300',
  rose: '#d9558a',
  teal: '#0e93a5',
  orange: '#e0622f',
  slate: '#64748b'
};

const COLOR_LABEL: Record<PortfolioColor, string> = {
  blue: 'Albastru',
  green: 'Verde',
  violet: 'Violet',
  amber: 'Chihlimbar',
  rose: 'Roz',
  teal: 'Turcoaz',
  orange: 'Portocaliu',
  slate: 'Gri'
};

const ICONS: Record<IconName, LucideIcon> = {
  wallet: Wallet,
  'piggy-bank': PiggyBank,
  'trending-up': TrendingUp,
  bitcoin: Bitcoin,
  landmark: Landmark,
  briefcase: Briefcase,
  rocket: Rocket,
  shield: Shield,
  'graduation-cap': GraduationCap,
  house: House
};

const ICON_LABEL: Record<IconName, string> = {
  wallet: 'Portofel',
  'piggy-bank': 'Pușculiță',
  'trending-up': 'Creștere',
  bitcoin: 'Crypto',
  landmark: 'Bancă',
  briefcase: 'Servietă',
  rocket: 'Rachetă',
  shield: 'Scut',
  'graduation-cap': 'Educație',
  house: 'Casă'
};

/** Pătratul colorat cu iconița portofoliului. */
export function PortfolioIcon({ color, icon, size = 'md' }: { color: PortfolioColor; icon: IconName; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = ICONS[icon] ?? Wallet;
  const hex = PORTFOLIO_COLOR_HEX[color] ?? PORTFOLIO_COLOR_HEX.blue;
  const box = size === 'sm' ? 'size-5 rounded-md' : size === 'lg' ? 'size-10 rounded-xl' : 'size-7 rounded-lg';
  const glyph = size === 'sm' ? 'size-3' : size === 'lg' ? 'size-5' : 'size-4';
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center', box)} style={{ color: hex, backgroundColor: `${hex}24` }} aria-hidden>
      <Icon className={glyph} />
    </span>
  );
}

/** Eticheta mică cu numele portofoliului (în tabele, în vederea combinată). */
export function PortfolioTag({ portfolioId }: { portfolioId: number | null }) {
  const { portfolios } = useApp();
  const p = portfolios.find((x) => x.id === portfolioId);
  if (!p) return null;
  return (
    <span className="inline-flex max-w-40 items-center gap-1 text-xs text-ink-3">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: PORTFOLIO_COLOR_HEX[p.color] }} aria-hidden />
      <span className="truncate">{p.name}</span>
    </span>
  );
}

/** Selectorul de portofoliu din bara de sus: un portofoliu sau „Toate portofoliile”. */
export function PortfolioSwitcher({ onManage }: { onManage: () => void }) {
  const { activePortfolios, scope, currentPortfolio, setScope } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  const choose = (next: number | 'all'): void => {
    setScope(next);
    setOpen(false);
  };
  const item = 'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Alege portofoliul"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9.5 max-w-60 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        {currentPortfolio ? (
          <PortfolioIcon color={currentPortfolio.color} icon={currentPortfolio.icon} size="sm" />
        ) : (
          <span className="inline-flex size-5 items-center justify-center rounded-md bg-accent-soft text-accent" aria-hidden>
            <Layers className="size-3" />
          </span>
        )}
        <span className="truncate">{currentPortfolio?.name ?? 'Toate portofoliile'}</span>
        <ChevronDown className="size-4 shrink-0 text-ink-3" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="animate-in absolute left-0 z-40 mt-1.5 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          {activePortfolios.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={scope === p.id} className={item} onClick={() => choose(p.id)}>
              <PortfolioIcon color={p.color} icon={p.icon} size="sm" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="text-xs text-ink-3">{p.baseCurrency}</span>
              {scope === p.id && <Check className="size-4 text-accent" aria-hidden />}
            </button>
          ))}
          {activePortfolios.length > 1 && (
            <button type="button" role="menuitemradio" aria-checked={scope === 'all'} className={item} onClick={() => choose('all')}>
              <span className="inline-flex size-5 items-center justify-center rounded-md bg-accent-soft text-accent" aria-hidden>
                <Layers className="size-3" />
              </span>
              <span className="min-w-0 flex-1 truncate">Toate portofoliile</span>
              {scope === 'all' && <Check className="size-4 text-accent" aria-hidden />}
            </button>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Settings2 className="size-4 text-ink-3" aria-hidden />
            Gestionează portofoliile…
          </button>
        </div>
      )}
    </div>
  );
}

/** Câmpul „Portofoliu” din formulare; nu apare dacă utilizatorul are un singur portofoliu activ. */
export function PortfolioField({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const { activePortfolios } = useApp();
  if (activePortfolios.length < 2) return null;
  return (
    <Field label="Portofoliu">
      <Select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))} required>
        {activePortfolios.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Crearea sau editarea unui portofoliu: nume, culoare, iconiță, monedă de bază, indice de referință. */
export function PortfolioForm({ initial, onClose, onSaved }: { initial: Portfolio | null; onClose: () => void; onSaved: (p: Portfolio) => void }) {
  const { settings } = useApp();
  const [form, setForm] = useState<Required<PortfolioInput>>({
    name: initial?.name ?? '',
    color: initial?.color ?? 'blue',
    icon: initial?.icon ?? 'wallet',
    baseCurrency: initial?.baseCurrency ?? settings?.baseCurrency ?? 'RON',
    benchmark: initial?.benchmark ?? null
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(initial ? await api.portfolios.update(initial.id, form) : await api.portfolios.create(form));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial ? `Editează „${initial.name}”` : 'Portofoliu nou'}
      width="max-w-lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="portfolio-form" loading={saving}>
            {initial ? 'Salvează' : 'Creează portofoliul'}
          </Button>
        </>
      }
    >
      <form id="portfolio-form" onSubmit={submit} className="space-y-4">
        <Field label="Nume">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ex.: Pe termen lung, Trading, Pensie" maxLength={40} autoFocus required />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-body font-medium text-ink-2">Culoare</legend>
          <div className="flex flex-wrap gap-2">
            {PORTFOLIO_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={COLOR_LABEL[c]}
                aria-pressed={form.color === c}
                title={COLOR_LABEL[c]}
                onClick={() => setForm({ ...form, color: c })}
                className={cx('size-8 rounded-full ring-offset-2 ring-offset-surface focus-visible:outline-2 focus-visible:outline-accent', form.color === c && 'ring-2 ring-ink')}
                style={{ backgroundColor: PORTFOLIO_COLOR_HEX[c] }}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-body font-medium text-ink-2">Iconiță</legend>
          <div className="flex flex-wrap gap-2">
            {PORTFOLIO_ICONS.map((i) => (
              <button
                key={i}
                type="button"
                aria-label={ICON_LABEL[i]}
                aria-pressed={form.icon === i}
                title={ICON_LABEL[i]}
                onClick={() => setForm({ ...form, icon: i })}
                className={cx('rounded-xl p-0.5 focus-visible:outline-2 focus-visible:outline-accent', form.icon === i ? 'ring-2 ring-ink' : 'opacity-70 hover:opacity-100')}
              >
                <PortfolioIcon color={form.color} icon={i} size="lg" />
              </button>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Moneda de bază" hint="Moneda în care vezi totalurile acestui portofoliu.">
            <Select value={form.baseCurrency} onChange={(e) => setForm({ ...form, baseCurrency: e.target.value })}>
              {BASE_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Indice de referință" hint="Cu el se compară randamentul.">
            <Select value={form.benchmark ?? ''} onChange={(e) => setForm({ ...form, benchmark: e.target.value || null })}>
              <option value="">Implicit (din Setări)</option>
              {BENCHMARKS.map((b) => (
                <option key={b.symbol} value={b.symbol}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}

/** Confirmarea mutării unor tranzacții (sau a unei poziții întregi) în alt portofoliu. */
export function MoveDialog({
  ids,
  fromPortfolioId,
  title,
  onClose,
  onMoved
}: {
  ids: number[];
  fromPortfolioId: number | null;
  title: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { activePortfolios, notify } = useApp();
  const targets = activePortfolios.filter((p) => p.id !== fromPortfolioId);
  const [target, setTarget] = useState<number | null>(targets[0]?.id ?? null);
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [moveCash, setMoveCash] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target === null) return;
    let alive = true;
    setPreview(null);
    api.transactions
      .previewMove(ids, target)
      .then((p) => alive && setPreview(p))
      .catch((err) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [ids, target]);

  const submit = async (): Promise<void> => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.transactions.move(ids, target, { moveCash: moveCash && (preview?.cash.length ?? 0) > 0 });
      notify('success', `${res.moved === 1 ? 'O tranzacție a fost mutată' : `${res.moved} tranzacții au fost mutate`} în „${preview?.to ?? ''}”.`);
      onMoved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      width="max-w-lg"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Renunță
          </Button>
          <Button variant="primary" loading={busy} disabled={!preview || preview.count === 0} onClick={() => void submit()}>
            Mută
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <Notice tone="accent">Ai un singur portofoliu activ. Creează altul din Portofolii → Portofoliu nou.</Notice>
      ) : (
        <div className="space-y-3 text-sm text-ink-2">
          <Field label="Mută în portofoliul">
            <Select value={target ?? ''} onChange={(e) => setTarget(Number(e.target.value))}>
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {!preview && !error && <Spinner className="size-5" />}
          {preview && (
            <>
              <p>
                Se mută <strong className="text-ink">{preview.count === 1 ? 'o tranzacție' : `${preview.count} tranzacții`}</strong>
                {preview.from.length > 0 && <> din „{preview.from.join('”, „')}”</>} în „{preview.to}”. Costul, profitul și cash-ul se recalculează automat în ambele portofolii.
              </p>
              {preview.cash.length > 0 && (
                <div className="rounded-lg border border-line p-3">
                  <p className="text-body">Efectul asupra cash-ului din portofoliul de unde pleacă:</p>
                  <ul className="mt-1.5 space-y-0.5 text-body">
                    {preview.cash.map((c) => (
                      <li key={`${c.portfolioName}:${c.brokerName}:${c.currency}`} className="tabular">
                        {c.portfolioName} · {c.brokerName}: cash-ul {c.amount < 0 ? 'crește' : 'scade'} cu <strong className="text-ink">{money(Math.abs(c.amount), c.currency)}</strong>
                      </li>
                    ))}
                  </ul>
                  <label className="mt-2.5 flex items-start gap-2 text-body text-ink">
                    <input type="checkbox" className="mt-0.5 size-4 accent-accent" checked={moveCash} onChange={(e) => setMoveCash(e.target.checked)} />
                    <span>
                      Mută și banii: o retragere din portofoliul vechi și o depunere în „{preview.to}” cu aceeași sumă, ca soldurile de cash să rămână corecte.
                    </span>
                  </label>
                </div>
              )}
            </>
          )}
          {error && <Notice tone="loss">{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}
