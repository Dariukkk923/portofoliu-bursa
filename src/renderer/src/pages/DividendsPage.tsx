/**
 * Calendarul de dividende: venitul pasiv pe luni (încasat vs. estimat), calendarul lunar cu
 * datele ex-dividend și de plată, dividendele plătite care trebuie înregistrate, randamentul
 * fiecărei poziții și introducerea manuală a unui dividend anunțat.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import type { DividendCalendar, DividendCalendarEntry, DividendProposal, DividendStatus } from '@shared/types';
import { parseNumberLoose } from '@shared/csv';
import { todayIso } from '@shared/dates';
import { api, errorMessage } from '../api';
import { useApp, useLoad } from '../context/AppContext';
import { date as fmtDate, money, percent, quantity as fmtQty } from '../lib/format';
import { IncomeChart, monthName } from '../components/charts';
import { TickerLogo } from '../components/TickerLogo';
import { TransactionForm, type TransactionPreset } from '../components/TransactionForm';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, LoadError, Modal, Notice, PageSkeleton, Select, TD, TH, cx } from '../components/ui';

const STATUS_LABEL: Record<DividendStatus, string> = {
  received: 'Încasat',
  announced: 'Anunțat',
  estimated: 'Estimat',
  manual: 'Introdus de tine'
};
const STATUS_TONE: Record<DividendStatus, 'gain' | 'accent' | 'neutral' | 'warn'> = {
  received: 'gain',
  announced: 'accent',
  estimated: 'neutral',
  manual: 'warn'
};
const FREQUENCY_LABEL: Record<number, string> = { 1: 'anual', 2: 'semestrial', 4: 'trimestrial', 12: 'lunar' };
const WEEKDAYS = ['L', 'Ma', 'Mi', 'J', 'V', 'S', 'D'];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <p className="tabular mt-1 text-stat font-semibold text-ink">{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

/** Eticheta unei plăți în celula zilei: încasat = plin, estimat = hașurat, anunțat/manual = contur. */
function Chip({ entry }: { entry: DividendCalendarEntry }) {
  const amount = money(entry.gross, entry.currency);
  return (
    <span
      title={`${entry.symbol}: ${amount} · ${entry.coupon ? 'cupon' : STATUS_LABEL[entry.status].toLowerCase()}`}
      className={cx(
        'block truncate rounded px-1.5 py-0.5 text-2xs leading-4 font-medium',
        entry.status === 'received' && 'bg-(--series-1) text-white',
        entry.status === 'estimated' && 'income-hatch text-ink',
        (entry.status === 'announced' || entry.status === 'manual') && 'border border-(--series-1) text-ink'
      )}
    >
      {entry.symbol}
    </span>
  );
}

