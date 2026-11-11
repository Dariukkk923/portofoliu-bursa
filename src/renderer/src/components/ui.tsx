/** Componentele de bază ale interfeței: butoane, câmpuri, carduri, ferestre modale. */
import {
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { ArrowDownRight, ArrowUpRight, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { pnlClass } from '../lib/format';

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/* ---------------------------------------------------------------- butoane */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-loss text-white dark:text-[#2a0a0a] hover:brightness-110'
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9.5 px-3.5 text-sm',
        BUTTON_STYLES[variant],
        className
      )}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** Buton pătrat doar cu iconiță (acțiunile din rândurile tabelelor). */
export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={cx(
        'inline-flex size-8 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-2 hover:text-ink',
        'focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- câmpuri */

const CONTROL =
  'w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-3 transition ' +
  'focus:border-accent focus:outline-2 focus:outline-accent/30 disabled:bg-surface-2 disabled:text-ink-3';

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  // Indiciul stă în afara etichetei, ca numele accesibil al câmpului să fie doar eticheta.
  return (
    <div className={className}>
      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink-2">{label}</span>
        {children}
      </label>
      {error ? <p className="mt-1 text-xs text-loss">{error}</p> : hint ? <p className="mt-1 text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(CONTROL, 'h-9.5', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={2} {...rest} className={cx(CONTROL, 'resize-none py-2', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(CONTROL, 'h-9.5 pr-8', className)}>
      {children}
    </select>
  );
}

/** Grup de butoane cu o singură opțiune activă (ex.: tipul activului, intervalul graficului). */
export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md font-medium transition focus-visible:outline-2 focus-visible:outline-accent',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
            o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- afișare */

export function Card({ title, action, children, className, padded = true }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface', className)}>
      {(title || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 px-4 pt-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'gain' | 'loss' | 'warn' }) {
  const tones = {
    neutral: 'bg-surface-2 text-ink-2',
    accent: 'bg-accent-soft text-accent',
    gain: 'bg-gain-soft text-gain',
    loss: 'bg-loss-soft text-loss',
    warn: 'bg-warn-soft text-warn'
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold', tones[tone])}>{children}</span>;
}

/**
 * Valoare de profit/pierdere: verde pentru profit, roșu pentru pierdere.
 * Semnul și săgeata dublează culoarea, ca sensul să nu depindă doar de ea.
 */
export function Pnl({ value, children, arrow = false, className }: { value: number | null | undefined; children: ReactNode; arrow?: boolean; className?: string }) {
  const Icon = (value ?? 0) >= 0 ? ArrowUpRight : ArrowDownRight;
  const flat = value === null || value === undefined || Math.abs(value) < 0.005;
  return (
    <span className={cx('tabular inline-flex items-center gap-0.5', pnlClass(value), className)}>
      {arrow && !flat && <Icon className="size-3.5" aria-hidden />}
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx('size-5 animate-spin text-ink-3', className)} aria-label="Se încarcă" />;
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-surface-2 text-ink-3">{icon}</div>}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {text && <p className="max-w-md text-[13px] text-ink-2">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Bandă de avertizare sau de eroare, afișată în pagină. */
export function Notice({ tone = 'warn', children, action }: { tone?: 'warn' | 'loss' | 'accent'; children: ReactNode; action?: ReactNode }) {
  const tones = { warn: 'bg-warn-soft text-warn', loss: 'bg-loss-soft text-loss', accent: 'bg-accent-soft text-accent' };
  return (
    <div role="status" className={cx('flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-[13px]', tones[tone])}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-ink">{children}</div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ modale */

export function Modal({ title, onClose, children, footer, width = 'max-w-xl' }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('animate-in flex max-h-[92vh] w-full flex-col rounded-xl border border-line bg-surface shadow-2xl', width)}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id={titleId} className="text-base font-semibold text-ink">
            {title}
          </h2>
          <IconButton label="Închide" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Șterge', onConfirm, onCancel, busy }: { title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onCancel}>Renunță</Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-2">{message}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ tabele */

export const TH = 'px-3 py-2.5 text-left text-xs font-semibold text-ink-3 whitespace-nowrap';
export const TD = 'px-3 py-2.5 text-[13px] text-ink whitespace-nowrap';