function MonthGrid({ year, month, entries }: { year: number; month: number; entries: DividendCalendarEntry[] }) {
  const today = todayIso();
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // luni = 0
  const byDay = new Map<number, DividendCalendarEntry[]>();
  for (const e of entries) {
    const d = Number(e.payDate.slice(8, 10));
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const cells: (number | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return (
    <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-line" role="grid" aria-label={`Plățile din ${monthName(month)} ${year}`}>
      {WEEKDAYS.map((w) => (
        <div key={w} className="border-b border-line bg-surface-2 px-2 py-1.5 text-center text-2xs font-semibold text-ink-3">
          {w}
        </div>
      ))}
      {cells.map((day, i) => {
        const iso = day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
        const list = day ? (byDay.get(day) ?? []) : [];
        return (
          <div key={i} className={cx('min-h-18 border-line p-1', i % 7 !== 6 && 'border-r', i < cells.length - 7 && 'border-b', !day && 'bg-surface-2/40')}>
            {day && (
              <>
                <span className={cx('tabular inline-flex size-5 items-center justify-center rounded-full text-2xs', iso === today ? 'bg-brand font-semibold text-brand-ink' : 'text-ink-3')}>
                  {day}
                </span>
                <div className="mt-0.5 space-y-0.5">
                  {list.slice(0, 3).map((e) => (
                    <Chip key={e.key} entry={e} />
                  ))}
                  {list.length > 3 && <span className="block px-1 text-2xs text-ink-3">+{list.length - 3}</span>}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ManualDividendForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const assets = useLoad(() => api.assets.list(), []);
  const choices = (assets.data ?? []).filter((a) => a.type === 'stock' || a.type === 'etf');
  const [assetId, setAssetId] = useState<number | ''>('');
  const [exDate, setExDate] = useState('');
  const [payDate, setPayDate] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const asset = choices.find((a) => a.id === assetId) ?? choices[0];

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const value = parseNumberLoose(amount);
    if (!asset) return setError('Alege acțiunea.');
    if (value === null || value <= 0) return setError('Scrie suma pe acțiune.');
    setSaving(true);
    try {
      await api.dividends.addManual({ assetId: asset.id, exDate, payDate: payDate || null, amount: value });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Adaugă un dividend anunțat"
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Renunță</Button>
          <Button variant="primary" type="submit" form="manual-dividend" loading={saving}>
            Adaugă
          </Button>
        </>
      }
    >
      <form id="manual-dividend" onSubmit={submit} className="space-y-3.5">
        <p className="text-body text-ink-2">Pentru dividendele pe care providerul de date nu le are încă (de exemplu cele anunțate de companiile de la BVB).</p>
        <Field label="Acțiunea">
          <Select value={asset?.id ?? ''} onChange={(e) => setAssetId(Number(e.target.value))} required>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.symbol} — {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Data ex-dividend" hint="Trebuie să deții acțiunile înainte de această zi.">
            <Input type="date" value={exDate} onChange={(e) => setExDate(e.target.value)} required />
          </Field>
          <Field label="Data plății (opțional)">
            <Input type="date" value={payDate} min={exDate || undefined} onChange={(e) => setPayDate(e.target.value)} />
          </Field>
        </div>
        <Field label={`Suma brută pe acțiune${asset ? ` (${asset.currency})` : ''}`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="ex.: 0,05" required />
        </Field>
        {error && <Notice tone="loss">{error}</Notice>}
      </form>
    </Modal>
  );
}

export function DividendsPage() {
  const { filter, dataVersion, bumpData, notify } = useApp();
  const now = todayIso();
  const [year, setYear] = useState(Number(now.slice(0, 4)));
  const [month, setMonth] = useState(Number(now.slice(5, 7)));
  const [manualOpen, setManualOpen] = useState(false);
  const [record, setRecord] = useState<DividendProposal | null>(null);
  const cal = useLoad(() => api.dividends.calendar(year, filter), [year, filter, dataVersion]);
  const assets = useLoad(() => api.assets.list(), [dataVersion]);
  const c: DividendCalendar | null = cal.data;

  const monthEntries = useMemo(() => (c ? c.entries.filter((e) => Number(e.payDate.slice(5, 7)) === month) : []), [c, month]);

  const shiftMonth = (delta: number): void => {
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y--;
    } else if (m > 12) {
      m = 1;
      y++;
    }
    setMonth(m);
    setYear(y);
  };

  const dismiss = async (p: DividendProposal): Promise<void> => {
    try {
      await api.dividends.dismiss(p.assetId, p.exDate);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };
  const removeManual = async (id: number): Promise<void> => {
    try {
      await api.dividends.removeManual(id);
      bumpData();
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };

  if (!c) {
    return cal.error ? <LoadError message={cal.error} onRetry={cal.reload} /> : <PageSkeleton />;
  }
  const base = c.baseCurrency;
  const currentYear = year === Number(now.slice(0, 4));
  const preset = (p: DividendProposal): TransactionPreset => ({
    portfolioId: p.portfolioId,
    type: p.coupon ? 'coupon' : 'dividend',
    assetId: p.assetId,
    brokerId: p.brokerId,
    date: p.payDate,
    gross: p.gross,
    tax: p.tax,
    notes: `${p.coupon ? 'Cupon' : 'Dividend'} ${fmtQty(p.quantity)} × ${p.amountPerShare.toLocaleString('ro-RO', { maximumFractionDigits: 6 })} ${p.currency} (ex-dividend ${fmtDate(p.exDate)})`
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-3xl text-body text-ink-2">
          Dividendele și cupoanele pozițiilor tale: cele încasate (din tranzacții), cele anunțate de companii și cele estimate din istoricul plăților. Sumele sunt brute, înainte de impozit.
        </p>
        <Select className="w-28!" value={String(year)} onChange={(e) => setYear(Number(e.target.value))} aria-label="Anul">
          {c.years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <Button icon={<Plus className="size-4" />} onClick={() => setManualOpen(true)}>
          Adaugă dividend anunțat
        </Button>
      </div>

      {c.proposals.length > 0 && (
        <Card title={`Dividende plătite, de înregistrat (${c.proposals.length})`}>
          <p className="mb-3 text-xs text-ink-2">Aceste dividende ar fi trebuit să fie plătite. Verifică suma în extrasul brokerului și înregistreaz-o, ca să apară în cash și în randament.</p>
          <ul className="divide-y divide-line">
            {c.proposals.map((p) => (
              <li key={p.key} className="flex flex-wrap items-center gap-3 py-2.5">
                <TickerLogo symbol={p.symbol} type={p.coupon ? 'bond' : 'stock'} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-ink">
                    {p.symbol} · <span className="tabular">{money(p.gross, p.currency)}</span>{' '}
                    <Badge tone={STATUS_TONE[p.status]}>{p.coupon ? 'Cupon' : STATUS_LABEL[p.status]}</Badge>
                  </p>
                  <p className="text-xs text-ink-2">
                    Plătit pe {fmtDate(p.payDate)} · {fmtQty(p.quantity)} × {p.amountPerShare.toLocaleString('ro-RO', { maximumFractionDigits: 6 })} {p.currency} · {p.brokerName}
                    {p.portfolioName ? ` · ${p.portfolioName}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => setRecord(p)}>
                  Înregistrează
                </Button>
                <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => void dismiss(p)}>
                  Nu l-am primit
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={`Încasat în ${year}`} value={money(c.receivedTotal, base)} hint="Din tranzacțiile de dividend și cupon." />
        <Stat label={currentYear ? `Estimat până la final de ${year}` : `Neîncasat în ${year}`} value={money(c.estimatedTotal, base)} hint="Anunțat, introdus de tine sau după istoric." />
        <Stat label={`Total ${year}`} value={money(c.receivedTotal + c.estimatedTotal, base)} />
        <Stat label="Următoarele 12 luni" value={money(c.next12Months, base)} hint="Estimare, la cursul de azi." />
      </div>

      <Card title={`Venit pasiv pe luni, ${year}`}>
        <IncomeChart data={c.months} currency={base} year={year} />
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2">
            <IconButton label="Luna anterioară" onClick={() => shiftMonth(-1)}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <span className="min-w-36 text-center first-letter:uppercase">
              {monthName(month)} {year}
            </span>
            <IconButton label="Luna următoare" onClick={() => shiftMonth(1)}>
              <ChevronRight className="size-4" />
            </IconButton>
          </span>
        }
        action={
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-(--series-1)" /> Încasat
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm border border-(--series-1)" /> Anunțat
            </span>
            <span className="flex items-center gap-1.5">
              <span className="income-hatch size-2.5 rounded-sm" /> Estimat
            </span>
          </div>
        }
      >
        <MonthGrid year={year} month={month} entries={monthEntries} />
        {monthEntries.length === 0 ? (
          <p className="mt-3 text-body text-ink-3">Nicio plată în această lună.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className={TH}>Data plății</th>
                  <th className={TH}>Poziție</th>
                  <th className={TH}>Ex-dividend</th>
                  <th className={cx(TH, 'text-right')}>Pe acțiune</th>
                  <th className={cx(TH, 'text-right')}>Cantitate</th>
                  <th className={cx(TH, 'text-right')}>Sumă brută</th>
                  <th className={TH}>Stare</th>
                  <th className={TH} aria-label="Acțiuni" />
                </tr>
              </thead>
              <tbody>
                {monthEntries.map((e) => (
                  <tr key={e.key} className="border-b border-line last:border-0">
                    <td className={TD}>
                      {fmtDate(e.payDate)}
                      {e.payDateEstimated && <span className="ml-1 text-xs text-ink-3">(estimată)</span>}
                    </td>
                    <td className={TD}>
                      <span className="flex items-center gap-2">
                        <TickerLogo symbol={e.symbol} type={e.assetType} size={22} />
                        <span className="font-semibold">{e.symbol}</span>
                        <span className="max-w-40 truncate text-xs text-ink-3">{e.name}</span>
                      </span>
                    </td>
                    <td className={cx(TD, 'text-ink-2')}>{e.coupon ? '—' : fmtDate(e.exDate)}</td>
                    <td className={cx(TD, 'tabular text-right')}>{e.amountPerShare === null ? '—' : `${e.amountPerShare.toLocaleString('ro-RO', { maximumFractionDigits: 6 })} ${e.currency}`}</td>
                    <td className={cx(TD, 'tabular text-right')}>{e.quantity > 0 ? fmtQty(e.quantity) : '—'}</td>
                    <td className={cx(TD, 'tabular text-right font-medium')}>
                      {money(e.gross, e.currency)}
                      {e.net !== null && <span className="block text-xs font-normal text-ink-3">net {money(e.net, e.currency)}</span>}
                    </td>
                    <td className={TD}>
                      <Badge tone={STATUS_TONE[e.status]}>{e.coupon && e.status !== 'received' ? 'Cupon' : STATUS_LABEL[e.status]}</Badge>
                    </td>
                    <td className={cx(TD, 'text-right')}>
                      {e.manualId !== null && e.status === 'manual' && (
                        <IconButton label={`Șterge dividendul introdus pentru ${e.symbol}`} onClick={() => void removeManual(e.manualId as number)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Randament din dividende pe poziții" padded={false}>
        <p className="px-4 pb-3 text-xs text-ink-2">
          <strong className="font-medium text-ink">Dividend yield</strong> = dividendele din ultimele 12 luni / prețul de azi. <strong className="font-medium text-ink">Yield on cost</strong> = aceleași dividende / prețul tău mediu de cumpărare: cât îți aduce investiția inițială.
        </p>
        {c.yields.length === 0 ? (
          <EmptyState icon={<CalendarDays className="size-5" />} title="Nicio poziție cu dividende" text="Dividendele apar după actualizarea prețurilor sau când le introduci manual." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-y border-line">
                  <th className={TH}>Poziție</th>
                  <th className={cx(TH, 'text-right')}>Cantitate</th>
                  <th className={cx(TH, 'text-right')}>Dividende / acțiune (12 luni)</th>
                  <th className={TH}>Plăți</th>
                  <th className={cx(TH, 'text-right')}>Dividend yield</th>
                  <th className={cx(TH, 'text-right')}>Yield on cost</th>
                  <th className={cx(TH, 'text-right')}>Venit anual estimat</th>
                </tr>
              </thead>
              <tbody>
                {c.yields.map((y) => (
                  <tr key={y.assetId} className="border-b border-line last:border-0">
                    <td className={TD}>
                      <span className="flex items-center gap-2">
                        <TickerLogo symbol={y.symbol} type={y.assetType} size={22} />
                        <span className="font-semibold">{y.symbol}</span>
                        <span className="max-w-48 truncate text-xs text-ink-3">{y.name}</span>
                      </span>
                    </td>
                    <td className={cx(TD, 'tabular text-right')}>{fmtQty(y.quantity)}</td>
                    <td className={cx(TD, 'tabular text-right')}>
                      {y.trailingPerShare.toLocaleString('ro-RO', { maximumFractionDigits: 4 })} {y.currency}
                    </td>
                    <td className={cx(TD, 'text-ink-2')}>{y.frequency ? FREQUENCY_LABEL[y.frequency] : '—'}</td>
                    <td className={cx(TD, 'tabular text-right')}>{percent(y.yield, 2)}</td>
                    <td className={cx(TD, 'tabular text-right font-medium')}>{percent(y.yieldOnCost, 2)}</td>
                    <td className={cx(TD, 'tabular text-right')}>{money(y.annualIncomeBase, base)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {c.withoutData.length > 0 && (
          <p className="px-4 py-2.5 text-xs text-ink-3">
            Fără date despre dividende pentru {c.withoutData.join(', ')}. Dacă plătesc dividende, le poți adăuga cu „Adaugă dividend anunțat”.
          </p>
        )}
      </Card>

      {manualOpen && (
        <ManualDividendForm
          onClose={() => setManualOpen(false)}
          onSaved={() => {
            setManualOpen(false);
            notify('success', 'Dividendul a fost adăugat în calendar.');
            bumpData();
          }}
        />
      )}
      {record && assets.data && (
        <TransactionForm
          assets={assets.data}
          initial={null}
          preset={preset(record)}
          onClose={() => setRecord(null)}
          onSaved={() => {
            setRecord(null);
            bumpData();
          }}
        />
      )}
    </>
  );
}
